import { createHash, createHmac } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// S3-compatible object storage (Cloudflare R2 by default, plain S3 or MinIO
// work unchanged) for the one thing the rest of this backend never touches:
// actual video bytes.
//
// Presigning is implemented here rather than via @aws-sdk/* on purpose. The
// SDK pulls in ~40 packages to produce a signature that is 60 lines of
// documented HMAC, and this codebase already prefers a small explicit helper
// to a dependency (see forEachBounded in publisher.ts). A presigner with no
// network in it is also directly unit-testable, which the storage tests use
// to pin down the parts that fail silently in production — encoding,
// tenant-prefix isolation, and what is and isn't covered by the signature.
//
// Path-style addressing ({endpoint}/{bucket}/{key}) is used throughout — R2
// requires it, and S3 still supports it.

const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export interface StorageConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  // Optional public base URL (an R2 custom domain, a CDN). When set, a
  // completed render can be handed to the client as a permanent link instead
  // of a presigned one that expires.
  publicBaseUrl?: string;
}

export class StorageNotConfiguredError extends Error {
  constructor() {
    super('storage_not_configured');
    this.name = 'StorageNotConfiguredError';
  }
}

export function storageConfigFromEnv(): StorageConfig | null {
  const endpoint = process.env.STORAGE_ENDPOINT;
  const bucket = process.env.STORAGE_BUCKET;
  const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;

  return {
    endpoint: endpoint.replace(/\/+$/, ''),
    bucket,
    // R2 ignores the region but still requires a syntactically valid one in
    // the credential scope; 'auto' is what Cloudflare documents.
    region: process.env.STORAGE_REGION ?? 'auto',
    accessKeyId,
    secretAccessKey,
    publicBaseUrl: process.env.STORAGE_PUBLIC_BASE_URL?.replace(/\/+$/, ''),
  };
}

// encodeURIComponent leaves !'()* unescaped; SigV4 requires RFC 3986, and a
// key containing any of them signs correctly but fails verification.
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeKeyPath(key: string): string {
  return key.split('/').map(encodeRfc3986).join('/');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf-8').digest();
}

function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service), 'aws4_request');
}

// '2026-09-14T10:04:05.123Z' -> '20260914T100405Z'
function amzDate(now: Date): string {
  return now.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
}

export interface PresignOptions {
  method: 'GET' | 'PUT';
  key: string;
  expiresInSec?: number;
  contentType?: string;
  now?: Date;
}

export function presign(config: StorageConfig, options: PresignOptions): string {
  const { method, key, expiresInSec = 900, now = new Date() } = options;
  const url = new URL(`${config.endpoint}/${config.bucket}/${encodeKeyPath(key)}`);
  const stamp = amzDate(now);
  const dateStamp = stamp.slice(0, 8);
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;

  // Content-Type is signed as a header (not a query param) when present, so
  // the browser's PUT must send exactly the same value — an upload with a
  // different type is rejected by the storage, which is the point: it stops a
  // presigned video URL being reused to host arbitrary content.
  const signedHeaders = options.contentType ? 'content-type;host' : 'host';
  const canonicalHeaders = options.contentType
    ? `content-type:${options.contentType}\nhost:${url.host}\n`
    : `host:${url.host}\n`;

  const query = new URLSearchParams({
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${config.accessKeyId}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(expiresInSec),
    'X-Amz-SignedHeaders': signedHeaders,
  });

  // SigV4 requires the canonical query string sorted by key, with both key
  // and value RFC 3986 encoded. URLSearchParams.sort() plus manual encoding
  // (its own toString uses form encoding, where a space becomes '+') gets
  // there; using toString() directly produces a signature that silently
  // mismatches for any key with a space in it.
  const canonicalQuery = [...query.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .join('&');

  const canonicalRequest = [
    method,
    `/${config.bucket}/${encodeKeyPath(key)}`,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const stringToSign = [ALGORITHM, stamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(config.secretAccessKey, dateStamp, config.region, 's3'), stringToSign).toString('hex');

  return `${url.origin}/${config.bucket}/${encodeKeyPath(key)}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// How long a link to a finished render stays valid.
//
// A day, not the week this used to be. The link is the whole authorisation:
// anyone holding it watches a client's video, and these get forwarded — into
// chats, into email, into places neither we nor the client control. A week of
// validity means a link pasted somewhere careless stays live for a week.
//
// A day is long enough to download a render you were told about, and the job
// can be re-signed on demand for anything older.
const RENDER_URL_TTL_SEC = 24 * 3600;

export function publicUrlFor(config: StorageConfig, key: string): string {
  // Set only if the bucket is deliberately public — then the object is
  // readable by anyone who guesses the key, with no signature and no expiry.
  if (config.publicBaseUrl) return `${config.publicBaseUrl}/${encodeKeyPath(key)}`;
  return presign(config, { method: 'GET', key, expiresInSec: RENDER_URL_TTL_SEC });
}

export async function downloadToFile(config: StorageConfig, key: string, destPath: string): Promise<void> {
  const response = await fetch(presign(config, { method: 'GET', key }));
  if (!response.ok || !response.body) throw new Error(`storage GET failed with ${response.status}`);
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(destPath));
}

export async function uploadFile(config: StorageConfig, key: string, sourcePath: string, contentType: string): Promise<void> {
  // Read into memory rather than streaming: undici requires duplex:'half' for
  // a streaming body and, more importantly, refuses a stream body without a
  // known length, which S3 needs. Rendered reels are tens of megabytes, which
  // the worker can hold; if output sizes ever grow past that this is the
  // place that switches to multipart upload.
  const body = await fs.readFile(sourcePath);
  const response = await fetch(presign(config, { method: 'PUT', key, contentType }), {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body,
  });
  if (!response.ok) throw new Error(`storage PUT failed with ${response.status}`);
}
