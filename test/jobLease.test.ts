import { describe, it, expect } from 'vitest';
import { isAwaitingWorker, CLAIM_LEASE_MS } from '../src/jobLease';

const now = new Date('2026-09-18T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

describe('isAwaitingWorker', () => {
  it('a job nobody has claimed is waiting', () => {
    expect(isAwaitingWorker({ status: 'processing', claimed_at: null }, now)).toBe(true);
  });

  it('a job claimed just now is being worked on', () => {
    expect(isAwaitingWorker({ status: 'processing', claimed_at: ago(1000) }, now)).toBe(false);
  });

  it('a claim inside the lease still counts as active, however long the render', () => {
    // Renders run for minutes. Expiring a live claim would hand the same job
    // to a second worker while the first is still encoding it.
    expect(isAwaitingWorker({ status: 'processing', claimed_at: ago(CLAIM_LEASE_MS - 1000) }, now)).toBe(false);
  });

  it('a claim past the lease is waiting again — that worker is gone', () => {
    expect(isAwaitingWorker({ status: 'processing', claimed_at: ago(CLAIM_LEASE_MS + 1000) }, now)).toBe(true);
  });

  it('is never true for a job that is not processing', () => {
    // A finished or failed job is not waiting for anything, and an unclaimed
    // completed row would otherwise read as queued forever.
    for (const status of ['completed', 'failed', 'awaiting_review', 'queued']) {
      expect(isAwaitingWorker({ status, claimed_at: null }, now)).toBe(false);
    }
  });

  it('treats an unreadable timestamp as waiting rather than as progress', () => {
    expect(isAwaitingWorker({ status: 'processing', claimed_at: 'not a date' }, now)).toBe(true);
  });
});
