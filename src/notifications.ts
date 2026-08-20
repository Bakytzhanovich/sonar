import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import webpush from 'web-push';
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
export function notify(db: Database.Database, tenantId: string, type: NotificationType, message: string, relatedId?: string): void {
  const id = randomUUID();
  db.prepare(`INSERT INTO notifications (id, tenant_id, type, message, related_id) VALUES (?, ?, ?, ?, ?)`).run(
    id,
    tenantId,
    type,
    message,
    relatedId ?? null
  );

  ensureVapidConfigured();
  const subscriptions = db.prepare(`SELECT * FROM push_subscriptions WHERE tenant_id = ?`).all(tenantId) as PushSubscriptionRecord[];

  for (const sub of subscriptions) {
    webpush
      .sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify({ type, message, relatedId }))
      .catch((err: unknown) => {
        // 404/410 — the push service says this subscription no longer
        // exists on the browser's end. Keeping it would just mean
        // retrying a permanently dead endpoint on every future notify().
        const statusCode = err instanceof webpush.WebPushError ? err.statusCode : undefined;
        if (statusCode === 404 || statusCode === 410) {
          db.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).run(sub.id);
        }
      });
  }
}

export function listNotifications(db: Database.Database, tenantId: string, unreadOnly: boolean): AppNotification[] {
  const query = unreadOnly
    ? `SELECT * FROM notifications WHERE tenant_id = ? AND is_read = 0 ORDER BY created_at DESC, rowid DESC`
    : `SELECT * FROM notifications WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC`;

  const rows = db.prepare(query).all(tenantId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({ ...row, is_read: row.is_read === 1 })) as AppNotification[];
}
