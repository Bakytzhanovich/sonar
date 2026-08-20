'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type GeneratedScript, type ReelAnalysis } from '@/lib/api';
import { useDevConfig } from '@/lib/useDevConfig';

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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'system-ui, sans-serif' }}>
      <header style={{ padding: 12, borderBottom: '1px solid #ddd', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <strong>Sonar — Анализ рилсов (мок)</strong>
        <span style={{ fontSize: 11, color: '#888' }}>
          {apiKey ? '' : 'Нет apiKey — зайди через редактор бота и нажми "Быстрый старт"'}
        </span>
        <Link href="/" style={{ marginLeft: 'auto' }}>
          ← Редактор бота
        </Link>
        <Link href="/crm">CRM →</Link>
        <Link href="/carousels">Карусели →</Link>
        <Link href="/scheduler">Автопостинг →</Link>
        <Link href="/content-plan">Контент-план →</Link>
        <Link href="/video">Видео →</Link>
      </header>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ width: 320, borderRight: '1px solid #ddd', padding: 12, overflowY: 'auto' }}>
          <h4>Вставьте ссылку</h4>
          <input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} style={{ width: '100%' }} />
          <button onClick={analyze} style={{ marginTop: 6 }}>
            Разобрать
          </button>

          <h4 style={{ marginTop: 16 }}>Библиотека</h4>
          {analyses.map((a) => (
            <div
              key={a.id}
              onClick={() => selectAnalysis(a.id)}
              style={{
                cursor: 'pointer',
                padding: 6,
                border: '1px solid #ccc',
                borderRadius: 4,
                marginBottom: 6,
                background: a.id === selectedId ? '#eef' : undefined,
              }}
            >
              <div style={{ fontSize: 12, wordBreak: 'break-all' }}>{a.source_url}</div>
              <div style={{ fontSize: 11, color: '#666' }}>{a.hook}</div>
            </div>
          ))}

          <h4 style={{ marginTop: 16 }}>Поиск сценариев по нише</h4>
          <input value={nicheSearch} onChange={(e) => setNicheSearch(e.target.value)} placeholder="напр. фитнес" style={{ width: '70%' }} />
          <button onClick={searchByNiche}>Найти</button>
          {searchResults && (
            <ul style={{ fontSize: 12 }}>
              {searchResults.map((s) => (
                <li key={s.id}>{s.script_text.slice(0, 60)}…</li>
              ))}
              {searchResults.length === 0 && <li style={{ color: '#888' }}>Ничего не найдено</li>}
            </ul>
          )}
        </div>

        <div style={{ flex: 1, padding: 12, overflowY: 'auto' }}>
          {!selected ? (
            <p>Выбери разбор из библиотеки слева или создай новый.</p>
          ) : (
            <>
              <h3>Карточка анализа</h3>
              <p style={{ fontSize: 12, color: '#888' }}>{selected.source_url}</p>
              <p>
                <strong>Хук:</strong> {selected.hook}
              </p>
              <p>
                <strong>Длительность:</strong> {selected.duration_seconds}с
              </p>
              <p>
                <strong>Текст на экране:</strong> {selected.on_screen_text}
              </p>

              <h4>Структура (чек-лист)</h4>
              <ul>
                {selected.structure.map((beat, i) => (
                  <li key={i}>
                    <label>
                      <input type="checkbox" /> {beat.label} — {beat.timestampSeconds}с
                    </label>
                  </li>
                ))}
              </ul>

              <h4>Сгенерировать сценарий под нишу</h4>
              <input value={niche} onChange={(e) => setNiche(e.target.value)} style={{ width: 200 }} />
              <button onClick={generate}>Сгенерировать сценарий</button>

              {scripts.map((s) => (
                <div key={s.id} style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, color: '#888' }}>ниша: {s.niche}</div>
                  {/* Editable per the ТЗ ("редактируемый текстовый блок") — edits are local only, not persisted back. */}
                  <textarea defaultValue={s.script_text} rows={10} style={{ width: '100%' }} />
                </div>
              ))}
            </>
          )}

          {status && <div style={{ fontSize: 12, color: '#555', marginTop: 8 }}>{status}</div>}
        </div>
      </div>
    </div>
  );
}
