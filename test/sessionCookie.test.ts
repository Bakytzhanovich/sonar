import { describe, expect, it } from 'vitest';
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  isAllowedOrigin,
  readSessionCookie,
  SESSION_COOKIE,
} from '../src/sessionCookie';
import type { Request } from 'express';

function req(method: string, headers: Record<string, string>): Request {
  return { method, header: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
}

describe('session cookie', () => {
  it('is unreadable by page scripts and not sent cross-site', () => {
    const cookie = buildSessionCookie('tok');
    // These two flags are the entire point: HttpOnly stops a compromised
    // dependency from reading the token, SameSite stops another site from
    // using it.
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain(`${SESSION_COOKIE}=tok`);
  });

  it('expires the cookie on sign-out', () => {
    expect(buildClearedSessionCookie()).toContain('Max-Age=0');
  });

  it('reads its own cookie out of a crowded header', () => {
    expect(readSessionCookie(`other=1; ${SESSION_COOKIE}=abc; third=2`)).toBe('abc');
  });

  it('returns nothing rather than guessing', () => {
    expect(readSessionCookie(undefined)).toBeNull();
    expect(readSessionCookie('other=1')).toBeNull();
    expect(readSessionCookie(`${SESSION_COOKIE}=`)).toBeNull();
  });
});

describe('origin guard', () => {
  const allowed = 'https://app.sonar.kz';

  it('rejects a state-changing request from another site', () => {
    // The CSRF case: a form on evil.example posting to our API.
    expect(isAllowedOrigin(req('POST', { origin: 'https://evil.example' }), allowed)).toBe(false);
  });

  it('allows our own frontend', () => {
    expect(isAllowedOrigin(req('POST', { origin: allowed }), allowed)).toBe(true);
  });

  it('never blocks reads', () => {
    expect(isAllowedOrigin(req('GET', { origin: 'https://evil.example' }), allowed)).toBe(true);
  });

  it('leaves API clients alone', () => {
    // A Bearer header is never attached by a browser on its own, so these
    // requests carry no CSRF risk — and server-to-server callers send no
    // Origin at all.
    expect(isAllowedOrigin(req('POST', { origin: 'https://evil.example', authorization: 'Bearer k' }), allowed)).toBe(true);
    expect(isAllowedOrigin(req('POST', {}), allowed)).toBe(true);
  });
});
