// Whether a render worker is alive, and how both sides agree on the answer.
//
// Its own module for the same reason as jobLease.ts: the worker writes the
// heartbeat and the API reads it, and a threshold copied into two files is a
// threshold that drifts. Importing it from worker.ts would drag ffmpeg and
// object storage into the API for the sake of one column.

import { exec, queryOne, type Queryable } from './db';

/** The only kind there is today; the column exists so a second one can join. */
export const SMART_CUT_WORKER = 'smart_cut';

/** How often a running worker says it is still there. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * How old a heartbeat may be before the worker counts as gone.
 *
 * Four beats, not one. A single missed write is ordinary — a slow query, a
 * retried connection, a moment of packet loss — and treating it as death
 * would tell a customer their render is stranded while it is in fact running.
 * A full minute of silence is not ordinary.
 */
export const HEARTBEAT_STALE_MS = 60_000;

export async function recordHeartbeat(
  db: Queryable,
  kind: string = SMART_CUT_WORKER,
  now: Date = new Date()
): Promise<void> {
  await exec(
    db,
    `INSERT INTO worker_heartbeats (worker_kind, last_seen_at) VALUES (?, ?)
     ON CONFLICT (worker_kind) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
    kind,
    now.toISOString()
  );
}

/** True when some worker of this kind has reported in recently enough. */
export function isHeartbeatFresh(lastSeenAt: string | Date | null, now: Date): boolean {
  if (!lastSeenAt) return false;
  const seen = lastSeenAt instanceof Date ? lastSeenAt.getTime() : new Date(lastSeenAt).getTime();
  if (Number.isNaN(seen)) return false;
  return seen > now.getTime() - HEARTBEAT_STALE_MS;
}

export async function isWorkerOnline(
  db: Queryable,
  kind: string = SMART_CUT_WORKER,
  now: Date = new Date()
): Promise<boolean> {
  const row = await queryOne<{ last_seen_at: string | Date }>(
    db,
    `SELECT last_seen_at FROM worker_heartbeats WHERE worker_kind = ?`,
    kind
  );
  return isHeartbeatFresh(row?.last_seen_at ?? null, now);
}
