'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type GeneratedScript, type ReelAnalysis } from '@/lib/api';
import { useDevConfig } from '@/lib/useDevConfig';
import { useApiAccess } from '@/lib/useApiAccess';
import ModuleNav from './ModuleNav';
import TabBar from './TabBar';
import StatusMessage from './StatusMessage';
import controls from './Controls.module.css';
import styles from './ReelsView.module.css';
import layout from './Layout.module.css';

// Module 3 — upload a reel, get back what makes it work.
//
// The file is uploaded rather than linked: the server does not download other
// people's reels (the same legal question that keeps Module 7 unstarted), and
// the person making the comparison usually has the file. The worker
// transcribes it and a model reads the transcript for its mechanic; this
// screen polls while that happens.

const STAGE_LABEL: Record<string, string> = {
  probe: 'Открываю файл',
  transcribe: 'Расшифровываю речь',
  analyze: 'Разбираю структуру',
};

// Said for the person, not for us — what happened and what to do about it.
const FAILURE_LABEL: Record<string, string> = {
  no_audio_track: 'В ролике нет звука — разбирать нечего.',
  no_speech: 'В ролике нет речи. Механика читается по словам, а здесь их нет.',
  video_too_long: 'Слишком длинное видео — разбираем ролики до 3 минут.',
  source_unreadable: 'Не получилось открыть файл. Попробуйте MP4.',
  audio_too_large: 'Слишком большой файл для расшифровки.',
  transcription_failed: 'Не получилось расшифровать речь. Попробуйте ещё раз.',
  transcription_quota_exhausted: 'Закончился лимит расшифровки. Попробуйте позже.',
  transcription_not_configured: 'Расшифровка не настроена на сервере.',
  llm_not_configured: 'Разбор не настроен на сервере.',
  llm_failed: 'Не получилось разобрать ролик. Загрузите его ещё раз.',
  llm_invalid_answer: 'Не получилось разобрать ролик. Загрузите его ещё раз.',
  storage_not_configured: 'Хранилище файлов не настроено.',
  legacy_mock: 'Старый тестовый разбор — это не настоящий анализ. Загрузите ролик заново.',
};

const SCRIPT_ERROR: Record<string, string> = {
  analysis_not_ready: 'Разбор ещё не готов.',
  llm_not_configured: 'Сценарии не настроены на сервере.',
  llm_failed: 'Не получилось написать сценарий. Попробуйте ещё раз.',
  llm_invalid_answer: 'Не получилось написать сценарий. Попробуйте ещё раз.',
};

function seconds(value: number): string {
  const m = Math.floor(value / 60);
  const s = Math.floor(value % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s} с`;
}

// The part of the reel the playhead is in: the last one that has started.
function activeBeatIndex(starts: number[], at: number): number {
  let index = -1;
  starts.forEach((start, i) => {
    if (at + 0.05 >= start) index = i;
  });
  return index;
}

// The upload screen's own wording for an API error, falling back to the raw
// message only when there is nothing better to say.
function errorText(err: unknown, table: Record<string, string>): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = Object.keys(table).find((key) => message.includes(key));
  return code ? table[code] : message;
}

export default function ReelsView() {
  const [devConfig] = useDevConfig();
  const { baseUrl, apiKey } = devConfig;
  const config = { baseUrl, apiKey };
  // Not the same as holding a key — see useApiAccess: the session is a cookie
  // this code cannot read.
  const { hasAccess } = useApiAccess();

  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [analyses, setAnalyses] = useState<ReelAnalysis[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scripts, setScripts] = useState<GeneratedScript[]>([]);
  const [niche, setNiche] = useState('');
  const [writing, setWriting] = useState(false);
  const [nicheSearch, setNicheSearch] = useState('');
  const [searchResults, setSearchResults] = useState<GeneratedScript[] | null>(null);
  const [status, setStatus] = useState('');
  // The reel itself, for the selected analysis. Fetched once per selection —
  // a signed link, so it is not part of the polled list.
  const [video, setVideo] = useState<{ id: string; url: string | null } | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);

  const selected = analyses.find((a) => a.id === selectedId) ?? null;
  const selectedReady = selected?.status === 'completed';

  useEffect(() => {
    if (!selectedId || !selectedReady) return;
    let cancelled = false;
    api
      .getAnalysis(config, selectedId)
      .then((res) => {
        if (!cancelled) setVideo({ id: selectedId, url: res.videoUrl });
      })
      .catch(() => {
        if (!cancelled) setVideo({ id: selectedId, url: null });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, selectedReady]);

  const videoUrl = video && video.id === selectedId ? video.url : null;

  // Jump the player to where a part of the reel starts — the point of having
  // the video beside the analysis is to check each claim against it.
  function seekTo(sec: number) {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = sec;
    void el.play().catch(() => {});
  }

  const loadAnalyses = useCallback(async () => {
    if (!hasAccess) return;
    try {
      const res = await api.listAnalyses(config);
      setAnalyses(res.analyses);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAccess, apiKey, baseUrl]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAnalyses();
  }, [loadAnalyses]);

  // Poll while the worker has something in hand; stop the moment nothing is
  // processing, so an idle screen costs nothing.
  useEffect(() => {
    if (!analyses.some((a) => a.status === 'processing')) return;
    const timer = setInterval(loadAnalyses, 2500);
    return () => clearInterval(timer);
  }, [analyses, loadAnalyses]);

  async function analyze() {
    if (!file) return;
    setUploading(true);
    setStatus('');
    try {
      const ticket = await api.createVideoUpload(config, file.type || 'video/mp4');
      await api.uploadVideoFile(ticket, file);
      const res = await api.createAnalysis(config, ticket.objectKey);
      await loadAnalyses();
      setSelectedId(res.analysis.id);
      setScripts([]);
      setFile(null);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  async function selectAnalysis(id: string) {
    setSelectedId(id);
    setScripts([]);
    try {
      const res = await api.listScriptsForAnalysis(config, id);
      setScripts(res.scripts);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function generate() {
    if (!selected || !niche.trim()) return;
    setWriting(true);
    setStatus('');
    try {
      await api.generateScript(config, selected.id, niche.trim());
      const res = await api.listScriptsForAnalysis(config, selected.id);
      setScripts(res.scripts);
    } catch (err) {
      setStatus(errorText(err, SCRIPT_ERROR));
    } finally {
      setWriting(false);
    }
  }

  async function searchByNiche() {
    if (!nicheSearch.trim()) return setSearchResults(null);
    try {
      const res = await api.searchScriptsByNiche(config, nicheSearch.trim());
      setSearchResults(res.scripts);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className={styles.page}>
      <header className={layout.header}>
        <div className={styles.headerTitle}>
          <span className={styles.eyebrow}>ИССЛЕДОВАНИЯ</span>
          <span className={layout.title}>Анализ рилсов</span>
        </div>
        <ModuleNav current="/reels" />
      </header>

      <div className={layout.twoPane}>
        <div className={`${layout.sidebar} ${styles.sidebar}`}>
          {/* The upload lives in the main area, where the screen's own
              empty state points; this only gets back to it from a result. */}
          {selected && (
            <button
              type="button"
              className={`${controls.buttonSecondary} ${styles.fullButton}`}
              onClick={() => setSelectedId(null)}
            >
              + Новый разбор
            </button>
          )}

          {analyses.length > 0 && <div className={styles.sectionLabel}>Мои разборы</div>}
          {analyses.map((a) => (
            <button
              type="button"
              key={a.id}
              onClick={() => selectAnalysis(a.id)}
              className={`${styles.analysisItem} ${a.id === selectedId ? styles.analysisItemActive : ''}`}
            >
              <span className={styles.itemTitle}>
                {a.status === 'completed' && a.hook}
                {a.status === 'processing' && (STAGE_LABEL[a.stage ?? ''] ?? 'В очереди') + '…'}
                {a.status === 'failed' && 'Не получилось'}
              </span>
              <span className={styles.itemMeta}>
                {new Date(a.created_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
                {a.duration_seconds ? ` · ${seconds(a.duration_seconds)}` : ''}
              </span>
            </button>
          ))}

          <div className={styles.sectionLabel}>Сценарии по нише</div>
          <div className={styles.searchRow}>
            <input
              className={controls.input}
              value={nicheSearch}
              onChange={(e) => setNicheSearch(e.target.value)}
              placeholder="Например: фитнес"
            />
            <button className={controls.buttonSecondary} onClick={searchByNiche}>
              Найти
            </button>
          </div>
          {searchResults && (
            <div className={styles.searchResults}>
              {searchResults.map((s) => (
                <div key={s.id} className={styles.searchResultItem}>
                  {s.script_text.slice(0, 80)}…
                </div>
              ))}
              {searchResults.length === 0 && <div className={styles.searchResultEmpty}>Ничего не найдено</div>}
            </div>
          )}
        </div>

        <div className={`${layout.main} ${styles.main}`}>
          {!selected && (
            <div className={styles.uploadPanel}>
              <span className={styles.eyebrow}>АНАЛИЗ КОНТЕНТА</span>
              <h2>Найди повторяемую механику</h2>
              <p>
                Загрузи чужой рилс, который хорошо зашёл: разберём, чем он цепляет и как устроен, и перепишем под твою
                нишу.
              </p>
              {/* A file, not a link: the server does not download other
                  people's reels. Styled as a target, because the native
                  input is a tiny OS button with English text on it. */}
              <label className={`${styles.dropzone} ${file ? styles.dropzoneFilled : ''}`}>
                <input
                  className={styles.hiddenInput}
                  type="file"
                  accept="video/mp4,video/quicktime,video/webm"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
                <span className={styles.dropzoneIcon} aria-hidden="true">{file ? '▶' : '+'}</span>
                <span className={styles.dropzoneTitle}>{file ? file.name : 'Выбрать рилс'}</span>
                <span className={styles.dropzoneHint}>
                  {file ? `${(file.size / 1024 / 1024).toFixed(1)} МБ · нажмите, чтобы заменить` : 'Файл видео, до 3 минут'}
                </span>
              </label>
              <button
                className={`${controls.buttonPrimary} ${styles.analyzeButton}`}
                onClick={analyze}
                disabled={!file || uploading || !hasAccess}
              >
                {uploading ? 'Загружаю…' : 'Разобрать'}
              </button>
              {/* One message, at the button — the only thing that needs an account. */}
              {!hasAccess && (
                <p className={styles.accessHint}>
                  Чтобы разобрать, нужен аккаунт: <a href="/login">Войти</a> · <a href="/signup">Регистрация</a>
                </p>
              )}
            </div>
          )}

          {selected?.status === 'processing' && (
            <div className={styles.progress}>
              <span className={styles.eyebrow}>ИДЁТ РАЗБОР</span>
              <h2>{(STAGE_LABEL[selected.stage ?? ''] ?? 'Ждёт очереди') + '…'}</h2>
              <p>Обычно это меньше минуты. Страницу можно не обновлять.</p>
            </div>
          )}

          {selected?.status === 'failed' && (
            <div className={styles.progress}>
              <span className={styles.eyebrow}>РАЗБОР НЕ ПОЛУЧИЛСЯ</span>
              <h2>{FAILURE_LABEL[selected.failure_reason ?? ''] ?? 'Что-то пошло не так. Загрузите ролик ещё раз.'}</h2>
            </div>
          )}

          {selected?.status === 'completed' && selected.structure && (
            <>
              <div className={styles.resultGrid}>
                {/* The reel beside its analysis, so every claim below can be
                    checked against the video instead of taken on trust. */}
                <div className={styles.playerColumn}>
                  {videoUrl ? (
                    <video
                      ref={videoRef}
                      className={styles.player}
                      src={videoUrl}
                      controls
                      playsInline
                      preload="metadata"
                      onTimeUpdate={(e) => setPlayhead(e.currentTarget.currentTime)}
                    />
                  ) : (
                    <div className={styles.playerMissing}>Видео недоступно</div>
                  )}
                </div>

                <div className={styles.resultColumn}>
                  <div className={styles.signalCard}>
                    <span>ЧЕМ ЦЕПЛЯЕТ</span>
                    <strong>{selected.hook}</strong>
                  </div>

                  {selected.why && (
                    <div className={styles.signalCard}>
                      <span>ПОЧЕМУ РАБОТАЕТ</span>
                      <p>{selected.why}</p>
                    </div>
                  )}

                  <h3 className={styles.sectionTitle}>Структура ролика</h3>
                  {selected.duration_seconds ? (
                    <div className={styles.timeline}>
                      {selected.structure.map((beat, i) => (
                        <span
                          key={i}
                          className={styles.timelineMarker}
                          style={{ left: `${Math.min(100, (beat.timestampSeconds / selected.duration_seconds!) * 100)}%` }}
                          title={`${beat.label} — ${seconds(beat.timestampSeconds)}`}
                        />
                      ))}
                      {videoUrl ? (
                        <span
                          className={styles.timelinePlayhead}
                          style={{ left: `${Math.min(100, (playhead / selected.duration_seconds) * 100)}%` }}
                        />
                      ) : null}
                    </div>
                  ) : null}
                  {/* Each part is a button that plays the reel from where the
                      part starts; the part being played is highlighted. */}
                  <ol className={styles.beatList}>
                    {(() => {
                      const active = videoUrl
                        ? activeBeatIndex(selected.structure.map((b) => b.timestampSeconds), playhead)
                        : -1;
                      return selected.structure.map((beat, i) => (
                        <li key={i}>
                          <button
                            type="button"
                            className={`${styles.beatItem} ${i === active ? styles.beatItemActive : ''}`}
                            onClick={() => seekTo(beat.timestampSeconds)}
                            disabled={!videoUrl}
                          >
                            <span className={styles.beatTime}>{seconds(beat.timestampSeconds)}</span>
                            <span>
                              <strong>{beat.label}</strong>
                              {beat.summary ? <span className={styles.beatSummary}> — {beat.summary}</span> : null}
                            </span>
                          </button>
                        </li>
                      ));
                    })()}
                  </ol>
                </div>
              </div>

              {selected.transcript && selected.transcript.length > 0 && (
                <>
                  <h3 className={styles.sectionTitle}>Что говорится</h3>
                  <p className={styles.transcript}>{selected.transcript.map((w) => w.word).join(' ')}</p>
                </>
              )}

              <div className={styles.scriptPanel}>
                <h3>Переписать под свою нишу</h3>
                <p className={styles.panelHint}>Та же механика, но про твою тему — готовый текст, который можно сразу записать.</p>
                <div className={styles.nicheRow}>
                  <input
                    className={controls.input}
                    value={niche}
                    onChange={(e) => setNiche(e.target.value)}
                    placeholder="Например: фитнес, недвижимость, психология"
                  />
                  <button className={controls.buttonPrimary} onClick={generate} disabled={!niche.trim() || writing}>
                    {writing ? 'Пишу…' : 'Написать сценарий'}
                  </button>
                </div>

                {scripts.map((s) => (
                  <div key={s.id} className={styles.scriptCard}>
                    <span className={styles.nicheBadge}>{s.niche}</span>
                    {/* Editable so it can be tweaked before recording; the
                        edits stay on this screen. */}
                    <textarea className={`${controls.input} ${styles.scriptTextarea}`} defaultValue={s.script_text} rows={12} />
                  </div>
                ))}
              </div>
            </>
          )}

          <StatusMessage>{status}</StatusMessage>
        </div>
      </div>
      <TabBar current="/reels" />
    </div>
  );
}
