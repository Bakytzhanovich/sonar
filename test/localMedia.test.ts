import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { isSafeKey, resolveKeyPath, signLocalUrl, verifyLocalUrl, type LocalMediaConfig } from '../src/localMedia';

const config: LocalMediaConfig = {
  root: path.resolve('/tmp/sonar-media'),
  publicBaseUrl: 'http://localhost:4001',
  secret: 'test-secret',
};

const now = new Date('2026-09-14T12:00:00Z');
const later = new Date('2026-09-14T13:00:00Z');

function parts(url: string) {
  const parsed = new URL(url);
  return { exp: parsed.searchParams.get('exp'), token: parsed.searchParams.get('token'), path: parsed.pathname };
}

describe('object key safety', () => {
  it.each(['tenants/t1/sources/a.mp4', 'tenants/t1/renders/b-c_d.mp4'])('accepts %s', (key) => {
    expect(isSafeKey(key)).toBe(true);
  });

  it.each([
    ['traversal', '../../etc/passwd'],
    ['traversal mid-path', 'tenants/t1/../../../etc/passwd'],
    ['absolute', '/etc/passwd'],
    ['backslash', 'tenants\\t1\\a.mp4'],
    ['empty segment', 'tenants//a.mp4'],
    ['empty', ''],
  ])('rejects %s', (_label, key) => {
    expect(isSafeKey(key)).toBe(false);
    // The key reaches this function straight from a URL, so a rejection has to
    // be a throw, not a sanitised path that still resolves somewhere.
    expect(() => resolveKeyPath(config, key)).toThrow();
  });

  it('keeps a resolved path inside the media root', () => {
    expect(resolveKeyPath(config, 'tenants/t1/a.mp4')).toBe(path.join(config.root, 'tenants/t1/a.mp4'));
  });
});

describe('signed local URLs', () => {
  it('round-trips a valid token', () => {
    const url = signLocalUrl(config, 'GET', 'tenants/t1/a.mp4', 900, now);
    const { exp, token } = parts(url);
    expect(verifyLocalUrl(config, 'GET', 'tenants/t1/a.mp4', exp, token, now)).toBe(true);
  });

  it('rejects a token issued for a different method', () => {
    // A link handed out so a browser can PLAY a render must not be replayable
    // to OVERWRITE it.
    const url = signLocalUrl(config, 'GET', 'tenants/t1/a.mp4', 900, now);
    const { exp, token } = parts(url);
    expect(verifyLocalUrl(config, 'PUT', 'tenants/t1/a.mp4', exp, token, now)).toBe(false);
  });

  it('rejects a token issued for a different key', () => {
    const url = signLocalUrl(config, 'GET', 'tenants/t1/a.mp4', 900, now);
    const { exp, token } = parts(url);
    expect(verifyLocalUrl(config, 'GET', 'tenants/other/secret.mp4', exp, token, now)).toBe(false);
  });

  it('rejects an expired token', () => {
    const url = signLocalUrl(config, 'GET', 'tenants/t1/a.mp4', 900, now);
    const { exp, token } = parts(url);
    expect(verifyLocalUrl(config, 'GET', 'tenants/t1/a.mp4', exp, token, later)).toBe(false);
  });

  it('rejects a tampered expiry', () => {
    const url = signLocalUrl(config, 'GET', 'tenants/t1/a.mp4', 900, now);
    const { token } = parts(url);
    const extended = Math.floor(later.getTime() / 1000) + 900;
    expect(verifyLocalUrl(config, 'GET', 'tenants/t1/a.mp4', extended, token, now)).toBe(false);
  });

  it('rejects a token signed with another secret', () => {
    const url = signLocalUrl({ ...config, secret: 'other' }, 'GET', 'tenants/t1/a.mp4', 900, now);
    const { exp, token } = parts(url);
    expect(verifyLocalUrl(config, 'GET', 'tenants/t1/a.mp4', exp, token, now)).toBe(false);
  });

  it.each([['not hex', 'zz'], ['wrong length', 'abcd'], ['missing', undefined]])('rejects a malformed token (%s)', (_l, token) => {
    // timingSafeEqual throws on a length mismatch, so the shape check has to
    // come first or a malformed token becomes a 500 instead of a 403.
    expect(verifyLocalUrl(config, 'GET', 'tenants/t1/a.mp4', 99999999999, token, now)).toBe(false);
  });

  it('percent-encodes the key in the URL path', () => {
    const url = signLocalUrl(config, 'GET', 'tenants/t1/my file.mp4', 900, now);
    expect(parts(url).path).toBe('/api/media/tenants/t1/my%20file.mp4');
  });
});
