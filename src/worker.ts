import { createDb, closeDb } from './db';
import { ffmpegAvailable } from './ffmpeg';
import { defaultPipelineDeps, runSmartCutJobs } from './videoPipeline';
import { storageConfigFromEnv } from './storage';
import { localMediaConfigFromEnv } from './localMedia';
import { deriveKey } from './auth';

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

async function main(): Promise<void> {
  const deps = defaultPipelineDeps();

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

  while (!stopping) {
    try {
      const { processed } = await runSmartCutJobs(db, new Date(), deps, CONCURRENCY);
      // Only sleep when there was nothing to do — with a backlog, poll again
      // immediately instead of idling for the interval between every job.
      if (processed === 0) await sleep(POLL_INTERVAL_MS);
    } catch (err) {
      // A throw here is infrastructure (the claim query itself failed), not a
      // job failure — processSmartCutJob handles those internally. Backing
      // off keeps a database outage from becoming a hot retry loop.
      console.error('[worker] tick failed', err);
      await sleep(POLL_INTERVAL_MS);
    }
  }

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
