'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type VideoEditJob, type VideoTemplate } from '@/lib/api';
import { useDevConfig } from '@/lib/useDevConfig';

const TEMPLATES: { value: VideoTemplate; label: string }[] = [
  { value: 'auto_crop_916', label: 'Уровень 1: автонарезка 9:16 + субтитры' },
  { value: 'template_with_transitions', label: 'Уровень 2: шаблонный монтаж с переходами' },
];

const STATUS_LABEL: Record<string, string> = { processing: 'Рендерится', completed: 'Готово', failed: 'Ошибка' };

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'system-ui, sans-serif' }}>
      <header style={{ padding: 12, borderBottom: '1px solid #ddd', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <strong>Sonar — Видеомонтаж (Уровень 1-2, мок Shotstack/Creatomate)</strong>
        <span style={{ fontSize: 11, color: '#888' }}>
          {apiKey ? '' : 'Нет apiKey — зайди через редактор бота и нажми "Быстрый старт"'}
        </span>
        <Link href="/" style={{ marginLeft: 'auto' }}>
          ← Редактор бота
        </Link>
        <Link href="/content-plan">Контент-план →</Link>
      </header>

      <div style={{ flex: 1, padding: 16, overflowY: 'auto', maxWidth: 700 }}>
        <h4>Загрузка видео → шаблон → рендер</h4>
        <p style={{ fontSize: 12, color: '#888' }}>
          Реального файла нет — источник это просто ссылка (как ссылка на рилс в Модуле 3), настоящей загрузки/хранения видео не делаем.
        </p>
        <input value={sourceVideoUrl} onChange={(e) => setSourceVideoUrl(e.target.value)} style={{ width: '100%' }} />
        <select value={template} onChange={(e) => setTemplate(e.target.value as VideoTemplate)} style={{ width: '100%', margin: '4px 0' }}>
          {TEMPLATES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <button onClick={submit}>Отправить на рендер</button>{' '}
        <button onClick={tickNow}>Продвинуть рендер сейчас</button>

        <h4 style={{ marginTop: 16 }}>Очередь рендеров</h4>
        {jobs.map((j) => (
          <div key={j.id} style={{ border: '1px solid #ddd', borderRadius: 6, padding: 10, marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>{j.template}</span>
              <span>{STATUS_LABEL[j.status]}</span>
            </div>
            <div style={{ background: '#eee', borderRadius: 4, height: 8, marginTop: 6, overflow: 'hidden' }}>
              <div
                style={{
                  width: `${j.progress_percent}%`,
                  background: j.status === 'failed' ? '#c0392b' : '#1a9c4a',
                  height: '100%',
                }}
              />
            </div>
            <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
              {j.progress_percent}%{j.failure_reason && <> · причина: {j.failure_reason}</>}
            </div>
            {j.output_url && (
              <a href={j.output_url} target="_blank" rel="noreferrer">
                {j.output_url}
              </a>
            )}
          </div>
        ))}
        {jobs.length === 0 && <p style={{ color: '#888' }}>Пока пусто</p>}

        {status && <div style={{ fontSize: 12, color: '#555', marginTop: 8 }}>{status}</div>}
      </div>
    </div>
  );
}
