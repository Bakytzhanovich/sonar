import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { Db } from '../src/db';
import { createApp } from '../src/api';
import { createTestDb, dropTestDb } from './dbTestHelper';
import {
  ACTIVE_GRACE_MS,
  heartbeatKey,
  localSignalStore,
  readHeartbeat,
  ringWorker,
  SAFETY_INTERVAL_MS,
  shouldCheckDatabase,
  WORK_SIGNAL_KEY,
  writeHeartbeat,
  type SignalStore,
} from '../src/workerSignal';
import { SMART_CUT_WORKER } from '../src/workerHealth';

function memoryStore(): SignalStore & { data: Map<string, string>; writes: string[] } {
  const data = new Map<string, string>();
  const writes: string[] = [];
  return {
    data,
    writes,
    async read(key) {
      return data.get(key) ?? null;
    },
    async write(key, body) {
      writes.push(key);
      data.set(key, body);
    },
  };
}

describe('shouldCheckDatabase', () => {
  const now = 10 * SAFETY_INTERVAL_MS;
  it('goes to the database when rung, while busy, and on the safety timer — and otherwise leaves it asleep', () => {
    expect(shouldCheckDatabase({ rung: true, lastWorkAt: 0, lastCheckAt: now }, now)).toBe(true);
    expect(shouldCheckDatabase({ rung: false, lastWorkAt: now - ACTIVE_GRACE_MS + 1, lastCheckAt: now }, now)).toBe(true);
    expect(shouldCheckDatabase({ rung: false, lastWorkAt: 0, lastCheckAt: now - SAFETY_INTERVAL_MS }, now)).toBe(true);
    expect(shouldCheckDatabase({ rung: false, lastWorkAt: now - ACTIVE_GRACE_MS, lastCheckAt: now - 60_000 }, now)).toBe(false);
  });
});

describe('signal store', () => {
  it('rings with a new value every time, even twice in the same moment', async () => {
    const store = memoryStore();
    const at = new Date('2026-10-19T12:00:00Z');
    await ringWorker(store, at);
    const first = await store.read(WORK_SIGNAL_KEY);
    await ringWorker(store, at);
    expect(await store.read(WORK_SIGNAL_KEY)).not.toBe(first);
  });

  it('reads back the pulse it wrote, and nothing when there is none', async () => {
    const store = memoryStore();
    expect(await readHeartbeat(store, SMART_CUT_WORKER)).toBeNull();
    const at = new Date('2026-10-19T12:00:00Z');
    await writeHeartbeat(store, SMART_CUT_WORKER, at);
    expect((await readHeartbeat(store, SMART_CUT_WORKER))?.toISOString()).toBe(at.toISOString());
    store.data.set(heartbeatKey(SMART_CUT_WORKER), 'garbage');
    expect(await readHeartbeat(store, SMART_CUT_WORKER)).toBeNull();
  });

  it('keeps signals as files in the local media folder in development', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonar-signal-'));
    try {
      const store = localSignalStore({ root, publicBaseUrl: 'http://localhost', secret: 'x' } as never);
      expect(await store.read(WORK_SIGNAL_KEY)).toBeNull();
      await ringWorker(store);
      expect(await store.read(WORK_SIGNAL_KEY)).toMatch(/^\d{4}-/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('the API rings the worker', () => {
  let app: Express;
  let db: Db;
  let store: ReturnType<typeof memoryStore>;
  let auth: { Authorization: string };

  beforeEach(async () => {
    db = await createTestDb();
    store = memoryStore();
    app = createApp(db, { signals: store, paidAccess: false });
    const tenant = await request(app).post('/api/tenants').send({ name: 'T', email: 'ring@example.com' });
    auth = { Authorization: `Bearer ${tenant.body.apiKey}` };
  });

  afterEach(async () => {
    if (db) await dropTestDb(db);
  });

  const rings = () => store.writes.filter((k) => k === WORK_SIGNAL_KEY).length;
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it('after work is queued, and not on a read or a refused request', async () => {
    const tenantId = (await db.query(`SELECT id FROM tenants WHERE email = 'ring@example.com'`)).rows[0].id as string;
    await request(app).get('/api/video-edit-jobs').set(auth);
    await request(app).post('/api/video-edit-jobs').set(auth).send({ template: 'nope' });
    await settle();
    expect(rings()).toBe(0);

    const created = await request(app)
      .post('/api/video-edit-jobs')
      .set(auth)
      .send({ template: 'ai_smart_cut', sourceObjectKey: `tenants/${tenantId}/sources/a.mp4` });
    expect(created.status).toBe(201);
    await settle();
    expect(rings()).toBe(1);
  });

  it('reports the worker online from the pulse in the store', async () => {
    const before = await request(app).get('/api/video-edit-jobs').set(auth);
    expect(before.body.worker_online).toBe(false);
    await writeHeartbeat(store, SMART_CUT_WORKER);
    // A fresh app: the answer is cached for a few seconds.
    const fresh = createApp(db, { signals: store, paidAccess: false });
    const after = await request(fresh).get('/api/video-edit-jobs').set(auth);
    expect(after.body.worker_online).toBe(true);
  });
});
