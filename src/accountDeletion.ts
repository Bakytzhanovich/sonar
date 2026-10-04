import { exec, queryAll, type Db } from './db';
import { posterKeyForOutput } from './videoPipeline';

// A workspace erased at its owner's request — the right to erasure under
// Kazakhstan's personal data law, for the customer themselves rather than
// for one of their contacts (that is DELETE /api/subscribers/:id).
//
// Every row goes in one transaction, children before parents, so a failure
// halfway leaves the account whole rather than half-erased. Files cannot be
// part of a database transaction, so their keys are collected inside it and
// removed after it commits: a file left behind is storage to tidy, a row left
// behind would be a person's data still on record after they asked us to
// forget it.

export interface ErasedAccount {
  /** Storage keys of every file the workspace owned: uploads, renders,
   *  posters, previews, reels. */
  objectKeys: string[];
}

export async function eraseAccount(db: Db, tenantId: string): Promise<ErasedAccount> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Taken before anything is deleted: the rows are what know the keys.
    const files = await queryAll<{ key: string | null }>(
      client,
      `SELECT source_object_key AS key FROM video_edit_jobs WHERE tenant_id = ?
       UNION SELECT output_object_key FROM video_edit_jobs WHERE tenant_id = ?
       UNION SELECT source_object_key FROM reel_analyses WHERE tenant_id = ?
       UNION SELECT video_object_key FROM scheduled_posts WHERE tenant_id = ?`,
      tenantId,
      tenantId,
      tenantId,
      tenantId
    );
    const renders = await queryAll<{ key: string }>(
      client,
      `SELECT output_object_key AS key FROM video_edit_jobs WHERE tenant_id = ? AND output_object_key IS NOT NULL`,
      tenantId
    );
    // The transcripts of this workspace's recordings, in the cache that
    // spares a second transcription of the same audio.
    const hashes = await queryAll<{ hash: string }>(
      client,
      `SELECT audio_hash AS hash FROM video_edit_jobs WHERE tenant_id = ? AND audio_hash IS NOT NULL
       UNION SELECT audio_hash FROM reel_analyses WHERE tenant_id = ? AND audio_hash IS NOT NULL`,
      tenantId,
      tenantId
    );

    const bots = `(SELECT id FROM bots WHERE tenant_id = ?)`;
    const subscribers = `(SELECT id FROM subscribers WHERE tenant_id = ?)`;
    const statements: string[] = [
      // Bot and CRM: messages and runs hang off subscribers and bots.
      `DELETE FROM mock_sent_messages WHERE subscriber_id IN ${subscribers}`,
      `DELETE FROM flow_runs WHERE tenant_id = ?`,
      `DELETE FROM webhook_events WHERE bot_id IN ${bots}`,
      `DELETE FROM messages WHERE tenant_id = ?`,
      `DELETE FROM notes WHERE tenant_id = ?`,
      `DELETE FROM subscriber_tags WHERE subscriber_id IN ${subscribers}`,
      `DELETE FROM subscribers WHERE tenant_id = ?`,
      `DELETE FROM tags WHERE tenant_id = ?`,
      `DELETE FROM triggers WHERE bot_id IN ${bots}`,
      `DELETE FROM flows WHERE bot_id IN ${bots}`,
      `DELETE FROM bots WHERE tenant_id = ?`,
      // Content.
      `DELETE FROM carousel_slides WHERE tenant_id = ?`,
      `DELETE FROM carousels WHERE tenant_id = ?`,
      `DELETE FROM brand_presets WHERE tenant_id = ?`,
      `DELETE FROM generated_scripts WHERE tenant_id = ?`,
      `DELETE FROM reel_analyses WHERE tenant_id = ?`,
      `DELETE FROM content_calendar WHERE tenant_id = ?`,
      `DELETE FROM content_plans WHERE tenant_id = ?`,
      // Publishing and video. A job's parent and preview links point within
      // the same workspace, and a single statement deleting all of them is
      // checked only once it is done.
      `DELETE FROM scheduled_posts WHERE tenant_id = ?`,
      `DELETE FROM video_edit_jobs WHERE tenant_id = ?`,
      // Access: connected accounts (their tokens), devices, keys, people.
      `DELETE FROM platform_accounts WHERE tenant_id = ?`,
      `DELETE FROM push_subscriptions WHERE tenant_id = ?`,
      `DELETE FROM notifications WHERE tenant_id = ?`,
      `DELETE FROM api_keys WHERE tenant_id = ?`,
      `DELETE FROM users WHERE tenant_id = ?`,
      `DELETE FROM tenants WHERE id = ?`,
    ];
    for (const sql of statements) await exec(client, sql, tenantId);
    if (hashes.length > 0) {
      await exec(client, `DELETE FROM transcript_cache WHERE audio_hash = ANY(?::text[])`, hashes.map((h) => h.hash));
    }
    await client.query('COMMIT');

    const keys = new Set<string>();
    for (const { key } of files) if (key && key.startsWith(`tenants/${tenantId}/`)) keys.add(key);
    for (const { key } of renders) if (key.startsWith(`tenants/${tenantId}/`)) keys.add(posterKeyForOutput(key));
    return { objectKeys: [...keys] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** How long a transcript stays in the cache. Long enough to spare a second
 *  bill for a re-edit or a re-analysis the same month; short enough that the
 *  text of someone's speech is not kept indefinitely for an optimisation. */
export const TRANSCRIPT_CACHE_DAYS = 30;

export async function purgeTranscriptCache(db: Db, now: Date = new Date(), days = TRANSCRIPT_CACHE_DAYS): Promise<number> {
  const removed = await queryAll<{ audio_hash: string }>(
    db,
    `DELETE FROM transcript_cache WHERE created_at < ? RETURNING audio_hash`,
    new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
  );
  return removed.length;
}
