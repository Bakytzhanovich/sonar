'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type AppNotification } from '@/lib/api';
import { useDevConfig } from '@/lib/useDevConfig';
import controls from './Controls.module.css';

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

  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [open, setOpen] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!apiKey) return;
    try {
      const res = await api.listNotifications(config);
      setNotifications(res.notifications);
    } catch {
      // Silent — a global bell shouldn't interrupt whatever page it's on.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, baseUrl]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Polling is the in-app fallback the ТЗ requires when push isn't
  // permitted — it runs regardless of push permission state, not just
  // when push is unavailable.
  useEffect(() => {
    if (!apiKey) return;
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [apiKey, load]);

  async function enablePush() {
    setError('');
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        setError('Push не поддерживается этим браузером');
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setError('Разрешение на уведомления не дано — доступны только in-app уведомления (список выше)');
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

  if (!apiKey) return null;

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  return (
    <div style={{ position: 'relative' }}>
      <button className={controls.buttonSecondary} onClick={() => setOpen((v) => !v)}>
        🔔{unreadCount > 0 && <span style={{ marginLeft: 4, color: 'var(--status-failed)', fontWeight: 'bold' }}>{unreadCount}</span>}
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: '100%',
            width: 320,
            maxHeight: 400,
            overflowY: 'auto',
            background: 'var(--background)',
            color: 'var(--foreground)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: 10,
            zIndex: 10,
          }}
        >
          {!pushEnabled && (
            <div style={{ marginBottom: 8 }}>
              <button className={controls.buttonSecondary} onClick={enablePush}>Включить push-уведомления</button>
              {error && <p style={{ fontSize: 11, color: 'var(--status-failed)' }}>{error}</p>}
            </div>
          )}
          <button className={controls.buttonSecondary} onClick={markAllRead} style={{ fontSize: 11 }}>
            Отметить все прочитанными
          </button>
          {notifications.length === 0 && <p style={{ fontSize: 12, color: 'var(--foreground-muted)' }}>Пусто</p>}
          {notifications.map((n) => (
            <div key={n.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', opacity: n.is_read ? 0.6 : 1 }}>
              <div style={{ fontSize: 12 }}>{n.message}</div>
              <div style={{ fontSize: 10, color: 'var(--foreground-muted)' }}>{new Date(n.created_at).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
