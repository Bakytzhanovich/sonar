import { describe, it, expect, afterEach } from 'vitest';
import { exec, isUniqueViolation, type Db } from '../src/db';
import { matchTrigger, hasRunToday, normalizeKeyword } from '../src/triggerMatcher';
import type { Trigger } from '../src/types';
import { createTestDb, dropTestDb } from './dbTestHelper';

function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 'trigger-1',
    bot_id: 'bot-1',
    flow_id: 'flow-1',
    flow_version: 1,
    keyword: 'цена',
    match_type: 'contains',
    is_active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('normalizeKeyword', () => {
  it('trims and lowercases', () => {
    expect(normalizeKeyword('  ЦЕНА  ')).toBe('цена');
  });
});

describe('matchTrigger', () => {
  it('matches "contains" case-insensitively and ignores surrounding text', () => {
    const trigger = makeTrigger({ match_type: 'contains', keyword: 'цена' });
    expect(matchTrigger([trigger], 'а сколько ЦЕНА за курс?')).toBe(trigger);
  });

  it('requires full equality for "exact"', () => {
    const trigger = makeTrigger({ match_type: 'exact', keyword: 'старт' });
    expect(matchTrigger([trigger], 'старт')).toBe(trigger);
    expect(matchTrigger([trigger], 'дай старт')).toBeNull();
  });

  it('skips inactive triggers', () => {
    const trigger = makeTrigger({ is_active: false });
    expect(matchTrigger([trigger], 'цена')).toBeNull();
  });

  it('returns null when nothing matches', () => {
    const trigger = makeTrigger({ keyword: 'цена' });
    expect(matchTrigger([trigger], 'привет')).toBeNull();
  });

  it('returns the first matching trigger when several match', () => {
    const first = makeTrigger({ id: 'first', keyword: 'курс' });
    const second = makeTrigger({ id: 'second', keyword: 'курс' });
    expect(matchTrigger([first, second], 'хочу на курс')?.id).toBe('first');
  });
});

describe('hasRunToday', () => {
  let db: Db;

  afterEach(async () => {
    if (db) await dropTestDb(db);
  });

  it('is false with no matching flow_run, true once one exists', async () => {
    db = await createTestDb();

    await exec(db, `INSERT INTO tenants (id, name, email) VALUES ('t1', 'Tenant', 't@example.com')`);
    await exec(db, `INSERT INTO bots (id, tenant_id, name, external_account_id) VALUES ('bot-1', 't1', 'Bot', 'ig-1')`);
    await exec(db, `INSERT INTO flows (id, bot_id, version, definition, status) VALUES ('flow-1', 'bot-1', 1, '{}', 'published')`);
    await exec(db, `INSERT INTO triggers (id, bot_id, flow_id, flow_version, keyword) VALUES ('trigger-1', 'bot-1', 'flow-1', 1, 'цена')`);
    await exec(db, `INSERT INTO subscribers (id, tenant_id, bot_id, external_user_id) VALUES ('sub-1', 't1', 'bot-1', 'ig-user-1')`);

    expect(await hasRunToday(db, 'trigger-1', 'sub-1', '2026-08-20')).toBe(false);

    await exec(
      db,
      `INSERT INTO flow_runs (id, tenant_id, bot_id, trigger_id, subscriber_id, flow_id, flow_version, run_date, status)
       VALUES ('run-1', 't1', 'bot-1', 'trigger-1', 'sub-1', 'flow-1', 1, '2026-08-20', 'completed')`
    );

    expect(await hasRunToday(db, 'trigger-1', 'sub-1', '2026-08-20')).toBe(true);
    expect(await hasRunToday(db, 'trigger-1', 'sub-1', '2026-08-21')).toBe(false);
  });

  it('enforces one run per trigger+subscriber+day at the DB level', async () => {
    db = await createTestDb();
    await exec(db, `INSERT INTO tenants (id, name, email) VALUES ('t1', 'Tenant', 't@example.com')`);
    await exec(db, `INSERT INTO bots (id, tenant_id, name, external_account_id) VALUES ('bot-1', 't1', 'Bot', 'ig-1')`);
    await exec(db, `INSERT INTO flows (id, bot_id, version, definition, status) VALUES ('flow-1', 'bot-1', 1, '{}', 'published')`);
    await exec(db, `INSERT INTO triggers (id, bot_id, flow_id, flow_version, keyword) VALUES ('trigger-1', 'bot-1', 'flow-1', 1, 'цена')`);
    await exec(db, `INSERT INTO subscribers (id, tenant_id, bot_id, external_user_id) VALUES ('sub-1', 't1', 'bot-1', 'ig-user-1')`);

    const insertRun = (id: string) =>
      exec(
        db,
        `INSERT INTO flow_runs (id, tenant_id, bot_id, trigger_id, subscriber_id, flow_id, flow_version, run_date, status)
         VALUES (?, 't1', 'bot-1', 'trigger-1', 'sub-1', 'flow-1', 1, '2026-08-20', 'completed')`,
        id
      );

    await insertRun('run-1');
    try {
      await insertRun('run-2');
      expect.unreachable('expected a unique_violation on the second insert');
    } catch (err) {
      expect(isUniqueViolation(err)).toBe(true);
    }
  });
});
