import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import { exec, queryOne, type Db } from '../src/db';
import { createApp } from '../src/api';
import { createTestDb, dropTestDb } from './dbTestHelper';
import { sessionTokenFrom } from './sessionTestHelper';
import { isAdminEmail, normalizePhone, pathAllowed, videoLimit, workspaceState } from '../src/paidAccess';
import { PLANS, TRIAL_VIDEOS, planById } from '../src/plans';

describe('normalizePhone', () => {
  it.each([
    ['+7 701 123 45 67', '+77011234567'],
    ['8 (701) 123-45-67', '+77011234567'],
    ['7011234567', '+77011234567'],
    ['77011234567', '+77011234567'],
  ])('accepts %s as people type it', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  it.each(['', '123', '+998 90 123 45 67', '+7 701 123 45 6', '8 701 123 45 6', 'семь ноль один', null, 42])('refuses %s', (raw) => {
    expect(normalizePhone(raw)).toBeNull();
  });
});

describe('workspaceState', () => {
  const now = new Date('2026-10-17T12:00:00Z');
  it('tells a trial from a paid plan from one that ran out', () => {
    expect(workspaceState({ access_forever: true, access_until: null }, {}, now)).toBe('unlimited');
    expect(workspaceState({ access_forever: false, access_until: null }, { isAdmin: true }, now)).toBe('unlimited');
    expect(workspaceState({ access_forever: false, access_until: null }, { enforced: false }, now)).toBe('unlimited');
    expect(workspaceState({ access_forever: false, access_until: '2026-10-18T00:00:00Z' }, {}, now)).toBe('active');
    expect(workspaceState({ access_forever: false, access_until: '2026-10-17T11:59:59Z' }, {}, now)).toBe('expired');
    expect(workspaceState({ access_forever: false, access_until: null }, {}, now)).toBe('trial');
  });

  it('gives each state its video limit', () => {
    expect(videoLimit('unlimited', null)).toBeNull();
    expect(videoLimit('trial', null)).toBe(TRIAL_VIDEOS);
    expect(videoLimit('expired', planById('pro'))).toBe(0);
    expect(videoLimit('active', planById('start'))).toBe(planById('start')!.videosPerPeriod);
    expect(videoLimit('active', null)).toBeNull();
  });
});

describe('pathAllowed', () => {
  it('lets a trial reach the editor and its own billing, not the rest', () => {
    expect(pathAllowed('trial', '/api/video-edit-jobs')).toBe(true);
    expect(pathAllowed('trial', '/api/video-edit-jobs/abc/revise')).toBe(true);
    expect(pathAllowed('trial', '/api/video-uploads')).toBe(true);
    expect(pathAllowed('trial', '/api/billing')).toBe(true);
    expect(pathAllowed('trial', '/api/carousels')).toBe(false);
    expect(pathAllowed('trial', '/api/billingx')).toBe(false);
  });

  it('leaves an expired plan only billing, the account and admin', () => {
    expect(pathAllowed('expired', '/api/video-edit-jobs')).toBe(false);
    expect(pathAllowed('expired', '/api/billing/requests')).toBe(true);
    expect(pathAllowed('expired', '/api/account')).toBe(true);
    expect(pathAllowed('expired', '/api/admin/overview')).toBe(true);
  });
});

describe('isAdminEmail', () => {
  it('matches the configured list case-insensitively, and nobody when unset', () => {
    expect(isAdminEmail('Owner@Example.com', 'a@x.kz, owner@example.com')).toBe(true);
    expect(isAdminEmail('other@example.com', 'owner@example.com')).toBe(false);
    expect(isAdminEmail('owner@example.com', undefined)).toBe(false);
    expect(isAdminEmail('owner@example.com', '')).toBe(false);
  });
});

describe('paid access over HTTP', () => {
  let app: Express;
  let db: Db;
  const ADMIN = 'owner@sonar.test';

  beforeEach(async () => {
    db = await createTestDb();
    app = createApp(db, { paidAccess: true, adminEmails: ADMIN });
  });

  afterEach(async () => {
    if (db) await dropTestDb(db);
  });

  async function signUp(email: string) {
    const res = await request(app).post('/api/auth/signup').send({ email, password: 'correct-horse', consent: true });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { res, tenantId: res.body.tenant.id as string, auth: { Authorization: `Bearer ${sessionTokenFrom(res)}` } };
  }

  /** A finished new edit, as the worker would leave it. */
  async function addVideo(tenantId: string, opts: { createdAt?: string; status?: string; parent?: string } = {}) {
    const id = randomUUID();
    await exec(
      db,
      `INSERT INTO video_edit_jobs (id, tenant_id, source_video_url, template, pipeline, status, created_at, parent_job_id)
       VALUES (?, ?, 'r2://x', 'ai_smart_cut', 'smart_cut', ?, COALESCE(?::timestamptz, now()), ?)`,
      id,
      tenantId,
      opts.status ?? 'completed',
      opts.createdAt ?? null,
      opts.parent ?? null
    );
    return id;
  }

  /** A real new edit: a key under the workspace's own prefix gets inserted. */
  const newEdit = (auth: object, tenantId: string) =>
    request(app).post('/api/video-edit-jobs').set(auth).send({ template: 'ai_smart_cut', sourceObjectKey: `tenants/${tenantId}/sources/${randomUUID()}.mp4` });

  it('starts a new account on the trial: the editor opens, the rest waits for a plan', async () => {
    const { res, auth } = await signUp('new@example.com');
    expect(res.body.access).toMatchObject({ state: 'trial', active: true });
    expect((await request(app).get('/api/video-edit-jobs').set(auth)).status).toBe(200);
    const carousels = await request(app).get('/api/carousels').set(auth);
    expect(carousels.status).toBe(402);
    expect(carousels.body.error).toBe('payment_required');
  });

  it('allows one free video, then asks for a plan — on the upload ticket too', async () => {
    const { tenantId, auth } = await signUp('trial@example.com');
    expect((await newEdit(auth, tenantId)).status).toBe(201);

    const second = await newEdit(auth, tenantId);
    expect(second.status).toBe(402);
    expect(second.body.error).toBe('video_limit');
    expect(second.body.message).toMatch(/Бесплатный ролик/);

    const ticket = await request(app).post('/api/video-uploads').set(auth).send({ contentType: 'video/mp4', size: 1000, purpose: 'edit' });
    expect(ticket.status).toBe(402);
  });

  it('does not count revisions, previews or failed renders against the limit', async () => {
    const { tenantId, auth } = await signUp('fair@example.com');
    await addVideo(tenantId, { status: 'failed' });
    const parent = await addVideo(tenantId, { status: 'failed' });
    await addVideo(tenantId, { parent });
    expect((await newEdit(auth, tenantId)).status).toBe(201);
  });

  it('takes a plan request with the number, and replaces it when another is chosen', async () => {
    const { tenantId, auth } = await signUp('buyer@example.com');
    const bad = await request(app).post('/api/billing/requests').set(auth).send({ planId: 'start', phone: '123' });
    expect(bad.body.error).toBe('invalid_phone');
    expect((await request(app).post('/api/billing/requests').set(auth).send({ planId: 'gold', phone: '+77011234567' })).body.error).toBe('unknown_plan');

    const first = await request(app).post('/api/billing/requests').set(auth).send({ planId: 'start', phone: '8 701 123 45 67' });
    expect(first.status).toBe(201);
    expect(first.body.pendingRequest).toMatchObject({ planId: 'start', phone: '+77011234567', amountKzt: planById('start')!.priceKzt });

    const second = await request(app).post('/api/billing/requests').set(auth).send({ planId: 'pro', phone: '+77011234567' });
    expect(second.body.pendingRequest.planId).toBe('pro');
    const open = await queryOne<{ n: number }>(db, `SELECT count(*)::int AS n FROM payment_requests WHERE tenant_id = ? AND status = 'pending'`, tenantId);
    expect(open?.n).toBe(1);

    const page = await request(app).get('/api/billing').set(auth);
    expect(page.body.plans.map((p: { id: string }) => p.id)).toEqual(PLANS.map((p) => p.id));
  });

  it('opens the plan when the admin marks the request paid — once, however many presses', async () => {
    const { tenantId, auth } = await signUp('client@example.com');
    const { auth: admin } = await signUp(ADMIN);
    await addVideo(tenantId);
    await request(app).post('/api/billing/requests').set(auth).send({ planId: 'start', phone: '+77011234567' });

    const overview = await request(app).get('/api/admin/overview').set(admin);
    expect(overview.body.requests).toHaveLength(1);
    const req = overview.body.requests[0];
    expect(req).toMatchObject({ email: 'client@example.com', planName: 'Старт', phone: '+77011234567' });

    expect((await request(app).post(`/api/admin/requests/${req.id}/paid`).set(admin)).status).toBe(200);
    expect((await request(app).post(`/api/admin/requests/${req.id}/paid`).set(admin)).status).toBe(409);

    const billing = await request(app).get('/api/billing').set(auth);
    expect(billing.body).toMatchObject({ state: 'active', plan: { id: 'start' }, pendingRequest: null });
    // The free video was before the period: it is not charged to it.
    expect(billing.body.videos).toEqual({ used: 0, limit: planById('start')!.videosPerPeriod });
    expect((await request(app).get('/api/carousels').set(auth)).status).toBe(200);

    const days = (new Date(billing.body.until).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it('holds a paid plan to its limit over the last 30 days', async () => {
    const { tenantId, auth } = await signUp('heavy@example.com');
    await exec(db, `UPDATE tenants SET plan_id = 'start', access_until = now() + interval '20 days' WHERE id = ?`, tenantId);
    const limit = planById('start')!.videosPerPeriod;
    await addVideo(tenantId, { createdAt: new Date(Date.now() - 40 * 86_400_000).toISOString() });
    for (let i = 0; i < limit - 1; i++) await addVideo(tenantId);
    expect((await newEdit(auth, tenantId)).status).toBe(201);

    const over = await newEdit(auth, tenantId);
    expect(over.status).toBe(402);
    expect(over.body.message).toMatch(/«Старт»/);
  });

  it('counts the payment in the overview and writes it to the log', async () => {
    const { auth } = await signUp('payer@example.com');
    const { auth: admin } = await signUp(ADMIN);
    await request(app).post('/api/billing/requests').set(auth).send({ planId: 'pro', phone: '+77011234567' });
    const before = await request(app).get('/api/admin/stats').set(admin);
    expect(before.body.totals).toMatchObject({ revenue: 0, pendingRequests: 1, signups: 2 });
    expect(before.body.daily).toHaveLength(30);

    const reqId = (await request(app).get('/api/admin/overview').set(admin)).body.requests[0].id;
    await request(app).post(`/api/admin/requests/${reqId}/paid`).set(admin);

    const after = await request(app).get('/api/admin/stats').set(admin);
    const pro = planById('pro')!.priceKzt;
    expect(after.body.totals).toMatchObject({ revenue: pro, paying: 1, pendingRequests: 0 });
    expect(after.body.daily.at(-1).revenue).toBe(pro);
    expect(after.body.byPlan.find((p: { planId: string }) => p.planId === 'pro')).toMatchObject({ payments: 1, revenue: pro });

    const log = await request(app).get('/api/admin/actions').set(admin);
    expect(log.body.actions[0]).toMatchObject({ action: 'paid:pro', tenantEmail: 'payer@example.com', adminEmail: ADMIN });

    expect((await request(app).get('/api/admin/stats').set(auth)).status).toBe(404);
  });

  it('starts a fresh count when a lapsed plan is paid again', async () => {
    const { tenantId, auth } = await signUp('again@example.com');
    const { auth: admin } = await signUp(ADMIN);
    await exec(db, `UPDATE tenants SET plan_id = 'start', access_until = now() - interval '1 day', period_started_at = now() - interval '31 days' WHERE id = ?`, tenantId);
    const limit = planById('start')!.videosPerPeriod;
    for (let i = 0; i < limit; i++) await addVideo(tenantId, { createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString() });

    await request(app).post('/api/billing/requests').set(auth).send({ planId: 'start', phone: '+77011234567' });
    const reqId = (await request(app).get('/api/admin/overview').set(admin)).body.requests[0].id;
    await request(app).post(`/api/admin/requests/${reqId}/paid`).set(admin);

    expect((await request(app).get('/api/billing').set(auth)).body.videos.used).toBe(0);
    expect((await newEdit(auth, tenantId)).status).toBe(201);
  });

  it('holds the limit when several edits are sent at once', async () => {
    const { tenantId, auth } = await signUp('racer@example.com');
    const results = await Promise.all([1, 2, 3, 4].map(() => newEdit(auth, tenantId)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 402)).toHaveLength(3);
    const jobs = await queryOne<{ n: number }>(db, `SELECT count(*)::int AS n FROM video_edit_jobs WHERE tenant_id = ?`, tenantId);
    expect(jobs?.n).toBe(1);
  });

  it('keeps one open request however many are sent at once', async () => {
    const { tenantId, auth } = await signUp('double@example.com');
    await Promise.all([1, 2, 3].map(() => request(app).post('/api/billing/requests').set(auth).send({ planId: 'pro', phone: '+77011234567' })));
    const open = await queryOne<{ n: number }>(db, `SELECT count(*)::int AS n FROM payment_requests WHERE tenant_id = ? AND status = 'pending'`, tenantId);
    expect(open?.n).toBe(1);
  });

  it('opens a hand grant on a chosen plan, never without one', async () => {
    const { tenantId, auth } = await signUp('gift@example.com');
    const { auth: admin } = await signUp(ADMIN);
    const bare = await request(app).post(`/api/admin/accounts/${tenantId}/access`).set(admin).send({ days: 30 });
    expect(bare.status).toBe(400);
    expect(bare.body.error).toBe('plan_required');

    expect((await request(app).post(`/api/admin/accounts/${tenantId}/access`).set(admin).send({ days: 30, planId: 'start' })).status).toBe(200);
    const billing = await request(app).get('/api/billing').set(auth);
    expect(billing.body).toMatchObject({ state: 'active', plan: { id: 'start' } });
    expect(billing.body.videos.limit).toBe(planById('start')!.videosPerPeriod);
  });

  it('moves an unlimited workspace that pays for a plan onto that plan', async () => {
    const { tenantId, auth } = await signUp('legacy@example.com');
    const { auth: admin } = await signUp(ADMIN);
    await exec(db, `UPDATE tenants SET access_forever = true WHERE id = ?`, tenantId);
    await request(app).post('/api/billing/requests').set(auth).send({ planId: 'pro', phone: '+77011234567' });
    const reqId = (await request(app).get('/api/admin/overview').set(admin)).body.requests[0].id;
    await request(app).post(`/api/admin/requests/${reqId}/paid`).set(admin);
    expect((await request(app).get('/api/billing').set(auth)).body).toMatchObject({ state: 'active', plan: { id: 'pro' } });
  });

  it('extends from the current end, so paying early does not lose days', async () => {
    const { tenantId } = await signUp('early@example.com');
    const { auth: admin } = await signUp(ADMIN);
    await exec(db, `UPDATE tenants SET plan_id = 'start', access_until = now() + interval '10 days' WHERE id = ?`, tenantId);
    await request(app).post(`/api/admin/accounts/${tenantId}/access`).set(admin).send({ days: 30 });
    const row = await queryOne<{ access_until: string }>(db, `SELECT access_until FROM tenants WHERE id = ?`, tenantId);
    const days = (new Date(row!.access_until).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(39.9);
    expect(days).toBeLessThan(40.1);
  });

  it('closes access as "expired", not as a fresh trial with another free video', async () => {
    const { tenantId, auth } = await signUp('closed@example.com');
    const { auth: admin } = await signUp(ADMIN);
    await exec(db, `UPDATE tenants SET access_forever = true WHERE id = ?`, tenantId);
    await request(app).post(`/api/admin/accounts/${tenantId}/revoke`).set(admin);
    expect((await request(app).get('/api/auth/me').set(auth)).body.access).toMatchObject({ state: 'expired', active: false });
    expect((await request(app).get('/api/video-edit-jobs').set(auth)).status).toBe(402);
    const log = await queryOne<{ n: number }>(db, `SELECT count(*)::int AS n FROM admin_actions WHERE tenant_id = ?`, tenantId);
    expect(log?.n).toBe(1);
  });

  it('refuses a nonsense number of days', async () => {
    const { tenantId } = await signUp('days@example.com');
    const { auth: admin } = await signUp(ADMIN);
    for (const days of [0, -5, 1.5, 9999, 'thirty']) {
      const res = await request(app).post(`/api/admin/accounts/${tenantId}/access`).set(admin).send({ days });
      expect(res.status, String(days)).toBe(400);
    }
  });

  it('hides the admin area from everyone not on the list, including API keys', async () => {
    const { auth } = await signUp('nosy@example.com');
    expect((await request(app).get('/api/admin/overview').set(auth)).status).toBe(404);
    const keyed = await request(app).post('/api/tenants').send({ name: 'Staff', email: ADMIN });
    expect((await request(app).get('/api/admin/overview').set({ Authorization: `Bearer ${keyed.body.apiKey}` })).status).toBe(404);
  });

  it('never makes the admin wait, and marks them in the list', async () => {
    const { res, auth } = await signUp(ADMIN);
    expect(res.body.user.isAdmin).toBe(true);
    expect(res.body.access.state).toBe('unlimited');
    expect((await request(app).get('/api/carousels').set(auth)).status).toBe(200);
    const overview = await request(app).get('/api/admin/overview').set(auth);
    expect(overview.body.accounts.find((a: { email: string }) => a.email === ADMIN)).toMatchObject({ isAdmin: true, state: 'unlimited' });
  });

  it('never gates a staff-created workspace', async () => {
    const keyed = await request(app).post('/api/tenants').send({ name: 'Staff', email: 'staff@example.com' });
    expect((await request(app).get('/api/carousels').set({ Authorization: `Bearer ${keyed.body.apiKey}` })).status).toBe(200);
  });

  it('lets a waiting account delete itself', async () => {
    const { tenantId, auth } = await signUp('leaving@example.com');
    await request(app).post('/api/billing/requests').set(auth).send({ planId: 'pro', phone: '+77011234567' });
    await exec(db, `UPDATE tenants SET access_until = now() - interval '1 day' WHERE id = ?`, tenantId);
    const del = await request(app).delete('/api/account').set(auth).send({ password: 'correct-horse' });
    expect(del.status).toBe(204);
    expect(await queryOne(db, `SELECT id FROM payment_requests WHERE tenant_id = ?`, tenantId)).toBeFalsy();
  });
});

describe('paid access switched off', () => {
  it('lets everything through and says so', async () => {
    const db = await createTestDb();
    try {
      const app = createApp(db, { paidAccess: false });
      const res = await request(app).post('/api/auth/signup').send({ email: 'free@example.com', password: 'correct-horse', consent: true });
      expect(res.body.access).toMatchObject({ state: 'unlimited', active: true });
      expect((await request(app).get('/api/carousels').set({ Authorization: `Bearer ${sessionTokenFrom(res)}` })).status).toBe(200);
    } finally {
      await dropTestDb(db);
    }
  });
});
