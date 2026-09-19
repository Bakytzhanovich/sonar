import { describe, it, expect, afterEach } from 'vitest';
import { downloadUrlFor, presign, publicUrlFor, storageConfigFromEnv, type StorageConfig } from '../src/storage';

const config: StorageConfig = {
  endpoint: 'https://account.r2.cloudflarestorage.com',
  bucket: 'sonar-video',
  region: 'auto',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

const now = new Date('2026-09-14T10:04:05.123Z');

function signatureOf(url: string): string {
  return new URL(url).searchParams.get('X-Amz-Signature') ?? '';
}

describe('presign', () => {
  it('produces a path-style URL carrying every parameter SigV4 requires', () => {
    const url = new URL(presign(config, { method: 'GET', key: 'tenants/t1/renders/job.mp4', now }));

    expect(url.pathname).toBe('/sonar-video/tenants/t1/renders/job.mp4');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    // Credential scope is date/region/service/aws4_request — a mismatch here
    // is the single most common cause of an opaque 403 from S3.
    expect(url.searchParams.get('X-Amz-Credential')).toBe('AKIAIOSFODNN7EXAMPLE/20260914/auto/s3/aws4_request');
    expect(url.searchParams.get('X-Amz-Date')).toBe('20260914T100405Z');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same request and instant', () => {
    const a = presign(config, { method: 'GET', key: 'a/b.mp4', now });
    const b = presign(config, { method: 'GET', key: 'a/b.mp4', now });
    expect(a).toBe(b);
  });

  it.each([
    ['a different key', { key: 'a/other.mp4' }],
    ['a different method', { method: 'PUT' as const }],
    ['a different expiry', { expiresInSec: 60 }],
  ])('covers %s in the signature', (_label, override) => {
    const base = presign(config, { method: 'GET', key: 'a/b.mp4', expiresInSec: 900, now });
    const changed = presign(config, { method: 'GET', key: 'a/b.mp4', expiresInSec: 900, now, ...override });
    expect(signatureOf(changed)).not.toBe(signatureOf(base));
  });

  it('signs content-type only when one is given, and covers its value', () => {
    const withoutType = new URL(presign(config, { method: 'PUT', key: 'a/b.mp4', now }));
    const mp4 = new URL(presign(config, { method: 'PUT', key: 'a/b.mp4', contentType: 'video/mp4', now }));
    const webm = new URL(presign(config, { method: 'PUT', key: 'a/b.mp4', contentType: 'video/webm', now }));

    expect(withoutType.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(mp4.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
    // This is what stops a presigned "video" upload URL being reused to put
    // arbitrary content in our bucket.
    expect(signatureOf(mp4.toString())).not.toBe(signatureOf(webm.toString()));
  });

  it('encodes keys per RFC 3986 while keeping the path separators', () => {
    const url = presign(config, { method: 'GET', key: "tenants/t1/sources/my clip (1).mp4", now });

    expect(url).toContain('/tenants/t1/sources/my%20clip%20%281%29.mp4');
    // A form-encoded space ('+') here signs one string and requests another,
    // which S3 rejects as a signature mismatch.
    expect(url).not.toContain('+');
  });

  it('changes with the secret, so a rotated key invalidates old URLs', () => {
    const rotated = { ...config, secretAccessKey: 'another-secret' };
    expect(signatureOf(presign(rotated, { method: 'GET', key: 'a/b.mp4', now })))
      .not.toBe(signatureOf(presign(config, { method: 'GET', key: 'a/b.mp4', now })));
  });
});

describe('publicUrlFor', () => {
  it('uses the public domain when one is configured, with no credentials in the URL', () => {
    const url = publicUrlFor({ ...config, publicBaseUrl: 'https://cdn.sonar.kz' }, 'tenants/t1/renders/job.mp4');
    expect(url).toBe('https://cdn.sonar.kz/tenants/t1/renders/job.mp4');
    expect(url).not.toContain('X-Amz-');
  });

  it('falls back to a presigned GET when no public domain is set', () => {
    const url = publicUrlFor(config, 'tenants/t1/renders/job.mp4');
    expect(url).toContain('X-Amz-Signature=');
  });
});

describe('downloadUrlFor', () => {
  it('asks the storage to send the object as an attachment', () => {
    const url = new URL(downloadUrlFor(config, 'tenants/t1/renders/job.mp4', 'sonar-ab12cd34.mp4'));
    expect(url.searchParams.get('response-content-disposition')).toBe('attachment; filename="sonar-ab12cd34.mp4"');
  });

  it('signs the disposition rather than appending it', () => {
    // The bug this guards: a parameter bolted onto a finished presigned URL is
    // outside the signature, and S3 answers 403 for the whole request.
    const plain = publicUrlFor(config, 'a/b.mp4');
    const download = downloadUrlFor(config, 'a/b.mp4', 'b.mp4');
    expect(signatureOf(download)).not.toBe(signatureOf(plain));
    expect(new URL(download).searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });

  it('refuses a filename that could break out of the header', () => {
    const url = new URL(downloadUrlFor(config, 'a/b.mp4', 'evil"\n; filename="other.exe'));
    expect(url.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="evil____filename__other.exe"'
    );
  });

  it('leaves a public bucket alone, having no signature to carry the header', () => {
    const url = downloadUrlFor({ ...config, publicBaseUrl: 'https://cdn.sonar.kz' }, 'a/b.mp4', 'b.mp4');
    expect(url).toBe('https://cdn.sonar.kz/a/b.mp4');
  });
});

describe('storageConfigFromEnv', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  function setEnv(values: Record<string, string>) {
    Object.assign(process.env, values);
  }

  it('strips the newline a hosting panel adds to a pasted key', () => {
    // The failure this exists for: a trailing newline on the access key went
    // into the SigV4 credential scope, the signed URL carried
    // "...328b978%0A%2F20260918%2F...", and R2 answered 400 — reported by the
    // browser as a CORS error, because an error response carries no CORS
    // headers. Hours in the wrong direction over one invisible byte.
    setEnv({
      STORAGE_ENDPOINT: 'https://acc.r2.cloudflarestorage.com\n',
      STORAGE_BUCKET: ' sonar-media ',
      STORAGE_ACCESS_KEY_ID: '72a762d819afc578cd5c2e1da328b978\n',
      STORAGE_SECRET_ACCESS_KEY: '  secret\r\n',
    });

    const config = storageConfigFromEnv();
    expect(config).not.toBeNull();
    expect(config!.accessKeyId).toBe('72a762d819afc578cd5c2e1da328b978');
    expect(config!.secretAccessKey).toBe('secret');
    expect(config!.bucket).toBe('sonar-media');
    expect(config!.endpoint).toBe('https://acc.r2.cloudflarestorage.com');
  });

  it('signs a URL with no stray characters in the credential', () => {
    setEnv({
      STORAGE_ENDPOINT: 'https://acc.r2.cloudflarestorage.com',
      STORAGE_BUCKET: 'sonar-media',
      STORAGE_ACCESS_KEY_ID: 'KEYID\n',
      STORAGE_SECRET_ACCESS_KEY: 'secret',
    });

    const url = presign(storageConfigFromEnv()!, { method: 'PUT', key: 'a/b.mov', contentType: 'video/quicktime' });
    // %0A is the encoded newline that made the original URL unusable.
    expect(url).not.toContain('%0A');
    expect(url).toContain('X-Amz-Credential=KEYID%2F');
  });

  it('treats a whitespace-only value as unset rather than as a credential', () => {
    setEnv({
      STORAGE_ENDPOINT: 'https://acc.r2.cloudflarestorage.com',
      STORAGE_BUCKET: 'sonar-media',
      STORAGE_ACCESS_KEY_ID: '   ',
      STORAGE_SECRET_ACCESS_KEY: 'secret',
    });
    expect(storageConfigFromEnv()).toBeNull();
  });
});
