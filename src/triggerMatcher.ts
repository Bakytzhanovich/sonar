import type Database from 'better-sqlite3';
import type { Trigger } from './types';

// Matching is a pure function, deliberately separate from the two DB
// query helpers below — it can be unit-tested with plain objects, no
// database needed.
export function normalizeKeyword(text: string): string {
  return text.trim().toLowerCase();
}

export function matchTrigger(triggers: Trigger[], messageText: string): Trigger | null {
  const normalizedMessage = normalizeKeyword(messageText);

  for (const trigger of triggers) {
    if (!trigger.is_active) continue;
    const normalizedKeyword = normalizeKeyword(trigger.keyword);

    const isMatch =
      trigger.match_type === 'exact'
        ? normalizedMessage === normalizedKeyword
        : normalizedMessage.includes(normalizedKeyword);

    if (isMatch) return trigger;
  }

  return null;
}

export function getActiveTriggersForBot(db: Database.Database, botId: string): Trigger[] {
  const rows = db
    .prepare(
      `SELECT id, bot_id, flow_id, flow_version, keyword, match_type, is_active, created_at
       FROM triggers
       WHERE bot_id = ? AND is_active = 1
       ORDER BY created_at ASC`
    )
    .all(botId) as Array<Omit<Trigger, 'is_active'> & { is_active: number }>;

  return rows.map((row) => ({ ...row, is_active: row.is_active === 1 }));
}

// Fast pre-check for the common (non-racing) case, so flowEngine can skip
// starting a run before doing any work. It is NOT the source of truth for
// correctness under concurrent webhook deliveries — the UNIQUE(trigger_id,
// subscriber_id, run_date) constraint on flow_runs is (see schema.sql).
// flowEngine still has to handle that constraint violation as the real
// dedup guarantee; this function only avoids the common-case race.
export function hasRunToday(
  db: Database.Database,
  triggerId: string,
  subscriberId: string,
  runDate: string
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM flow_runs WHERE trigger_id = ? AND subscriber_id = ? AND run_date = ? LIMIT 1`
    )
    .get(triggerId, subscriberId, runDate);

  return row !== undefined;
}
