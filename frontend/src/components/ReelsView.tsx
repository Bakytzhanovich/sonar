'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type GeneratedScript, type ReelAnalysis } from '@/lib/api';
import { useDevConfig } from '@/lib/useDevConfig';
import { useApiAccess } from '@/lib/useApiAccess';
import PageHeader from './PageHeader';
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
  source_too_large: 'Файл больше 600 МБ — для рилса это слишком много.',
  transcription_failed: 'Не получилось расшифровать речь. Попробуйте ещё раз.',
  transcription_quota_exhausted: 'Закончился лимит расшифровки. Попробуйте позже.',
  transcription_not_configured: 'Расшифровка не настроена на сервере.',
  llm_not_configured: 'Разбор не настроен на сервере.',
  llm_failed: 'Не получилось разобрать ролик. Загрузите его ещё раз.',
  llm_invalid_answer: 'Не получилось разобрать ролик. Загрузите его ещё раз.',
  storage_not_configured: 'Хранилище файлов не настроено.',
  legacy_mock: 'Старый тестовый разбор — это не настоящий анализ. Загрузите ролик заново.',
};

// Mirrors the server's REEL_RETRYABLE: offered only where another attempt
// can change the answer. The server refuses the rest anyway.
const RETRYABLE = new Set(['llm_failed', 'llm_invalid_answer', 'transcription_failed', 'transcription_quota_exhausted']);

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
      const ticket = await api.createVideoUpload(config, file.type || 'video/mp4', file.size);
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

  async function retry() {
    if (!selected) return;
    try {
      await api.retryAnalysis(config, selected.id);
      await loadAnalyses();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove() {
    if (!selected) return;
    // Asked, because it cannot be undone and takes the uploaded file and the
    // scripts with it.
    if (!window.confirm('Удалить разбор вместе со сценариями и загруженным видео?')) return;
    try {
      await api.deleteAnalysis(config, selected.id);
      setSelectedId(null);
      await loadAnalyses();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  // Copies what is in the box, edits included — the script is for a notes
  // app or a teleprompter, and selecting a long text by hand on a phone is
  // the part people give up on.
  const [copiedId, setCopiedId] = useState<string | null>(null);
  async function copyScript(id: string, textarea: HTMLTextAreaElement | null) {
    if (!textarea) return;
    try {
      await navigator.clipboard.writeText(textarea.value);
      setCopiedId(id);
      setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 2000);
    } catch {
      // Clipboard can be refused (insecure context, permissions); selecting
      // the text leaves the person one shortcut away instead.
      textarea.select();
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
      <PageHeader section="Исследования" title="Анализ рилсов" current="/reels" />

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
              placeholder="Например: фитнес" aria-label="Ниша"
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
              <h2>Найдите повторяемую механику</h2>
              <p>
                Загрузите чужой рилс, который хорошо зашёл: разберём, чем он цепляет и как устроен, и перепишем под вашу
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
              <div className={styles.failureActions}>
                {RETRYABLE.has(selected.failure_reason ?? '') && (
                  <button className={controls.buttonPrimary} onClick={retry}>
                    Попробовать ещё раз
                  </button>
                )}
                <button className={controls.buttonSecondary} onClick={remove}>
                  Удалить разбор
                </button>
              </div>
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
                  <button type="button" className={styles.deleteLink} onClick={remove}>
                    Удалить разбор
                  </button>
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
                <p className={styles.panelHint}>Та же механика, но про вашу тему — готовый текст, который можно сразу записать.</p>
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
                    <div className={styles.scriptHead}>
                      <span className={styles.nicheBadge}>{s.niche}</span>
                      <button
                        type="button"
                        className={controls.buttonSecondary}
                        onClick={(e) =>
                          copyScript(s.id, e.currentTarget.closest('div')?.parentElement?.querySelector('textarea') ?? null)
                        }
                      >
                        {copiedId === s.id ? 'Скопировано ✓' : 'Скопировать'}
                      </button>
                    </div>
                    {/* Editable so it can be tweaked before recording; the
                        copy button takes the edited text. */}
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
