'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type PostingPlatform, type ScheduledPost } from '@/lib/api';
import { useDevConfig } from '@/lib/useDevConfig';

const PLATFORMS: PostingPlatform[] = ['instagram', 'tiktok', 'youtube_shorts'];
const STATUS_LABEL: Record<string, string> = {
  pending_approval: 'Ждёт согласования',
  scheduled: 'Запланировано',
  published: 'Опубликовано',
  failed: 'Ошибка',
  rejected: 'Отклонено',
};
const STATUS_COLOR: Record<string, string> = {
  pending_approval: '#b8860b',
  scheduled: '#1e6fd9',
  published: '#1a9c4a',
  failed: '#c0392b',
  rejected: '#888',
};

function toLocalInputValue(isoFuture: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${isoFuture.getFullYear()}-${pad(isoFuture.getMonth() + 1)}-${pad(isoFuture.getDate())}T${pad(isoFuture.getHours())}:${pad(isoFuture.getMinutes())}`;
}

export default function SchedulerView() {
  const [devConfig] = useDevConfig();
  const { baseUrl, apiKey } = devConfig;
  const config = { baseUrl, apiKey };

  const [platform, setPlatform] = useState<PostingPlatform>('instagram');
  const [caption, setCaption] = useState('Новый пост');
  const [scheduledAt, setScheduledAt] = useState(() => toLocalInputValue(new Date(Date.now() + 5 * 60 * 1000)));
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [posts, setPosts] = useState<ScheduledPost[]>([]);
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    if (!apiKey) return;
    try {
      const res = await api.listScheduledPosts(config);
      setPosts(res.posts);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, baseUrl]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function createPost() {
    if (!caption.trim()) return;
    try {
      await api.createScheduledPost(config, {
        platform,
        caption: caption.trim(),
        scheduledAt: new Date(scheduledAt).toISOString(),
        requiresApproval,
      });
      await load();
      setStatus('Пост добавлен в очередь');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function approve(id: string) {
    try {
      await api.approvePost(config, id);
      await load();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function reject(id: string) {
    try {
      await api.rejectPost(config, id);
      await load();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function processDue() {
    try {
      const res = await api.processDuePosts(config);
      await load();
      setStatus(`Обработано постов: ${res.processed}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  const pending = posts.filter((p) => p.status === 'pending_approval');
  const rest = posts.filter((p) => p.status !== 'pending_approval');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'system-ui, sans-serif' }}>
      <header style={{ padding: 12, borderBottom: '1px solid #ddd', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <strong>Sonar — Автопостинг (мок платформ, без Redis)</strong>
        <span style={{ fontSize: 11, color: '#888' }}>
          {apiKey ? '' : 'Нет apiKey — зайди через редактор бота и нажми "Быстрый старт"'}
        </span>
        <Link href="/" style={{ marginLeft: 'auto' }}>
          ← Редактор бота
        </Link>
        <Link href="/carousels">Карусели →</Link>
        <Link href="/content-plan">Контент-план →</Link>
        <Link href="/video">Видео →</Link>
      </header>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ width: 300, borderRight: '1px solid #ddd', padding: 12, overflowY: 'auto' }}>
          <h4>Новый пост</h4>
          <select value={platform} onChange={(e) => setPlatform(e.target.value as PostingPlatform)} style={{ width: '100%' }}>
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={3} style={{ width: '100%', marginTop: 4 }} />
          <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} style={{ width: '100%', marginTop: 4 }} />
          <label style={{ display: 'block', marginTop: 4 }}>
            <input type="checkbox" checked={requiresApproval} onChange={(e) => setRequiresApproval(e.target.checked)} /> Нужно согласование
          </label>
          <button onClick={createPost} style={{ marginTop: 6 }}>
            Добавить в очередь
          </button>

          <button onClick={processDue} style={{ marginTop: 16, display: 'block' }}>
            Обработать due-посты сейчас
          </button>
          <p style={{ fontSize: 11, color: '#888' }}>Без Redis/BullMQ фоновый опрос идёт раз в 15с — эта кнопка не ждёт таймер.</p>
        </div>

        <div style={{ flex: 1, padding: 12, overflowY: 'auto' }}>
          {pending.length > 0 && (
            <>
              <h3>Ждут согласования</h3>
              {pending.map((p) => (
                <div key={p.id} style={{ border: '1px solid #b8860b', borderRadius: 6, padding: 8, marginBottom: 8 }}>
                  <PostRow post={p} />
                  <button onClick={() => approve(p.id)}>Approve</button> <button onClick={() => reject(p.id)}>Reject</button>
                </div>
              ))}
            </>
          )}

          <h3>Очередь</h3>
          {rest.map((p) => (
            <div key={p.id} style={{ border: '1px solid #ddd', borderRadius: 6, padding: 8, marginBottom: 8 }}>
              <PostRow post={p} />
            </div>
          ))}
          {posts.length === 0 && <p style={{ color: '#888' }}>Пока пусто</p>}

          {status && <div style={{ fontSize: 12, color: '#555', marginTop: 8 }}>{status}</div>}
        </div>
      </div>
    </div>
  );
}

function PostRow({ post }: { post: ScheduledPost }) {
  return (
    <div>
      <span style={{ fontWeight: 'bold' }}>{post.platform}</span> —{' '}
      <span style={{ color: STATUS_COLOR[post.status], fontWeight: 'bold' }}>{STATUS_LABEL[post.status]}</span>
      <div>{post.caption}</div>
      <div style={{ fontSize: 11, color: '#888' }}>
        план: {new Date(post.scheduled_at).toLocaleString()}
        {post.published_at && <> · опубликовано: {new Date(post.published_at).toLocaleString()}</>}
        {post.failure_reason && <> · причина: {post.failure_reason}</>}
      </div>
      {post.external_post_url && (
        <a href={post.external_post_url} target="_blank" rel="noreferrer">
          {post.external_post_url}
        </a>
      )}
    </div>
  );
}
