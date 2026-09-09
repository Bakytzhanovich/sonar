import { randomUUID } from 'node:crypto';
import webpush from 'web-push';
import { exec, queryAll, type Db } from './db';
import { getOrCreateVapidKeys } from './vapidKeys';
import type { AppNotification, NotificationType, PushSubscriptionRecord } from './types';

let vapidConfigured = false;
function ensureVapidConfigured(): void {
  if (vapidConfigured) return;
  const keys = getOrCreateVapidKeys();
  webpush.setVapidDetails('mailto:dev@sonar.local', keys.publicKey, keys.privateKey);
  vapidConfigured = true;
}

// Always writes an in-app notification first — this is the ТЗ's required
// fallback for when push isn't permitted in the browser, not an
// afterthought. Push delivery to every subscription this tenant has is
// best-effort on top of that: a push failure is caught and never
// propagates, because the in-app row already exists regardless of
// whether the push succeeds.
export async function notify(db: Db, tenantId: string, type: NotificationType, message: string, relatedId?: string): Promise<void> {
  const id = randomUUID();
  await exec(db, `INSERT INTO notifications (id, tenant_id, type, message, related_id) VALUES (?, ?, ?, ?, ?)`, id, tenantId, type, message, relatedId ?? null);

  ensureVapidConfigured();
  const subscriptions = await queryAll<PushSubscriptionRecord>(db, `SELECT * FROM push_subscriptions WHERE tenant_id = ?`, tenantId);

  for (const sub of subscriptions) {
    webpush
      .sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify({ type, message, relatedId }))
      .catch(async (err: unknown) => {
        // 404/410 — the push service says this subscription no longer
        // exists on the browser's end. Keeping it would just mean
        // retrying a permanently dead endpoint on every future notify().
        const statusCode = err instanceof webpush.WebPushError ? err.statusCode : undefined;
        if (statusCode === 404 || statusCode === 410) {
          try {
            await exec(db, `DELETE FROM push_subscriptions WHERE id = ?`, sub.id);
          } catch {
            // Best-effort cleanup — nothing awaits notify()'s push delivery,
            // so a transient DB error here (pool exhaustion, connection
            // reset) must not become an unhandled rejection. The stale row
            // just survives until the next notify() retries this cleanup.
          }
        }
      });
  }
}

export async function listNotifications(db: Db, tenantId: string, unreadOnly: boolean): Promise<AppNotification[]> {
  const query = unreadOnly
    ? `SELECT * FROM notifications WHERE tenant_id = ? AND is_read = false ORDER BY created_at DESC, seq DESC`
    : `SELECT * FROM notifications WHERE tenant_id = ? ORDER BY created_at DESC, seq DESC`;

  return queryAll<AppNotification>(db, query, tenantId);
}
