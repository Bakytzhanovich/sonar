import { createApp } from './api';
import { createDb } from './db';
import { purgeTranscriptCache } from './accountDeletion';
import { maintainTokens } from './platformAccounts';
import { publishDuePosts } from './publisher';
import { keyringFromEnv } from './tokenVault';
import { assertMockWebhookConfig } from './webhookAuth';

const PORT = Number(process.env.PORT ?? 4001);
const PUBLISH_POLL_INTERVAL_MS = 15_000;
// Hourly: tokens are renewed a week ahead, so this has days of slack, and
// each pass is one cheap query when nothing is due.
const TOKEN_UPKEEP_INTERVAL_MS = 60 * 60 * 1000;

async function main() {
  // Refuses to boot with the mock webhook switched on but no shared secret
  // configured — that combination would expose an unauthenticated endpoint
  // able to send DMs from a client's connected account. Same fail-loudly
  // stance as auth.ts's SESSION_SECRET check.
  assertMockWebhookConfig();

  const db = await createDb();
  const app = createApp(db);

  // Read once and shared with the sweep below. Production without
  // TOKEN_ENCRYPTION_KEYS still boots — connecting an account answers "not
  // configured" — but says so here, where a deploy log will show it.
  const tokenKeyring = keyringFromEnv();
  if (!tokenKeyring) console.warn('[tokens] TOKEN_ENCRYPTION_KEYS not set: connecting social accounts is disabled');

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

  // Cached transcripts are the text of people's speech, kept to spare a second
  // transcription bill — for a month, not forever. Here rather than in the
  // worker: the worker's database role may only add to the cache.
  const purge = () =>
    purgeTranscriptCache(db)
      .then((removed) => {
        if (removed > 0) console.log(`[transcripts] из кэша удалено расшифровок: ${removed}`);
      })
      .catch((err) => console.error('[transcripts] purge failed', err));
  void purge();
  setInterval(purge, TOKEN_UPKEEP_INTERVAL_MS);

  // Connected accounts' tokens: renewed before they expire, marked for the
  // person to reconnect when they cannot be, re-sealed after a key rotation.
  if (tokenKeyring) {
    const upkeep = () =>
      maintainTokens(db, tokenKeyring)
        .then(({ refreshed, needsReconnect, reencrypted }) => {
          if (refreshed || needsReconnect || reencrypted) {
            console.log(`[tokens] продлено: ${refreshed}, нужно переподключить: ${needsReconnect}, перешифровано: ${reencrypted}`);
          }
        })
        .catch((err) => console.error('[tokens] upkeep failed', err));
    void upkeep();
    setInterval(upkeep, TOKEN_UPKEEP_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
