'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type PlatformAccount, type PostingPlatform, type ScheduledPost, type VideoEditJob } from '@/lib/api';
import { useDevConfig } from '@/lib/useDevConfig';
import { STAFF_BOOTSTRAP_AVAILABLE, useApiAccess } from '@/lib/useApiAccess';
import ModuleNav from './ModuleNav';
import TabBar from './TabBar';
import Switch from './Switch';
import PillPicker from './PillPicker';
import NoticeBanner, { MISSING_API_KEY_MESSAGE } from './NoticeBanner';
import PulseIndicator from './PulseIndicator';
import StatusMessage from './StatusMessage';
import controls from './Controls.module.css';
import layout from './Layout.module.css';
import styles from './SchedulerView.module.css';

// Module 5 — a reel, a platform and a time.
//
// A post is a video first: the platforms this publishes to take nothing else.
// The video is either a finished render from the editor — the usual path,
// "edited it, now post it", which the editor links to with ?video=<job> — or
// a file uploaded here.

const PLATFORMS: Array<{ id: PostingPlatform; label: string }> = [
  { id: 'instagram', label: 'Instagram' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'youtube_shorts', label: 'YouTube Shorts' },
];
const PLATFORM_LABEL: Record<string, string> = Object.fromEntries(PLATFORMS.map((p) => [p.id, p.label]));

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
const STATUS_COLOR: Record<string, string> = {
  pending_approval: 'var(--status-pending)',
  scheduled: 'var(--status-scheduled)',
  publishing: 'var(--status-scheduled)',
  published: 'var(--status-published)',
  failed: 'var(--status-failed)',
  rejected: 'var(--foreground-muted)',
};
const FAILURE_LABEL: Record<string, string> = {
  token_expired: 'Доступ к аккаунту истёк — подключите его заново',
  rejected_by_platform: 'Платформа отклонила публикацию',
  rate_limited: 'Слишком много публикаций подряд — платформа просит подождать',
  no_video: 'К посту не прикреплено видео',
};
const CREATE_ERRORS: Record<string, string> = {
  video_not_ready: 'Этот ролик ещё не готов — дождитесь конца монтажа',
  'video job not found': 'Ролик не найден',
  'video is required': 'Выберите видео для поста',
  storage_not_configured: 'Загрузка файлов сейчас недоступна',
};

// Instagram sends the person back to /scheduler?instagram=<outcome>.
const CONNECT_OUTCOME: Record<string, string> = {
  connected: 'Instagram подключён',
  denied: 'Подключение отменено на стороне Instagram',
  expired: 'Ссылка подключения устарела — нажмите «Подключить Instagram» ещё раз',
  failed: 'Instagram не подтвердил подключение — попробуйте ещё раз',
  unavailable: 'Подключение Instagram сейчас недоступно',
};

// Read without side effects: React may call a state initialiser twice, and a
// reader that also cleared the address would find nothing the second time.
function connectOutcomeFromAddress(): string {
  if (typeof window === 'undefined') return '';
  return CONNECT_OUTCOME[new URLSearchParams(window.location.search).get('instagram') ?? ''] ?? '';
}

/** Said once: a reload must not announce the same connection again. */
function forgetConnectOutcome(): void {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('instagram')) return;
  params.delete('instagram');
  const rest = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
}

const SOURCE_OPTIONS = [
  { id: 'render', label: 'Мой монтаж' },
  { id: 'upload', label: 'Загрузить файл' },
];

function errorText(err: unknown, table: Record<string, string>): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = Object.keys(table).find((key) => message.includes(key));
  return code ? table[code] : message;
}

function toLocalInputValue(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// The editor hands a render over in the address, so the person lands here
// with it already chosen. Read once: the page is client-only.
function videoFromAddress(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('video');
}

// Renders a post can be made from: finished, from the real pipeline. The
// mock levels hand back a link to a file that does not exist.
function isPostable(job: VideoEditJob): boolean {
  return job.status === 'completed' && job.pipeline === 'smart_cut' && Boolean(job.output_url);
}

export default function SchedulerView() {
  const [devConfig] = useDevConfig();
  const { baseUrl, apiKey } = devConfig;
  const config = { baseUrl, apiKey };
  // Not the same as holding a key — see useApiAccess: the session is a cookie
  // this code cannot read.
  const { hasAccess } = useApiAccess();

  const [source, setSource] = useState<'render' | 'upload'>('render');
  const [renders, setRenders] = useState<VideoEditJob[]>([]);
  const [rendersLoaded, setRendersLoaded] = useState(false);
  const [jobId, setJobId] = useState<string | null>(videoFromAddress);
  const [file, setFile] = useState<File | null>(null);
  const [platform, setPlatform] = useState<PostingPlatform>('instagram');
  const [caption, setCaption] = useState('');
  const [scheduledAt, setScheduledAt] = useState(() => toLocalInputValue(new Date(Date.now() + 60 * 60 * 1000)));
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [posts, setPosts] = useState<ScheduledPost[]>([]);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(connectOutcomeFromAddress);

  const load = useCallback(async () => {
    if (!hasAccess) return;
    try {
      const res = await api.listScheduledPosts(config);
      setPosts(res.posts);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, baseUrl, hasAccess]);

  const loadRenders = useCallback(async () => {
    if (!hasAccess) return;
    try {
      const res = await api.listVideoJobs(config);
      const ready = res.jobs.filter(isPostable);
      setRenders(ready);
      // Nothing edited yet: the upload is the only way to make a post, so
      // open on it instead of on an empty list.
      if (ready.length === 0) setSource('upload');
    } catch {
      setSource('upload');
    } finally {
      setRendersLoaded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, baseUrl, hasAccess]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    loadRenders();
  }, [load, loadRenders]);

  useEffect(forgetConnectOutcome, []);

  const videoChosen = source === 'render' ? Boolean(jobId && renders.some((r) => r.id === jobId)) : Boolean(file);

  async function createPost() {
    if (!videoChosen) return setStatus('Выберите видео для поста');
    if (!caption.trim()) return setStatus('Напишите текст поста');
    const when = new Date(scheduledAt);
    if (Number.isNaN(when.getTime())) return setStatus('Укажите дату и время');
    setSaving(true);
    setStatus('');
    try {
      let video: { videoJobId?: string; videoObjectKey?: string };
      if (source === 'upload' && file) {
        const ticket = await api.createVideoUpload(config, file.type || 'video/mp4');
        await api.uploadVideoFile(ticket, file);
        video = { videoObjectKey: ticket.objectKey };
      } else {
        video = { videoJobId: jobId! };
      }
      await api.createScheduledPost(config, {
        platform,
        caption: caption.trim(),
        scheduledAt: when.toISOString(),
        requiresApproval,
        ...video,
      });
      await load();
      setCaption('');
      setFile(null);
      setStatus(requiresApproval ? 'Пост ждёт согласования' : `Запланировано на ${when.toLocaleString()}`);
    } catch (err) {
      setStatus(errorText(err, CREATE_ERRORS));
    } finally {
      setSaving(false);
    }
  }

  async function decide(id: string, action: 'approve' | 'reject') {
    try {
      await (action === 'approve' ? api.approvePost(config, id) : api.rejectPost(config, id));
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

          <PillPicker label="Видео" options={SOURCE_OPTIONS} value={source} onChange={(id) => setSource(id as 'render' | 'upload')} />

          {source === 'render' && (
            <>
              {renders.length > 0 ? (
                <div className={styles.renderGrid} role="listbox" aria-label="Готовые ролики">
                  {renders.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      role="option"
                      aria-selected={jobId === r.id}
                      className={`${styles.renderTile} ${jobId === r.id ? styles.renderTileActive : ''}`}
                      onClick={() => setJobId(r.id)}
                      title={new Date(r.completed_at ?? r.created_at).toLocaleString()}
                    >
                      {r.poster_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={r.poster_url} alt="" />
                      ) : (
                        <video src={r.output_url ?? undefined} preload="metadata" muted playsInline />
                      )}
                      <span className={styles.renderDate}>{new Date(r.completed_at ?? r.created_at).toLocaleDateString()}</span>
                    </button>
                  ))}
                </div>
              ) : (
                rendersLoaded && (
                  <p className={styles.hint}>
                    Готовых роликов пока нет. <a href="/video">Смонтировать</a> или загрузите файл.
                  </p>
                )
              )}
            </>
          )}

          {source === 'upload' && (
            // Styled as a target, because the native input is a tiny OS
            // button with English text on it.
            <label className={`${styles.dropzone} ${file ? styles.dropzoneFilled : ''}`}>
              <input
                className={styles.hiddenInput}
                type="file"
                accept="video/mp4,video/quicktime,video/webm"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <span className={styles.dropzoneTitle}>{file ? file.name : 'Выбрать видео'}</span>
              <span className={styles.dropzoneHint}>
                {file ? `${(file.size / 1024 / 1024).toFixed(1)} МБ · нажмите, чтобы заменить` : 'Вертикальное видео, MP4 или MOV'}
              </span>
            </label>
          )}

          <PillPicker label="Куда" options={PLATFORMS} value={platform} onChange={(id) => setPlatform(id as PostingPlatform)} />

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Текст поста</span>
            <textarea
              className={controls.input}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              rows={4}
              placeholder="Подпись, хэштеги, призыв написать в директ"
            />
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Когда публиковать</span>
            <input className={controls.input} type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
          </label>

          <Switch
            checked={requiresApproval}
            onChange={setRequiresApproval}
            label="Нужно согласование"
            hint="Пост не выйдет, пока его не одобрят"
          />

          {/* Secondary, not primary: "Запланировать" and "Одобрить" (below)
              can both be on screen at once. Approve is the more decisive of
              the two, so it's the one solid-accent button when both show. */}
          <button
            className={`${pending.length > 0 ? controls.buttonSecondary : controls.buttonPrimary} ${styles.fullButton}`}
            onClick={createPost}
            disabled={saving || !hasAccess}
          >
            {saving ? (source === 'upload' ? 'Загружаю видео…' : 'Сохраняю…') : 'Запланировать'}
          </button>

          {STAFF_BOOTSTRAP_AVAILABLE && (
            <>
              <div className={styles.divider} />
              <button className={controls.buttonSecondary} onClick={processDue}>
                Опубликовать наступившие сейчас
              </button>
              <p className={styles.hint}>Только в разработке: фоновый опрос идёт раз в 15с, кнопка его не ждёт.</p>
            </>
          )}
        </div>

        <div className={`${layout.main} ${styles.main}`}>
          {/* Said plainly: until an account is connected through the
              platform's own review, nothing here reaches a real feed, and a
              post marked "Опубликовано" must not be mistaken for one that is. */}
          <AccountsPanel config={config} hasAccess={hasAccess} onMessage={setStatus} />

          <NoticeBanner>
            Публикация в соцсети подключается: сейчас посты проходят очередь и расписание, но в аккаунт не уходят.
          </NoticeBanner>

          {pending.length > 0 && (
            <>
              <h3>Ждут согласования</h3>
              {pending.map((p) => (
                <div key={p.id} className={styles.postCard} style={{ borderLeftColor: STATUS_COLOR[p.status] }}>
                  <PostRow post={p} />
                  <div className={controls.decisionPair}>
                    <button className={controls.buttonPrimary} onClick={() => decide(p.id, 'approve')}>Одобрить</button>
                    <button className={controls.buttonSecondary} onClick={() => decide(p.id, 'reject')}>Отклонить</button>
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
          {posts.length === 0 && <div className={styles.emptyState}><div><div className={styles.emptyIcon}>↗</div><h2>Очередь свободна</h2><p>Выберите ролик слева, напишите текст и время — пост встанет сюда.</p></div></div>}

          <StatusMessage>{status}</StatusMessage>
        </div>
      </div>
      <TabBar current="/scheduler" />
    </div>
  );
}

function PostRow({ post }: { post: ScheduledPost }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // The mock publisher's links point at a host that does not exist.
  const realLink = post.external_post_url && !/\.mock\//.test(post.external_post_url) ? post.external_post_url : null;

  return (
    <div className={styles.postRow}>
      {post.video_url ? (
        <video
          ref={videoRef}
          className={styles.postVideo}
          src={post.video_url}
          preload="metadata"
          muted
          playsInline
          // A tap plays it — controls on something this small are just noise.
          onClick={() => {
            const v = videoRef.current;
            if (v) void (v.paused ? v.play() : v.pause());
          }}
        />
      ) : (
        <div className={`${styles.postVideo} ${styles.postVideoMissing}`}>нет видео</div>
      )}
      <div className={styles.postBody}>
        <div className={styles.postHeader}>
          <span className={styles.platformLabel}>{PLATFORM_LABEL[post.platform] ?? post.platform}</span>
          <span className={styles.statusBadge} style={{ '--status-color': STATUS_COLOR[post.status] } as React.CSSProperties}>
            {STATUS_LABEL[post.status]}
          </span>
        </div>
        <div className={styles.postCaption}>{post.caption}</div>
        <div className={styles.postMeta}>
          {post.published_at
            ? <>опубликовано {new Date(post.published_at).toLocaleString()}</>
            : <>на {new Date(post.scheduled_at).toLocaleString()}</>}
        </div>
        {post.failure_reason && <div className={styles.postFailure}>{FAILURE_LABEL[post.failure_reason] ?? post.failure_reason}</div>}
        {realLink && (
          <a href={realLink} target="_blank" rel="noreferrer">Открыть публикацию</a>
        )}
      </div>
    </div>
  );
}

// The accounts posts go to. Connecting is a trip to Instagram's own sign-in —
// we never see a password — and the token it hands back never reaches this
// screen; what does is who, and whether it still works.
function AccountsPanel({
  config,
  hasAccess,
  onMessage,
}: {
  config: { baseUrl: string; apiKey: string };
  hasAccess: boolean;
  onMessage: (message: string) => void;
}) {
  const [accounts, setAccounts] = useState<PlatformAccount[]>([]);
  const [instagramAvailable, setInstagramAvailable] = useState(false);
  const [testAvailable, setTestAvailable] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!hasAccess) return;
    try {
      const res = await api.listPlatformAccounts(config);
      setAccounts(res.accounts);
      setInstagramAvailable(res.instagramAvailable);
      setTestAvailable(res.testConnectAvailable);
    } catch {
      // The panel is not the screen's main job; the queue still works.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.apiKey, config.baseUrl, hasAccess]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function connect() {
    setBusy(true);
    try {
      const { authorizeUrl } = await api.connectInstagram(config);
      // Leaves the page: Instagram brings the person back here.
      window.location.assign(authorizeUrl);
    } catch (err) {
      onMessage(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function connectTest() {
    try {
      await api.connectTestAccount(config);
      await load();
      onMessage('Тестовый аккаунт подключён');
    } catch (err) {
      onMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function disconnect(account: PlatformAccount) {
    const who = account.username ? `@${account.username}` : 'аккаунт';
    if (!window.confirm(`Отключить ${who}? Запланированные в него посты не выйдут, пока аккаунт не подключат снова.`)) return;
    try {
      await api.disconnectAccount(config, account.id);
      await load();
      onMessage(`${who} отключён`);
    } catch (err) {
      onMessage(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className={styles.accounts}>
      <div className={styles.accountsHead}>
        <h3>Аккаунты</h3>
        <div className={styles.accountsActions}>
          {testAvailable && (
            <button type="button" className={controls.buttonSecondary} onClick={connectTest} disabled={!hasAccess}>
              Тестовое подключение
            </button>
          )}
          <button
            type="button"
            className={controls.buttonSecondary}
            onClick={connect}
            disabled={!instagramAvailable || busy || !hasAccess}
          >
            {busy ? 'Открываю Instagram…' : 'Подключить Instagram'}
          </button>
        </div>
      </div>

      {!instagramAvailable && (
        <p className={styles.accountsHint}>Подключение Instagram откроется после одобрения приложения в Meta.</p>
      )}

      {accounts.length > 0 ? (
        <ul className={styles.accountList}>
          {accounts.map((a) => (
            <li key={a.id} className={styles.accountItem}>
              <span className={styles.accountAvatar} aria-hidden="true">{(a.username ?? '?').slice(0, 1).toUpperCase()}</span>
              <span className={styles.accountName}>
                {a.username ? `@${a.username}` : 'Instagram'}
                <span className={styles.accountMeta}>
                  {PLATFORM_LABEL[a.platform] ?? a.platform}
                  {a.is_test && ' · тестовый'}
                </span>
              </span>
              {a.status === 'needs_reconnect' ? (
                <button type="button" className={styles.accountWarn} onClick={connect} disabled={!instagramAvailable}>
                  Переподключить
                </button>
              ) : (
                <span className={styles.accountOk}>подключён</span>
              )}
              <button type="button" className={styles.accountRemove} onClick={() => disconnect(a)}>
                Отключить
              </button>
            </li>
          ))}
        </ul>
      ) : (
        instagramAvailable && <p className={styles.accountsHint}>Пока ни одного аккаунта. Подключите Instagram, чтобы посты уходили в него.</p>
      )}
    </section>
  );
}
