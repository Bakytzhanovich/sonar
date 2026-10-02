import { createDb, closeDb } from './db';
import { ffmpegAvailable } from './ffmpeg';
import { sweepExpiredPreviews } from './previewSweep';
import { runReelJobs, type ReelDeps } from './reelPipeline';
import { openAiChatFromEnv } from './reelLlm';
import { defaultPipelineDeps, runSmartCutJobs } from './videoPipeline';
import { storageConfigFromEnv } from './storage';
import { localMediaConfigFromEnv } from './localMedia';
import { deriveKey } from './auth';
import { HEARTBEAT_INTERVAL_MS, recordHeartbeat } from './workerHealth';

// Separate process entry point for Module 8's Level-3 renders. server.ts runs
// the API and the two mock pollers; this runs ffmpeg. They are split because
// a render pins a CPU core for minutes — inside the API process that means
// every HTTP request waits behind it, including /health, which makes the
// platform restart a server that is merely busy.
//
// Deployed as a Render background worker from the same image (see Dockerfile
// and render.yaml). Scale by running more instances, not by raising
// WORKER_CONCURRENCY beyond the instance's core count.

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5_000);
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 1);
// Hourly. The thing being cleaned up expires in hours, so sweeping more often
// would be work that finds nothing, and less often lets a day of trying
// styles pile up before anything is collected.
const SWEEP_INTERVAL_MS = Number(process.env.WORKER_SWEEP_INTERVAL_MS ?? 3_600_000);

async function main(): Promise<void> {
  const deps = defaultPipelineDeps();
  // The reel analysis reuses the video pipeline's storage, ffmpeg and
  // transcriber — same engines, same Kazakh handling — plus the chat model.
  const reelDeps: ReelDeps = {
    storage: deps.storage,
    transcribe: deps.transcribe,
    ffmpeg: { probe: deps.ffmpeg.probe, extractAudio: deps.ffmpeg.extractAudio },
    chat: openAiChatFromEnv(),
  };

  // Both are fatal-at-boot rather than per-job failures on purpose, the same
  // fail-loudly stance as server.ts's mock webhook check: a worker that can
  // neither fetch a source nor run ffmpeg will fail every job it claims, and
  // failing them one by one turns a misconfigured deploy into a queue of
  // permanently dead user jobs instead of an obvious crash loop.
  const usingR2 = Boolean(storageConfigFromEnv());
  const usingLocal = !usingR2 && Boolean(localMediaConfigFromEnv(deriveKey('local-media')));
  if (!usingR2 && !usingLocal) {
    throw new Error('STORAGE_* env vars are required in production: the worker cannot fetch sources or store renders without object storage');
  }
  console.log(`[worker] хранилище: ${usingR2 ? 'R2/S3' : 'локальная ФС (режим разработки)'}`);
  if (!(await ffmpegAvailable())) {
    throw new Error('ffmpeg/ffprobe not found on PATH — the worker image must install them (see Dockerfile)');
  }

  const db = await createDb({
    // The worker does not own the schema. It connects with a role that has
    // no DDL rights (see src/worker-role.sql), and migrations are the API's
    // job at boot — running them from two processes would race anyway.
    skipSchemaSetup: true,
  });
  console.log(`[worker] smart-cut worker started, polling every ${POLL_INTERVAL_MS}ms, concurrency ${CONCURRENCY}`);

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    // No forced abort of an in-flight render: the loop below finishes the
    // current job first. If the platform kills us before it does, the job's
    // lease simply expires and another worker resumes it from its last
    // checkpoint — which is what the lease is for.
    console.log(`[worker] ${signal} received, finishing current job then exiting`);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));

  // On its own timer rather than inside the poll below, because the poll
  // awaits a whole render — minutes, on a long clip. A heartbeat written by
  // the loop would go stale during exactly the work it is meant to report,
  // and the queue would cry wolf on a worker that is busy doing its job.
  //
  // It shares the pool with the render, which is the point: if the connection
  // has silently died, this write hangs or rejects too, and the heartbeat
  // stops. Staleness then means what it claims to mean — this worker is not
  // reaching the database — rather than merely that the process exited.
  const beat = setInterval(() => {
    void recordHeartbeat(db).catch((err) => console.error('[worker] heartbeat failed', err));
  }, HEARTBEAT_INTERVAL_MS);
  // Unref so a pending beat cannot hold the process open after the loop ends.
  beat.unref();

  // Previews expire on their own timer for the same reason the heartbeat
  // does: the poll below awaits a whole render, and a sweep sitting inside it
  // would run once an hour or once a day depending on how busy the queue was.
  const sweep = setInterval(() => {
    void sweepExpiredPreviews(db, deps.storage)
      .then(({ removed, failed }) => {
        if (removed || failed) console.log(`[worker] превью убрано: ${removed}, не удалось: ${failed}`);
      })
      .catch((err) => console.error('[worker] preview sweep failed', err));
  }, SWEEP_INTERVAL_MS);
  sweep.unref();
  await recordHeartbeat(db).catch((err) => console.error('[worker] heartbeat failed', err));

  while (!stopping) {
    try {
      const { processed } = await runSmartCutJobs(db, new Date(), deps, CONCURRENCY);
      // Reels after renders, in the same loop: one worker process, one job at
      // a time, because both lean on the same CPU and the same transcription
      // budget. A reel is short, so it never holds a render up for long.
      const { processed: reels } = await runReelJobs(db, new Date(), reelDeps, CONCURRENCY);
      // Only sleep when there was nothing to do — with a backlog, poll again
      // immediately instead of idling for the interval between every job.
      if (processed === 0 && reels === 0) await sleep(POLL_INTERVAL_MS);
    } catch (err) {
      // A throw here is infrastructure (the claim query itself failed), not a
      // job failure — processSmartCutJob handles those internally. Backing
      // off keeps a database outage from becoming a hot retry loop.
      console.error('[worker] tick failed', err);
      await sleep(POLL_INTERVAL_MS);
    }
  }

  clearInterval(sweep);
  clearInterval(beat);
  await closeDb(db);
  console.log('[worker] stopped');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
