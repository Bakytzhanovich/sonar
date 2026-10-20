// The worker's doorbell and its pulse — kept in object storage, not in the
// database.
//
// Why: the database (Neon) only bills, and only stays awake, while something
// talks to it. A worker that polled it every five seconds and wrote a
// heartbeat every fifteen kept it awake around the clock and spent the free
// quota in ten days, which took the whole product down with it. So the idle
// worker watches a tiny object instead: the API rings it whenever it queues
// work, and the worker goes to the database only when rung, for a while after
// it last had work, and on a slow safety timer. Its "I am alive" lives here
// too, for the same reason.
//
// Reading an object every few seconds costs a fraction of a cent a month;
// waking a database for it costs its whole quota.

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { presign, storageConfigFromEnv, type StorageConfig } from './storage';
import { localMediaConfigFromEnv, resolveKeyPath, type LocalMediaConfig } from './localMedia';

export interface SignalStore {
  /** The object's text, or null when there is none yet. */
  read(key: string): Promise<string | null>;
  write(key: string, body: string): Promise<void>;
}

/** Rung by the API when there is new work for the worker. */
export const WORK_SIGNAL_KEY = 'signals/work';

/** Where a worker of this kind writes the time it was last alive. */
export function heartbeatKey(kind: string): string {
  return `signals/heartbeat-${kind}`;
}

export function r2SignalStore(config: StorageConfig): SignalStore {
  return {
    async read(key) {
      const response = await fetch(presign(config, { method: 'GET', key, expiresInSec: 60 }));
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`signal GET failed with ${response.status}`);
      return response.text();
    },
    async write(key, body) {
      const contentType = 'text/plain';
      const response = await fetch(presign(config, { method: 'PUT', key, contentType, expiresInSec: 60 }), {
        method: 'PUT',
        headers: { 'content-type': contentType },
        body,
      });
      if (!response.ok) throw new Error(`signal PUT failed with ${response.status}`);
    },
  };
}

export function localSignalStore(config: LocalMediaConfig): SignalStore {
  return {
    async read(key) {
      try {
        return await fs.readFile(resolveKeyPath(config, key), 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    async write(key, body) {
      const target = resolveKeyPath(config, key);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, body, 'utf-8');
    },
  };
}

/**
 * R2 when it is configured, the local media folder in development, or null —
 * in which case the worker falls back to polling the database, as before.
 */
export function signalStoreFromEnv(localMediaSecret: string): SignalStore | null {
  const r2 = storageConfigFromEnv();
  if (r2) return r2SignalStore(r2);
  const local = localMediaConfigFromEnv(localMediaSecret);
  return local ? localSignalStore(local) : null;
}

/**
 * Tells the worker there is work. A new value each time — the time plus a
 * few random bytes — because the worker reacts to a change, and two rings in
 * the same millisecond must still both be a change.
 */
export async function ringWorker(store: SignalStore, now: Date = new Date()): Promise<void> {
  await store.write(WORK_SIGNAL_KEY, `${now.toISOString()} ${randomBytes(4).toString('hex')}`);
}

export async function writeHeartbeat(store: SignalStore, kind: string, now: Date = new Date()): Promise<void> {
  await store.write(heartbeatKey(kind), now.toISOString());
}

/** The last time a worker of this kind was alive, or null when it never said. */
export async function readHeartbeat(store: SignalStore, kind: string): Promise<Date | null> {
  const text = await store.read(heartbeatKey(kind));
  if (!text) return null;
  const at = new Date(text.trim());
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * When the idle worker should next look in the database.
 *
 * - rung: there is new work — now;
 * - busy: it had work within ACTIVE_GRACE_MS — keep polling, a job often
 *   leads to another (a caption review approved, a preview after an edit);
 * - otherwise only once SAFETY_INTERVAL_MS has passed, for anything a lost
 *   ring would strand: a lease left by a crashed worker, a job queued while
 *   the store was unreachable.
 */
export const ACTIVE_GRACE_MS = 2 * 60_000;
export const SAFETY_INTERVAL_MS = 3 * 60 * 60_000;

export function shouldCheckDatabase(state: { rung: boolean; lastWorkAt: number; lastCheckAt: number }, now: number): boolean {
  if (state.rung) return true;
  if (now - state.lastWorkAt < ACTIVE_GRACE_MS) return true;
  return now - state.lastCheckAt >= SAFETY_INTERVAL_MS;
}
