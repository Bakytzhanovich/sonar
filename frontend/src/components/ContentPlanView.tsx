'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type ContentRecommendation } from '@/lib/api';
import { useDevConfig } from '@/lib/useDevConfig';

export default function ContentPlanView() {
  const [devConfig] = useDevConfig();
  const { baseUrl, apiKey } = devConfig;
  const config = { baseUrl, apiKey };

  const [segmentFilter, setSegmentFilter] = useState('');
  const [recommendations, setRecommendations] = useState<ContentRecommendation[]>([]);
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    if (!apiKey) return;
    try {
      const res = await api.getContentRecommendations(config, segmentFilter || undefined);
      setRecommendations(res.recommendations);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, baseUrl, segmentFilter]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'system-ui, sans-serif' }}>
      <header style={{ padding: 12, borderBottom: '1px solid #ddd', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <strong>Sonar — Контент-план (CRM + рилсы)</strong>
        <span style={{ fontSize: 11, color: '#888' }}>
          {apiKey ? '' : 'Нет apiKey — зайди через редактор бота и нажми "Быстрый старт"'}
        </span>
        <Link href="/" style={{ marginLeft: 'auto' }}>
          ← Редактор бота
        </Link>
        <Link href="/scheduler">Автопостинг →</Link>
        <Link href="/video">Видео →</Link>
      </header>

      <div style={{ flex: 1, padding: 16, overflowY: 'auto', maxWidth: 700 }}>
        <p style={{ color: '#666', fontSize: 13 }}>
          Рекомендации строятся из реальных данных: кто из подписчиков с каким тегом реально стал клиентом (Модуль 2 CRM) + есть ли уже
          готовые сценарии под эту тему (Модуль 3). Формулировка объяснения — мок LLM-вызова, сама логика ранжирования настоящая.
        </p>

        <input
          value={segmentFilter}
          onChange={(e) => setSegmentFilter(e.target.value)}
          placeholder="показать темы для сегмента (тега)…"
          style={{ width: '100%', padding: 6, marginBottom: 16 }}
        />

        {recommendations.length === 0 && <p style={{ color: '#888' }}>Пока нет рекомендаций — нужны подписчики с тегами в CRM.</p>}

        {recommendations.map((r) => (
          <div key={r.segment} style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <strong style={{ fontSize: 16 }}>{r.segment}</strong>
              <span style={{ fontSize: 13, color: '#1a9c4a', fontWeight: 'bold' }}>{Math.round(r.conversionRate * 100)}% конверсия</span>
            </div>
            <p style={{ fontSize: 13, color: '#333', marginTop: 6 }}>{r.explanation}</p>
            <div style={{ fontSize: 11, color: '#888' }}>
              {r.subscriberCount} подписчиков в сегменте · {r.matchingScriptCount} готовых сценариев
            </div>
          </div>
        ))}

        {status && <div style={{ fontSize: 12, color: '#555', marginTop: 8 }}>{status}</div>}
      </div>
    </div>
  );
}
