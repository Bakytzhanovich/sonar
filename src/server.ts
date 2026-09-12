import { createApp } from './api';
import { createDb } from './db';
import { publishDuePosts } from './publisher';
import { advanceRenderJobs } from './videoRender';
import { assertMockWebhookConfig } from './webhookAuth';

const PORT = Number(process.env.PORT ?? 4001);
const PUBLISH_POLL_INTERVAL_MS = 15_000;
const RENDER_POLL_INTERVAL_MS = 15_000;

async function main() {
  // Refuses to boot with the mock webhook switched on but no shared secret
  // configured — that combination would expose an unauthenticated endpoint
  // able to send DMs from a client's connected account. Same fail-loudly
  // stance as auth.ts's SESSION_SECRET check.
  assertMockWebhookConfig();

  const db = await createDb();
  const app = createApp(db);

  app.listen(PORT, () => {
    console.log(`Sonar Module 1 API listening on http://localhost:${PORT}`);
  });

  // No Redis/BullMQ (see schema.sql) — this timer is Module 5's entire
  // "job queue" for now. POST /api/scheduled-posts/process-due exists so a
  // demo doesn't have to wait up to 15s for this to tick.
  //
  // Deliberately unscoped (no tenantId): this is server-side infrastructure
  // sweeping every tenant's due posts, which is what a real queue worker
  // would do. The HTTP endpoint is the one that must pass its caller's
  // tenant id, and does.
  setInterval(() => {
    publishDuePosts(db)
      .then(({ processed }) => {
        if (processed > 0) console.log(`[publisher] processed ${processed} due post(s)`);
      })
      .catch((err) => console.error('[publisher] tick failed', err));
  }, PUBLISH_POLL_INTERVAL_MS);

  // Same polling approach for Module 8's mocked render jobs — a job needs
  // ~4 ticks (~1 min) to go from 0% to resolved, simulating a real
  // Shotstack/Creatomate render instead of resolving instantly.
  setInterval(() => {
    advanceRenderJobs(db)
      .then(({ advanced }) => {
        if (advanced > 0) console.log(`[render] advanced ${advanced} job(s)`);
      })
      .catch((err) => console.error('[render] tick failed', err));
  }, RENDER_POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
