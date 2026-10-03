'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AppNotification } from '@/lib/api';
import { useDevConfig } from '@/lib/useDevConfig';
import { useApiAccess } from '@/lib/useApiAccess';
import styles from './NotificationBell.module.css';

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) output[i] = rawData.charCodeAt(i);
  return output;
}

// Global bell mounted once in the root layout, not per-page — every page
// shares the same tenant apiKey (via useDevConfig/localStorage), and
// notifications aren't page-specific.
export default function NotificationBell() {
  const [devConfig] = useDevConfig();
  const { baseUrl, apiKey } = devConfig;
  const config = { baseUrl, apiKey };
  // Not the same as holding a key — see useApiAccess: the session is a cookie
  // this code cannot read.
  const { hasAccess } = useApiAccess();

  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [open, setOpen] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [error, setError] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!hasAccess) return;
    try {
      const res = await api.listNotifications(config);
      setNotifications(res.notifications);
    } catch {
      // Silent — a global bell shouldn't interrupt whatever page it's on.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, baseUrl, hasAccess]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Polling is the in-app fallback the ТЗ requires when push isn't
  // permitted — it runs regardless of push permission state, not just
  // when push is unavailable.
  useEffect(() => {
    if (!hasAccess) return;
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [hasAccess, load]);

  async function enablePush() {
    setError('');
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        setError('Этот браузер не умеет присылать уведомления — они будут появляться здесь.');
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setError('Браузер не разрешил уведомления — они всё равно будут появляться здесь.');
        return;
      }

      const registration = await navigator.serviceWorker.register('/sw.js');
      const { publicKey } = await api.getVapidPublicKey(config);
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        // TS's lib.dom Uint8Array/BufferSource generics disagree here even
        // though this is the standard MDN pattern for VAPID key conversion
        // at runtime — a type-level-only mismatch, not a real bug.
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });

      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error('Браузер вернул неполную push-подписку');

      await api.subscribePush(config, { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
      setPushEnabled(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function markAllRead() {
    try {
      await api.markAllNotificationsRead(config);
      await load();
    } catch {
      // ignore
    }
  }

  // Closed by a click anywhere else or by Escape — a dropdown that only the
  // bell itself could close stayed over the page until someone found it.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Signed in, not "holds an API key": customers sign in with a password and
  // a session cookie, and gating on the key hid the bell from every one of
  // them — no "published", no "video ready", no "reconnect Instagram".
  if (!hasAccess) return null;

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.bell}
        onClick={() => setOpen((v) => !v)}
        aria-label={unreadCount > 0 ? `Уведомления: ${unreadCount} новых` : 'Уведомления'}
        aria-expanded={open}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unreadCount > 0 && <span className={styles.badge}>{unreadCount > 9 ? '9+' : unreadCount}</span>}
      </button>

      {open && (
        <div className={styles.panel} role="dialog" aria-label="Уведомления">
          <div className={styles.panelHead}>
            <strong>Уведомления</strong>
            {unreadCount > 0 && (
              <button type="button" className={styles.linkButton} onClick={markAllRead}>
                Прочитать все
              </button>
            )}
          </div>

          {notifications.length === 0 ? (
            <p className={styles.empty}>Пока тихо. Здесь появятся готовые ролики, вышедшие посты и напоминания.</p>
          ) : (
            <ul className={styles.list}>
              {notifications.map((n) => (
                <li key={n.id} className={`${styles.item} ${n.is_read ? styles.itemRead : ''}`}>
                  {!n.is_read && <span className={styles.dot} aria-hidden="true" />}
                  <span className={styles.message}>{n.message}</span>
                  <span className={styles.time}>{new Date(n.created_at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                </li>
              ))}
            </ul>
          )}

          {!pushEnabled && (
            <div className={styles.push}>
              <button type="button" className={styles.linkButton} onClick={enablePush}>
                Присылать уведомления на это устройство
              </button>
              {error && <p className={styles.error}>{error}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
