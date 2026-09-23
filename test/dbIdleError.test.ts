import { describe, expect, it, afterEach, vi } from 'vitest';
import { exec, queryOne, type Db } from '../src/db';
import { createTestDb, dropTestDb } from './dbTestHelper';

// The failure this guards is not a wrong answer — it is the process ending.
//
// A pooled connection that dies while idle has no pending query to reject, so
// pg reports it by emitting 'error' on the pool. An EventEmitter with no
// listener for 'error' does not log and carry on: it throws, out of any
// try/catch the poll loop has, and takes the worker with it. The worker ran
// against a managed database over the public internet from a laptop that
// sleeps, so this arrived nightly — it was found 13 hours after the fact, with
// every queued render untouched.
describe('an idle connection dropping', () => {
  let db: Db;
  afterEach(async () => { if (db) await dropTestDb(db); });

  it('does not bring the process down', async () => {
    db = await createTestDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // What pg does when keepAlive finds the peer gone. Without the listener
      // in createDb this line throws rather than returning — which is exactly
      // how the worker died, and why the assertion is "not.toThrow" rather
      // than anything about the message.
      expect(() => db.emit('error', new Error('read ETIMEDOUT'), {} as never)).not.toThrow();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('still answers queries afterwards', async () => {
    db = await createTestDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      db.emit('error', new Error('read ETIMEDOUT'), {} as never);
    } finally {
      warn.mockRestore();
    }

    // The point of surviving the event: the next tick asks the pool for a
    // connection and gets a working one. pg discarded the broken client
    // itself, so there is nothing for us to reconnect.
    await exec(db, `CREATE TABLE idle_probe (id INT)`);
    await exec(db, `INSERT INTO idle_probe (id) VALUES (?)`, 1);
    const row = await queryOne<{ id: number }>(db, `SELECT id FROM idle_probe`);
    expect(row?.id).toBe(1);
  });
});
