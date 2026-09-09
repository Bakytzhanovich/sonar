'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type GeneratedScript, type ReelAnalysis } from '@/lib/api';
import { useDevConfig } from '@/lib/useDevConfig';
import ModuleNav from './ModuleNav';
import NoticeBanner, { MISSING_API_KEY_MESSAGE } from './NoticeBanner';
import StatusMessage from './StatusMessage';
import controls from './Controls.module.css';
import styles from './ReelsView.module.css';
import layout from './Layout.module.css';

export default function ReelsView() {
  const [devConfig] = useDevConfig();
  const { baseUrl, apiKey } = devConfig;
  const config = { baseUrl, apiKey };

  const [sourceUrl, setSourceUrl] = useState('https://instagram.com/reel/example');
  const [analyses, setAnalyses] = useState<ReelAnalysis[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scripts, setScripts] = useState<GeneratedScript[]>([]);
  const [niche, setNiche] = useState('фитнес');
  const [nicheSearch, setNicheSearch] = useState('');
  const [searchResults, setSearchResults] = useState<GeneratedScript[] | null>(null);
  const [status, setStatus] = useState('');

  const selected = analyses.find((a) => a.id === selectedId) ?? null;

  const loadAnalyses = useCallback(async () => {
    if (!apiKey) return;
    try {
      const res = await api.listAnalyses(config);
      setAnalyses(res.analyses);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, baseUrl]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAnalyses();
  }, [loadAnalyses]);

  async function analyze() {
    if (!sourceUrl.trim()) return;
    try {
      const res = await api.createAnalysis(config, sourceUrl.trim());
      await loadAnalyses();
      setSelectedId(res.analysis.id);
      setScripts([]);
      setStatus('Разбор готов (мок-пайплайн — не настоящий анализ видео)');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function selectAnalysis(id: string) {
    setSelectedId(id);
    try {
      const res = await api.listScriptsForAnalysis(config, id);
      setScripts(res.scripts);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function generate() {
    if (!selected || !niche.trim()) return;
    try {
      await api.generateScript(config, selected.id, niche.trim());
      const res = await api.listScriptsForAnalysis(config, selected.id);
      setScripts(res.scripts);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
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
        <div><span className={styles.eyebrow}>ИССЛЕДОВАНИЯ</span><span className={layout.title}>Анализ рилсов</span></div>
        <ModuleNav current="/reels" />
      </header>

      <div className={layout.twoPane}>
        <div className={`${layout.sidebar} ${styles.sidebar}`}>
          {!apiKey && <NoticeBanner>{MISSING_API_KEY_MESSAGE}</NoticeBanner>}
          <div className={styles.panelHeading}><span className={styles.eyebrow}>НОВЫЙ РАЗБОР</span><h2>Источник видео</h2></div>
          <input className={controls.input} value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} style={{ width: '100%' }} />
          <button className={`${controls.buttonPrimary} ${styles.fullButton}`} onClick={analyze}>
            Разобрать
          </button>

          <div className={styles.divider} /><div className={styles.panelHeading}><span className={styles.eyebrow}>БИБЛИОТЕКА</span><h2>Последние разборы</h2></div>
          {analyses.map((a) => (
            <div
              key={a.id}
              onClick={() => selectAnalysis(a.id)}
              className={`${styles.analysisItem} ${a.id === selectedId ? styles.analysisItemActive : ''}`}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                <div style={{ fontSize: 12, wordBreak: 'break-all' }}>{a.source_url}</div>
                <span className={styles.durationBadge}>{a.duration_seconds}с</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>{a.hook}</div>
            </div>
          ))}

          <div className={styles.divider} /><div className={styles.panelHeading}><span className={styles.eyebrow}>БИБЛИОТЕКА СЦЕНАРИЕВ</span><h2>Поиск по нише</h2></div>
          <div className={styles.searchRow}>
            <input className={controls.input} value={nicheSearch} onChange={(e) => setNicheSearch(e.target.value)} placeholder="напр. фитнес" />
            <button className={controls.buttonSecondary} onClick={searchByNiche}>Найти</button>
          </div>
          {searchResults && (
            <div className={styles.searchResults}>
              {searchResults.map((s) => (
                <div key={s.id} className={styles.searchResultItem}>{s.script_text.slice(0, 60)}…</div>
              ))}
              {searchResults.length === 0 && <div className={styles.searchResultEmpty}>Ничего не найдено</div>}
            </div>
          )}
        </div>

        <div className={`${layout.main} ${styles.main}`}>
          {!selected ? (
            <div className={styles.emptyState}><div className={styles.emptyIcon}>◌</div><span className={styles.eyebrow}>АНАЛИЗ КОНТЕНТА</span><h2>Найди повторяемую механику</h2><p>Добавь рилс, чтобы разобрать хук, структуру и собрать сценарий под свою нишу.</p></div>
          ) : (
            <>
              <div className={styles.analysisHeader}><div><span className={styles.eyebrow}>РАЗБОР ЗАВЕРШЕН</span><h1>Карточка анализа</h1><p>{selected.source_url}</p></div><span className={styles.durationBadge}>{selected.duration_seconds}с</span></div>
              <div className={styles.signalGrid}><div className={styles.signalCard}><span>ХУК</span><strong>{selected.hook}</strong></div><div className={styles.signalCard}><span>ТЕКСТ НА ЭКРАНЕ</span><strong>{selected.on_screen_text}</strong></div></div>

              <h3 className={styles.sectionTitle}>Структура ролика</h3>
              {/* Real position in time, not decoration — each beat's
                  timestampSeconds plotted against the reel's actual
                  duration_seconds. */}
              <div className={styles.timeline}>
                {selected.structure.map((beat, i) => (
                  <span
                    key={i}
                    className={styles.timelineMarker}
                    style={{ left: `${Math.min(100, (beat.timestampSeconds / selected.duration_seconds) * 100)}%` }}
                    title={`${beat.label} — ${beat.timestampSeconds}с`}
                  />
                ))}
              </div>
              <div className={styles.beatList}>
                {selected.structure.map((beat, i) => (
                  <label key={i} className={styles.beatItem}>
                    <input type="checkbox" /> {beat.label} — {beat.timestampSeconds}с
                  </label>
                ))}
              </div>

              <div className={styles.scriptPanel}>
                <h3>Адаптировать под нишу</h3>
                <div className={styles.nicheRow}>
                  <input className={controls.input} value={niche} onChange={(e) => setNiche(e.target.value)} />
                  <button className={controls.buttonPrimary} onClick={generate}>Сгенерировать сценарий</button>
                </div>

                {scripts.map((s) => (
                  <div key={s.id} className={styles.scriptCard}>
                    <span className={styles.nicheBadge}>ниша: {s.niche}</span>
                    {/* Editable per the ТЗ ("редактируемый текстовый блок") — edits are local only, not persisted back. */}
                    <textarea className={`${controls.input} ${styles.scriptTextarea}`} defaultValue={s.script_text} rows={10} />
                  </div>
                ))}
              </div>
            </>
          )}

          <StatusMessage>{status}</StatusMessage>
        </div>
      </div>
    </div>
  );
}
