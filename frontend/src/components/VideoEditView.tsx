'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { plural } from '@/lib/plural';
import { api, type AspectRatioOption, type HeadlineOption, type PosterLayout, type SubtitlePosition, type SubtitlePreset, type VideoEditJob } from '@/lib/api';
import { useDevConfig } from '@/lib/useDevConfig';
import { useSession } from '@/lib/useSession';
import { STAFF_BOOTSTRAP_AVAILABLE } from '@/lib/useApiAccess';
import PageHeader from './PageHeader';
import TabBar from './TabBar';
import Switch from './Switch';
import PillPicker from './PillPicker';
import { type CaptionLook } from './CaptionOverlay';
import FramePreview from './FramePreview';
import PulseIndicator from './PulseIndicator';
import CutEditor from './CutEditor';
import StatusMessage from './StatusMessage';
import controls from './Controls.module.css';
import styles from './VideoEditView.module.css';

// A line with the shape the real ones have: a couple of quiet words and one
// worth shouting. Fixed rather than generated, because the word to emphasise
// is chosen server-side for a real render and a second heuristic in the
// browser would be a third thing to keep in step.
const SAMPLE_CAPTION = { words: ['каждая', 'твоя', 'история'], emphasis: 2 };

// What a job is called in the list. Only one kind can be made now; the two
// older names belong to the retired Level 1-2 mock and survive only on old rows.
const TEMPLATE_TITLE: Record<string, string> = {
  ai_smart_cut: 'ИИ-монтаж',
  auto_crop_916: 'Старый шаблон',
  template_with_transitions: 'Старый шаблон',
};

// The tabs of the look panel. Subtitles and the headline share three of them
// by name, which is why the panel always says which of the two it is changing.
const SUBTITLE_TABS = [['style', 'Стиль'], ['font', 'Шрифт'], ['color', 'Цвет'], ['size', 'Размер'], ['position', 'Позиция']] as const;
const HEADLINE_TABS = [['text', 'Текст'], ['font', 'Шрифт'], ['size', 'Размер'], ['color', 'Цвет']] as const;
type SubtitleTab = (typeof SUBTITLE_TABS)[number][0];
type HeadlineTab = (typeof HEADLINE_TABS)[number][0];
// "No captions" is offered as one more style rather than a separate switch:
// it is the answer to the same question — what should the words look like.
const NO_SUBTITLES = '__none';

const STATUS_LABEL: Record<string, string> = { processing: 'Рендерится', awaiting_review: 'Проверьте субтитры', completed: 'Готово', failed: 'Ошибка' };

// Languages the speech models transcribe only approximately. Measured on real
// footage: Kazakh comes back as plausible-looking phonetics, and mixed
// Kazakh-Russian speech fares worst of all. The captions are burned into the
// pixels and cannot be edited afterwards, so the card has to say this before
// the video is published — not after a viewer points it out.
const UNRELIABLE_LANGUAGES: Record<string, string> = {
  kazakh: 'казахский',
  kk: 'казахский',
  kyrgyz: 'киргизский',
  ky: 'киргизский',
  uzbek: 'узбекский',
  uz: 'узбекский',
  tajik: 'таджикский',
  tg: 'таджикский',
};

function unreliableLanguageLabel(language: string | null | undefined): string | null {
  if (!language) return null;
  return UNRELIABLE_LANGUAGES[language.trim().toLowerCase()] ?? null;
}

// The Level-3 pipeline reports which stage it is in. Showing "Расшифровка"
// instead of a bare 38% matters because the stages take wildly different
// times — a bar sitting at 35% for a minute looks stuck unless it says it is
// waiting on Whisper.
const STAGE_LABEL: Record<string, string> = {
  probe: 'Проверка файла',
  transcribe: 'Расшифровка речи',
  plan_cuts: 'Планирование нарезки',
  subtitles: 'Генерация субтитров',
  render: 'Рендер',
  upload: 'Сохранение',
};

// Machine-readable reasons from the backend; the wording lives here so it can
// change without a data migration.
const FAILURE_LABEL: Record<string, string> = {
  no_audio_track: 'В файле нет звуковой дорожки',
  source_too_large: 'Файл больше 600 МБ — загрузите ролик покороче или сожмите его',
  video_too_long: 'Видео длиннее 20 минут',
  source_unreadable: 'Не удалось прочитать файл',
  transcription_not_configured: 'Не задан OPENAI_API_KEY — расшифровка недоступна',
  transcription_failed: 'Whisper не ответил',
  // The one failure the user can actually fix, so it says what to do.
  transcription_quota_exhausted: 'Закончились кредиты OpenAI — пополните счёт, распознавание речи недоступно',
  ffmpeg_not_available: 'На сервере нет ffmpeg',
  storage_not_configured: 'Не настроено хранилище',
  render_failed: 'Ошибка рендера',
  upload_failed: 'Не удалось сохранить результат',
  video_processing_error: 'Ошибка обработки',
  template_retired: 'Этот шаблон больше не поддерживается — смонтируйте ролик заново через ИИ-монтаж',
};
// "processing" reuses --accent (an active-right-now state, same precedent
// as the pulse indicator), "completed" reuses Scheduler's "published"
// success color, "failed" reuses its failed color — same tokens, same
// meanings, across screens instead of a fresh ad hoc palette per screen.
const STATUS_COLOR: Record<string, string> = {
  processing: 'var(--accent)',
  awaiting_review: 'var(--accent)',
  completed: 'var(--status-published)',
  failed: 'var(--status-failed)',
};

export default function VideoEditView() {
  const [devConfig, setDevConfig] = useDevConfig();
  const { baseUrl } = devConfig;

  // A signed-in user carries a session token that the API accepts on these
  // routes just like a dev apiKey. Without this fallback, logging in and
  // walking straight to this screen left apiKey empty — devConfig is only
  // populated on the last step of onboarding — so every action 401'd and the
  // submit button looked broken. Read-only on purpose: useSession and
  // useDevConfig keep separate storage and must not clobber each other.
  // The session itself travels as a cookie; only the dev-panel key is a
  // value this code holds.
  const apiKey = devConfig.apiKey;
  const config = { baseUrl, apiKey };

  // Access is no longer the same thing as holding a key. The session became
  // an httpOnly cookie, which this code cannot see — so a signed-in user has
  // an empty apiKey and their requests still authenticate. Gating on the key
  // alone locked them out of a screen that works: the button sat disabled
  // saying "no access" while the cookie rode along on every fetch.
  const [session] = useSession();
  const hasAccess = Boolean(apiKey) || session !== null;

  const [file, setFile] = useState<File | null>(null);
  // A local preview of the chosen file. The browser already holds the bytes,
  // so this costs no upload, no render and no request — and without it every
  // choice below (the frame, the caption style, the headline) is made against
  // a video the person cannot see.
  const [filePreviewUrl, setFilePreviewUrl] = useState<string | null>(null);
  const [subtitles, setSubtitles] = useState(true);
  // The catalogue comes from the server rather than a copy kept here: the
  // styles are defined in the renderer's terms, and two lists drift.
  const [presets, setPresets] = useState<SubtitlePreset[]>([]);
  const [subtitlePreset, setSubtitlePreset] = useState('classic');
  const [positions, setPositions] = useState<SubtitlePosition[]>([]);
  // 'auto' is the absence of an override, which leaves the chosen style's own
  // placement alone — the older "Снизу" style still positions itself.
  const [subtitlePosition, setSubtitlePosition] = useState('auto');
  // Typed by hand and drawn in a band above the video. Empty means no band.
  const [headline, setHeadline] = useState('');
  const [headlineMaxChars, setHeadlineMaxChars] = useState(48);
  const [headlineFonts, setHeadlineFonts] = useState<HeadlineOption[]>([]);
  const [headlineSizes, setHeadlineSizes] = useState<HeadlineOption[]>([]);
  const [headlineColors, setHeadlineColors] = useState<Array<HeadlineOption & { hex: string }>>([]);
  const [headlineFont, setHeadlineFont] = useState('montserrat');
  const [headlineSize, setHeadlineSize] = useState('medium');
  const [headlineColor, setHeadlineColor] = useState('white');
  const [aspectRatios, setAspectRatios] = useState<AspectRatioOption[]>([]);
  // The three axes that used to be baked into the preset. 'auto' and the
  // neutral 'medium' mean "leave the style alone", which is why they are the
  // defaults: choosing a style must not silently repaint it.
  const [subtitleFonts, setSubtitleFonts] = useState<Array<HeadlineOption & { family: string }>>([]);
  const [subtitleColors, setSubtitleColors] = useState<Array<HeadlineOption & { hex: string }>>([]);
  const [subtitleSizes, setSubtitleSizes] = useState<HeadlineOption[]>([]);
  const [posterLayout, setPosterLayout] = useState<PosterLayout | null>(null);
  const [sizeScales, setSizeScales] = useState<Record<string, number>>({});
  const [fontEmRatios, setFontEmRatios] = useState<Record<string, number>>({});
  const [subtitleFont, setSubtitleFont] = useState('auto');
  const [subtitleColor, setSubtitleColor] = useState('auto');
  const [subtitleSize, setSubtitleSize] = useState('medium');
  // Vertical by default — it is what the pipeline produced before the format
  // was a choice, and what Reels, TikTok and Shorts all want.
  const [aspectRatio, setAspectRatio] = useState('9_16');
  const [removeBreaths, setRemoveBreaths] = useState(false);
  // Which of the two things on the frame the settings below change, and the
  // tab open for each — kept apart so switching back lands where you were.
  const [target, setTarget] = useState<'subs' | 'headline'>('subs');
  const [subsTab, setSubsTab] = useState<SubtitleTab>('style');
  const [headTab, setHeadTab] = useState<HeadlineTab>('text');
  // Off by default: removing ambience is right for a street recording and
  // wrong for anything where the background is part of the shot.
  // Line edits for the job currently under review, keyed by job id.
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [uploading, setUploading] = useState(false);
  const [jobs, setJobs] = useState<VideoEditJob[]>([]);
  // Undefined until the first answer: "we have not asked yet" is not the same
  // as "nobody is there", and only the second one is worth alarming about.
  const [workerOnline, setWorkerOnline] = useState<boolean | undefined>(undefined);
  const [status, setStatus] = useState('');
  // The job whose cut is open in the editor, or null when it is closed.
  const [editingJobId, setEditingJobId] = useState<string | null>(null);

  // The live object URL, kept in a ref so unmount can revoke whatever is
  // current without the cleanup depending on it — and so revoking never
  // happens inside a state updater, which React may run twice.
  const previewUrlRef = useRef<string | null>(null);

  // Everything that sets the file goes through here. An object URL holds the
  // whole file in memory until revoked, so picking five videos in a row
  // without this keeps all five — on a phone, with half-gigabyte recordings,
  // that is the tab being killed.
  function chooseFile(next: File | null) {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    const url = next ? URL.createObjectURL(next) : null;
    previewUrlRef.current = url;
    setFilePreviewUrl(url);
    setFile(next);
  }

  useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    },
    []
  );

  // Everything the overlay needs, assembled from the axes on screen. Null
  // until the catalogue has arrived, which is also what keeps the preview
  // from flashing a default look before the real one loads.
  const presetLayout = presets.find((p) => p.id === subtitlePreset)?.layout;
  const captionLook: CaptionLook | null =
    presetLayout && posterLayout
      ? {
          preset: presetLayout,
          poster: posterLayout,
          sizeScale: sizeScales[subtitleSize] ?? 1,
          fontFamily: subtitleFonts.find((f) => f.id === subtitleFont)?.family || undefined,
          emRatio:
            fontEmRatios[subtitleFonts.find((f) => f.id === subtitleFont)?.family || presetLayout.fontFamily],
          highlight: subtitleColors.find((c) => c.id === subtitleColor)?.hex,
          position: (() => {
            const chosen = positions.find((x) => x.id === subtitlePosition);
            return chosen?.row ? { row: chosen.row, marginRatio: chosen.marginRatio ?? null } : null;
          })(),
        }
      : null;

  const load = useCallback(async () => {
    if (!hasAccess) return;
    try {
      const res = await api.listVideoJobs(config);
      setJobs(res.jobs);
      setWorkerOnline(res.worker_online);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAccess, baseUrl]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  useEffect(() => {
    // Public catalogue — no credential needed, and it never changes between
    // renders, so one fetch per mount.
    api
      .listSubtitlePresets({ baseUrl })
      .then((res) => {
        setPresets(res.presets ?? []);
        setPositions(res.positions ?? []);
        // The renderer owns this number; the input only enforces what it says.
        if (res.headlineMaxChars) setHeadlineMaxChars(res.headlineMaxChars);
        setHeadlineFonts(res.headlineFonts ?? []);
        setHeadlineSizes(res.headlineSizes ?? []);
        setHeadlineColors(res.headlineColors ?? []);
        setAspectRatios(res.aspectRatios ?? []);
        setSubtitleFonts(res.subtitleFonts ?? []);
        setSubtitleColors(res.subtitleColors ?? []);
        setSubtitleSizes(res.subtitleSizes ?? []);
        setPosterLayout(res.posterLayout ?? null);
        setSizeScales(res.sizeScales ?? {});
        setFontEmRatios(res.fontEmRatios ?? {});
      })
      .catch(() => {
        setPresets([]);
        setPositions([]);
        setHeadlineFonts([]);
        setHeadlineSizes([]);
        setHeadlineColors([]);
        setAspectRatios([]);
        setSubtitleFonts([]);
        setSubtitleColors([]);
        setSubtitleSizes([]);
        setPosterLayout(null);
        setSizeScales({});
        setFontEmRatios({});
      });
  }, [baseUrl]);

  // Auto-poll while anything is still rendering — no real webhook/push to
  // tell us when a job finishes (that's the deferred push-notification
  // piece), so the progress bar has to pull.
  useEffect(() => {
    if (!hasAccess || !jobs.some((j) => j.status === 'processing')) return;
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, [hasAccess, jobs, load]);

  // Three steps, because the file never passes through our API: ask for a
  // presigned URL, PUT the bytes straight at storage, then create the job
  // referencing the key we were given.
  async function submitSmartCut() {
    if (!file) return;
    setUploading(true);
    try {
      setStatus('Запрашиваю ссылку для загрузки…');
      const ticket = await api.createVideoUpload(config, file.type || 'video/mp4', file.size);

      setStatus(`Загружаю ${(file.size / 1024 / 1024).toFixed(1)} МБ…`);
      await api.uploadVideoFile(ticket, file);

      await api.createSmartCutJob(config, {
        sourceObjectKey: ticket.objectKey,
        subtitles,
        subtitlePreset,
        subtitlePosition,
        subtitleFont,
        subtitleColor,
        subtitleSize,
        removeBreaths,
        headline,
        headlineFont,
        headlineSize,
        headlineColor,
        aspectRatio,
      });
      await load();
      chooseFile(null);
      setStatus(
        ticket.storage === 'local'
          ? 'Готово. Рендер выполняет воркер — запусти его: npm run worker'
          : 'Готово. Рендер в очереди воркера.'
      );
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  // Same workspace bootstrap as the bot editor's "Быстрый старт". It lives
  // here too because needing a key is what blocks this screen, and sending
  // someone to another module to find a button folded inside a collapsed
  // "Режим разработчика" panel is how a working screen reads as broken.
  async function quickSetup() {
    try {
      setStatus('Создаю тестовый workspace…');
      const tenant = await api.createTenant(config, 'Demo Blogger', `demo-${Date.now()}@example.com`);
      const accountId = `ig-${Date.now()}`;
      const bot = await api.createBot({ baseUrl, apiKey: tenant.apiKey }, 'Demo Bot', accountId);
      setDevConfig((c) => ({ ...c, apiKey: tenant.apiKey, botId: bot.bot.id, externalAccountId: accountId }));
      setStatus('Готово — теперь можно монтировать.');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function approveCaptions(jobId: string, lines: string[]) {
    try {
      setStatus('Отправляю исправления…');
      await api.approveCaptions(config, jobId, lines.map((text) => ({ text })));
      setDraft((d) => { const next = { ...d }; delete next[jobId]; return next; });
      await load();
      setStatus('Субтитры приняты, монтаж продолжается.');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  const hasHeadline = headline.trim() !== '';
  const processingCount = jobs.filter((j) => j.status === 'processing' && !j.awaiting_worker).length;

  // Why the submit button is unavailable, in the order the user hits them:
  // no key means every request 401s, so say that before asking for a file.
  const blockedReason = !hasAccess
    ? 'Чтобы смонтировать, нужен аккаунт:'
    : file
      ? null
      : 'Выберите файл видео — ИИ-монтажу нужен сам файл, а не ссылка.';

  return (
    <div className={styles.page}>
      <PageHeader section="Редактор" title="Видеомонтаж" current="/video">
        {processingCount > 0 && <PulseIndicator count={processingCount} label={plural(processingCount, ['ролик монтируется', 'ролика монтируются', 'роликов монтируются'])} />}
      </PageHeader>

      <main className={styles.main}>
        {/* No banner here, unlike the other screens. Everything below can be
            tried without an account — picking a file, previewing the frame,
            leafing through fonts and colours — and that is what shows a
            visitor what the product does. The one thing that needs an account
            is the button, so that is the one place that says so. A banner on
            top as well meant the same message twice, the first one before
            anybody had tried to do anything. */}

        <div className={styles.hero}>
          <div>
            <h1>Превратите исходник в ролик</h1>
            {/* Said in what the person gets, not in how we build it: "Уровень 3"
                and "мок" were our words, and customers read them here. */}
            <p className={styles.lead}>
              Загрузите запись — Sonar расшифрует речь, вырежет паузы и слова-паразиты и наложит субтитры.
              Шумную запись почистит сам, а если речь распознана неуверенно, покажет субтитры на проверку
              перед монтажом.
            </p>
          </div>
        </div>

        <div className={styles.composer}>
          <div className={styles.composerHead}>
            <span className={styles.eyebrow}>НОВЫЙ ПРОЕКТ</span>
            <h2>Загрузите исходник</h2>
          </div>

          <>
              {/* The native file input renders as an OS button with English
                  text next to it, which is the single most out-of-place thing
                  on a phone. It stays in the DOM for accessibility and is
                  driven by this label instead. */}
              <label className={`${styles.dropzone} ${file ? styles.dropzoneFilled : ''}`}>
                <input
                  className={styles.hiddenFileInput}
                  type="file"
                  accept="video/mp4,video/quicktime,video/webm"
                  onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
                />
                {file ? (
                  <>
                    <span className={styles.dropzoneIcon} aria-hidden="true">▶</span>
                    <span className={styles.dropzoneName}>{file.name}</span>
                    <span className={styles.dropzoneHint}>
                      {(file.size / 1024 / 1024).toFixed(1)} МБ · нажмите, чтобы заменить
                    </span>
                  </>
                ) : (
                  <>
                    <span className={styles.dropzoneIcon} aria-hidden="true">+</span>
                    <span className={styles.dropzoneName}>Выбрать видео</span>
                    <span className={styles.dropzoneHint}>MP4, MOV или WebM</span>
                  </>
                )}
              </label>

              {/* About the recording, chosen once: the frame it goes into and
                  what to do with its sound. Everything after is about the look. */}
              <div className={styles.controls}>
                <PillPicker
                  label="Формат кадра"
                  options={aspectRatios}
                  value={aspectRatio}
                  onChange={setAspectRatio}
                />
                <Switch
                  checked={removeBreaths}
                  onChange={setRemoveBreaths}
                  label="Убрать вздохи"
                  hint="Вырезает вдохи между фразами"
                />
              </div>

              {/* The look, laid out the way phone editors (CapCut, Instagram)
                  do it: the frame on top, then what you are changing, then one
                  row of choices. It replaced ten pickers stacked in a column —
                  every option still here, but the frame no longer scrolls away
                  while you choose, and only one row is on screen at a time. */}
              <section className={styles.studio} aria-label="Оформление">
                {/* Shown in the frame that is actually selected, so choosing
                    1:1 over 9:16 is a thing you see rather than a thing you
                    imagine. Drawn rather than rendered, so every typeface and
                    colour can be tried at once; the caption words are a sample,
                    since nothing has been transcribed yet. */}
                {filePreviewUrl && (
                  <div className={styles.previewStage}>
                    <FramePreview
                      src={filePreviewUrl}
                      aspectRatio={aspectRatio}
                      headline={headline}
                      headlineChoice={{ font: headlineFont, size: headlineSize, colour: headlineColor }}
                      captions={subtitles && captionLook ? { line: SAMPLE_CAPTION, look: captionLook } : null}
                      fontEmRatios={fontEmRatios}
                      focus={target === 'subs' ? 'captions' : 'headline'}
                    />
                    <p className={styles.previewNote}>
                      Пунктиром выделено то, что вы меняете.{subtitles && captionLook ? ' Слова субтитров — пример: настоящие возьмутся из вашей речи.' : ''}
                    </p>
                  </div>
                )}

                {/* First the thing, then its settings. "Шрифт" and "Цвет"
                    exist for both, and without saying which one is being
                    changed people set the headline colour looking for the
                    captions'. */}
                <div className={styles.targetSwitch} role="group" aria-label="Что меняем">
                  {(['subs', 'headline'] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={target === t}
                      className={`${styles.targetButton} ${target === t ? styles.targetButtonOn : ''}`}
                      onClick={() => setTarget(t)}
                    >
                      {t === 'subs' ? 'Субтитры' : 'Заголовок'}
                    </button>
                  ))}
                </div>

                <div className={styles.studioTabs} role="group" aria-label={target === 'subs' ? 'Настройки субтитров' : 'Настройки заголовка'}>
                  {(target === 'subs' ? SUBTITLE_TABS : HEADLINE_TABS).map(([id, name]) => {
                    const on = (target === 'subs' ? subsTab : headTab) === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={on}
                        className={`${styles.studioTab} ${on ? styles.studioTabOn : ''}`}
                        onClick={() => (target === 'subs' ? setSubsTab(id as SubtitleTab) : setHeadTab(id as HeadlineTab))}
                      >
                        {name}
                      </button>
                    );
                  })}
                </div>

                <div className={styles.studioPanel}>
                  {target === 'subs' ? (
                    <>
                      {subsTab === 'style' && (
                        <PillPicker
                          label="Стиль субтитров"
                          options={[...presets, { id: NO_SUBTITLES, label: 'Без субтитров', description: 'Видео без подписей' }]}
                          value={subtitles ? subtitlePreset : NO_SUBTITLES}
                          onChange={(id) => {
                            if (id === NO_SUBTITLES) return setSubtitles(false);
                            setSubtitles(true);
                            setSubtitlePreset(id);
                          }}
                        />
                      )}
                      {subsTab === 'font' && (
                        <PillPicker label="Шрифт субтитров" options={subtitleFonts} value={subtitleFont} onChange={setSubtitleFont} disabled={!subtitles} />
                      )}
                      {subsTab === 'color' && (
                        <PillPicker label="Цвет подсветки слова" options={subtitleColors} value={subtitleColor} onChange={setSubtitleColor} disabled={!subtitles} />
                      )}
                      {subsTab === 'size' && (
                        <PillPicker label="Размер субтитров" options={subtitleSizes} value={subtitleSize} onChange={setSubtitleSize} disabled={!subtitles} />
                      )}
                      {/* Placement is its own axis, not part of a style: the
                          same typography belongs over the face on one clip
                          and under it on the next. */}
                      {subsTab === 'position' && (
                        <PillPicker label="Где стоят субтитры" options={positions} value={subtitlePosition} onChange={setSubtitlePosition} disabled={!subtitles} />
                      )}
                      {!subtitles && subsTab !== 'style' && (
                        <p className={styles.studioNote}>Субтитры выключены — выберите стиль во вкладке «Стиль».</p>
                      )}
                    </>
                  ) : (
                    <>
                      {/* The limit is shown while typing rather than enforced
                          by a renderer that silently drops the overflow. */}
                      {headTab === 'text' && (
                        <label className={styles.field}>
                          <span className={styles.fieldLabel}>Текст заголовка</span>
                          <input
                            className={controls.input}
                            value={headline}
                            onChange={(e) => setHeadline(e.target.value.slice(0, headlineMaxChars))}
                            maxLength={headlineMaxChars}
                            placeholder="Например: Брось работу прямо сейчас"
                          />
                          <span className={styles.fieldHint}>
                            {headline
                              ? `Встанет сверху, видео останется целым · ${headline.length}/${headlineMaxChars}`
                              : 'Пусто — плашки не будет, видео займёт весь кадр'}
                          </span>
                        </label>
                      )}
                      {headTab === 'font' && (
                        <PillPicker label="Шрифт заголовка" options={headlineFonts} value={headlineFont} onChange={setHeadlineFont} disabled={!hasHeadline} />
                      )}
                      {headTab === 'size' && (
                        <PillPicker label="Размер заголовка" options={headlineSizes} value={headlineSize} onChange={setHeadlineSize} disabled={!hasHeadline} />
                      )}
                      {headTab === 'color' && (
                        <PillPicker label="Цвет заголовка" options={headlineColors} value={headlineColor} onChange={setHeadlineColor} disabled={!hasHeadline} />
                      )}
                      {!hasHeadline && headTab !== 'text' && (
                        <p className={styles.studioNote}>Сначала напишите текст во вкладке «Текст» — без него плашки не будет.</p>
                      )}
                    </>
                  )}
                </div>
              </section>
          </>


          {/* On a phone this becomes a fixed bar at the bottom. It needs to be
              a real element with its own background: a bare fixed button lets
              the page scroll visibly through it, and a disabled button is
              semi-transparent on top of that. */}
          <div className={styles.actionBar}>
            <button
              className={`${controls.buttonPrimary} ${styles.submitButton}`}
              onClick={submitSmartCut}
              disabled={uploading || blockedReason !== null}
            >
              {uploading ? 'Загружаю…' : 'Смонтировать'}
            </button>
          {/* A disabled button that does not say what it is waiting for reads
            * as broken rather than as blocked. */}
          {blockedReason && (
            <p className={styles.blockedHint}>
              {blockedReason}
              {!hasAccess && (
                <>
                  {/* Every way out of this state is offered, and only the ones
                      that work here: signing in, registering, and — where the
                      API still answers it — the staff-assisted demo tenant. */}
                  <a className={styles.inlineAction} href="/login">
                    Войти
                  </a>
                  <a className={styles.inlineAction} href="/signup">
                    Регистрация
                  </a>
                  {STAFF_BOOTSTRAP_AVAILABLE && (
                    <button className={styles.inlineAction} onClick={quickSetup}>
                      Создать тестовый
                    </button>
                  )}
                </>
              )}
            </p>
          )}
          </div>

          {/* Feedback belongs next to the control that caused it. This used to
            * render at the bottom of the queue section, a screen below the
            * button, so a failed submit looked like a dead button. */}
          <StatusMessage>{status}</StatusMessage>
        </div>

        <section className={styles.queue}>
          <div className={styles.queueHeader}>
            {/* "Мои ролики", not "Очередь рендеров": a person looks here for
                their videos, and "render queue" is how the system sees them. */}
            <h2>Мои ролики</h2>
            <span className={styles.queueCount}>{jobs.length}</span>
          </div>

          {jobs.length > 0 && (
            <div className={styles.jobList}>
              {jobs.map((j) => (
                <div key={j.id} className={styles.jobCard} style={{ '--job-color': STATUS_COLOR[j.status] } as React.CSSProperties}>
                  <div className={styles.jobHeader}>
                    <span className={styles.jobTemplate}>{TEMPLATE_TITLE[j.template] ?? j.template}</span>
                    <span className={styles.statusBadge}>
                      {j.awaiting_worker ? 'В очереди' : STATUS_LABEL[j.status]}
                    </span>
                  </div>

                  {/* No bar while the job is only queued. A track frozen at
                      0% claims progress that is not happening, and that reads
                      as a broken site rather than as a wait. */}
                  {!j.awaiting_worker && (
                    <div className={styles.progressRow}>
                      <div className={styles.progressTrack}>
                        <div className={styles.progressFill} style={{ width: `${j.progress_percent}%` }} />
                      </div>
                      <span className={styles.progressPercent}>{j.progress_percent}%</span>
                    </div>
                  )}

                  {/* Two different waits, and they deserve different words.
                      "Начнётся автоматически" is true only while a worker is
                      actually running; said over a stopped one it is a promise
                      the page cannot keep, and the job sits there for hours
                      looking patient. */}
                  {j.awaiting_worker && (
                    <div className={styles.jobMeta}>
                      {workerOnline === false
                        ? 'Обработчик не на связи — рендер начнётся, когда он вернётся.'
                        : 'Ждёт свободного обработчика — начнётся автоматически.'}
                    </div>
                  )}

                  {j.status === 'processing' && !j.awaiting_worker && j.stage && (
                    <div className={styles.jobMeta}>{STAGE_LABEL[j.stage] ?? j.stage}…</div>
                  )}

                  {j.artifacts?.plan && (
                    <div className={styles.jobMeta}>
                      {j.artifacts.probe && `${j.artifacts.probe.durationSec.toFixed(1)}с → `}
                      {j.artifacts.plan.keptDurationSec.toFixed(1)}с · вырезано{' '}
                      {j.artifacts.probe && j.artifacts.probe.durationSec > 0
                        ? Math.round((j.artifacts.plan.removedDurationSec / j.artifacts.probe.durationSec) * 100)
                        : 0}
                      % · склеек {Math.max(0, j.artifacts.plan.segments.length - 1)}
                      {j.artifacts.plan.droppedFillerCount > 0 && ` · паразитов ${j.artifacts.plan.droppedFillerCount}`}
                      {j.artifacts.subtitles && ` · титров ${j.artifacts.subtitles.chunkCount}`}
                    </div>
                  )}

                  {j.failure_reason && (
                    <div className={`${styles.jobMeta} ${styles.jobFailure}`}>
                      {FAILURE_LABEL[j.failure_reason] ?? j.failure_reason}
                    </div>
                  )}

                  {/* A Level-3 result is a real file, so it plays right here —
                      that is the whole point of the screen. The presets below
                      still hand back a mock link that resolves to nothing. */}
                  {j.artifacts?.noise && (
                    // The decision was made for the user, so it has to be
                    // visible — otherwise "why does this one sound different"
                    // has no answer anywhere in the product.
                    <p className={styles.autoNote}>
                      {j.artifacts.noise.denoised
                        ? `Запись шумная (запас ${j.artifacts.noise.headroomDb.toFixed(0)} dB) — фоновый шум убран автоматически.`
                        : `Звук чистый (запас ${j.artifacts.noise.headroomDb.toFixed(0)} dB) — обработка не понадобилась.`}
                    </p>
                  )}

                  {j.status === 'awaiting_review' && j.artifacts?.captions && (
                    <div className={styles.review}>
                      <p className={styles.reviewLead}>
                        Проверьте текст — он будет вжжён в видео и после монтажа не редактируется.
                      </p>
                      {j.artifacts.captions.lines.map((line, i) => {
                        const value = draft[j.id]?.[i] ?? line.text;
                        return (
                          <label key={i} className={styles.reviewLine}>
                            <span className={styles.reviewTime}>
                              {Math.floor(line.start / 60)}:{String(Math.floor(line.start % 60)).padStart(2, '0')}
                            </span>
                            <input
                              className={`${controls.input} ${styles.reviewInput}`}
                              value={value}
                              onChange={(e) =>
                                setDraft((d) => {
                                  const lines = [...(d[j.id] ?? j.artifacts!.captions!.lines.map((l) => l.text))];
                                  lines[i] = e.target.value;
                                  return { ...d, [j.id]: lines };
                                })
                              }
                            />
                          </label>
                        );
                      })}
                      <button
                        className={`${controls.buttonPrimary} ${styles.reviewSubmit}`}
                        onClick={() => approveCaptions(j.id, draft[j.id] ?? j.artifacts!.captions!.lines.map((l) => l.text))}
                      >
                        Всё верно — монтировать
                      </button>
                    </div>
                  )}

                  {(() => {
                    // Only worth saying when captions were actually burned in:
                    // a job with subtitles off has nothing to mistrust.
                    const label = j.subtitles === false ? null : unreliableLanguageLabel(j.artifacts?.transcript?.language);
                    return label ? (
                      <p className={styles.captionWarning}>
                        Распознан {label}. Субтитры могут содержать ошибки — проверьте текст перед публикацией.
                      </p>
                    ) : null;
                  })()}

                  {j.output_url && j.pipeline === 'smart_cut' && (
                    // poster shows the finished frame, subtitles and all, so a
                    // done job reads as done without pressing play. preload
                    // drops to "none" when there is one: the poster already
                    // answers "did this work?", and the video itself is tens
                    // of megabytes that nobody asked to download yet.
                    <video
                      className={styles.jobPlayer}
                      src={j.output_url}
                      poster={j.poster_url ?? undefined}
                      controls
                      preload={j.poster_url ? 'none' : 'metadata'}
                    />
                  )}

                  {j.output_url && (
                    <div className={styles.jobOutputRow}>
                      {/* No target="_blank": with the server sending
                          Content-Disposition the browser saves the file and
                          stays put. Opening a tab instead stranded people on
                          a bare video with no history to go back through. */}
                      <a
                        className={styles.jobOutputButton}
                        href={j.download_url ?? j.output_url!}
                        download={`sonar-${j.id.slice(0, 8)}.mp4`}
                      >
                        Скачать видео
                      </a>
                      {/* output_url is a mock link (render.mock doesn't resolve to a
                          real server) until a real Shotstack/Creatomate integration
                          replaces videoRender.ts — flagging that here so clicking
                          "Скачать" and hitting a DNS error isn't a surprise. */}
                      {/* "Изменить монтаж", not "Редактировать нарезку": the
                          screen behind this button also changes the caption
                          style, the colour, the typeface and the headline,
                          and a name that promises only cuts is a name the
                          person with a colour complaint never presses.
                          Offered next to the download rather than hidden in a
                          menu: disagreeing with the edit is a normal outcome,
                          not an advanced one. */}
                      {/* Gated on the plan, not the transcript: the list
                          strips transcripts out (they are tens of kilobytes
                          per job and nothing here shows them), and a job that
                          reached a plan necessarily has one. */}
                      {j.pipeline === 'smart_cut' && j.artifacts?.plan && (
                        <button
                          type="button"
                          className={styles.jobSecondaryButton}
                          onClick={() => setEditingJobId(j.id)}
                        >
                          Изменить монтаж
                        </button>
                      )}
                      {/* Straight to the scheduler with this render chosen:
                          posting it should not mean downloading the file and
                          uploading it again. Last in the row, furthest from
                          the player: it is the one button that leaves the
                          page, and the result gets watched before it gets
                          posted. */}
                      {j.pipeline === 'smart_cut' && j.status === 'completed' && (
                        <a className={styles.jobSecondaryButton} href={`/scheduler?video=${encodeURIComponent(j.id)}`}>
                          Запланировать публикацию
                        </a>
                      )}
                      {j.pipeline !== 'smart_cut' && (
                        <span className={styles.jobOutputHint}>мок-ссылка, реального файла ещё нет</span>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {jobs.length === 0 && (
            <div className={styles.emptyState}>
              <div>
                <div className={styles.emptyIcon}>▶</div>
                <h2>Готов к первому монтажу</h2>
                <p>Выберите файл и нажмите «Смонтировать».</p>
              </div>
            </div>
          )}
        </section>
      </main>

      {editingJobId && (
        <CutEditor
          config={config}
          jobId={editingJobId}
          onClose={() => setEditingJobId(null)}
          onRevised={() => {
            setEditingJobId(null);
            setStatus('Пересборка запущена — новый вариант появится в очереди.');
            load();
          }}
        />
      )}

      <TabBar current="/video" />
    </div>
  );
}
