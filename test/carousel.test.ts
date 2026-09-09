import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Db } from '../src/db';
import { createApp } from '../src/api';
import { generateCarouselMock } from '../src/carouselGeneration';
import { createTestDb, dropTestDb } from './dbTestHelper';

async function createTenant(app: Express, email = 'carousel@example.com') {
  const res = await request(app).post('/api/tenants').send({ name: 'Blogger', email });
  return { apiKey: res.body.apiKey as string };
}

describe('generateCarouselMock (pure)', () => {
  it('is deterministic and produces 4-6 slides', () => {
    const a = generateCarouselMock('5 привычек продуктивности');
    const b = generateCarouselMock('5 привычек продуктивности');
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(4);
    expect(a.length).toBeLessThanOrEqual(6);
  });
});

describe('carousel API', () => {
  let app: Express;
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    app = createApp(db);
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
