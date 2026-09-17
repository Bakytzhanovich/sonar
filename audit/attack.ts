// Батарея атак. Запуск: SESSION_SECRET=... npx tsx audit/attack.ts
import request from 'supertest';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/api';
import { createTestDb, dropTestDb } from '../test/dbTestHelper';
import { queryAll, type Db } from '../src/db';

type Row = { group: string; name: string; ok: boolean; detail: string };
const rows: Row[] = [];
let GROUP = '';
const group = (g: string) => { GROUP = g; };
const check = (name: string, ok: boolean, detail = '') => { rows.push({ group: GROUP, name, ok, detail }); };

let app: Express; let db: Db;
const auth = (k: string) => ({ Authorization: `Bearer ${k}` });
async function tenant(email: string) {
  return (await request(app).post('/api/tenants').send({ name: email, email })).body.apiKey as string;
}

async function main() {
  db = await createTestDb();
  app = createApp(db);
  const A = await tenant('a@atk.test');
  await tenant('b@atk.test');
  const bot = (await request(app).post('/api/bots').set(auth(A)).send({ name: 'B', externalAccountId: 'acc' })).body.bot;

  group('A. Обход аутентификации');
  const protectedRoutes: [string, string][] = [
    ['get', '/api/bots'], ['post', '/api/bots'], ['get', '/api/reel-analyses'],
    ['post', '/api/reel-analyses'], ['get', '/api/carousels'], ['post', '/api/carousels'],
    ['get', '/api/brand-presets'], ['get', '/api/scheduled-posts'], ['post', '/api/scheduled-posts'],
    ['post', '/api/scheduled-posts/process-due'], ['get', '/api/content-recommendations'],
    ['get', '/api/video-edit-jobs'], ['post', '/api/video-edit-jobs'],
    ['post', '/api/video-edit-jobs/process-tick'], ['get', '/api/notifications'],
    ['post', '/api/notifications/read-all'], ['get', '/api/push/vapid-public-key'],
    ['post', '/api/push/subscribe'], ['get', '/api/scripts'],
    ['get', `/api/bots/${bot.id}/dashboard`], ['get', `/api/bots/${bot.id}/subscribers`],
    ['post', `/api/bots/${bot.id}/test`], ['post', `/api/bots/${bot.id}/simulate-incoming`],
    ['post', `/api/bots/${bot.id}/flows`], ['post', '/api/onboarding/demo-workspace'],
  ];
  const unguarded: string[] = [];
  for (const [m, path] of protectedRoutes) {
    const res = await (request(app) as any)[m](path).send({});
    if (res.status !== 401) unguarded.push(`${m.toUpperCase()} ${path} -> ${res.status}`);
  }
  check(`все ${protectedRoutes.length} защищённых маршрутов требуют токен`, unguarded.length === 0, unguarded.join('; ') || 'ни одной дыры');
  check('пустой Bearer -> 401', (await request(app).get('/api/bots').set({ Authorization: 'Bearer ' })).status === 401);
  check('мусорный ключ -> 401', (await request(app).get('/api/bots').set(auth('deadbeef'.repeat(8)))).status === 401);
  check('схема Basic вместо Bearer -> 401', (await request(app).get('/api/bots').set({ Authorization: 'Basic YWRtaW46YWRtaW4=' })).status === 401);

  group('B. Атаки на JWT');
  const secret = process.env.SESSION_SECRET!;
  const signup = await request(app).post('/api/auth/signup').send({ email: 'jwt@atk.test', password: 'password123' });
  const realJwt = signup.body.sessionToken as string;
  const decoded = jwt.decode(realJwt) as any;

  const algNone = jwt.sign({ userId: decoded.userId, tenantId: decoded.tenantId }, '', { algorithm: 'none' } as any);
  check('alg=none (подделка без подписи) -> 401', (await request(app).get('/api/bots').set(auth(algNone))).status === 401);
  const wrongSecret = jwt.sign({ userId: decoded.userId, tenantId: decoded.tenantId }, 'ne-tot-sekret');
  check('подпись чужим секретом -> 401', (await request(app).get('/api/bots').set(auth(wrongSecret))).status === 401);
  check('испорченная подпись -> 401', (await request(app).get('/api/bots').set(auth(realJwt.slice(0, -3) + 'AAA'))).status === 401);
  const expired = jwt.sign({ userId: decoded.userId, tenantId: decoded.tenantId }, secret, { expiresIn: -3600 });
  check('просроченный токен -> 401', (await request(app).get('/api/bots').set(auth(expired))).status === 401);
  const forgedTenant = jwt.sign({ userId: decoded.userId, tenantId: 'podstavnoy-tenant' }, secret);
  check('валидная подпись, несуществующий тенант -> 401', (await request(app).get('/api/bots').set(auth(forgedTenant))).status === 401);
  const victimTenant = (await queryAll<any>(db, `SELECT id FROM tenants WHERE id <> ? LIMIT 1`, decoded.tenantId))[0].id;
  const swapped = jwt.sign({ userId: decoded.userId, tenantId: victimTenant }, secret);
  const sw = await request(app).get('/api/bots').set(auth(swapped));
  check('подмена tenantId на ЧУЖОЙ существующий -> 401', sw.status === 401, `HTTP ${sw.status}`);

  group('C. SQL-инъекции');
  const sqlPayloads = [
    "' OR '1'='1", "'; DROP TABLE subscribers; --", "1' UNION SELECT * FROM api_keys --",
    "admin'--", "' OR 1=1--",
  ];
  const sqlProblems: string[] = [];
  for (const p of sqlPayloads) {
    const inPath = await request(app).get(`/api/subscribers/${encodeURIComponent(p)}`).set(auth(A));
    if (inPath.status >= 500) sqlProblems.push(`path:${p} -> ${inPath.status}`);
    const inQuery = await request(app).get(`/api/bots/${bot.id}/subscribers?tag=${encodeURIComponent(p)}`).set(auth(A));
    if (inQuery.status >= 500) sqlProblems.push(`query:${p} -> ${inQuery.status}`);
    const inBody = await request(app).post('/api/reel-analyses').set(auth(A)).send({ sourceUrl: p });
    if (inBody.status >= 500) sqlProblems.push(`body:${p} -> ${inBody.status}`);
  }
  check(`SQL-инъекции (${sqlPayloads.length} payload x 3 точки) без 5xx`, sqlProblems.length === 0, sqlProblems.join('; ') || 'все отбиты');
  check('таблицы целы после DROP TABLE payload', Array.isArray(await queryAll(db, `SELECT 1 FROM subscribers LIMIT 1`)), 'схема на месте');
  check('SQL-инъекция вместо API-ключа -> 401', (await request(app).get('/api/bots').set(auth("' OR '1'='1"))).status === 401);

  group('D. Загрязнение прототипа и mass assignment');
  const proto = await request(app).post('/api/reel-analyses').set(auth(A))
    .send(JSON.parse('{"sourceUrl":"https://x/1","__proto__":{"admin":true}}'));
  check('__proto__ в теле не ломает запрос', proto.status < 500, `HTTP ${proto.status}`);
  check('прототип Object не загрязнён', ({} as any).admin === undefined, `admin=${({} as any).admin}`);
  const massAssign = await request(app).post('/api/reel-analyses').set(auth(A))
    .send({ sourceUrl: 'https://x/2', tenant_id: 'chuzhoy-tenant', id: 'poddelannyy-id' });
  check('tenant_id из тела игнорируется', massAssign.body.analysis?.tenant_id !== 'chuzhoy-tenant', `tenant_id=${massAssign.body.analysis?.tenant_id}`);
  check('id из тела игнорируется', massAssign.body.analysis?.id !== 'poddelannyy-id', `id=${massAssign.body.analysis?.id}`);
  const postMass = await request(app).post('/api/scheduled-posts').set(auth(A))
    .send({ platform: 'instagram', caption: 'x', scheduledAt: new Date(Date.now() + 3600000).toISOString(), status: 'published', tenant_id: 'chuzhoy' });
  check('status из тела игнорируется', postMass.body.post?.status === 'scheduled', `status=${postMass.body.post?.status}`);
  const jobMass = await request(app).post('/api/video-edit-jobs').set(auth(A))
    .send({ sourceVideoUrl: 'https://x/v.mp4', template: 'auto_crop_916', progress_percent: 100, status: 'completed' });
  check('progress/status задачи не подделываются', jobMass.body.job?.progress_percent === 0 && jobMass.body.job?.status === 'processing',
    `${jobMass.body.job?.status}/${jobMass.body.job?.progress_percent}%`);

  group('E. Путаница типов и мусорный ввод');
  const typeConfusion: [string, unknown][] = [
    ['массив вместо строки', ['a', 'b']], ['объект вместо строки', { $ne: null }],
    ['число вместо строки', 12345], ['null', null], ['true', true],
  ];
  const typeProblems: string[] = [];
  for (const [label, value] of typeConfusion) {
    const r = await request(app).post('/api/reel-analyses').set(auth(A)).send({ sourceUrl: value });
    if (r.status >= 500) typeProblems.push(`analyses ${label} -> ${r.status}`);
    const r2 = await request(app).post('/api/auth/login').send({ email: value, password: value });
    if (r2.status >= 500) typeProblems.push(`login ${label} -> ${r2.status}`);
    const r3 = await request(app).post(`/api/subscribers/${bot.id}/tags`).set(auth(A)).send({ name: value });
    if (r3.status >= 500) typeProblems.push(`tags ${label} -> ${r3.status}`);
  }
  check('путаница типов не даёт 5xx', typeProblems.length === 0, typeProblems.join('; ') || 'все обработаны');
  const NUL = String.fromCharCode(0);
  const nullByte = await request(app).post('/api/reel-analyses').set(auth(A)).send({ sourceUrl: 'https://x/' + NUL + 'evil' });
  check('null-байт в строке не даёт 5xx', nullByte.status < 500, `HTTP ${nullByte.status}`);
  const longStr = await request(app).post('/api/reel-analyses').set(auth(A)).send({ sourceUrl: 'https://x/' + 'a'.repeat(50000) });
  check('строка 50КБ не даёт 5xx', longStr.status < 500, `HTTP ${longStr.status}`);
  const huge = await request(app).post('/api/reel-analyses').set(auth(A)).send({ sourceUrl: 'https://x', pad: 'x'.repeat(2 * 1024 * 1024) });
  check('тело 2МБ отклонено лимитом express.json', huge.status === 413, `HTTP ${huge.status}`);

  group('F. Параметры пути и чисел');
  const versionAbuse = ['-1', '0', '999999999999999999999', 'NaN', 'Infinity', '1e400'];
  const verProblems: string[] = [];
  for (const v of versionAbuse) {
    const r = await request(app).get(`/api/flows/${bot.id}/versions/${encodeURIComponent(v)}`).set(auth(A));
    if (r.status >= 500) verProblems.push(`${v} -> ${r.status}`);
  }
  check('аномальные номера версий без 5xx', verProblems.length === 0, verProblems.join('; ') || 'все обработаны');
  check('обход пути в :id -> 404, не 5xx',
    (await request(app).get(`/api/subscribers/${encodeURIComponent('../../../etc/passwd')}`).set(auth(A))).status === 404);
  check('очень длинный :id не даёт 5xx',
    (await request(app).get(`/api/subscribers/${'a'.repeat(5000)}`).set(auth(A))).status < 500);

  group('G. Хранимый XSS: формат ответа');
  const xss = '<script>alert(document.cookie)</script>';
  await request(app).post(`/api/bots/${bot.id}/simulate-incoming`).set(auth(A)).send({ externalUserId: xss, messageText: xss });
  const subsList = await request(app).get(`/api/bots/${bot.id}/subscribers`).set(auth(A));
  check('Content-Type строго application/json', /application\/json/.test(subsList.headers['content-type'] ?? ''), subsList.headers['content-type']);
  check('nosniff присутствует', subsList.headers['x-content-type-options'] === 'nosniff', subsList.headers['x-content-type-options']);
  check('payload хранится как данные', JSON.stringify(subsList.body).includes('script'), 'дословно; экранирование - задача фронта');

  console.log('%%SPLIT%%');
  await dropTestDb(db);
}

main().then(() => {
  const fails = rows.filter((r) => !r.ok);
  let last = '';
  for (const r of rows) {
    if (r.group !== last) { console.log(`\n-- ${r.group}`); last = r.group; }
    console.log(`  ${r.ok ? 'OK      ' : 'ПРОБЛЕМА'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
  }
  console.log(`\nИтого: ${rows.length - fails.length}/${rows.length} ок, проблем: ${fails.length}`);
  process.exit(0);
}).catch((e) => { console.error('СТЕНД УПАЛ:', e); process.exit(1); });
