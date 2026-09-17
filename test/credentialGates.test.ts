// Two routes hand out a credential without requiring one. These assert they
// stay shut on a public address, and — the part worth testing carefully —
// that they fail CLOSED when nobody configured them, which is the state a
// half-finished deploy is actually in.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/api';
import {
  evaluateGate,
  gateStartupWarnings,
  signupAvailability,
  signupDecision,
  ADMIN_SECRET_HEADER,
} from '../src/credentialGates';
import { queryOne, type Db } from '../src/db';
import { createTestDb, dropTestDb } from './dbTestHelper';

describe('evaluateGate', () => {
  const secret = 'correct-horse-battery-staple';

  it('lets a matching secret through', () => {
    expect(evaluateGate({ isProduction: true, configuredSecret: secret, providedSecret: secret }))
      .toEqual({ allowed: true });
  });

  it('refuses a wrong secret, a missing one, and a non-string', () => {
    for (const provided of ['wrong', '', undefined, null, 42, { toString: () => secret }]) {
      expect(evaluateGate({ isProduction: true, configuredSecret: secret, providedSecret: provided }))
        .toEqual({ allowed: false, reason: 'bad_secret' });
    }
  });

  it('enforces a configured secret in development too', () => {
    // Otherwise the check would first run for real in production, which is
    // the worst place to discover a mistake in it.
    expect(evaluateGate({ isProduction: false, configuredSecret: secret, providedSecret: 'wrong' }))
      .toEqual({ allowed: false, reason: 'bad_secret' });
  });

  it('is open in development when nothing is configured', () => {
    expect(evaluateGate({ isProduction: false, configuredSecret: null, providedSecret: undefined }))
      .toEqual({ allowed: true });
  });

  it('is CLOSED in production when nothing is configured', () => {
    // The whole point. An unset variable is an oversight far more often than
    // it is a decision to let the internet in.
    expect(evaluateGate({ isProduction: true, configuredSecret: null, providedSecret: undefined }))
      .toEqual({ allowed: false, reason: 'not_configured' });
    expect(evaluateGate({ isProduction: true, configuredSecret: null, providedSecret: 'anything' }))
      .toEqual({ allowed: false, reason: 'not_configured' });
  });

  it('treats an empty string as unset', () => {
    // `KEY=` in an env file is a blank, not a secret that happens to be ''.
    expect(evaluateGate({ isProduction: true, configuredSecret: '', providedSecret: '' }))
      .toEqual({ allowed: false, reason: 'not_configured' });
  });
});

describe('signupDecision', () => {
  const base = { isProduction: true, configuredSecret: null, providedSecret: undefined };

  it('lets anyone in when the mode is explicitly open', () => {
    expect(signupDecision({ ...base, signupMode: 'open' })).toEqual({ allowed: true });
  });

  it('open beats a configured code', () => {
    // Both set is contradictory, and 'open' is the one someone typed on
    // purpose — the code may simply be left over from a previous round.
    expect(signupDecision({ ...base, configuredSecret: 'code', signupMode: 'open' }))
      .toEqual({ allowed: true });
  });

  it('only the exact word opens it', () => {
    // 'true', 'yes' and 'OPEN' are guesses at an interface, and a guess that
    // silently opened registration is the failure this mode exists to avoid.
    for (const mode of ['true', 'yes', 'OPEN', 'open ', '1', undefined]) {
      expect(signupDecision({ ...base, signupMode: mode }))
        .toEqual({ allowed: false, reason: 'not_configured' });
    }
  });
});

describe('signupAvailability', () => {
  it('reports what a visitor can actually do', () => {
    const prod = { isProduction: true };
    expect(signupAvailability({ ...prod, configuredSecret: null, signupMode: 'open' })).toBe('open');
    expect(signupAvailability({ ...prod, configuredSecret: 'code', signupMode: undefined })).toBe('invite');
    expect(signupAvailability({ ...prod, configuredSecret: null, signupMode: undefined })).toBe('closed');
    // Development with nothing configured is open, matching evaluateGate.
    expect(signupAvailability({ isProduction: false, configuredSecret: null, signupMode: undefined })).toBe('open');
  });
});

describe('gateStartupWarnings', () => {
  it('says nothing outside production', () => {
    expect(gateStartupWarnings({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toEqual([]);
  });

  it('names each unset gate in production', () => {
    const warnings = gateStartupWarnings({ NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    expect(warnings).toHaveLength(2);
    expect(warnings.join(' ')).toContain('ADMIN_BOOTSTRAP_SECRET');
    expect(warnings.join(' ')).toContain('SIGNUP_INVITE_CODE');
  });

  it('announces open signup rather than staying silent about it', () => {
    const warnings = gateStartupWarnings({
      NODE_ENV: 'production',
      ADMIN_BOOTSTRAP_SECRET: 's',
      SIGNUP_MODE: 'open',
    } as NodeJS.ProcessEnv);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('anyone may register');
  });

  it('stays quiet about the gates that are configured', () => {
    const warnings = gateStartupWarnings({
      NODE_ENV: 'production',
      ADMIN_BOOTSTRAP_SECRET: 's',
      SIGNUP_INVITE_CODE: 'c',
    } as NodeJS.ProcessEnv);
    expect(warnings).toEqual([]);
  });
});

describe('the credential-minting routes in production', () => {
  let db: Db;
  let saved: NodeJS.ProcessEnv;

  beforeEach(async () => {
    db = await createTestDb();
    saved = { ...process.env };
    process.env.NODE_ENV = 'production';
    // createApp refuses cross-origin requests without this in production, and
    // it is unrelated to what these tests are about.
    process.env.CORS_ORIGIN = 'https://example.test';
    delete process.env.ADMIN_BOOTSTRAP_SECRET;
    delete process.env.SIGNUP_INVITE_CODE;
    delete process.env.SIGNUP_MODE;
  });

  afterEach(async () => {
    process.env = saved;
    if (db) await dropTestDb(db);
  });

  describe('POST /api/tenants', () => {
    it('is not there at all when no bootstrap secret is configured', async () => {
      const app: Express = createApp(db);
      const res = await request(app).post('/api/tenants').send({ name: 'x', email: 'x@example.com' });

      // 404, not 403: there is no reason to confirm that a route handing out
      // tenant API keys exists at this address.
      expect(res.status).toBe(404);
      expect(res.body.apiKey).toBeUndefined();

      const tenant = await queryOne(db, `SELECT id FROM tenants WHERE email = ?`, 'x@example.com');
      expect(tenant).toBeUndefined();
    });

    it('answers a wrong secret with 401 and creates nothing', async () => {
      process.env.ADMIN_BOOTSTRAP_SECRET = 'the-real-one';
      const app: Express = createApp(db);

      const res = await request(app)
        .post('/api/tenants')
        .set(ADMIN_SECRET_HEADER, 'not-the-real-one')
        .send({ name: 'x', email: 'x@example.com' });

      expect(res.status).toBe(401);
      expect(await queryOne(db, `SELECT id FROM tenants WHERE email = ?`, 'x@example.com')).toBeUndefined();
    });

    it('still issues a key to a caller holding the secret', async () => {
      process.env.ADMIN_BOOTSTRAP_SECRET = 'the-real-one';
      const app: Express = createApp(db);

      const res = await request(app)
        .post('/api/tenants')
        .set(ADMIN_SECRET_HEADER, 'the-real-one')
        .send({ name: 'x', email: 'x@example.com' });

      expect(res.status).toBe(201);
      expect(typeof res.body.apiKey).toBe('string');
      expect(res.body.apiKey.length).toBeGreaterThan(20);
    });
  });

  describe('POST /api/auth/signup', () => {
    const credentials = { email: 'blogger@example.com', password: 'longenoughpassword' };

    it('is closed when no invite code is configured', async () => {
      const app: Express = createApp(db);
      const res = await request(app).post('/api/auth/signup').send(credentials);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('signup_closed');
      expect(await queryOne(db, `SELECT id FROM users WHERE email = ?`, credentials.email)).toBeUndefined();
    });

    it('refuses a wrong invite code', async () => {
      process.env.SIGNUP_INVITE_CODE = 'sonar-2026';
      const app: Express = createApp(db);

      const res = await request(app).post('/api/auth/signup').send({ ...credentials, inviteCode: 'guess' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('invalid_invite_code');
      expect(await queryOne(db, `SELECT id FROM users WHERE email = ?`, credentials.email)).toBeUndefined();
    });

    it('registers an invited user', async () => {
      process.env.SIGNUP_INVITE_CODE = 'sonar-2026';
      const app: Express = createApp(db);

      const res = await request(app).post('/api/auth/signup').send({ ...credentials, inviteCode: 'sonar-2026' });
      expect(res.status).toBe(201);
      expect(res.body.user.email).toBe(credentials.email);
    });

    it('registers anyone when SIGNUP_MODE=open', async () => {
      process.env.SIGNUP_MODE = 'open';
      const app: Express = createApp(db);

      const res = await request(app).post('/api/auth/signup').send(credentials);
      expect(res.status).toBe(201);
      expect(res.body.user.email).toBe(credentials.email);
    });

    it('tells the signup form which of the three states it is in', async () => {
      const closed: Express = createApp(db);
      expect((await request(closed).get('/api/auth/signup-config')).body).toEqual({ signup: 'closed' });

      process.env.SIGNUP_INVITE_CODE = 'sonar-2026';
      const invite: Express = createApp(db);
      expect((await request(invite).get('/api/auth/signup-config')).body).toEqual({ signup: 'invite' });

      process.env.SIGNUP_MODE = 'open';
      const open: Express = createApp(db);
      expect((await request(open).get('/api/auth/signup-config')).body).toEqual({ signup: 'open' });
    });

    it('does not reveal a registered email to someone without the code', async () => {
      process.env.SIGNUP_INVITE_CODE = 'sonar-2026';
      const app: Express = createApp(db);
      await request(app).post('/api/auth/signup').send({ ...credentials, inviteCode: 'sonar-2026' });

      // Signing up again with the SAME email but no code must not answer
      // 'email_taken' — that would turn signup into an oracle for which
      // addresses hold accounts, which is exactly what the login route
      // already goes out of its way not to leak.
      const probe = await request(app).post('/api/auth/signup').send(credentials);
      expect(probe.status).toBe(403);
      expect(probe.body.error).toBe('invalid_invite_code');

      // The same answer for an address nobody has registered. Identical
      // replies are the property that matters — 'email_taken' here would
      // have made signup an oracle.
      const unknown = await request(app)
        .post('/api/auth/signup')
        .send({ email: 'nobody@example.com', password: credentials.password });
      expect(unknown.status).toBe(probe.status);
      expect(unknown.body.error).toBe(probe.body.error);
    });
  });
});
