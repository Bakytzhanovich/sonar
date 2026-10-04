import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { queryAll, type Db } from '../src/db';
import { createApp } from '../src/api';
import { parseSlides } from '../src/carouselGeneration';
import { ReelAnalysisError, type ChatModel } from '../src/reelLlm';
import { createTestDb, dropTestDb } from './dbTestHelper';

async function createTenant(app: Express, email = 'carousel@example.com') {
  const res = await request(app).post('/api/tenants').send({ name: 'Blogger', email });
  return { apiKey: res.body.apiKey as string };
}

const slidesAnswer = (n: number) =>
  JSON.stringify({ slides: Array.from({ length: n }, (_, i) => ({ headline: `Слайд ${i + 1}`, body: `Текст ${i + 1}` })) });

describe('parseSlides', () => {
  it('reads the model\'s slides, trimming what runs long', () => {
    const slides = parseSlides(JSON.stringify({ slides: [{ headline: '  Привычка  ', body: 'x'.repeat(900) }, ...JSON.parse(slidesAnswer(4)).slides] }));
    expect(slides[0]).toEqual({ headline: 'Привычка', body: 'x'.repeat(400) });
    expect(parseSlides(slidesAnswer(12))).toHaveLength(8);
  });

  it('refuses something that is not a carousel', () => {
    expect(() => parseSlides(slidesAnswer(3))).toThrow(ReelAnalysisError);
    expect(() => parseSlides('{"slides": [{"body": "без заголовка"}]}')).toThrow(ReelAnalysisError);
    expect(() => parseSlides('не JSON')).toThrow(ReelAnalysisError);
  });
});

describe('carousel API', () => {
  let app: Express;
  let db: Db;
  let chat: ChatModel;

  beforeEach(async () => {
    db = await createTestDb();
    chat = async () => slidesAnswer(5);
    app = createApp(db, { reelChat: (s, u) => chat(s, u) });
  });

  afterEach(async () => {
    if (db) await dropTestDb(db);
  });

  it('creates a brand preset with defaults when optional fields are omitted', async () => {
    const { apiKey } = await createTenant(app);
    const res = await request(app).post('/api/brand-presets').set('Authorization', `Bearer ${apiKey}`).send({ name: 'Основной' });
    expect(res.status).toBe(201);
    expect(res.body.preset).toMatchObject({ name: 'Основной', font_family: 'system-ui', primary_color: '#111111' });
  });

  it('generates a carousel with slides and lists it in the library', async () => {
    const { apiKey } = await createTenant(app);
    const res = await request(app)
      .post('/api/carousels')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ prompt: '5 привычек продуктивности' });

    expect(res.status).toBe(201);
    expect(res.body.carousel.prompt).toBe('5 привычек продуктивности');
    expect(res.body.slides.length).toBeGreaterThanOrEqual(4);
    expect(res.body.slides[0].position).toBe(0);

    const list = await request(app).get('/api/carousels').set('Authorization', `Bearer ${apiKey}`);
    expect(list.body.carousels).toHaveLength(1);
  });

  // The old fallback handed out "Пункт 1 / [мок] текст слайда" as a
  // generated carousel. A failure now says it failed, and leaves nothing
  // half-made in the library.
  it('says the model failed instead of handing out template slides', async () => {
    const { apiKey } = await createTenant(app);
    chat = async () => { throw new ReelAnalysisError('llm_failed', 'down'); };
    const failed = await request(app).post('/api/carousels').set('Authorization', `Bearer ${apiKey}`).send({ prompt: 'тема' });
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe('llm_failed');

    chat = async () => { throw new ReelAnalysisError('llm_not_configured'); };
    const unconfigured = await request(app).post('/api/carousels').set('Authorization', `Bearer ${apiKey}`).send({ prompt: 'тема' });
    expect(unconfigured.status).toBe(503);

    chat = async () => slidesAnswer(2);
    const tooShort = await request(app).post('/api/carousels').set('Authorization', `Bearer ${apiKey}`).send({ prompt: 'тема' });
    expect(tooShort.status).toBe(502);

    expect(await queryAll(db, `SELECT id FROM carousels`)).toHaveLength(0);
  });

  it('keeps the style picked for a carousel, and only this account\'s styles', async () => {
    const { apiKey } = await createTenant(app);
    const preset = (await request(app).post('/api/brand-presets').set('Authorization', `Bearer ${apiKey}`).send({ name: 'Блог' })).body.preset;
    const made = (await request(app).post('/api/carousels').set('Authorization', `Bearer ${apiKey}`).send({ prompt: 'тема' })).body.carousel;

    const res = await request(app).patch(`/api/carousels/${made.id}`).set('Authorization', `Bearer ${apiKey}`).send({ presetId: preset.id });
    expect(res.status).toBe(200);
    expect((await request(app).get(`/api/carousels/${made.id}`).set('Authorization', `Bearer ${apiKey}`)).body.carousel.preset_id).toBe(preset.id);

    const other = await createTenant(app, 'other-carousel@example.com');
    const theirs = (await request(app).post('/api/brand-presets').set('Authorization', `Bearer ${other.apiKey}`).send({ name: 'Чужой' })).body.preset;
    expect((await request(app).patch(`/api/carousels/${made.id}`).set('Authorization', `Bearer ${apiKey}`).send({ presetId: theirs.id })).status).toBe(404);
    expect((await request(app).patch(`/api/carousels/${made.id}`).set('Authorization', `Bearer ${other.apiKey}`).send({ presetId: null })).status).toBe(404);
  });

  // Sign-up is open, so a paid model call needs a ceiling per workspace —
  // and one workspace hitting it must not slow down any other.
  it('caps model calls per workspace per hour, without touching other workspaces', async () => {
    const { apiKey } = await createTenant(app, 'busy@example.com');
    const other = await createTenant(app, 'calm@example.com');
    const make = (key: string) => request(app).post('/api/carousels').set('Authorization', `Bearer ${key}`).send({ prompt: 'тема' });
    for (let i = 0; i < 30; i++) expect((await make(apiKey)).status).toBe(201);

    const over = await make(apiKey);
    expect(over.status).toBe(429);
    expect(over.body.error).toMatch(/Слишком много запросов к ИИ/);
    expect((await make(other.apiKey)).status).toBe(201);
  });

  it('deletes a carousel with its slides, and only the owner\'s', async () => {
    const { apiKey } = await createTenant(app, 'del-car@example.com');
    const other = await createTenant(app, 'del-other@example.com');
    const made = (await request(app).post('/api/carousels').set('Authorization', `Bearer ${apiKey}`).send({ prompt: 'тема' })).body.carousel;

    expect((await request(app).delete(`/api/carousels/${made.id}`).set('Authorization', `Bearer ${other.apiKey}`)).status).toBe(404);
    expect((await request(app).delete(`/api/carousels/${made.id}`).set('Authorization', `Bearer ${apiKey}`)).status).toBe(204);
    expect(await queryAll(db, `SELECT id FROM carousel_slides WHERE carousel_id = ?`, made.id)).toHaveLength(0);
    expect((await request(app).get(`/api/carousels/${made.id}`).set('Authorization', `Bearer ${apiKey}`)).status).toBe(404);
  });

  it('rejects an unknown presetId', async () => {
    const { apiKey } = await createTenant(app);
    const res = await request(app)
      .post('/api/carousels')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ prompt: 'тест', presetId: 'does-not-exist' });
    expect(res.status).toBe(404);
  });

  it('persists a manual edit to a slide', async () => {
    const { apiKey } = await createTenant(app);
    const created = await request(app)
      .post('/api/carousels')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ prompt: 'тест' });
    const slideId = created.body.slides[0].id;
    const carouselId = created.body.carousel.id;

    const edited = await request(app)
      .patch(`/api/carousels/${carouselId}/slides/${slideId}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ headline: 'Ручной заголовок' });
    expect(edited.body.slide.headline).toBe('Ручной заголовок');

    const fetched = await request(app).get(`/api/carousels/${carouselId}`).set('Authorization', `Bearer ${apiKey}`);
    expect(fetched.body.slides[0].headline).toBe('Ручной заголовок');
  });

  it('one tenant cannot read or edit another tenant\'s carousel', async () => {
    const owner = await createTenant(app, 'owner-carousel@example.com');
    const intruder = await createTenant(app, 'intruder-carousel@example.com');
    const created = await request(app).post('/api/carousels').set('Authorization', `Bearer ${owner.apiKey}`).send({ prompt: 'тест' });

    const read = await request(app).get(`/api/carousels/${created.body.carousel.id}`).set('Authorization', `Bearer ${intruder.apiKey}`);
    expect(read.status).toBe(404);

    const slideId = created.body.slides[0].id;
    const write = await request(app)
      .patch(`/api/carousels/${created.body.carousel.id}/slides/${slideId}`)
      .set('Authorization', `Bearer ${intruder.apiKey}`)
      .send({ headline: 'взлом' });
    expect(write.status).toBe(404);
  });
});
