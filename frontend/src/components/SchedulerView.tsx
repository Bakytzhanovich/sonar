'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { count, plural } from '@/lib/plural';
import { api, type PlatformAccount, type PostingPlatform, type ScheduledPost, type VideoEditJob } from '@/lib/api';
import { useDevConfig } from '@/lib/useDevConfig';
import { STAFF_BOOTSTRAP_AVAILABLE, useApiAccess } from '@/lib/useApiAccess';
import PageHeader from './PageHeader';
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
  processing_failed: 'Instagram не смог обработать видео',
  processing_timeout: 'Instagram слишком долго обрабатывал видео — попробуйте запланировать ещё раз',
  publish_failed: 'Instagram не отвечал несколько раз подряд — попробуйте запланировать ещё раз',
  account_unavailable: 'Аккаунт отключён или недоступен — подключите его снова',
};
const WAITING_LABEL: Record<string, string> = {
  pace: 'Ждёт паузы между публикациями — так аккаунт не выглядит как бот',
  instagram_limit: 'Дневной лимит Instagram исчерпан — пост выйдет, как только он обновится',
};
// The answers the cancel, edit and retry buttons can get, in words.
const CHANGE_ERRORS: Record<string, string> = {
  already_publishing: 'Пост уже передан в Instagram — изменить или отменить его нельзя',
  already_published: 'Пост уже опубликован',
  account_needs_reconnect: 'Сначала переподключите аккаунт — блок «Аккаунты» выше',
  account_unavailable: 'Аккаунт отключён — подключите его снова или удалите пост',
  no_video: 'К посту не прикреплено видео — создайте пост заново',
  caption: 'Текст поста не может быть пустым',
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
  const [accounts, setAccounts] = useState<PlatformAccount[]>([]);
  const [accountId, setAccountId] = useState('');
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

  // The accounts a post on this platform can go to. None: the post goes
  // through the test publisher, which the notice on the right says plainly.
  const usableAccounts = accounts.filter((a) => a.platform === platform && a.status === 'active');
  const chosenAccount = usableAccounts.find((a) => a.id === accountId) ?? usableAccounts[0];
  const hasRealAccount = accounts.some((a) => !a.is_test && a.status === 'active');
  const accountName = (id: string | null) => {
    const a = accounts.find((x) => x.id === id);
    return a ? `@${a.username ?? 'аккаунт'}` : null;
  };

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
        ...(chosenAccount ? { platformAccountId: chosenAccount.id } : {}),
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
      <PageHeader section="Публикация" title="Автопостинг" current="/scheduler">
        {pending.length > 0 && <PulseIndicator count={pending.length} label={plural(pending.length, ['пост ждёт согласования', 'поста ждут согласования', 'постов ждут согласования'])} />}
      </PageHeader>

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

          {usableAccounts.length > 1 && (
            <PillPicker
              label="Аккаунт"
              options={usableAccounts.map((a) => ({ id: a.id, label: `@${a.username ?? 'аккаунт'}`, badge: a.is_test ? 'тест' : undefined }))}
              value={chosenAccount?.id ?? ''}
              onChange={setAccountId}
            />
          )}
          {usableAccounts.length === 1 && chosenAccount && (
            <p className={styles.hint}>Уйдёт в @{chosenAccount.username ?? 'аккаунт'}{chosenAccount.is_test ? ' (тестовый)' : ''}</p>
          )}

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
          <AccountsPanel config={config} hasAccess={hasAccess} onMessage={setStatus} onAccounts={setAccounts} />

          {/* Said plainly where nothing reaches a real feed, so "Опубликовано"
              on a test post is never mistaken for a real one. */}
          <NoticeBanner>
            {hasRealAccount
              ? 'В Instagram посты уходят по-настоящему. TikTok и YouTube Shorts пока в тестовом режиме: туда посты не уходят.'
              : 'Пока не подключён Instagram, посты проходят очередь и расписание, но в аккаунт не уходят.'}
          </NoticeBanner>

          {pending.length > 0 && (
            <>
              <h3>Ждут согласования</h3>
              {pending.map((p) => (
                <div key={p.id} className={styles.postCard} style={{ borderLeftColor: STATUS_COLOR[p.status] }}>
                  <PostRow post={p} account={accountName(p.platform_account_id)} config={config} accounts={accounts} onChanged={load} onMessage={setStatus} />
                  <div className={controls.decisionPair}>
                    <button className={controls.buttonPrimary} onClick={() => decide(p.id, 'approve')}>Одобрить</button>
                    <button className={controls.buttonSecondary} onClick={() => decide(p.id, 'reject')}>Отклонить</button>
                  </div>
                </div>
              ))}
            </>
          )}

          <div className={styles.queueHeader}><h2>Очередь</h2><span className={styles.queueCount}>{count(posts.length, ['публикация', 'публикации', 'публикаций'])}</span></div>
          {rest.map((p) => (
            <div key={p.id} className={styles.postCard} style={{ borderLeftColor: STATUS_COLOR[p.status] }}>
              <PostRow post={p} account={accountName(p.platform_account_id)} config={config} accounts={accounts} onChanged={load} onMessage={setStatus} />
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

function PostRow({
  post,
  account,
  config,
  accounts,
  onChanged,
  onMessage,
}: {
  post: ScheduledPost;
  account: string | null;
  config: { baseUrl: string; apiKey: string };
  accounts: PlatformAccount[];
  onChanged: () => Promise<void>;
  onMessage: (message: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draftCaption, setDraftCaption] = useState(post.caption);
  const [draftAt, setDraftAt] = useState(() => toLocalInputValue(new Date(post.scheduled_at)));
  const [draftAccount, setDraftAccount] = useState(post.platform_account_id ?? '');
  const accountChoices = accounts.filter((a) => a.platform === post.platform && a.status === 'active');

  // What can be done depends on where the post is. The server holds the same
  // rule and has the last word — a post the publisher picks up a moment
  // before the click is refused there, and the answer is shown in words.
  const notOutYet = post.status === 'scheduled' || post.status === 'pending_approval';
  const canCancel = notOutYet || (post.status === 'publishing' && Boolean(post.waiting_reason));
  const canRetry = post.status === 'failed' && post.failure_reason !== 'no_video';
  const canClear = post.status === 'failed' || post.status === 'rejected';

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await action();
      await onChanged();
      onMessage(done);
      setEditing(false);
    } catch (err) {
      onMessage(errorText(err, CHANGE_ERRORS));
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    const question = canClear ? 'Удалить пост из очереди?' : 'Отменить публикацию? Пост не выйдет.';
    if (!window.confirm(question)) return;
    void run(() => api.cancelPost(config, post.id), canClear ? 'Пост удалён' : 'Публикация отменена');
  }

  function save() {
    const when = new Date(draftAt);
    if (!draftCaption.trim()) return onMessage(CHANGE_ERRORS.caption);
    if (Number.isNaN(when.getTime())) return onMessage('Укажите дату и время');
    void run(
      () =>
        api.updatePost(config, post.id, {
          caption: draftCaption.trim(),
          scheduledAt: when.toISOString(),
          ...(accountChoices.length > 0 ? { platformAccountId: draftAccount || null } : {}),
        }),
      'Изменения сохранены'
    );
  }
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
          <span className={styles.platformLabel}>
            {PLATFORM_LABEL[post.platform] ?? post.platform}
            {account && <span className={styles.accountLabel}> · {account}</span>}
          </span>
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
        {post.status === 'publishing' && post.waiting_reason && <div className={styles.postMeta}>{WAITING_LABEL[post.waiting_reason]}</div>}
        {post.status === 'failed' && post.failure_reason && (
          <div className={styles.postFailure}>
            {FAILURE_LABEL[post.failure_reason] ?? post.failure_reason}
            {/* Instagram's own words, when it gave a reason: "video too long"
                is the fix, not just the fault. */}
            {post.failure_detail && <>: «{post.failure_detail}»</>}
          </div>
        )}
        {realLink && (
          <a href={realLink} target="_blank" rel="noreferrer">Открыть публикацию</a>
        )}

        {editing && (
          <div className={styles.editBox}>
            <textarea className={controls.input} value={draftCaption} onChange={(e) => setDraftCaption(e.target.value)} rows={4} />
            <input className={controls.input} type="datetime-local" value={draftAt} onChange={(e) => setDraftAt(e.target.value)} />
            {accountChoices.length > 1 && (
              <select className={controls.input} value={draftAccount} onChange={(e) => setDraftAccount(e.target.value)} aria-label="Аккаунт">
                {accountChoices.map((a) => (
                  <option key={a.id} value={a.id}>@{a.username ?? 'аккаунт'}{a.is_test ? ' (тестовый)' : ''}</option>
                ))}
              </select>
            )}
            <div className={styles.postActions}>
              <button type="button" className={controls.buttonPrimary} onClick={save} disabled={busy}>Сохранить</button>
              <button type="button" className={controls.buttonSecondary} onClick={() => setEditing(false)} disabled={busy}>Не менять</button>
            </div>
          </div>
        )}

        {!editing && (notOutYet || canCancel || canRetry || canClear) && (
          <div className={styles.postActions}>
            {canRetry && (
              <button type="button" className={controls.buttonSecondary} onClick={() => void run(() => api.retryPost(config, post.id), 'Пост снова в очереди')} disabled={busy}>
                Попробовать ещё раз
              </button>
            )}
            {notOutYet && (
              <button type="button" className={styles.textButton} onClick={() => setEditing(true)} disabled={busy}>Изменить</button>
            )}
            {(canCancel || canClear) && (
              <button type="button" className={`${styles.textButton} ${styles.dangerText}`} onClick={cancel} disabled={busy}>
                {canClear ? 'Удалить' : 'Отменить'}
              </button>
            )}
          </div>
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
  onAccounts,
}: {
  config: { baseUrl: string; apiKey: string };
  hasAccess: boolean;
  onMessage: (message: string) => void;
  /** The form above picks from the same list. */
  onAccounts: (accounts: PlatformAccount[]) => void;
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
      onAccounts(res.accounts);
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
