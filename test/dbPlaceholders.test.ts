import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { exec, queryOne, type Db } from '../src/db';
import { createTestDb, dropTestDb } from './dbTestHelper';

// toPositional is not exported, so these go through the real driver — which
// is the point: the failure being guarded against only shows up as Postgres
// rejecting the finished statement.
describe('? placeholders', () => {
  let db: Db;
  beforeEach(async () => { db = await createTestDb(); });
  afterEach(async () => { await dropTestDb(db); });

  it('survives an apostrophe inside a SQL comment', async () => {
    // A plain English comment used to swallow the placeholders after it: the
    // apostrophe read as an opening quote, the scanner ran to the next one,
    // and the statement reached Postgres with the wrong parameter count.
    const row = await queryOne<{ value: number }>(
      db,
      `SELECT ?::int AS value
       -- counting the job's retries
       WHERE ?::int = 1`,
      7,
      1
    );
    expect(row?.value).toBe(7);
  });

  it('survives a block comment containing a quote', async () => {
    const row = await queryOne<{ value: number }>(db, `SELECT ?::int AS value /* it's fine */`, 3);
    expect(row?.value).toBe(3);
  });

  it('still leaves real string literals alone', async () => {
    // '?' inside a literal is data, not a placeholder.
    const row = await queryOne<{ a: string; b: number }>(db, `SELECT 'why?' AS a, ?::int AS b`, 5);
    expect(row?.a).toBe('why?');
    expect(row?.b).toBe(5);
  });

  it('handles an escaped quote inside a literal', async () => {
    const row = await queryOne<{ a: string; b: number }>(db, `SELECT 'it''s here' AS a, ?::int AS b`, 9);
    expect(row?.a).toBe("it's here");
    expect(row?.b).toBe(9);
  });

  it('writes jsonb through a commented statement', async () => {
    await exec(db, `INSERT INTO tenants (id, name, email) VALUES (?, 'T', ?)`, 'ph-1', 'ph1@example.com');
    const row = await queryOne<{ name: string }>(
      db,
      `SELECT name FROM tenants
       -- the tenant's own row
       WHERE id = ?`,
      'ph-1'
    );
    expect(row?.name).toBe('T');
  });
});
