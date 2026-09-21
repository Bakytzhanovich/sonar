import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { exec, type Db } from '../src/db';
import { createApp } from '../src/api';
import { createTestDb, dropTestDb } from './dbTestHelper';
import type { Role } from '../src/roles';

// The rules themselves are unit-tested in roles.test.ts. What this file is
// for is the wiring: whether the middleware sees the path it thinks it sees.
//
// It exists because of a bug it would have caught. Express strips the mount
// point from req.path, so a check mounted at '/api' reads '/bots' — and every
// rule, written against '/api/bots', silently matched nothing. Roles would
// have appeared to work (writes still needed a write role) while the
// owner-only and self-scoped lists quietly did nothing at all. No unit test on
// a pure function can see that.

describe('role enforcement over HTTP', () => {
  let app: Express;
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    app = createApp(db);
  });

  afterEach(async () => {
    if (db) await dropTestDb(db);
  });

  async function signUpAs(role: Role, email: string) {
    const res = await request(app).post('/api/auth/signup').send({ email, password: 'correct-horse' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // Signup always makes an owner — it creates the workspace. A weaker role
    // arrives by invitation, which does not exist yet, so it is set directly.
    await exec(db, `UPDATE users SET role = ? WHERE id = ?`, role, res.body.user.id);
    return res.body.sessionToken as string;
  }

  const get = (token: string, path: string) => request(app).get(path).set('Authorization', `Bearer ${token}`);
  const post = (token: string, path: string, body: unknown = {}) =>
    request(app).post(path).set('Authorization', `Bearer ${token}`).send(body);

  it('lets a viewer read', async () => {
    const token = await signUpAs('viewer', 'viewer@example.com');
    expect((await get(token, '/api/bots')).status).toBe(200);
  });

  it('refuses a viewer any write, with the role that was needed', async () => {
    const token = await signUpAs('viewer', 'viewer2@example.com');
    const res = await post(token, '/api/bots', { name: 'Bot', externalAccountId: 'ig-1' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('insufficient_role');
    // Saying which role is needed is the difference between a person
    // understanding the refusal and retrying the same thing.
    expect(res.body.requiredRole).toBe('editor');
    expect(res.body.role).toBe('viewer');
  });

  it('lets an editor write', async () => {
    const token = await signUpAs('editor', 'editor@example.com');
    const res = await post(token, '/api/bots', { name: 'Bot', externalAccountId: 'ig-2' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('lets a viewer mark their own notifications read', async () => {
    // Self-scoped writes: refusing them protects nothing and makes the
    // read-only role feel broken. This is one of the paths that matched
    // nothing while the mount prefix was being stripped.
    const token = await signUpAs('viewer', 'viewer3@example.com');
    expect((await post(token, '/api/notifications/read-all')).status).not.toBe(403);
  });

  it('keeps an editor out of managing people', async () => {
    // The other list that silently did nothing with the wrong path. An editor
    // who can invite can promote themselves.
    const token = await signUpAs('editor', 'editor2@example.com');
    const res = await post(token, '/api/members', { email: 'x@example.com', role: 'editor' });
    expect(res.status).toBe(403);
    expect(res.body.requiredRole).toBe('owner');
  });

  it('still lets an owner do everything', async () => {
    const token = await signUpAs('owner', 'owner@example.com');
    expect((await get(token, '/api/bots')).status).toBe(200);
    expect((await post(token, '/api/bots', { name: 'Bot', externalAccountId: 'ig-3' })).status).toBe(201);
  });

  it('takes a demotion into effect immediately, not when the token expires', async () => {
    // The role is read per request rather than carried in the session. A token
    // lives a week, and a demotion nobody feels for a week is not one.
    const token = await signUpAs('owner', 'demoted@example.com');
    const before = await post(token, '/api/bots', { name: 'Bot', externalAccountId: 'ig-4' });
    expect(before.status).toBe(201);

    await exec(db, `UPDATE users SET role = 'viewer' WHERE email = ?`, 'demoted@example.com');

    const after = await post(token, '/api/bots', { name: 'Bot', externalAccountId: 'ig-5' });
    expect(after.status).toBe(403);
  });

  it('treats an unreadable role in the database as the weakest', async () => {
    // A row written by an older version, or by hand, must not read as more
    // than it is.
    const token = await signUpAs('owner', 'broken@example.com');
    await exec(db, `UPDATE users SET role = 'superadmin' WHERE email = ?`, 'broken@example.com');

    expect((await get(token, '/api/bots')).status).toBe(200);
    expect((await post(token, '/api/bots', { name: 'Bot', externalAccountId: 'ig-6' })).status).toBe(403);
  });

  it('leaves tenant API keys with full rights', async () => {
    // They are the workspace itself, not a person in it, and are issued by a
    // staff-only route — so every existing integration keeps working.
    const created = await request(app).post('/api/tenants').send({ name: 'Blogger', email: 'key@example.com' });
    expect(created.status).toBe(201);
    const apiKey = created.body.apiKey as string;

    const res = await request(app)
      .post('/api/bots')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'Bot', externalAccountId: 'ig-7' });
    expect(res.status).toBe(201);
  });
});
