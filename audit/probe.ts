// Функциональный + security стенд по всем эндпоинтам. Запуск: npx tsx audit/probe.ts
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/api';
import { createTestDb, dropTestDb } from '../test/dbTestHelper';
import type { Db } from '../src/db';

type Row = { group: string; name: string; ok: boolean; detail: string };
const rows: Row[] = [];
let GROUP = '';
function group(g: string) { GROUP = g; }
function check(name: string, ok: boolean, detail = '') {
  rows.push({ group: GROUP, name, ok, detail });
}

let app: Express; let db: Db;

async function tenant(email: string) {
  const r = await request(app).post('/api/tenants').send({ name: email, email });
  return r.body.apiKey as string;
}
const auth = (k: string) => ({ Authorization: `Bearer ${k}` });

async function main() {
  db = await createTestDb();
  app = createApp(db);

  const A = await tenant('a@probe.test');
  const B = await tenant('b@probe.test');

  // ------------------------------------------------------------------
  group('1. Аутентификация');
  const signup = await request(app).post('/api/auth/signup').send({ email: 'u@probe.test', password: 'password123' });
  check('POST /api/auth/signup', signup.status === 201 && !!signup.body.sessionToken, `HTTP ${signup.status}`);
  const jwt = signup.body.sessionToken as string;

  const dupe = await request(app).post('/api/auth/signup').send({ email: 'u@probe.test', password: 'password123' });
  check('signup повторным email -> 409', dupe.status === 409, `HTTP ${dupe.status}`);

  const caseDupe = await request(app).post('/api/auth/signup').send({ email: 'U@PROBE.TEST', password: 'password123' });
  check('signup тем же email в другом регистре -> 409', caseDupe.status === 409, `HTTP ${caseDupe.status}`);

  const weak = await request(app).post('/api/auth/signup').send({ email: 'w@probe.test', password: 'short' });
  check('короткий пароль -> 400', weak.status === 400, `HTTP ${weak.status}`);

  const badEmail = await request(app).post('/api/auth/signup').send({ email: 'not-an-email', password: 'password123' });
  check('невалидный email -> 400', badEmail.status === 400, `HTTP ${badEmail.status}`);

  const login = await request(app).post('/api/auth/login').send({ email: 'u@probe.test', password: 'password123' });
  check('POST /api/auth/login', login.status === 200 && !!login.body.sessionToken, `HTTP ${login.status}`);

  const badLogin = await request(app).post('/api/auth/login').send({ email: 'u@probe.test', password: 'wrong-password' });
  check('неверный пароль -> 401', badLogin.status === 401, `HTTP ${badLogin.status}`);

  const me = await request(app).get('/api/auth/me').set(auth(jwt));
  check('GET /api/auth/me', me.status === 200 && me.body.user?.email === 'u@probe.test', `HTTP ${me.status}`);
  check('GET /api/auth/me без токена -> 401', (await request(app).get('/api/auth/me')).status === 401);

  // ------------------------------------------------------------------
  group('2. Боты и онбординг');
  const botRes = await request(app).post('/api/bots').set(auth(A)).send({ name: 'Bot A', externalAccountId: 'acc-a' });
  const botA = botRes.body.bot;
  check('POST /api/bots', botRes.status === 201 && !!botA?.id, `HTTP ${botRes.status}`);
  check('POST /api/bots без имени -> 400', (await request(app).post('/api/bots').set(auth(A)).send({})).status === 400);

  const listBots = await request(app).get('/api/bots').set(auth(A));
  check('GET /api/bots', listBots.status === 200 && listBots.body.bots.length === 1, `${listBots.body.bots?.length} шт`);
  const listBotsB = await request(app).get('/api/bots').set(auth(B));
  check('GET /api/bots другого тенанта не видит чужих', listBotsB.body.bots.length === 0, `${listBotsB.body.bots?.length} шт`);

  const ws = await request(app).post('/api/onboarding/demo-workspace').set(auth(A)).send({ keyword: 'старт', replyText: 'Привет' });
  check('POST /api/onboarding/demo-workspace', ws.status === 201 && !!ws.body.bot && !!ws.body.trigger, `HTTP ${ws.status}`);
  const ws2 = await request(app).post('/api/onboarding/demo-workspace').set(auth(A)).send({ keyword: 'старт', replyText: 'Привет' });
  check('demo-workspace идемпотентен', ws2.body.bot?.id === ws.body.bot?.id, 'тот же bot id');

  const demoBot = ws.body.bot;
  const demoInt = await request(app).post(`/api/bots/${demoBot.id}/demo-interactions`).set(auth(A)).send({ messageText: 'старт' });
  check('POST /api/bots/:id/demo-interactions', demoInt.status === 200 && !!demoInt.body.subscriberId, `HTTP ${demoInt.status}`);
  const demoOnNonDemo = await request(app).post(`/api/bots/${botA.id}/demo-interactions`).set(auth(A)).send({ messageText: 'x' });
  check('demo-interactions только для демо-бота -> 403', demoOnNonDemo.status === 403, `HTTP ${demoOnNonDemo.status}`);

  // ------------------------------------------------------------------
  group('3. Флоу и триггеры (Модуль 1)');
  const def = {
    nodes: [
      { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { keyword: 'цена', matchType: 'contains' } },
      { id: 'm', type: 'send_message', position: { x: 1, y: 0 }, data: { text: 'Прайс' } },
    ],
    edges: [{ id: 'e', source: 't', target: 'm' }],
  };
  const flowRes = await request(app).post(`/api/bots/${botA.id}/flows`).set(auth(A)).send({ definition: def });
  const flow = flowRes.body.flow;
  check('POST /api/bots/:id/flows', flowRes.status === 201 && flow?.version === 1, `HTTP ${flowRes.status}`);

  check('черновик без definition -> 400',
    (await request(app).post(`/api/bots/${botA.id}/flows`).set(auth(A)).send({})).status === 400);

  // Черновик намеренно принимает неполный граф (канвас редактируется по шагам);
  // инвариант обязан держаться на публикации.
  const badDraft = await request(app).post(`/api/bots/${botA.id}/flows`).set(auth(A))
    .send({ definition: { nodes: [], edges: [] } });
  const pubBad = await request(app).post(`/api/flows/${badDraft.body.flow.id}/versions/1/publish`).set(auth(A)).send({});
  check('публикация флоу без триггер-ноды -> 422', pubBad.status === 422, `HTTP ${pubBad.status}`);

  const dangDraft = await request(app).post(`/api/bots/${botA.id}/flows`).set(auth(A))
    .send({ definition: { nodes: def.nodes, edges: [{ id: 'x', source: 't', target: 'НЕТ-ТАКОЙ' }] } });
  const pubDang = await request(app).post(`/api/flows/${dangDraft.body.flow.id}/versions/1/publish`).set(auth(A)).send({});
  check('публикация флоу с висячим ребром -> 422', pubDang.status === 422, `HTTP ${pubDang.status}`);

  const pub = await request(app).post(`/api/flows/${flow.id}/versions/${flow.version}/publish`).set(auth(A)).send({});
  check('POST publish', pub.status === 200, `HTTP ${pub.status}`);

  const getVer = await request(app).get(`/api/flows/${flow.id}/versions/${flow.version}`).set(auth(A));
  check('GET /api/flows/:id/versions/:v', getVer.status === 200 && !!getVer.body.flow?.definition, `HTTP ${getVer.status}`);
  check('версия флоу чужого тенанта -> 404',
    (await request(app).get(`/api/flows/${flow.id}/versions/${flow.version}`).set(auth(B))).status === 404);

  const v2 = await request(app).post(`/api/flows/${flow.id}/versions`).set(auth(A)).send({ definition: def });
  check('POST новая версия флоу', v2.status === 201 && v2.body.flow?.version === 2, `version=${v2.body.flow?.version}`);

  const trigRes = await request(app).post(`/api/bots/${botA.id}/triggers`).set(auth(A))
    .send({ flowId: flow.id, flowVersion: 1, keyword: 'цена', matchType: 'contains' });
  check('POST /api/bots/:id/triggers', trigRes.status === 201, `HTTP ${trigRes.status}`);
  const trigger = trigRes.body.trigger;

  const dupTrig = await request(app).post(`/api/bots/${botA.id}/triggers`).set(auth(A))
    .send({ flowId: flow.id, flowVersion: 1, keyword: 'ЦЕНА', matchType: 'contains' });
  check('дубль ключевого слова (регистр) отклонён', dupTrig.status >= 400, `HTTP ${dupTrig.status}`);

  check('/test без externalUserId -> 400',
    (await request(app).post(`/api/bots/${botA.id}/test`).set(auth(A)).send({ messageText: 'цена?' })).status === 400);
  const test = await request(app).post(`/api/bots/${botA.id}/test`).set(auth(A)).send({ externalUserId: 'tester', messageText: 'цена?' });
  check('POST /api/bots/:id/test (тест-режим)', test.status === 200 && test.body.outcome?.status === 'completed', `${test.body.outcome?.status}`);

  const dash = await request(app).get(`/api/bots/${botA.id}/dashboard`).set(auth(A));
  check('GET /api/bots/:id/dashboard', dash.status === 200 && typeof dash.body.subscriberCount === 'number', `HTTP ${dash.status}`);
  check('тест-режим не пишет в БД', dash.body.subscriberCount === 0, `subscriberCount=${dash.body.subscriberCount}`);


  // ------------------------------------------------------------------
  group('4. CRM (Модуль 2)');
  await request(app).post(`/api/bots/${botA.id}/simulate-incoming`).set(auth(A))
    .send({ externalUserId: 'buyer-1', messageText: 'цена?' });
  const subs = await request(app).get(`/api/bots/${botA.id}/subscribers`).set(auth(A));
  check('GET /api/bots/:id/subscribers', subs.status === 200 && subs.body.subscribers.length === 1, `${subs.body.subscribers?.length} шт`);
  const sub = subs.body.subscribers[0];

  check('GET /api/subscribers/:id', (await request(app).get(`/api/subscribers/${sub.id}`).set(auth(A))).status === 200);
  check('GET /api/subscribers/:id чужого тенанта -> 404',
    (await request(app).get(`/api/subscribers/${sub.id}`).set(auth(B))).status === 404);

  const lead = await request(app).patch(`/api/subscribers/${sub.id}/lead-status`).set(auth(A)).send({ leadStatus: 'client' });
  check('PATCH lead-status', lead.status === 200, `HTTP ${lead.status}`);
  check('PATCH lead-status невалидное значение -> 400',
    (await request(app).patch(`/api/subscribers/${sub.id}/lead-status`).set(auth(A)).send({ leadStatus: 'админ' })).status === 400);

  const msgs = await request(app).get(`/api/subscribers/${sub.id}/messages`).set(auth(A));
  check('GET /api/subscribers/:id/messages', msgs.status === 200 && msgs.body.messages.length > 0, `${msgs.body.messages?.length} шт`);

  const note = await request(app).post(`/api/subscribers/${sub.id}/notes`).set(auth(A)).send({ body: 'важный лид' });
  check('POST /api/subscribers/:id/notes', note.status === 201, `HTTP ${note.status}`);
  check('GET /api/subscribers/:id/notes', (await request(app).get(`/api/subscribers/${sub.id}/notes`).set(auth(A))).body.notes.length === 1);

  const tag = await request(app).post(`/api/subscribers/${sub.id}/tags`).set(auth(A)).send({ name: 'горячий' });
  check('POST /api/subscribers/:id/tags', tag.status === 201 && !!tag.body.tag?.id, `HTTP ${tag.status}`);
  check('GET /api/bots/:id/tags', (await request(app).get(`/api/bots/${botA.id}/tags`).set(auth(A))).body.tags.length === 1);
  check('DELETE тега у подписчика',
    (await request(app).delete(`/api/subscribers/${sub.id}/tags/${tag.body.tag.id}`).set(auth(A))).status === 204);
  check('фильтр ?tag= работает',
    (await request(app).get(`/api/bots/${botA.id}/subscribers?tag=нет-такого`).set(auth(A))).body.subscribers.length === 0);
  check('фильтр ?leadStatus= работает',
    (await request(app).get(`/api/bots/${botA.id}/subscribers?leadStatus=client`).set(auth(A))).body.subscribers.length === 1);

  // ------------------------------------------------------------------
  group('5. Анализ рилсов (Модуль 3)');
  const an = await request(app).post('/api/reel-analyses').set(auth(A)).send({ sourceUrl: 'https://instagram.com/reel/xyz' });
  check('POST /api/reel-analyses', an.status === 201 && !!an.body.analysis?.id, `HTTP ${an.status}`);
  check('POST /api/reel-analyses без url -> 400',
    (await request(app).post('/api/reel-analyses').set(auth(A)).send({})).status === 400);
  check('GET /api/reel-analyses', (await request(app).get('/api/reel-analyses').set(auth(A))).body.analyses.length === 1);
  check('GET /api/reel-analyses/:id', (await request(app).get(`/api/reel-analyses/${an.body.analysis.id}`).set(auth(A))).status === 200);
  check('GET /api/reel-analyses/:id чужого -> 404',
    (await request(app).get(`/api/reel-analyses/${an.body.analysis.id}`).set(auth(B))).status === 404);
  const script = await request(app).post(`/api/reel-analyses/${an.body.analysis.id}/scripts`).set(auth(A)).send({ niche: 'нутрициология' });
  check('POST сценарий по анализу', script.status === 201, `HTTP ${script.status}`);
  check('GET сценарии анализа', (await request(app).get(`/api/reel-analyses/${an.body.analysis.id}/scripts`).set(auth(A))).body.scripts.length === 1);
  check('GET /api/scripts?niche=', (await request(app).get('/api/scripts?niche=нутрициология').set(auth(A))).body.scripts.length === 1);
  check('GET /api/scripts чужого тенанта пуст', (await request(app).get('/api/scripts?niche=нутрициология').set(auth(B))).body.scripts.length === 0);

  // ------------------------------------------------------------------
  group('6. Карусели (Модуль 4)');
  const preset = await request(app).post('/api/brand-presets').set(auth(A)).send({ name: 'Бренд', primaryColor: '#ff0000' });
  check('POST /api/brand-presets', preset.status === 201, `HTTP ${preset.status}`);
  check('GET /api/brand-presets', (await request(app).get('/api/brand-presets').set(auth(A))).body.presets.length === 1);
  const car = await request(app).post('/api/carousels').set(auth(A)).send({ prompt: '5 ошибок в питании', presetId: preset.body.preset.id });
  check('POST /api/carousels', car.status === 201 && car.body.slides?.length >= 4, `${car.body.slides?.length} слайдов`);
  check('POST /api/carousels без prompt -> 400', (await request(app).post('/api/carousels').set(auth(A)).send({})).status === 400);
  check('POST /api/carousels с чужим presetId -> 404',
    (await request(app).post('/api/carousels').set(auth(B)).send({ prompt: 'x', presetId: preset.body.preset.id })).status === 404);
  check('GET /api/carousels', (await request(app).get('/api/carousels').set(auth(A))).body.carousels.length === 1);
  const carFull = await request(app).get(`/api/carousels/${car.body.carousel.id}`).set(auth(A));
  check('GET /api/carousels/:id', carFull.status === 200 && carFull.body.slides.length > 0, `HTTP ${carFull.status}`);
  const slide = carFull.body.slides[0];
  const patched = await request(app).patch(`/api/carousels/${car.body.carousel.id}/slides/${slide.id}`).set(auth(A)).send({ headline: 'Новый заголовок' });
  check('PATCH слайда', patched.status === 200 && patched.body.slide.headline === 'Новый заголовок', `HTTP ${patched.status}`);
  check('PATCH слайда чужого тенанта -> 404',
    (await request(app).patch(`/api/carousels/${car.body.carousel.id}/slides/${slide.id}`).set(auth(B)).send({ headline: 'взлом' })).status === 404);

  // ------------------------------------------------------------------
  group('7. Автопостинг (Модуль 5)');
  const futureIso = new Date(Date.now() + 3600_000).toISOString();
  const pastIso = new Date(Date.now() - 3600_000).toISOString();
  const sp = await request(app).post('/api/scheduled-posts').set(auth(A)).send({ platform: 'instagram', caption: 'пост', scheduledAt: futureIso });
  check('POST /api/scheduled-posts', sp.status === 201, `HTTP ${sp.status}`);
  check('неизвестная платформа -> 400',
    (await request(app).post('/api/scheduled-posts').set(auth(A)).send({ platform: 'вконтакте', caption: 'x', scheduledAt: futureIso })).status === 400);
  check('невалидная дата -> 400',
    (await request(app).post('/api/scheduled-posts').set(auth(A)).send({ platform: 'instagram', caption: 'x', scheduledAt: 'завтра' })).status === 400);
  check('GET /api/scheduled-posts', (await request(app).get('/api/scheduled-posts').set(auth(A))).body.posts.length >= 1);
  check('GET /api/scheduled-posts/:id', (await request(app).get(`/api/scheduled-posts/${sp.body.post.id}`).set(auth(A))).status === 200);
  check('GET /api/scheduled-posts/:id чужого -> 404',
    (await request(app).get(`/api/scheduled-posts/${sp.body.post.id}`).set(auth(B))).status === 404);

  const needsApproval = await request(app).post('/api/scheduled-posts').set(auth(A))
    .send({ platform: 'tiktok', caption: 'на согласование', scheduledAt: pastIso, requiresApproval: true });
  check('пост со статусом pending_approval', needsApproval.body.post.status === 'pending_approval', needsApproval.body.post?.status);
  const appr = await request(app).post(`/api/scheduled-posts/${needsApproval.body.post.id}/approve`).set(auth(A)).send({});
  check('POST approve', appr.status === 200 && appr.body.post.status === 'scheduled', `HTTP ${appr.status}`);
  check('повторный approve -> 422', (await request(app).post(`/api/scheduled-posts/${needsApproval.body.post.id}/approve`).set(auth(A)).send({})).status === 422);

  const toReject = await request(app).post('/api/scheduled-posts').set(auth(A))
    .send({ platform: 'youtube_shorts', caption: 'отклонить', scheduledAt: futureIso, requiresApproval: true });
  check('POST reject', (await request(app).post(`/api/scheduled-posts/${toReject.body.post.id}/reject`).set(auth(A)).send({})).status === 200);

  const due = await request(app).post('/api/scheduled-posts/process-due').set(auth(A)).send({});
  check('POST process-due публикует свои due-посты', due.body.processed >= 1, `processed=${due.body.processed}`);

  // ------------------------------------------------------------------
  group('8. Контент-план (Модуль 6) и видео (Модуль 8)');
  const rec = await request(app).get('/api/content-recommendations').set(auth(A));
  check('GET /api/content-recommendations', rec.status === 200 && Array.isArray(rec.body.recommendations), `${rec.body.recommendations?.length} шт`);
  check('фильтр ?segment= не падает', (await request(app).get('/api/content-recommendations?segment=клиент').set(auth(A))).status === 200);

  const job = await request(app).post('/api/video-edit-jobs').set(auth(A)).send({ sourceVideoUrl: 'https://x/v.mp4', template: 'auto_crop_916' });
  check('POST /api/video-edit-jobs', job.status === 201 && job.body.job.progress_percent === 0, `HTTP ${job.status}`);
  check('неизвестный шаблон -> 400',
    (await request(app).post('/api/video-edit-jobs').set(auth(A)).send({ sourceVideoUrl: 'https://x/v.mp4', template: 'level_3' })).status === 400);
  check('GET /api/video-edit-jobs', (await request(app).get('/api/video-edit-jobs').set(auth(A))).body.jobs.length === 1);
  check('GET /api/video-edit-jobs/:id', (await request(app).get(`/api/video-edit-jobs/${job.body.job.id}`).set(auth(A))).status === 200);
  check('GET /api/video-edit-jobs/:id чужого -> 404',
    (await request(app).get(`/api/video-edit-jobs/${job.body.job.id}`).set(auth(B))).status === 404);
  const tick = await request(app).post('/api/video-edit-jobs/process-tick').set(auth(A)).send({});
  check('POST process-tick двигает свою задачу', tick.body.advanced === 1, `advanced=${tick.body.advanced}`);

  // ------------------------------------------------------------------
  group('9. Push и уведомления');
  const vapid = await request(app).get('/api/push/vapid-public-key').set(auth(A));
  check('GET /api/push/vapid-public-key', vapid.status === 200 && !!vapid.body.publicKey, `HTTP ${vapid.status}`);
  const psub = await request(app).post('/api/push/subscribe').set(auth(A))
    .send({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } });
  check('POST /api/push/subscribe', psub.status === 201, `HTTP ${psub.status}`);
  check('повторная подписка тем же endpoint (upsert)',
    (await request(app).post('/api/push/subscribe').set(auth(A)).send({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p2', auth: 'a2' } })).status === 201);
  check('subscribe без ключей -> 400', (await request(app).post('/api/push/subscribe').set(auth(A)).send({ endpoint: 'x' })).status === 400);
  check('POST /api/push/unsubscribe',
    (await request(app).post('/api/push/unsubscribe').set(auth(A)).send({ endpoint: 'https://push.example/abc' })).status === 200);

  const notifs = await request(app).get('/api/notifications').set(auth(A));
  check('GET /api/notifications', notifs.status === 200 && notifs.body.notifications.length > 0, `${notifs.body.notifications?.length} шт`);
  check('GET /api/notifications чужого тенанта пуст', (await request(app).get('/api/notifications').set(auth(B))).body.notifications.length === 0);
  check('POST /api/notifications/:id/read',
    (await request(app).post(`/api/notifications/${notifs.body.notifications[0].id}/read`).set(auth(A)).send({})).status === 200);
  check('POST /api/notifications/read-all', (await request(app).post('/api/notifications/read-all').set(auth(A)).send({})).status === 200);
  check('после read-all непрочитанных нет',
    (await request(app).get('/api/notifications?unreadOnly=true').set(auth(A))).body.notifications.length === 0);

  // ------------------------------------------------------------------
  group('10. Удаление персональных данных');
  const delRes = await request(app).delete(`/api/subscribers/${sub.id}`).set(auth(A));
  check('DELETE /api/subscribers/:id', delRes.status === 204, `HTTP ${delRes.status}`);
  check('после удаления контакт недоступен', (await request(app).get(`/api/subscribers/${sub.id}`).set(auth(A))).status === 404);
  check('повторное удаление -> 404', (await request(app).delete(`/api/subscribers/${sub.id}`).set(auth(A))).status === 404);

  console.log(JSON.stringify(rows, null, 0));
  await dropTestDb(db);
}

main().then(() => {
  const fails = rows.filter((r) => !r.ok);
  let last = '';
  for (const r of rows) {
    if (r.group !== last) { console.log(`\n── ${r.group}`); last = r.group; }
    console.log(`  ${r.ok ? '✓' : '✗ ПРОБЛЕМА'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
  }
  console.log(`\nИтого: ${rows.length - fails.length}/${rows.length} ок, проблем: ${fails.length}`);
  process.exit(0);
}).catch((e) => { console.error(e); process.exit(1); });
