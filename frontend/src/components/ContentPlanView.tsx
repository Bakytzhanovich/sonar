'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, type ContentRecommendation } from '@/lib/api';
import { useDevConfig } from '@/lib/useDevConfig';
import { useApiAccess } from '@/lib/useApiAccess';
import ModuleNav from './ModuleNav';
import TabBar from './TabBar';
import NoticeBanner, { MISSING_API_KEY_MESSAGE } from './NoticeBanner';
import StatusMessage from './StatusMessage';
import controls from './Controls.module.css';
import styles from './ContentPlanView.module.css';
import layout from './Layout.module.css';

const DEFAULT_ONBOARDING_SEGMENT = 'запуск';

function normalizeSegment(value: string): string {
  return value.trim().toLocaleLowerCase('ru');
}

export default function ContentPlanView() {
  const searchParams = useSearchParams();
  const onboarding = searchParams.get('onboarding') === '1';
  const requestedSegment = searchParams.get('segment')?.trim() || (onboarding ? DEFAULT_ONBOARDING_SEGMENT : '');
  const requestedSubscriberId = searchParams.get('subscriber')?.trim() || null;

  const [devConfig] = useDevConfig();
  const { baseUrl, apiKey } = devConfig;
  const config = { baseUrl, apiKey };
  // Not the same as holding a key — see useApiAccess: the session is a cookie
  // this code cannot read.
  const { hasAccess } = useApiAccess();

  const [segmentFilter, setSegmentFilter] = useState(requestedSegment);
  const [recommendations, setRecommendations] = useState<ContentRecommendation[]>([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);

  const onboardingRecommendation = onboarding
    ? recommendations.find((recommendation) => normalizeSegment(recommendation.segment) === normalizeSegment(requestedSegment))
    : undefined;
  const onboardingHasClientSignal = Boolean(onboardingRecommendation && onboardingRecommendation.clientCount > 0);
  const crmReturnHref = `/crm?onboarding=1&segment=${encodeURIComponent(requestedSegment || DEFAULT_ONBOARDING_SEGMENT)}${
    requestedSubscriberId ? `&subscriber=${encodeURIComponent(requestedSubscriberId)}` : ''
  }`;

  const load = useCallback(async () => {
    setStatus('');
    if (!hasAccess) {
      setRecommendations([]);
      setHasLoaded(true);
      return;
    }

    setLoading(true);
    try {
      const res = await api.getContentRecommendations(config, segmentFilter || undefined);
      setRecommendations(res.recommendations);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setHasLoaded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, baseUrl, segmentFilter]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  return (
    <div className={styles.page}>
      <header className={layout.header}>
        <div className={styles.headerTitle}><span className={styles.eyebrow}>СТРАТЕГИЯ</span><span className={layout.title}>Контент-план</span></div>
        <ModuleNav current="/content-plan" />
      </header>

      <main className={styles.main}>
        {!hasAccess && <NoticeBanner>{MISSING_API_KEY_MESSAGE}</NoticeBanner>}

        <div className={styles.intro}><div><h1>Темы, которые ведут к сделке</h1><p>
          Sonar сравнивает сегменты CRM: сколько контактов получили тег, кто из них стал клиентом и есть ли уже сценарии на эту тему. Объяснение сейчас формируется по правилам, без AI-прогноза.
        </p></div><div className={styles.introMark}>CRM<br />→<br />ПЛАН</div></div>

        <input
          className={`${controls.input} ${styles.filterInput}`}
          value={segmentFilter}
          onChange={(e) => setSegmentFilter(e.target.value)}
          placeholder="показать темы для сегмента (тега)…"
        />

        {onboarding && !hasLoaded && (
          <section className={styles.onboardingState} aria-live="polite">
            <span className={styles.onboardingEyebrow}>Шаг 4 из 4 · Контент-план</span>
            <h2>Собираем сигнал из CRM</h2>
            <p>Проверяем статус и тег сегмента «{requestedSegment}».</p>
          </section>
        )}

        {onboarding && hasLoaded && !loading && onboardingRecommendation && onboardingHasClientSignal && (
          <section className={`${styles.onboardingState} ${styles.onboardingComplete}`} aria-labelledby="content-onboarding-title">
            <span className={styles.onboardingEyebrow}>Онбординг завершён</span>
            <h2 id="content-onboarding-title">CRM и контент связаны</h2>
            <p>
              Рекомендация по теме «{onboardingRecommendation.segment}» появилась, потому что CRM видит контакт с этим тегом и статусом «Клиент».
            </p>
            <p className={styles.onboardingCaveat}>
              Сейчас это проверка цепочки на одном демо-контакте, а не статистически надёжный прогноз. Точность вырастет по мере накопления реальных диалогов и сделок.
            </p>
            <Link href="/bot" className={`${controls.buttonSecondary} ${styles.onboardingCta}`}>
              Перейти в рабочее пространство
            </Link>
          </section>
        )}

        {onboarding && hasLoaded && !loading && !onboardingHasClientSignal && (
          <section className={styles.onboardingState} aria-labelledby="content-onboarding-missing-title">
            <span className={styles.onboardingEyebrow}>Шаг 4 из 4 · Нужен ещё один сигнал</span>
            <h2 id="content-onboarding-missing-title">
              {onboardingRecommendation ? 'Нужен статус «Клиент»' : 'Рекомендация пока не появилась'}
            </h2>
            <p>
              {onboardingRecommendation
                ? `Сегмент «${onboardingRecommendation.segment}» уже виден, но в нём пока нет контакта со статусом «Клиент». Вернитесь в CRM и зафиксируйте результат диалога.`
                : `Для сегмента «${requestedSegment || DEFAULT_ONBOARDING_SEGMENT}» нужен контакт, у которого одновременно стоят этот тег и статус «Клиент». Вернитесь к контакту и проверьте оба пункта.`}
            </p>
            <Link href={crmReturnHref} className={`${controls.buttonPrimary} ${styles.onboardingCta}`}>
              Проверить контакт в CRM
            </Link>
          </section>
        )}

        {recommendations.length > 0 && <div className={styles.summary}><strong>{recommendations.length}</strong><span>сегмента найдено<br /><small>на основе живых данных CRM</small></span></div>}
        <div className={styles.cards}>
        {recommendations.map((r, i) => (
          <div key={r.segment} className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.segmentGroup}>
                {/* Real rank, not decoration — recommendations already come
                    back sorted by rankScore; this just makes that order
                    legible instead of implicit in array position. */}
                <span className={styles.rank}>{i + 1}</span>
                <span className={styles.segment}>{r.segment}</span>
              </div>
              <span className={styles.conversionPct}>{Math.round(r.conversionRate * 100)}%</span>
            </div>

            <div className={styles.barTrack}>
              <div className={styles.barFill} style={{ width: `${Math.round(r.conversionRate * 100)}%` }} />
            </div>

            <p className={styles.explanation}>{r.explanation}</p>

            <div className={styles.meta}>
              <span>{r.clientCount} из {r.subscriberCount} подписчиков стали клиентами</span>
              <span className={`${styles.scriptBadge} ${r.matchingScriptCount > 0 ? styles.scriptBadgeReady : styles.scriptBadgeMissing}`}>
                {r.matchingScriptCount > 0 ? `${r.matchingScriptCount} сценариев готово` : 'сценариев нет'}
              </span>
            </div>
          </div>
        ))}
        </div>

        {/* Explains sparseness, doesn't try to fix it — more segments only
            comes from more tagged subscribers, which is a CRM task, not
            something this screen can generate. Threshold (not just ===0)
            because 1-2 cards reads just as "is this broken?" as zero does. */}
        {!onboarding && hasLoaded && !loading && recommendations.length < 4 && (
          <div className={styles.emptyHint}>
            <p>
              {recommendations.length === 0
                ? 'Пока нет сегментов для сравнения. Отметьте в CRM хотя бы один контакт тегом и укажите, стал ли он клиентом.'
                : 'Чем больше контактов размечено тегами и статусами, тем больше сегментов можно сравнить.'}
            </p>
            <Link href="/crm" className={controls.buttonSecondary}>
              Перейти в CRM
            </Link>
          </div>
        )}

        <StatusMessage>{status}</StatusMessage>
      </main>
      <TabBar current="/content-plan" />
    </div>
  );
}
