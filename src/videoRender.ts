import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { notify } from './notifications';
import type { VideoEditJob } from './types';

const PROGRESS_STEP = 25; // reaches 100% after 4 ticks

// Stands in for Shotstack/Creatomate API. Real rendering is async and can
// take minutes (ТЗ: "важно показывать статус") — this simulates that
// with incremental progress across polling ticks instead of resolving
// instantly, so the progress bar has something real to show rather than
// jumping straight to 100%.
export function advanceRenderJobs(db: Database.Database, now: Date = new Date()): { advanced: number } {
  const jobs = db.prepare(`SELECT * FROM video_edit_jobs WHERE status = 'processing'`).all() as VideoEditJob[];

  for (const job of jobs) {
    const nextProgress = Math.min(100, job.progress_percent + PROGRESS_STEP);

    if (nextProgress < 100) {
      db.prepare(`UPDATE video_edit_jobs SET progress_percent = ? WHERE id = ?`).run(nextProgress, job.id);
      continue;
    }

    // Reached 100% — resolve success/failure, deterministic per job id
    // (same reasoning as mockPublish in Module 5's publisher.ts).
    const hash = createHash('sha256').update(job.id).digest();
    if (hash[0] % 10 === 0) {
      db.prepare(
        `UPDATE video_edit_jobs SET status = 'failed', progress_percent = 100, failure_reason = ?, completed_at = ? WHERE id = ?`
      ).run('video_processing_error', now.toISOString(), job.id);
      notify(db, job.tenant_id, 'video_failed', `Ошибка рендера видео: video_processing_error`, job.id);
    } else {
      const outputUrl = `https://render.mock/output/${job.id.slice(0, 8)}.mp4`;
      db.prepare(
        `UPDATE video_edit_jobs SET status = 'completed', progress_percent = 100, output_url = ?, completed_at = ? WHERE id = ?`
      ).run(outputUrl, now.toISOString(), job.id);
      notify(db, job.tenant_id, 'video_completed', `Рендер видео завершён: ${outputUrl}`, job.id);
    }
  }

  return { advanced: jobs.length };
}
