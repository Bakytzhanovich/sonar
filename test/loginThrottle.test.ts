import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/api';
import { exec, queryOne, type Db } from '../src/db';
import {
  isLocked,
  LOCK_DURATION_MS,
  MAX_FAILED_ATTEMPTS,
  nextFailureState,
  secondsUntilUnlock,
} from '../src/loginThrottle';
import { createTestDb, dropTestDb } from './dbTestHelper';

const NOW = new Date('2026-09-17T12:00:00Z');

describe('throttle state', () => {
  it('does not lock before the threshold', () => {
    const state = nextFailureState({ failed_logins: MAX_FAILED_ATTEMPTS - 2, locked_until: null }, NOW);
    expect(state.lockedUntil).toBeNull();
  });

  it('locks on the threshold attempt', () => {
    const state = nextFailureState({ failed_logins: MAX_FAILED_ATTEMPTS - 1, locked_until: null }, NOW);
    expect(state.failedLogins).toBe(MAX_FAILED_ATTEMPTS);
    expect(state.lockedUntil?.getTime()).toBe(NOW.getTime() + LOCK_DURATION_MS);
  });

  it('keeps counting past the threshold, as a record of the attack', () => {
    const state = nextFailureState({ failed_logins: 12, locked_until: null }, NOW);
    expect(state.failedLogins).toBe(13);
  });

  it('treats an elapsed lock as no lock', () => {
    const past = new Date(NOW.getTime() - 1000).toISOString();
    expect(isLocked({ failed_logins: 9, locked_until: past }, NOW)).toBe(false);
    expect(secondsUntilUnlock({ failed_logins: 9, locked_until: past }, NOW)).toBe(0);
  });

  it('reports the wait while locked', () => {
    const future = new Date(NOW.getTime() + 90_000).toISOString();
    expect(isLocked({ failed_logins: 5, locked_until: future }, NOW)).toBe(true);
    expect(secondsUntilUnlock({ failed_logins: 5, locked_until: future }, NOW)).toBe(90);
  });
});

describe('POST /api/auth/login throttling', () => {
  let db: Db;
  let app: Express;
  const email = 'throttle@example.com';
  const password = 'correct-horse-battery';

  beforeEach(async () => {
    db = await createTestDb();
    app = createApp(db);
    await request(app).post('/api/auth/signup').send({ email, password });
  });
  afterEach(async () => { await dropTestDb(db); });

  async function failOnce() {
    return request(app).post('/api/auth/login').send({ email, password: 'wrong' });
  }

  it('locks the account after consecutive failures, regardless of source', async () => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      const res = await failOnce();
      expect(res.status).toBe(401);
    }

    // The IP limiter is not what stopped this — the account itself is.
    const locked = await failOnce();
    expect(locked.status).toBe(429);
    expect(locked.body.error).toBe('account_locked');
    expect(locked.body.retryAfterSec).toBeGreaterThan(0);
  });

  it('refuses the CORRECT password while locked, without saying it was correct', async () => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await failOnce();

    // Otherwise the lock becomes an oracle: "locked" for the right password
    // and "invalid" for the wrong one would leak the answer.
    const res = await request(app).post('/api/auth/login').send({ email, password });
    expect(res.status).toBe(429);
    expect(res.body.sessionToken).toBeUndefined();
  });

  it('clears the lock once it expires and the password is right', async () => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await failOnce();
    // Move the expiry into the past, as the clock would.
    await exec(db, `UPDATE users SET locked_until = now() - interval '1 minute' WHERE email = ?`, email);

    const res = await request(app).post('/api/auth/login').send({ email, password });
    expect(res.status).toBe(200);

    // The owner is delayed, not shut out: signing in resets the budget, so
    // an attacker cannot keep someone locked out by failing on purpose.
    const row = await queryOne<{ failed_logins: number; locked_until: string | null }>(
      db,
      `SELECT failed_logins, locked_until FROM users WHERE email = ?`,
      email
    );
    expect(row?.failed_logins).toBe(0);
    expect(row?.locked_until).toBeNull();
  });

  it('forgets earlier failures after a success', async () => {
    await failOnce();
    await failOnce();
    await request(app).post('/api/auth/login').send({ email, password }).expect(200);

    const row = await queryOne<{ failed_logins: number }>(db, `SELECT failed_logins FROM users WHERE email = ?`, email);
    // A person mistyping twice a week must never accumulate their way into a
    // lock.
    expect(row?.failed_logins).toBe(0);
  });

  it('records nothing for an unknown email', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'x' });
    expect(res.status).toBe(401);

    // No row is created: there is no account to protect, and writing one per
    // guessed address would let an attacker fill the table.
    const rows = await queryOne<{ n: string }>(db, `SELECT count(*) AS n FROM users WHERE email = ?`, 'nobody@example.com');
    expect(Number(rows?.n)).toBe(0);
  });
});
