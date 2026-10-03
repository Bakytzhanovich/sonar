import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadToFile, SourceTooLargeError, type StorageConfig } from '../src/storage';

// A source larger than the worker will take must never reach its disk: a
// multi-gigabyte upload filled it and stopped every edit queued behind it.

describe('downloading a source', () => {
  let server: http.Server;
  let config: StorageConfig;
  let dir: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const body = Buffer.alloc(5000, 1);
      if (req.url?.includes('declared')) {
        res.writeHead(200, { 'content-length': String(body.length) });
        res.end(body);
      } else {
        // No length: the size only shows as the bytes arrive.
        res.writeHead(200, { 'transfer-encoding': 'chunked' });
        for (let i = 0; i < 5; i++) res.write(body.subarray(i * 1000, (i + 1) * 1000));
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    config = { endpoint: `http://127.0.0.1:${port}`, bucket: 'b', region: 'auto', accessKeyId: 'k', secretAccessKey: 's' };
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sonar-cap-'));
  });
  afterAll(async () => {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('refuses a source whose declared size is over the limit, without writing it', async () => {
    const dest = path.join(dir, 'declared.mp4');
    await expect(downloadToFile(config, 'declared.mp4', dest, 2000)).rejects.toBeInstanceOf(SourceTooLargeError);
    await expect(fs.stat(dest)).rejects.toThrow();
  });

  it('stops a stream that turns out too large, and removes what it wrote', async () => {
    const dest = path.join(dir, 'streamed.mp4');
    await expect(downloadToFile(config, 'streamed.mp4', dest, 2000)).rejects.toBeInstanceOf(SourceTooLargeError);
    await expect(fs.stat(dest)).rejects.toThrow();
  });

  it('downloads a source within the limit', async () => {
    const dest = path.join(dir, 'ok.mp4');
    await downloadToFile(config, 'streamed.mp4', dest, 10_000);
    expect((await fs.stat(dest)).size).toBe(5000);
  });
});

import request from 'supertest';
import { createApp } from '../src/api';
import { createTestDb, dropTestDb } from './dbTestHelper';

describe('asking to upload', () => {
  it('says at once that a file is too large, before minutes of uploading it', async () => {
    const db = await createTestDb();
    try {
      const app = createApp(db);
      const t = await request(app).post('/api/tenants').send({ name: 'B', email: 'big@example.com' });
      const ask = (size: number) =>
        request(app).post('/api/video-uploads').set('Authorization', `Bearer ${t.body.apiKey}`).send({ contentType: 'video/mp4', size });

      const big = await ask(2 * 1024 * 1024 * 1024);
      expect(big.status).toBe(413);
      expect(big.body.error).toMatch(/600 МБ/);
      expect((await ask(50 * 1024 * 1024)).status).toBe(201);
    } finally {
      await dropTestDb(db);
    }
  });
});
