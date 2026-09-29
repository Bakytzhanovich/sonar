import { exec, queryAll, type Db } from './db';
import type { StorageIo } from './videoPipeline';

// Previews are answers to a question, not work anyone ordered: four seconds
// rendered because somebody wanted to see what Оswald in turquoise looks like
// before committing. Someone comparing seven colours makes seven of them in a
// minute, and none is worth keeping once the tab is closed.
//
// Left alone they accumulate in the bucket forever — small files, but an
// unbounded number of them, which is the shape of problem that is invisible
// until the storage bill or the object count is the thing that breaks.
//
// Deliberately in the worker rather than the API: it already holds the
// storage credentials and already runs alone, so there is no second process
// racing it for the same rows.

/** How long a preview is worth keeping. Long enough to survive a slow look at
 *  it and a reload of the page; short enough that a day of trying styles does
 *  not leave a day of files behind. */
export const PREVIEW_TTL_HOURS = 6;

export interface SweepResult {
  removed: number;
  failed: number;
}

export async function sweepExpiredPreviews(
  db: Db,
  storage: StorageIo | null,
  now: Date = new Date(),
  ttlHours: number = PREVIEW_TTL_HOURS
): Promise<SweepResult> {
  const cutoff = new Date(now.getTime() - ttlHours * 3600 * 1000).toISOString();

  // Only ones that have stopped moving. A preview still rendering owns a
  // temp directory and a lease, and deleting its row out from under the
  // worker would strand both.
  const stale = await queryAll<{ id: string; output_object_key: string | null }>(
    db,
    `SELECT id, output_object_key
       FROM video_edit_jobs
      WHERE preview_of IS NOT NULL
        AND status IN ('completed', 'failed')
        AND created_at < ?`,
    cutoff
  );

  let removed = 0;
  let failed = 0;

  for (const preview of stale) {
    try {
      // Object first, row second. The row is the only record that the object
      // exists, so dropping it first would leak the file with nothing left
      // pointing at it — whereas a delete that dies between the two leaves a
      // row whose object is already gone, and the next sweep finishes the
      // job because remove() treats a missing object as success.
      if (preview.output_object_key && storage) {
        await storage.remove(preview.output_object_key);
      }
      await exec(db, `DELETE FROM video_edit_jobs WHERE id = ? AND preview_of IS NOT NULL`, preview.id);
      removed++;
    } catch (err) {
      // One unreachable object must not stop the sweep: the rest of the
      // backlog is exactly what the sweep exists for.
      failed++;
      console.warn(
        `[preview-sweep] ${preview.id} not removed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return { removed, failed };
}
