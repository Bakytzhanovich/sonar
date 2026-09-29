import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { exec, queryAll, type Db } from '../src/db';
import { sweepExpiredPreviews } from '../src/previewSweep';
import type { StorageIo } from '../src/videoPipeline';
import { createTestDb, dropTestDb } from './dbTestHelper';

const TENANT = 'sweep-tenant';

function fakeStorage(overrides: Partial<StorageIo> = {}): StorageIo & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    download: async () => {},
    upload: async () => {},
    publicUrl: (key) => `https://cdn.test/${key}`,
    remove: async (key) => {
      removed.push(key);
    },
    ...overrides,
  } as StorageIo & { removed: string[] };
}

describe('sweepExpiredPreviews', () => {
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    await exec(db, `INSERT INTO tenants (id, name, email) VALUES (?, 'T', ?)`, TENANT, `${TENANT}@example.com`);
  });
  afterEach(async () => { if (db) await dropTestDb(db); });

  async function seed(
    id: string,
    opts: { preview: boolean; ageHours: number; status?: string; key?: string | null }
  ): Promise<void> {
    const created = new Date(Date.now() - opts.ageHours * 3600 * 1000).toISOString();
    // A preview points at a parent, so one has to exist for the reference.
    if (opts.preview) {
      await exec(
        db,
        `INSERT INTO video_edit_jobs (id, tenant_id, source_video_url, template, pipeline, status)
         VALUES (?, ?, 'src', 'ai_smart_cut', 'smart_cut', 'completed') ON CONFLICT DO NOTHING`,
        `parent-${id}`,
        TENANT
      );
    }
    await exec(
      db,
      `INSERT INTO video_edit_jobs (id, tenant_id, source_video_url, template, pipeline, status, created_at, preview_of, output_object_key)
       VALUES (?, ?, 'src', 'ai_smart_cut', 'smart_cut', ?, ?, ?, ?)`,
      id,
      TENANT,
      opts.status ?? 'completed',
      created,
      opts.preview ? `parent-${id}` : null,
      opts.key === undefined ? `renders/${id}.mp4` : opts.key
    );
  }

  const idsLeft = () =>
    queryAll<{ id: string }>(db, `SELECT id FROM video_edit_jobs ORDER BY id`).then((r) => r.map((x) => x.id));

  it('removes an expired preview and its file', async () => {
    await seed('old', { preview: true, ageHours: 48 });
    const storage = fakeStorage();

    const result = await sweepExpiredPreviews(db, storage, new Date(), 6);

    expect(result).toEqual({ removed: 1, failed: 0 });
    expect(storage.removed).toEqual(['renders/old.mp4']);
    expect(await idsLeft()).not.toContain('old');
  });

  it('leaves a preview that is still fresh', async () => {
    await seed('fresh', { preview: true, ageHours: 1 });
    const storage = fakeStorage();

    expect(await sweepExpiredPreviews(db, storage, new Date(), 6)).toEqual({ removed: 0, failed: 0 });
    expect(storage.removed).toEqual([]);
    expect(await idsLeft()).toContain('fresh');
  });

  // The whole point of the column: real renders are someone's deliverable and
  // must never be collected, however old they get.
  it('never touches a job that is not a preview', async () => {
    await seed('real', { preview: false, ageHours: 5000 });
    const storage = fakeStorage();

    expect(await sweepExpiredPreviews(db, storage, new Date(), 6)).toEqual({ removed: 0, failed: 0 });
    expect(await idsLeft()).toContain('real');
  });

  // A preview still rendering owns a temp directory and a lease; deleting the
  // row out from under the worker would strand both.
  it('skips a preview that is still working', async () => {
    await seed('busy', { preview: true, ageHours: 48, status: 'processing' });

    expect(await sweepExpiredPreviews(db, fakeStorage(), new Date(), 6)).toEqual({ removed: 0, failed: 0 });
    expect(await idsLeft()).toContain('busy');
  });

  it('collects a preview that failed before producing anything', async () => {
    await seed('broken', { preview: true, ageHours: 48, status: 'failed', key: null });
    const storage = fakeStorage();

    expect(await sweepExpiredPreviews(db, storage, new Date(), 6)).toEqual({ removed: 1, failed: 0 });
    expect(storage.removed).toEqual([]);
    expect(await idsLeft()).not.toContain('broken');
  });

  // One unreachable object must not stop the sweep — the rest of the backlog
  // is exactly what it exists for.
  it('keeps going past an object it cannot delete', async () => {
    await seed('stuck', { preview: true, ageHours: 48 });
    await seed('next', { preview: true, ageHours: 48 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = fakeStorage({
      remove: async (key: string) => {
        if (key.includes('stuck')) throw new Error('bucket unreachable');
      },
    });

    try {
      const result = await sweepExpiredPreviews(db, storage, new Date(), 6);
      expect(result.removed).toBe(1);
      expect(result.failed).toBe(1);
    } finally {
      warn.mockRestore();
    }

    // The row whose file could not go stays, so the next sweep retries it.
    expect(await idsLeft()).toContain('stuck');
    expect(await idsLeft()).not.toContain('next');
  });

  it('still clears rows when there is no storage configured', async () => {
    await seed('local', { preview: true, ageHours: 48 });

    expect(await sweepExpiredPreviews(db, null, new Date(), 6)).toEqual({ removed: 1, failed: 0 });
    expect(await idsLeft()).not.toContain('local');
  });
});
