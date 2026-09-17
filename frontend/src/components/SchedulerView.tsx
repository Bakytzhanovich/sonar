'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type PostingPlatform, type ScheduledPost } from '@/lib/api';
import { useDevConfig } from '@/lib/useDevConfig';
import { useApiAccess } from '@/lib/useApiAccess';
import ModuleNav from './ModuleNav';
import TabBar from './TabBar';
import Select from './Select';
import Switch from './Switch';
import NoticeBanner, { MISSING_API_KEY_MESSAGE } from './NoticeBanner';
import PulseIndicator from './PulseIndicator';
import StatusMessage from './StatusMessage';
import controls from './Controls.module.css';
import layout from './Layout.module.css';
import styles from './SchedulerView.module.css';

const PLATFORMS: PostingPlatform[] = ['instagram', 'tiktok', 'youtube_shorts'];
const STATUS_LABEL: Record<string, string> = {
  pending_approval: 'Ждёт согласования',
  scheduled: 'Запланировано',
  publishing: 'Публикуется',
  published: 'Опубликовано',
  failed: 'Ошибка',
  rejected: 'Отклонено',
};
// Category colors, same precedent as FlowEditor's node-type colors — not
// the screen's one reserved accent. "rejected" isn't a hue at all, same
// muted token a disabled control uses, since it's an inactive state.
// "publishing" is the brief in-flight claim state set by publishDuePosts
// (see schema.sql) — reuses the scheduled color since there's no dedicated
// token and it's the same "about to be live" family.
const STATUS_COLOR: Record<string, string> = {
  pending_approval: 'var(--status-pending)',
  scheduled: 'var(--status-scheduled)',
  publishing: 'var(--status-scheduled)',
  published: 'var(--status-published)',
  failed: 'var(--status-failed)',
  rejected: 'var(--foreground-muted)',
};

function toLocalInputValue(isoFuture: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${isoFuture.getFullYear()}-${pad(isoFuture.getMonth() + 1)}-${pad(isoFuture.getDate())}T${pad(isoFuture.getHours())}:${pad(isoFuture.getMinutes())}`;
}

export default function SchedulerView() {
  const [devConfig] = useDevConfig();
  const { baseUrl, apiKey } = devConfig;
  const config = { baseUrl, apiKey };
  // Not the same as holding a key — see useApiAccess: the session is a cookie
  // this code cannot read.
  const { hasAccess } = useApiAccess();

  const [platform, setPlatform] = useState<PostingPlatform>('instagram');
  const [caption, setCaption] = useState('Новый пост');
  const [scheduledAt, setScheduledAt] = useState(() => toLocalInputValue(new Date(Date.now() + 5 * 60 * 1000)));
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [posts, setPosts] = useState<ScheduledPost[]>([]);
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    if (!hasAccess) return;
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
    <div className={styles.page}>
      <header className={layout.header}>
        <div className={styles.headerTitle}><span className={styles.eyebrow}>ПУБЛИКАЦИЯ</span><span className={layout.title}>Автопостинг</span></div>
        {pending.length > 0 && <PulseIndicator count={pending.length} label="постов ждут согласования" />}
        <ModuleNav current="/scheduler" />
      </header>

      <div className={layout.twoPane}>
        <div className={`${layout.sidebar} ${styles.sidebar}`}>
          {!hasAccess && <NoticeBanner>{MISSING_API_KEY_MESSAGE}</NoticeBanner>}
          <div className={styles.sectionLabel}>Новый пост</div>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Платформа</span>
            <Select
              value={platform}
              onChange={(next) => setPlatform(next as PostingPlatform)}
              options={PLATFORMS.map((p) => ({ value: p, label: p }))}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Текст поста</span>
            <textarea className={controls.input} value={caption} onChange={(e) => setCaption(e.target.value)} rows={3} />
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Когда публиковать</span>
            <input className={controls.input} type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
          </label>

          <Switch
            checked={requiresApproval}
            onChange={setRequiresApproval}
            label="Нужно согласование"
            hint="Пост встанет в очередь и будет ждать подтверждения"
          />

          {/* Secondary, not primary: "Добавить в очередь" and "Approve" (below)
              can both be on screen at once — the left form is always rendered,
              "Ждут согласования" appears alongside it whenever a post is
              pending. Approve is the more final/decisive action of the two,
              so it's the one solid-accent button when both are visible. */}
          <button className={`${controls.buttonPrimary} ${styles.fullButton}`} onClick={createPost}>
            Добавить в очередь
          </button>

          <div className={styles.divider} />
          <button className={controls.buttonSecondary} onClick={processDue}>
            Обработать due-посты сейчас
          </button>
          <p className={styles.hint}>Без Redis/BullMQ фоновый опрос идёт раз в 15с — эта кнопка не ждёт таймер.</p>
        </div>

        <div className={`${layout.main} ${styles.main}`}>
          {pending.length > 0 && (
            <>
              <h3>Ждут согласования</h3>
              {pending.map((p) => (
                <div key={p.id} className={styles.postCard} style={{ borderLeftColor: STATUS_COLOR[p.status] }}>
                  <PostRow post={p} />
                  <div className={controls.decisionPair}>
                    <button className={controls.buttonPrimary} onClick={() => approve(p.id)}>Approve</button>
                    <button className={controls.buttonSecondary} onClick={() => reject(p.id)}>Reject</button>
                  </div>
                </div>
              ))}
            </>
          )}

          <div className={styles.queueHeader}><h2>Очередь</h2><span className={styles.queueCount}>{posts.length} публикаций</span></div>
          {rest.map((p) => (
            <div key={p.id} className={styles.postCard} style={{ borderLeftColor: STATUS_COLOR[p.status] }}>
              <PostRow post={p} />
            </div>
          ))}
          {posts.length === 0 && <div className={styles.emptyState}><div><div className={styles.emptyIcon}>↗</div><h2>Очередь свободна</h2><p>Запланированные публикации появятся здесь.</p></div></div>}

          <StatusMessage>{status}</StatusMessage>
        </div>
      </div>
      <TabBar current="/scheduler" />
    </div>
  );
}

function PostRow({ post }: { post: ScheduledPost }) {
  return (
    <div>
      <div className={styles.postHeader}>
        <span className={styles.platformLabel}>{post.platform}</span>
        <span className={styles.statusBadge} style={{ '--status-color': STATUS_COLOR[post.status] } as React.CSSProperties}>
          {STATUS_LABEL[post.status]}
        </span>
      </div>
      <div>{post.caption}</div>
      <div className={styles.postMeta}>
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
