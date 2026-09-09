import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Db } from '../src/db';
import { createApp } from '../src/api';
import { createTestDb, dropTestDb } from './dbTestHelper';
import { signSession } from '../src/auth';
import { queryOne } from '../src/db';

describe('auth', () => {
  let app: Express;
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    app = createApp(db);
  });

  afterEach(async () => {
    if (db) await dropTestDb(db);
  });

  describe('signup', () => {
    it('creates a tenant + user and returns a usable session', async () => {
      const res = await request(app).post('/api/auth/signup').send({ email: 'new@example.com', password: 'correct-horse' });

      expect(res.status).toBe(201);
      expect(res.body.user.email).toBe('new@example.com');
      expect(res.body.tenant.id).toBeTruthy();
      expect(res.body.sessionToken).toBeTruthy();
      // The session must actually work, not just be present in the response.
      expect(res.body.user.password_hash).toBeUndefined();

      const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.sessionToken}`);
      expect(me.status).toBe(200);
      expect(me.body.user.email).toBe('new@example.com');
      expect(me.body.tenant.id).toBe(res.body.tenant.id);
    });

    it('rejects a duplicate email', async () => {
      await request(app).post('/api/auth/signup').send({ email: 'dup@example.com', password: 'correct-horse' });
      const second = await request(app).post('/api/auth/signup').send({ email: 'dup@example.com', password: 'another-password' });

      expect(second.status).toBe(409);
      expect(second.body.error).toBe('email_taken');
    });

    it('rejects a malformed email', async () => {
      const res = await request(app).post('/api/auth/signup').send({ email: 'not-an-email', password: 'correct-horse' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_email');
    });

    it('rejects a too-short password', async () => {
      const res = await request(app).post('/api/auth/signup').send({ email: 'short@example.com', password: 'abc' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_password');
    });

    it('stores a bcrypt hash, not the plaintext password', async () => {
      await request(app).post('/api/auth/signup').send({ email: 'hash@example.com', password: 'correct-horse' });
      const row = await queryOne<{ password_hash: string }>(db, `SELECT password_hash FROM users WHERE email = ?`, 'hash@example.com');

      expect(row?.password_hash).toBeTruthy();
      expect(row?.password_hash).not.toBe('correct-horse');
      expect(row?.password_hash).toMatch(/^\$2[aby]\$/); // bcrypt's own hash format prefix
    });
  });

  describe('login', () => {
    async function signup(email: string, password: string) {
      const res = await request(app).post('/api/auth/signup').send({ email, password });
      return res.body as { user: { id: string }; tenant: { id: string }; sessionToken: string };
    }

    it('logs in with correct credentials', async () => {
      await signup('login@example.com', 'correct-horse');
      const res = await request(app).post('/api/auth/login').send({ email: 'login@example.com', password: 'correct-horse' });

      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe('login@example.com');
      expect(res.body.sessionToken).toBeTruthy();
    });

    it('rejects an incorrect password with a generic error', async () => {
      await signup('wrongpw@example.com', 'correct-horse');
      const res = await request(app).post('/api/auth/login').send({ email: 'wrongpw@example.com', password: 'totally-wrong' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_credentials');
    });

    it('rejects a nonexistent email with the same generic error (no user enumeration)', async () => {
      const res = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'whatever123' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_credentials');
    });
  });

  describe('session-protected routes', () => {
    it('rejects a request with no session token', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('missing_session');
    });

    it('rejects a garbage/tampered token', async () => {
      const res = await request(app).get('/api/auth/me').set('Authorization', 'Bearer not-a-real-jwt');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_session');
    });

    it('rejects an expired session with a distinct error', async () => {
      const signupRes = await request(app).post('/api/auth/signup').send({ email: 'expiring@example.com', password: 'correct-horse' });
      const expiredToken = signSession({ userId: signupRes.body.user.id, tenantId: signupRes.body.tenant.id }, -1);

      const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${expiredToken}`);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('session_expired');
    });
  });
});
