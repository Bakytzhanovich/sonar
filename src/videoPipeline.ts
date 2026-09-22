import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exec, queryAll, type Db } from './db';
import { notify } from './notifications';
import { denoiseModelAvailable, extractAudio, extractPosterFrame, ffmpegAvailable, measureNoise, NOISY_HEADROOM_DB, probe, renderSegments, RNNOISE_MODEL_PATH } from './ffmpeg';
import { DEFAULT_SMART_CUT_OPTIONS, planSmartCut, type SmartCutOptions } from './smartCut';
import { buildSubtitlesForPlan, buildSubtitlesFromLines, DEFAULT_CHUNK_OPTIONS, DEFAULT_SUBTITLE_STYLE, scaleStyleToFrame, type ChunkOptions, type SubtitleStyle } from './subtitles';
import { transcriberFromEnv } from './transcribeGoogle';
import { needsTextCorrection } from './transcriptAlign';
import { styleForPreset } from './subtitlePresets';
import { applyPosition } from './subtitlePositions';
import { buildHeadlineAss, clearOfHeadline, headlineStyleFor, scaleHeadlineToFrame } from './headline';
import { aspectRatioFor } from './aspect';
import { runBreathPass } from './breathPass';
import { cleanAudioTrack } from './deepFilter';
import { hashAudioFile, readCachedTranscript, writeCachedTranscript } from './transcriptCache';
import { summarizeUsage } from './usage';
import { CLAIM_LEASE_MS } from './jobLease';
import { transcribeWithWhisper, TranscriptionError, type Transcriber } from './transcription';
import { downloadToFile, publicUrlFor, storageConfigFromEnv, uploadFile } from './storage';
import { localMediaConfigFromEnv, localStorageIo } from './localMedia';
import { deriveKey } from './auth';
import type { VideoEditJob, VideoFailureReason, VideoJobArtifacts, VideoStage } from './types';

// Module 8, Level 3 — the staged pipeline that turns an uploaded raw clip
// into a tightened one. Runs in worker.ts, NOT in the API process: a render
// occupies a CPU core for minutes, and sharing a process with Express means
// every request queues behind it.

// Anything longer is a podcast, not a reel, and would cost minutes of CPU and
// a transcription bill for a result nobody can post. Checked at probe time,
// before we spend anything.
const MAX_SOURCE_DURATION_SEC = 20 * 60;

// How long a claim is trusted before another worker may steal the job. Must
// comfortably exceed a real render (a 10-minute source on a small instance
// takes a few minutes), or two workers will process the same job in parallel
// and the second will overwrite the first's result.
const MAX_ATTEMPTS = 3;

// Failures worth retrying are the ones caused by the world rather than by the
// input: a storage blip, a transcription 5xx, an OOM-killed ffmpeg. A clip
// with no audio track will have no audio track on the third attempt either,
// so retrying it just burns the queue and delays the user's error message.
// Deliberately excludes transcription_quota_exhausted: an empty account
// does not refill between attempts, so retrying only delays the failure —
// and with several jobs queued, each burns its three attempts in turn before
// anyone sees why.
const RETRYABLE: ReadonlySet<VideoFailureReason> = new Set<VideoFailureReason>([
  'source_unreadable',
  'transcription_failed',
  'render_failed',
  'upload_failed',
]);

// Each stage owns a slice of the 0-100 bar. The weights are rough real-world
// proportions (transcription is a fixed-ish upload+wait, rendering scales with
// length) — the point is a bar that always moves forward, never backwards.
const STAGE_RANGE: Record<VideoStage, [number, number]> = {
  probe: [0, 5],
  transcribe: [5, 35],
  plan_cuts: [35, 38],
  // Writing a text file is instant; it gets a sliver purely so the stage is
  // nameable in the UI when something goes wrong in it.
  subtitles: [38, 40],
  render: [40, 90],
  upload: [90, 100],
};

// Not an error: the job did exactly what was asked and is now waiting for a
// person. Thrown rather than returned so it unwinds the stage sequence the
// same way a failure does, without every caller having to check a flag.
export class AwaitingReview extends Error {
  constructor() {
    super('awaiting_review');
    this.name = 'AwaitingReview';
  }
}

export class PipelineError extends Error {
  constructor(readonly reason: VideoFailureReason, readonly detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'PipelineError';
  }
}

// The three things the pipeline needs from object storage, behind an
// interface rather than the config object: it keeps the presigning details
// out of the stage code, and lets tests substitute a local-filesystem store
// so the staged flow can be exercised without a bucket.
export interface StorageIo {
  download(key: string, destPath: string): Promise<void>;
  upload(key: string, sourcePath: string, contentType: string): Promise<void>;
  publicUrl(key: string): string;
}

export interface PipelineDeps {
  storage: StorageIo | null;
  transcribe: Transcriber;
  smartCutOptions: SmartCutOptions;
  subtitleStyle: SubtitleStyle;
  chunkOptions: ChunkOptions;
  // Injected so tests can run the staged flow (claiming, checkpoints, retry,
  // failure mapping) without ffmpeg installed on the machine.
  ffmpeg: {
    available: typeof ffmpegAvailable;
    probe: typeof probe;
    extractAudio: typeof extractAudio;
    render: typeof renderSegments;
    poster: typeof extractPosterFrame;
    denoiseAvailable: typeof denoiseModelAvailable;
    measureNoise: typeof measureNoise;
  };
  findBreaths: typeof runBreathPass;
  // Speech separation outside the render graph. Returns null when the tool is
  // not installed, and the graph falls back to its own denoiser — a worker
  // without it still produces correct cuts and captions.
  cleanAudio: typeof cleanAudioTrack;
}

export function defaultPipelineDeps(): PipelineDeps {
  const config = storageConfigFromEnv();
  // R2 when configured; otherwise the local filesystem store, which is what
  // lets the whole pipeline run on a laptop. Same interface either way, so
  // nothing below this line knows which one it got.
  const localConfig = config ? null : localMediaConfigFromEnv(deriveKey('local-media'));
  return {
    storage: config
      ? {
          download: (key, destPath) => downloadToFile(config, key, destPath),
          upload: (key, sourcePath, contentType) => uploadFile(config, key, sourcePath, contentType),
          publicUrl: (key) => publicUrlFor(config, key),
        }
      : localConfig && localStorageIo(localConfig),
    // Google when GOOGLE_SPEECH_API_KEY is set (Kazakh + code-switching),
    // Whisper otherwise.
    transcribe: transcriberFromEnv(transcribeWithWhisper),
    smartCutOptions: DEFAULT_SMART_CUT_OPTIONS,
    subtitleStyle: DEFAULT_SUBTITLE_STYLE,
    chunkOptions: DEFAULT_CHUNK_OPTIONS,
    ffmpeg: { available: ffmpegAvailable, probe, extractAudio, render: renderSegments, poster: extractPosterFrame, denoiseAvailable: denoiseModelAvailable, measureNoise },
    findBreaths: runBreathPass,
    cleanAudio: cleanAudioTrack,
  };
}

// ---- Claiming ------------------------------------------------------------

// Claims unfinished smart_cut jobs by stamping a lease, in the same statement
// that selects them — same reasoning as publisher.ts's publishDuePosts: every
// query below is an await point, so a plain SELECT-then-UPDATE would let two
// overlapping ticks grab the same job. The difference here is that the job
// stays in 'processing' throughout, so the lease timestamp (not the status)
// is what distinguishes a live claim from an abandoned one.
export async function claimSmartCutJobs(db: Db, now: Date, limit: number): Promise<VideoEditJob[]> {
  return queryAll<VideoEditJob>(
    db,
    `UPDATE video_edit_jobs
     SET claimed_at = ?, attempt_count = attempt_count + 1
     WHERE id IN (
       SELECT id FROM video_edit_jobs
       WHERE pipeline = 'smart_cut'
         AND status = 'processing'
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

// ---- Stage checkpointing -------------------------------------------------

async function setStage(db: Db, job: VideoEditJob, stage: VideoStage, _now: Date): Promise<void> {
  // The lease is stamped with the CURRENT time, not the tick's `now`. The
  // tick timestamp is taken once before the batch starts and never moves, so
  // using it meant the lease expired 30 minutes after the batch began no
  // matter how long the render was still running — and a second worker could
  // claim a job mid-encode, overwrite its output key and notify twice.
  await exec(
    db,
    `UPDATE video_edit_jobs SET stage = ?, progress_percent = ?, claimed_at = ? WHERE id = ? AND status = 'processing'`,
    stage,
    STAGE_RANGE[stage][0],
    new Date().toISOString(),
    job.id
  );
}

async function saveArtifact<K extends keyof VideoJobArtifacts>(
  db: Db,
  job: VideoEditJob,
  key: K,
  value: VideoJobArtifacts[K]
): Promise<void> {
  // Merges into the existing object instead of replacing it, so a retry that
  // re-runs one stage cannot wipe the checkpoints of the stages before it.
  await exec(
    db,
    `UPDATE video_edit_jobs SET artifacts = artifacts || ?::jsonb WHERE id = ?`,
    JSON.stringify({ [key]: value }),
    job.id
  );
  job.artifacts = { ...job.artifacts, [key]: value };
}

async function reportProgress(db: Db, jobId: string, stage: VideoStage, fraction: number): Promise<void> {
  const [from, to] = STAGE_RANGE[stage];
  const percent = Math.round(from + (to - from) * Math.min(1, Math.max(0, fraction)));
  // Guarded by "never go backwards": progress updates race with each other
  // (ffmpeg emits them faster than a round-trip completes), and an
  // out-of-order write would make the bar jump back.
  await exec(
    db,
    // Also refreshes the lease: render is the one stage long enough to
    // outlive it, and it reports progress throughout.
    `UPDATE video_edit_jobs SET progress_percent = ?, claimed_at = now() WHERE id = ? AND status = 'processing' AND progress_percent < ?`,
    percent,
    jobId,
    percent
  );
}

// ---- The pipeline --------------------------------------------------------

export async function runSmartCutJobs(
  db: Db,
  now: Date = new Date(),
  deps: PipelineDeps = defaultPipelineDeps(),
  limit = 1
): Promise<{ processed: number }> {
  const jobs = await claimSmartCutJobs(db, now, limit);
  // Sequential on purpose, unlike publisher.ts's bounded concurrency: these
  // are CPU-bound renders, and running two at once on a one- or two-core
  // instance makes both slower without finishing any sooner. Parallelism here
  // is a matter of running more workers, not more jobs per worker.
  for (const job of jobs) {
    await processSmartCutJob(db, job, deps, now);
  }
  return { processed: jobs.length };
}

export async function processSmartCutJob(
  db: Db,
  job: VideoEditJob,
  deps: PipelineDeps,
  now: Date = new Date()
): Promise<void> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `sonar-video-${job.id.slice(0, 8)}-`));
  try {
    const storage = requireStorage(deps);
    const { outputKey, posterKey } = await runStages(db, job, deps, workDir, now);
    await exec(
      db,
      `UPDATE video_edit_jobs
       SET status = 'completed', progress_percent = 100, stage = NULL, output_object_key = ?, output_url = ?, poster_url = ?, completed_at = ?, claimed_at = NULL
       WHERE id = ? AND status = 'processing'`,
      outputKey,
      storage.publicUrl(outputKey),
      posterKey ? storage.publicUrl(posterKey) : null,
      now.toISOString(),
      job.id
    );
    await notify(db, job.tenant_id, 'video_completed', `Монтаж готов: ${storage.publicUrl(outputKey)}`, job.id);
  } catch (err) {
    if (err instanceof AwaitingReview) {
      // Releasing the lease as well as setting the status: the job is no
      // longer being worked on, and leaving it claimed would block the retry
      // sweeper from ever touching it again.
      await exec(
        db,
        `UPDATE video_edit_jobs SET status = 'awaiting_review', stage = NULL, claimed_at = NULL WHERE id = ? AND status = 'processing'`,
        job.id
      );
      await notify(db, job.tenant_id, 'video_completed', 'Проверьте субтитры перед монтажом', job.id);
    } else {
      await handleFailure(db, job, err, now);
    }
  } finally {
    // Sources and renders are tens of megabytes each; a worker that leaks one
    // temp directory per job fills its disk within a day, and a full disk
    // fails every subsequent job for an unrelated-looking reason.
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

interface StageResult {
  outputKey: string;
  // null when the poster step failed — it is best-effort, never fatal.
  posterKey: string | null;
}

async function runStages(db: Db, job: VideoEditJob, deps: PipelineDeps, workDir: string, now: Date): Promise<StageResult> {
  const storage = requireStorage(deps);
  if (!(await deps.ffmpeg.available())) throw new PipelineError('ffmpeg_not_available');
  if (!job.source_object_key) throw new PipelineError('source_missing');

  const sourcePath = path.join(workDir, 'source.mp4');
  const outputPath = path.join(workDir, 'output.mp4');
  // Resolved once, here, because three separate things draw into this frame —
  // the captions, the headline band and the filter graph — and every one of
  // them sizes itself from it. Reading the column three times is how two of
  // them end up agreeing and the third does not.
  const frame = aspectRatioFor(job.aspect_ratio);

  // ---- Stage 1: probe ----------------------------------------------------
  await setStage(db, job, 'probe', now);
  try {
    await storage.download(job.source_object_key, sourcePath);
  } catch (err) {
    throw new PipelineError('source_unreadable', err instanceof Error ? err.message : String(err));
  }

  let probeResult = job.artifacts.probe;
  if (!probeResult) {
    try {
      const result = await deps.ffmpeg.probe(sourcePath);
      probeResult = result;
    } catch (err) {
      throw new PipelineError('source_unreadable', err instanceof Error ? err.message : String(err));
    }
    if (!Number.isFinite(probeResult.durationSec)) throw new PipelineError('source_unreadable', 'no duration');
    // Both checks happen before transcription, which is the only stage that
    // costs money — failing here is free.
    if (!probeResult.hasAudio) throw new PipelineError('no_audio_track');
    if (probeResult.durationSec > MAX_SOURCE_DURATION_SEC) {
      throw new PipelineError('video_too_long', `${Math.round(probeResult.durationSec)}s`);
    }
    await saveArtifact(db, job, 'probe', probeResult);
  }

  // ---- Stage 2: transcribe ----------------------------------------------
  let transcript = job.artifacts.transcript;
  if (!transcript) {
    await setStage(db, job, 'transcribe', now);
    const audioPath = path.join(workDir, 'audio.mp3');
    try {
      await deps.ffmpeg.extractAudio(sourcePath, audioPath);
    } catch (err) {
      throw new PipelineError('source_unreadable', err instanceof Error ? err.message : String(err));
    }
    // Measured here because the audio track already exists for transcription
    // — no extra decode — and because the answer has to be known before the
    // render stage decides whether to clean the sound.
    if (!job.artifacts.noise) {
      const measurement = await deps.ffmpeg.measureNoise(audioPath);
      if (measurement) {
        // Whether the model is actually there decides this as much as the
        // measurement does — a card claiming the noise was removed when no
        // model was loaded is worse than saying nothing.
        const willDenoise =
          shouldDenoise(job.denoise_mode, measurement.headroomDb) && (await deps.ffmpeg.denoiseAvailable());
        await saveArtifact(db, job, 'noise', { headroomDb: measurement.headroomDb, denoised: willDenoise });
      }
    }

    await reportProgress(db, job.id, 'transcribe', 0.3);

    // Same audio, same captions — see transcriptCache.ts. Checked before
    // spending anything: a re-render after a caption correction, or two
    // tenants with the same clip, should not pay twice or get different
    // words than last time.
    const audioHash = await hashAudioFile(audioPath);
    // A cache that cannot be read is a missed saving, never a failed render.
    // It is also how this first breaks when the worker runs under the
    // least-privilege role and someone forgets to grant the new table: the
    // job should recognise the audio again, not die holding a permission
    // error from an optimisation.
    const cached = await readCachedTranscript(db, audioHash).catch((err) => {
      console.warn(`[video-pipeline] transcript cache unreadable: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (cached) {
      transcript = { words: cached.words, language: cached.language };
      await saveArtifact(db, job, 'transcript', transcript);
    }

    try {
      if (!transcript) {
        const result = await deps.transcribe(audioPath);
        transcript = { words: result.words, language: result.language };
        // Recorded per job rather than totalled somewhere central: the
        // question worth answering is what ONE video costs, and an average
        // over a month hides that a Kazakh clip costs several times what a
        // Russian one does. A cache hit records nothing, which is correct —
        // it spent nothing.
        if (result.usage?.length) {
          await saveArtifact(db, job, 'usage', summarizeUsage(result.usage));
        }
        // Failing to cache must not fail the job: the transcript is in hand,
        // and the only cost is recognising this file again next time.
        await writeCachedTranscript(db, audioHash, {
          words: result.words,
          text: result.text,
          language: result.language,
        }).catch((err) =>
          console.warn(`[video-pipeline] transcript not cached: ${err instanceof Error ? err.message : String(err)}`)
        );
      }
    } catch (err) {
      // TranscriptionError already carries the machine-readable code; anything
      // else (a socket reset, a JSON parse failure) collapses to the generic
      // retryable one.
      if (err instanceof TranscriptionError) throw new PipelineError(err.code, err.message);
      throw new PipelineError('transcription_failed', err instanceof Error ? err.message : String(err));
    }
    await saveArtifact(db, job, 'transcript', transcript);
  }

  // ---- Stage 3: plan cuts (pure) ----------------------------------------
  await setStage(db, job, 'plan_cuts', now);
  // Breaths are found in the signal, not the transcript — and only when the
  // recording has room for them to stand out. Measured on real footage: with
  // a street-level noise floor the band between "room" and "voice" is about
  // 4dB, too narrow to tell a breath from wind, while the same audio cleaned
  // opens it to 35dB. So the search runs on denoised audio when denoising is
  // happening, and is skipped when the floor leaves no band at all.
  let breaths: Array<{ start: number; end: number }> = [];
  if (job.remove_breaths) {
    try {
      breaths = await deps.findBreaths(
        sourcePath,
        transcript.words,
        probeResult.durationSec,
        // Same decision the render will make, so the analysis hears what the
        // viewer will.
        job.artifacts.noise?.denoised ? RNNOISE_MODEL_PATH : undefined
      );
      await saveArtifact(db, job, 'breaths', { count: breaths.length, removedSec: breaths.reduce((sum, b) => sum + (b.end - b.start), 0) });
    } catch (err) {
      // Never fatal: a job that cannot find breaths is a job with breaths in
      // it, not a failed render.
      console.warn(`[video-pipeline] job ${job.id}: breath pass skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const plan = planSmartCut(transcript.words, probeResult.durationSec, deps.smartCutOptions, breaths);
  if (plan.segments.length === 0) throw new PipelineError('nothing_to_cut');
  await saveArtifact(db, job, 'plan', {
    segments: plan.segments,
    keptDurationSec: plan.keptDurationSec,
    removedDurationSec: plan.removedDurationSec,
    droppedFillerCount: plan.droppedFillerCount,
    degraded: plan.degraded,
  });

  // ---- Stage 4: subtitles ------------------------------------------------
  let subtitlePath: string | undefined;
  if (job.subtitles) {
    await setStage(db, job, 'subtitles', now);
    // The words are remapped onto the OUTPUT timeline inside here. Passing
    // Whisper's original timestamps straight through would drift the captions
    // by exactly the amount of silence cut before them — seconds, by the end.
    const approved = job.artifacts.captions?.approved ? job.artifacts.captions.lines : null;
    // Rebuild from the user's corrected lines when there are any. Their
    // timings came from this same plan, so the captions stay in step with the
    // cut — only the words changed.
    // The look comes from the preset, the placement from the position — two
    // separate choices, resolved in that order because an explicit position is
    // the more recent thing the person said.
    // ...and then pushed clear of the headline, if there is one. Top-aligned
    // captions measure their margin from the frame edge, which is where the
    // band now is — without this the two land on top of each other, and the
    // only place that is visible is the finished video.
    // ...and only then resized for the frame. The scale goes last because
    // everything above it — preset sizes, the position's margin, the headline
    // clearance — is written against the vertical reference frame, so scaling
    // the finished style once is the only step that cannot leave one of those
    // numbers behind in the wrong coordinate space.
    const captionStyle = scaleStyleToFrame(
      clearOfHeadline(
        applyPosition(styleForPreset(job.subtitle_preset), job.subtitle_position),
        job.headline
      ),
      frame
    );
    const { ass, chunks } = approved
      ? buildSubtitlesFromLines(approved, captionStyle)
      : buildSubtitlesForPlan(plan.words, plan.segments, captionStyle, deps.chunkOptions);
    // A transcript that survives the cut as zero chunks (all filler, or a
    // plan that kept only silence) is not a failure — render without them
    // rather than burning an empty subtitle track.
    if (chunks.length > 0) {
      subtitlePath = path.join(workDir, 'captions.ass');
      await fs.writeFile(subtitlePath, ass, 'utf-8');
    }
    await saveArtifact(db, job, 'subtitles', {
      chunkCount: chunks.length,
      wordCount: chunks.reduce((sum, chunk) => sum + chunk.words.length, 0),
    });

    // Pause here, not earlier: by this point the pauses are cut and the words
    // are on the output timeline, so what the user edits is literally the
    // lines they will see — not a raw transcript they would have to imagine
    // against the finished video.
    if (shouldReview(job.review_mode, transcript.language) && !approved && chunks.length > 0) {
      await saveArtifact(db, job, 'captions', {
        approved: false,
        lines: chunks.map((chunk) => ({
          start: chunk.start,
          end: chunk.end,
          text: chunk.words.map((w) => w.word).join(' '),
        })),
      });
      throw new AwaitingReview();
    }
  }

  // ---- Stage 5: render ---------------------------------------------------
  await setStage(db, job, 'render', now);

  // Written outside the subtitles stage because it does not belong to it: a
  // headline shows whether or not captions were asked for.
  let headlinePath: string | undefined;
  const headlineAss = job.headline
    ? buildHeadlineAss(
        job.headline,
        scaleHeadlineToFrame(
          headlineStyleFor({ font: job.headline_font, size: job.headline_size, colour: job.headline_color }),
          frame
        )
      )
    : null;
  if (headlineAss) {
    headlinePath = path.join(workDir, 'headline.ass');
    await fs.writeFile(headlinePath, headlineAss, 'utf-8');
  }

  // The recorded decision, not a re-evaluation: the card already told the user
  // whether the sound would be cleaned, and deciding twice invites the two to
  // differ.
  const wantsDenoise = Boolean(job.artifacts.noise?.denoised);

  // Cleaned outside the render when the better separator is installed. It
  // works on the whole track before any cutting, so the graph can trim it
  // with the source's own timestamps. A null here is not a failure — the
  // graph falls back to the older in-filter denoiser.
  const cleanedAudioPath = wantsDenoise ? await deps.cleanAudio(sourcePath, workDir) : null;
  try {
    await deps.ffmpeg.render({
      inputPath: sourcePath,
      outputPath,
      workDir,
      segments: plan.segments,
      expectedDurationSec: plan.keptDurationSec,
      subtitlePath,
      // Its presence is also what reserves the band in the filter graph.
      headlinePath,
      // The same frame the two .ass files above were built for. libass sizes
      // their contents against their own PlayRes, so padding to a different
      // shape here would rescale the text with the picture.
      frame,
      // A missing model file must not fail the render: the job still produces
      // a correct cut, just without the noise removal it asked for.
      // The recorded decision, not a re-evaluation: the card already told the
      // user what would happen, and deciding twice invites the two to differ.
      denoiseModelPath: wantsDenoise ? RNNOISE_MODEL_PATH : undefined,
      // When the better cleaner ran, its output supersedes the in-graph one.
      cleanedAudioPath: cleanedAudioPath ?? undefined,
      // Fire-and-forget: a progress write must never be able to fail the
      // render it is only describing.
      onProgress: (fraction) => void reportProgress(db, job.id, 'render', fraction).catch(() => {}),
    });
  } catch (err) {
    throw new PipelineError('render_failed', err instanceof Error ? err.message : String(err));
  }

  // ---- Stage 6: upload ---------------------------------------------------
  await setStage(db, job, 'upload', now);
  const outputKey = `tenants/${job.tenant_id}/renders/${job.id}.mp4`;
  try {
    await storage.upload(outputKey, outputPath, 'video/mp4');
  } catch (err) {
    throw new PipelineError('upload_failed', err instanceof Error ? err.message : String(err));
  }

  // The poster is a convenience, not part of the result: a job that rendered
  // and uploaded successfully must not fail because one extra frame did not
  // encode. Without it the card falls back to a bare <video> element.
  let posterKey: string | null = posterKeyForOutput(outputKey);
  try {
    const posterPath = path.join(workDir, 'poster.jpg');
    await deps.ffmpeg.poster(outputPath, posterPath, posterTimeFor(plan.keptDurationSec));
    await storage.upload(posterKey, posterPath, 'image/jpeg');
  } catch (err) {
    console.warn(`[video-pipeline] job ${job.id}: poster skipped: ${err instanceof Error ? err.message : String(err)}`);
    posterKey = null;
  }

  return { outputKey, posterKey };
}

// Derives the poster's key from the render's, so nothing has to be stored:
// one fewer column, and no way for the two to drift apart.
export function posterKeyForOutput(outputKey: string): string {
  return outputKey.replace(/\.mp4$/i, '.jpg');
}

// A tenth of the way in, capped at 2s. Far enough past the opening frame to
// miss fades and blinks, early enough that a short clip does not land on its
// own ending.
export function posterTimeFor(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  return Math.min(durationSec / 10, 2);
}

// 'on'/'off' are the user overriding the decision; 'auto' defers to the
// measurement. An unmeasurable clip falls back to leaving the audio alone —
// cleaning audio that may not need it is the more destructive mistake.
// Pausing costs the user a round trip, so 'auto' spends it only where the
// transcript cannot be trusted. needsTextCorrection already encodes which
// languages those are — the same list that triggers the multi-pass recovery.
export function shouldReview(mode: string, language: string | null | undefined): boolean {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return needsTextCorrection(language ?? null);
}

export function shouldDenoise(mode: string, headroomDb: number | undefined): boolean {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return headroomDb !== undefined && headroomDb < NOISY_HEADROOM_DB;
}

function requireStorage(deps: PipelineDeps): StorageIo {
  if (!deps.storage) throw new PipelineError('storage_not_configured');
  return deps.storage;
}

async function handleFailure(db: Db, job: VideoEditJob, err: unknown, now: Date): Promise<void> {
  const reason: VideoFailureReason = err instanceof PipelineError ? err.reason : 'video_processing_error';
  const detail = err instanceof Error ? err.message : String(err);

  // attempt_count was already incremented by the claim, so job.attempt_count
  // is this attempt's number.
  if (RETRYABLE.has(reason) && job.attempt_count < MAX_ATTEMPTS) {
    // Releasing the lease is the whole retry mechanism: the row stays
    // 'processing' with its artifacts intact, and the next tick re-claims it
    // and resumes at the stage that has no checkpoint yet.
    console.warn(`[video-pipeline] job ${job.id} attempt ${job.attempt_count} failed (${reason}), will retry: ${detail}`);
    await exec(db, `UPDATE video_edit_jobs SET claimed_at = NULL WHERE id = ? AND status = 'processing'`, job.id);
    return;
  }

  console.error(`[video-pipeline] job ${job.id} failed permanently (${reason}): ${detail}`);
  const updated = await queryAll(
    db,
    `UPDATE video_edit_jobs SET status = 'failed', failure_reason = ?, completed_at = ?, claimed_at = NULL WHERE id = ? AND status = 'processing' RETURNING id`,
    reason,
    now.toISOString(),
    job.id
  );
  // Only notify if this call is the one that actually flipped the row — a
  // second worker losing the race must not send a duplicate push.
  if (updated.length > 0) {
    await notify(db, job.tenant_id, 'video_failed', `Ошибка монтажа: ${reason}`, job.id);
  }
}
