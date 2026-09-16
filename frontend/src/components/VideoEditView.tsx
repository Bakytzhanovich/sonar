'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type VideoEditJob, type VideoTemplate } from '@/lib/api';
import { useDevConfig } from '@/lib/useDevConfig';
import ModuleNav from './ModuleNav';
import NoticeBanner, { MISSING_API_KEY_MESSAGE } from './NoticeBanner';
import PulseIndicator from './PulseIndicator';
import StatusMessage from './StatusMessage';
import controls from './Controls.module.css';
import layout from './Layout.module.css';
import styles from './VideoEditView.module.css';

const TEMPLATES: { value: VideoTemplate; level: string; title: string; description: string }[] = [
  {
    value: 'ai_smart_cut',
    level: 'Уровень 3 · ИИ',
    title: 'ИИ-монтаж (Smart Cut)',
    description: 'Расшифровка речи, вырезание пауз и слов-паразитов, динамические субтитры. Нужен файл, а не ссылка.',
  },
  {
    value: 'auto_crop_916',
    level: 'Уровень 1',
    title: 'Автонарезка 9:16 + субтитры',
    description: 'Быстрый кроп под вертикальный формат Reels/Shorts с автоматическими субтитрами.',
  },
  {
    value: 'template_with_transitions',
    level: 'Уровень 2',
    title: 'Шаблонный монтаж',
    description: 'Готовые переходы между сценами по шаблону — для более собранного ролика.',
  },
];

const STATUS_LABEL: Record<string, string> = { processing: 'Рендерится', completed: 'Готово', failed: 'Ошибка' };

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
  video_too_long: 'Видео длиннее 20 минут',
  source_unreadable: 'Не удалось прочитать файл',
  transcription_not_configured: 'Не задан OPENAI_API_KEY — расшифровка недоступна',
  transcription_failed: 'Whisper не ответил',
  ffmpeg_not_available: 'На сервере нет ffmpeg',
  storage_not_configured: 'Не настроено хранилище',
  render_failed: 'Ошибка рендера',
  upload_failed: 'Не удалось сохранить результат',
  video_processing_error: 'Ошибка обработки',
};
// "processing" reuses --accent (an active-right-now state, same precedent
// as the pulse indicator), "completed" reuses Scheduler's "published"
// success color, "failed" reuses its failed color — same tokens, same
// meanings, across screens instead of a fresh ad hoc palette per screen.
const STATUS_COLOR: Record<string, string> = {
  processing: 'var(--accent)',
  completed: 'var(--status-published)',
  failed: 'var(--status-failed)',
};

export default function VideoEditView() {
  const [devConfig] = useDevConfig();
  const { baseUrl, apiKey } = devConfig;
  const config = { baseUrl, apiKey };

  const [sourceVideoUrl, setSourceVideoUrl] = useState('https://example.com/my-video.mp4');
  const [template, setTemplate] = useState<VideoTemplate>('ai_smart_cut');
  const [file, setFile] = useState<File | null>(null);
  const [subtitles, setSubtitles] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [jobs, setJobs] = useState<VideoEditJob[]>([]);
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    if (!apiKey) return;
    try {
      const res = await api.listVideoJobs(config);
      setJobs(res.jobs);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, baseUrl]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Auto-poll while anything is still rendering — no real webhook/push to
  // tell us when a job finishes (that's the deferred push-notification
  // piece), so the progress bar has to pull.
  useEffect(() => {
    if (!apiKey || !jobs.some((j) => j.status === 'processing')) return;
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, [apiKey, jobs, load]);

  async function submit() {
    if (template === 'ai_smart_cut') return submitSmartCut();
    if (!sourceVideoUrl.trim()) return;
    try {
      await api.createVideoJob(config, sourceVideoUrl.trim(), template);
      await load();
      setStatus('Job создан, рендер пошёл (мок Shotstack/Creatomate)');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  // Three steps, because the file never passes through our API: ask for a
  // presigned URL, PUT the bytes straight at storage, then create the job
  // referencing the key we were given.
  async function submitSmartCut() {
    if (!file) return;
    setUploading(true);
    try {
      setStatus('Запрашиваю ссылку для загрузки…');
      const ticket = await api.createVideoUpload(config, file.type || 'video/mp4');

      setStatus(`Загружаю ${(file.size / 1024 / 1024).toFixed(1)} МБ…`);
      await api.uploadVideoFile(ticket, file);

      await api.createSmartCutJob(config, ticket.objectKey, subtitles);
      await load();
      setFile(null);
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

  async function tickNow() {
    try {
      const res = await api.processVideoTick(config);
      await load();
      setStatus(`Продвинуто job'ов: ${res.advanced}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  const processingCount = jobs.filter((j) => j.status === 'processing').length;

  return (
    <div className={styles.page}>
      <header className={layout.header}>
        <div>
          <span className={styles.eyebrow}>РЕДАКТОР</span>
          <span className={layout.title}>Видеомонтаж</span>
        </div>
        {processingCount > 0 && <PulseIndicator count={processingCount} label="рендеров в процессе" />}
        <ModuleNav current="/video" />
      </header>

      <main className={styles.main}>
        {!apiKey && <NoticeBanner>{MISSING_API_KEY_MESSAGE}</NoticeBanner>}

        <div className={styles.hero}>
          <div>
            <h1>Преврати исходник в ролик</h1>
            <p className={styles.lead}>
              Уровень 3 работает с настоящим файлом: расшифровка речи, вырезание пауз, вжигание субтитров.
              Уровни 1–2 пока мок — там источник это просто ссылка.
            </p>
          </div>
        </div>

        <div className={styles.composer}>
          <div className={styles.composerHead}>
            <span className={styles.eyebrow}>НОВЫЙ ПРОЕКТ</span>
            <h2>Загрузи исходник</h2>
          </div>

          {template === 'ai_smart_cut' ? (
            <>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Файл видео</span>
                <input
                  className={`${controls.input} ${styles.input}`}
                  type="file"
                  accept="video/mp4,video/quicktime,video/webm"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
              {file && (
                <div className={styles.jobMeta}>
                  {file.name} · {(file.size / 1024 / 1024).toFixed(1)} МБ
                </div>
              )}
              <label className={styles.field}>
                <span className={styles.fieldLabel}>
                  <input type="checkbox" checked={subtitles} onChange={(e) => setSubtitles(e.target.checked)} /> Вжечь динамические субтитры
                </span>
              </label>
            </>
          ) : (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Ссылка на видео</span>
              <input
                className={`${controls.input} ${styles.input}`}
                placeholder="https://example.com/my-video.mp4"
                value={sourceVideoUrl}
                onChange={(e) => setSourceVideoUrl(e.target.value)}
              />
            </label>
          )}

          <div className={styles.templateLabel}>
            <span className={styles.fieldLabel}>Шаблон монтажа</span>
          </div>
          <div className={styles.templateGrid} role="radiogroup" aria-label="Шаблон монтажа">
            {TEMPLATES.map((t) => (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={template === t.value}
                className={`${styles.templateCard} ${template === t.value ? styles.templateCardActive : ''}`}
                onClick={() => setTemplate(t.value)}
              >
                <span className={styles.templateLevel}>{t.level}</span>
                <span className={styles.templateTitle}>{t.title}</span>
                <span className={styles.templateDesc}>{t.description}</span>
              </button>
            ))}
          </div>

          <button
            className={`${controls.buttonPrimary} ${styles.submitButton}`}
            onClick={submit}
            disabled={uploading || (template === 'ai_smart_cut' ? !file : !sourceVideoUrl.trim())}
          >
            {uploading ? 'Загружаю…' : template === 'ai_smart_cut' ? 'Смонтировать' : 'Запустить рендер'}
          </button>
        </div>

        <section className={styles.queue}>
          <div className={styles.queueHeader}>
            <h2>Очередь рендеров</h2>
            <span className={styles.queueCount}>{jobs.length} проектов</span>
          </div>
          <p className={styles.queueHint}>Без реальной очереди рендер продвигается по таймеру — эта кнопка не ждёт его.</p>
          <button className={controls.buttonSecondary} onClick={tickNow}>
            Продвинуть рендер сейчас
          </button>

          {jobs.length > 0 && (
            <div className={styles.jobList}>
              {jobs.map((j) => (
                <div key={j.id} className={styles.jobCard} style={{ '--job-color': STATUS_COLOR[j.status] } as React.CSSProperties}>
                  <div className={styles.jobHeader}>
                    <span className={styles.jobTemplate}>{TEMPLATES.find((t) => t.value === j.template)?.title ?? j.template}</span>
                    <span className={styles.statusBadge}>{STATUS_LABEL[j.status]}</span>
                  </div>

                  <div className={styles.progressRow}>
                    <div className={styles.progressTrack}>
                      <div className={styles.progressFill} style={{ width: `${j.progress_percent}%` }} />
                    </div>
                    <span className={styles.progressPercent}>{j.progress_percent}%</span>
                  </div>

                  {j.status === 'processing' && j.stage && (
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
                  {j.output_url && j.pipeline === 'smart_cut' && (
                    <video className={styles.jobPlayer} src={j.output_url} controls preload="metadata" />
                  )}

                  {j.output_url && (
                    <div className={styles.jobOutputRow}>
                      <a className={styles.jobOutputButton} href={j.output_url} download target="_blank" rel="noreferrer">
                        Скачать видео
                      </a>
                      {/* output_url is a mock link (render.mock doesn't resolve to a
                          real server) until a real Shotstack/Creatomate integration
                          replaces videoRender.ts — flagging that here so clicking
                          "Скачать" and hitting a DNS error isn't a surprise. */}
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
                <p>Выбери файл и нажми «Смонтировать».</p>
              </div>
            </div>
          )}

          <StatusMessage>{status}</StatusMessage>
        </section>
      </main>
    </div>
  );
}
