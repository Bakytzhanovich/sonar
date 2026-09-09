import { createHash } from 'node:crypto';
import { queryAll, type Db } from './db';
import { notify } from './notifications';
import type { VideoEditJob } from './types';

const PROGRESS_STEP = 25; // reaches 100% after 4 ticks

// Stands in for Shotstack/Creatomate API. Real rendering is async and can
// take minutes (ТЗ: "важно показывать статус") — this simulates that
// with incremental progress across polling ticks instead of resolving
// instantly, so the progress bar has something real to show rather than
// jumping straight to 100%.
export async function advanceRenderJobs(db: Db, now: Date = new Date()): Promise<{ advanced: number }> {
  const jobs = await queryAll<VideoEditJob>(db, `SELECT * FROM video_edit_jobs WHERE status = 'processing'`);

  // Each job is independently compare-and-swapped below (own row, own
  // WHERE-guarded UPDATE) — nothing here depends on another job's
  // outcome, so advancing them concurrently is safe and turns N
  // sequential round-trips into N parallel ones.
  const results = await Promise.all(jobs.map((job) => processOneJob(db, job, now)));
  return { advanced: results.filter(Boolean).length };
}

// Every UPDATE below is guarded by "the row still looks exactly like it did
// when we read it" (progress_percent = job.progress_percent, or status =
// 'processing' for the terminal transition) and reports back via RETURNING
// whether it actually matched a row — tryClaim() is that shared shape.
// Unlike scheduled_posts in publisher.ts, a job legitimately revisits
// status = 'processing' across many ticks, so it can't be claimed by moving
// it to a different status — this compare-and-swap is the equivalent
// protection against two overlapping advanceRenderJobs calls (timer +
// manual process-tick) both grabbing the same job and double-advancing or
// double-notifying it.
async function tryClaim(db: Db, sql: string, ...params: unknown[]): Promise<boolean> {
  return (await queryAll(db, sql, ...params)).length > 0;
}

async function processOneJob(db: Db, job: VideoEditJob, now: Date): Promise<boolean> {
  const nextProgress = Math.min(100, job.progress_percent + PROGRESS_STEP);

  if (nextProgress < 100) {
    return tryClaim(
      db,
      `UPDATE video_edit_jobs SET progress_percent = ? WHERE id = ? AND progress_percent = ? RETURNING id`,
      nextProgress,
      job.id,
      job.progress_percent
    );
  }

  // Reached 100% — resolve success/failure, deterministic per job id
  // (same reasoning as mockPublish in Module 5's publisher.ts).
  const hash = createHash('sha256').update(job.id).digest();
  if (hash[0] % 10 === 0) {
    const claimed = await tryClaim(
      db,
      `UPDATE video_edit_jobs SET status = 'failed', progress_percent = 100, failure_reason = ?, completed_at = ? WHERE id = ? AND status = 'processing' RETURNING id`,
      'video_processing_error',
      now.toISOString(),
      job.id
    );
    if (claimed) await notify(db, job.tenant_id, 'video_failed', `Ошибка рендера видео: video_processing_error`, job.id);
    return claimed;
  }

  const outputUrl = `https://render.mock/output/${job.id.slice(0, 8)}.mp4`;
  const claimed = await tryClaim(
    db,
    `UPDATE video_edit_jobs SET status = 'completed', progress_percent = 100, output_url = ?, completed_at = ? WHERE id = ? AND status = 'processing' RETURNING id`,
    outputUrl,
    now.toISOString(),
    job.id
  );
  if (claimed) await notify(db, job.tenant_id, 'video_completed', `Рендер видео завершён: ${outputUrl}`, job.id);
  return claimed;
}
