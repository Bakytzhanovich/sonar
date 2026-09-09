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
  const [template, setTemplate] = useState<VideoTemplate>('auto_crop_916');
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
    if (!sourceVideoUrl.trim()) return;
    try {
      await api.createVideoJob(config, sourceVideoUrl.trim(), template);
      await load();
      setStatus('Job создан, рендер пошёл (мок Shotstack/Creatomate)');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
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
              Реального файла нет — источник это просто ссылка (как ссылка на рилс в Модуле 3), настоящей загрузки/хранения видео не делаем.
            </p>
          </div>
        </div>

        <div className={styles.composer}>
          <div className={styles.composerHead}>
            <span className={styles.eyebrow}>НОВЫЙ ПРОЕКТ</span>
            <h2>Загрузи исходник</h2>
          </div>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Ссылка на видео</span>
            <input
              className={`${controls.input} ${styles.input}`}
              placeholder="https://example.com/my-video.mp4"
              value={sourceVideoUrl}
              onChange={(e) => setSourceVideoUrl(e.target.value)}
            />
          </label>

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
            disabled={!sourceVideoUrl.trim()}
          >
            Запустить рендер
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

                  {j.failure_reason && <div className={`${styles.jobMeta} ${styles.jobFailure}`}>Причина: {j.failure_reason}</div>}

                  {j.output_url && (
                    <div className={styles.jobOutputRow}>
                      <a className={styles.jobOutputButton} href={j.output_url} download target="_blank" rel="noreferrer">
                        Скачать видео
                      </a>
                      {/* output_url is a mock link (render.mock doesn't resolve to a
                          real server) until a real Shotstack/Creatomate integration
                          replaces videoRender.ts — flagging that here so clicking
                          "Скачать" and hitting a DNS error isn't a surprise. */}
                      <span className={styles.jobOutputHint}>мок-ссылка, реального файла ещё нет</span>
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
                <p>Добавь ссылку на видео, чтобы создать проект.</p>
              </div>
            </div>
          )}

          <StatusMessage>{status}</StatusMessage>
        </section>
      </main>
    </div>
  );
}
