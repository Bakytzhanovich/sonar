import { describe, it, expect } from 'vitest';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALE_MS, isHeartbeatFresh } from '../src/workerHealth';

const now = new Date('2026-09-21T12:00:00.000Z');

function agedBy(ms: number): string {
  return new Date(now.getTime() - ms).toISOString();
}

describe('isHeartbeatFresh', () => {
  it('counts a worker that just reported in as running', () => {
    expect(isHeartbeatFresh(agedBy(1_000), now)).toBe(true);
  });

  it('tolerates a few missed beats', () => {
    // The reason this margin exists: one slow query or retried connection is
    // ordinary, and calling it death would tell a customer their render is
    // stranded while it is in fact running.
    expect(isHeartbeatFresh(agedBy(HEARTBEAT_INTERVAL_MS * 3), now)).toBe(true);
  });

  it('gives up after a full minute of silence', () => {
    expect(isHeartbeatFresh(agedBy(HEARTBEAT_STALE_MS + 1), now)).toBe(false);
  });

  it('treats a worker that never reported as absent', () => {
    // A fresh database has no row at all, which is the state a deployment
    // with no worker running has been in all along.
    expect(isHeartbeatFresh(null, now)).toBe(false);
  });

  it('treats an unreadable timestamp as absent rather than as alive', () => {
    // "We cannot tell" must not render as a promise that a render is coming.
    expect(isHeartbeatFresh('not a date', now)).toBe(false);
  });

  it('accepts the Date the driver returns for a timestamptz column', () => {
    // node-postgres hands back a Date, not a string, for this column type —
    // a version of this that only parsed strings reported every live worker
    // as missing.
    expect(isHeartbeatFresh(new Date(now.getTime() - 1_000), now)).toBe(true);
  });

  it('leaves room for several missed beats before declaring the worker gone', () => {
    expect(HEARTBEAT_STALE_MS).toBeGreaterThanOrEqual(HEARTBEAT_INTERVAL_MS * 3);
  });
});
