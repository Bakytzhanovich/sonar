import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exec, queryAll, type Db } from './db';
import { notify } from './notifications';
import { analyzeReelTranscript, ReelAnalysisError, type ChatModel } from './reelLlm';
import { hashAudioFile, readCachedTranscript, writeCachedTranscript } from './transcriptCache';
import { TranscriptionError } from './transcription';
import type { ReelAnalysis } from './types';
import type { PipelineDeps } from './videoPipeline';

// Module 3 — an uploaded reel, read for its mechanic.
//
// Runs in the worker for the same reason the video pipeline does: it calls
// ffmpeg and waits on two network models, which is minutes of a process that
// should not be the API's. It is much shorter than a render — probe, audio,
// transcript, one model call — so it keeps no per-stage checkpoints: a retry
// simply starts again, and the transcript cache makes the expensive part of
// that free the second time.

/** Longer than any reel. A cap rather than no cap because a 40-minute upload
 *  would be a transcription bill for something that is not a reel. */
export const MAX_REEL_SECONDS = 180;
const MAX_ATTEMPTS = 3;
// Generous for a short clip; a lease that outlives a dead worker is only a
// delay, while one shorter than a real run would hand the job to a second
// worker halfway through.
const CLAIM_LEASE_MS = 10 * 60 * 1000;

export type ReelDeps = Pick<PipelineDeps, 'storage' | 'transcribe'> & {
  ffmpeg: Pick<PipelineDeps['ffmpeg'], 'probe' | 'extractAudio'>;
  chat: ChatModel;
};

/** Failures the input itself causes. Retrying cannot change the answer, and
 *  each retry would be another transcription bill. */
const PERMANENT = new Set([
  'storage_not_configured',
  'source_unreadable',
  'no_audio_track',
  'video_too_long',
  'no_speech',
  'llm_not_configured',
  'transcription_not_configured',
  'audio_too_large',
]);

class ReelPipelineError extends Error {
  constructor(readonly reason: string, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'ReelPipelineError';
  }
}

export async function claimReelJobs(db: Db, now: Date, limit: number): Promise<ReelAnalysis[]> {
  return queryAll<ReelAnalysis>(
    db,
    `UPDATE reel_analyses
     SET claimed_at = ?, attempt_count = attempt_count + 1
     WHERE id IN (
       SELECT id FROM reel_analyses
       WHERE status = 'processing'
         AND (claimed_at IS NULL OR claimed_at < ?)
       ORDER BY created_at
       LIMIT ?
     )
     RETURNING *`,
    now.toISOString(),
    new Date(now.getTime() - CLAIM_LEASE_MS).toISOString(),
    limit
  );
}

async function setStage(db: Db, id: string, stage: 'probe' | 'transcribe' | 'analyze'): Promise<void> {
  await exec(db, `UPDATE reel_analyses SET stage = ? WHERE id = ? AND status = 'processing'`, stage, id);
}

export async function processReelJob(db: Db, job: ReelAnalysis, deps: ReelDeps): Promise<void> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `sonar-reel-${job.id.slice(0, 8)}-`));
  try {
    if (!deps.storage) throw new ReelPipelineError('storage_not_configured');
    if (!job.source_object_key) throw new ReelPipelineError('source_unreadable', 'no uploaded file');

    await setStage(db, job.id, 'probe');
    const sourcePath = path.join(workDir, 'source');
    await deps.storage.download(job.source_object_key, sourcePath);
    let probed;
    try {
      probed = await deps.ffmpeg.probe(sourcePath);
    } catch (err) {
      throw new ReelPipelineError('source_unreadable', err instanceof Error ? err.message : String(err));
    }
    // Both checked before anything is paid for: a silent clip has nothing to
    // transcribe, and an hour-long upload is not a reel.
    if (!probed.hasAudio) throw new ReelPipelineError('no_audio_track');
    if (probed.durationSec > MAX_REEL_SECONDS) throw new ReelPipelineError('video_too_long', `${Math.round(probed.durationSec)}s`);

    await setStage(db, job.id, 'transcribe');
    const audioPath = path.join(workDir, 'audio.mp3');
    try {
      await deps.ffmpeg.extractAudio(sourcePath, audioPath);
    } catch (err) {
      throw new ReelPipelineError('source_unreadable', err instanceof Error ? err.message : String(err));
    }

    // The same cache the video pipeline fills: a reel someone analyses twice,
    // or one they already ran through the editor, is not paid for again. A
    // cache that cannot be read is a missed saving, never a failed job.
    const audioHash = await hashAudioFile(audioPath);
    let transcript = await readCachedTranscript(db, audioHash).catch(() => null);
    if (!transcript) {
      try {
        const result = await deps.transcribe(audioPath);
        transcript = { words: result.words, text: result.text, language: result.language };
      } catch (err) {
        if (err instanceof TranscriptionError) throw new ReelPipelineError(err.code, err.message);
        throw new ReelPipelineError('transcription_failed', err instanceof Error ? err.message : String(err));
      }
      await writeCachedTranscript(db, audioHash, transcript).catch(() => {});
    }
    // Music under a dance, or footage with no talking: there is no spoken
    // mechanic to read, and a model asked to find one would invent it.
    if (transcript.words.length < 3) throw new ReelPipelineError('no_speech');

    await setStage(db, job.id, 'analyze');
    let analysis;
    try {
      analysis = await analyzeReelTranscript(transcript.words, probed.durationSec, deps.chat);
    } catch (err) {
      if (err instanceof ReelAnalysisError) throw new ReelPipelineError(err.reason, err.message);
      throw new ReelPipelineError('llm_failed', err instanceof Error ? err.message : String(err));
    }

    await exec(
      db,
      `UPDATE reel_analyses
       SET status = 'completed', stage = NULL, claimed_at = NULL, failure_reason = NULL,
           hook = ?, structure = ?::jsonb, why = ?, duration_seconds = ?,
           transcript = ?::jsonb, language = ?
       WHERE id = ? AND status = 'processing'`,
      analysis.hook,
      JSON.stringify(analysis.structure),
      analysis.why,
      Math.round(probed.durationSec),
      JSON.stringify(transcript.words),
      transcript.language,
      job.id
    );
    await notify(db, job.tenant_id, 'reel_analyzed', `Разбор рилса готов: ${analysis.hook}`, job.id).catch(() => {});
  } catch (err) {
    await handleFailure(db, job, err);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch((err: unknown) =>
      console.warn(`[reel-pipeline] ${job.id}: temp dir not removed: ${err instanceof Error ? err.message : String(err)}`)
    );
  }
}

async function handleFailure(db: Db, job: ReelAnalysis, err: unknown): Promise<void> {
  const reason = err instanceof ReelPipelineError ? err.reason : 'llm_failed';
  const detail = err instanceof Error ? err.message : String(err);
  const permanent = PERMANENT.has(reason) || job.attempt_count >= MAX_ATTEMPTS;

  if (permanent) {
    console.warn(`[reel-pipeline] ${job.id} failed (${reason}): ${detail}`);
    await exec(
      db,
      `UPDATE reel_analyses SET status = 'failed', stage = NULL, claimed_at = NULL, failure_reason = ?
       WHERE id = ? AND status = 'processing'`,
      reason,
      job.id
    );
    await notify(db, job.tenant_id, 'reel_failed', 'Разбор рилса не получился', job.id).catch(() => {});
    return;
  }

  // Released rather than left claimed, so the next tick picks it up instead of
  // waiting out the lease. The reason is kept for the screen meanwhile.
  console.warn(`[reel-pipeline] ${job.id} attempt ${job.attempt_count} failed (${reason}), will retry: ${detail}`);
  await exec(
    db,
    `UPDATE reel_analyses SET claimed_at = NULL, failure_reason = ? WHERE id = ? AND status = 'processing'`,
    reason,
    job.id
  );
}

export async function runReelJobs(db: Db, now: Date, deps: ReelDeps, limit = 1): Promise<{ processed: number }> {
  const jobs = await claimReelJobs(db, now, limit);
  for (const job of jobs) await processReelJob(db, job, deps);
  return { processed: jobs.length };
}
