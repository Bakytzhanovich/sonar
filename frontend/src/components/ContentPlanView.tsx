'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, type ContentPlan, type ContentRecommendation, type ContentTopic, type PlanReadiness } from '@/lib/api';
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

// Mirrors MIN_CLIENT_MESSAGES in src/contentTopics.ts — only used to say how
// many are still missing; the server decides whether a plan can be made.
const MIN_CLIENT_MESSAGES = 3;

const PLAN_ERRORS: Record<string, string> = {
  not_enough_data: 'Пока мало переписок с купившими, чтобы увидеть закономерность',
  llm_not_configured: 'ИИ сейчас не подключён — план собрать не получится',
  llm_invalid_answer: 'ИИ не нашёл тем, подтверждённых сообщениями покупателей. Попробуйте позже, когда переписок станет больше',
  llm_failed: 'ИИ не ответил — попробуйте ещё раз через минуту',
};

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = Object.keys(PLAN_ERRORS).find((key) => message.includes(key));
  return code ? PLAN_ERRORS[code] : message;
}

// Shown before a workspace has data of its own, so the screen says what it is
// for instead of being an empty box. Labelled as an example everywhere it
// appears — a made-up topic passed off as theirs is the one thing this module
// must never show.
const EXAMPLE_TOPIC: ContentTopic = {
  id: 'example',
  title: 'Можно ли заниматься с больной спиной после родов',
  segment: 'йога для мам',
  why: 'Купившие чаще всего спрашивали, подойдут ли занятия при боли в спине. Ролик-ответ приведёт тех, кто сомневается так же.',
  quotes: ['подойдёт ли курс, если болит спина после родов?', 'у меня диастаз, мне можно?'],
  clientCount: 7,
  subscriberCount: 19,
};

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
  const [allRecommendations, setAllRecommendations] = useState<ContentRecommendation[]>([]);
  const [plan, setPlan] = useState<ContentPlan | null>(null);
  const [readiness, setReadiness] = useState<PlanReadiness | null>(null);
  const [generating, setGenerating] = useState(false);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);

  // Filtered here rather than by the server: the topics and the segments
  // answer to the same filter, and both are already on the page.
  const filter = normalizeSegment(segmentFilter);
  const recommendations = filter ? allRecommendations.filter((r) => normalizeSegment(r.segment).includes(filter)) : allRecommendations;
  const topics = (plan?.topics ?? []).filter((t) => !filter || normalizeSegment(t.segment).includes(filter));

  const onboardingRecommendation = onboarding
    ? allRecommendations.find((recommendation) => normalizeSegment(recommendation.segment) === normalizeSegment(requestedSegment))
    : undefined;
  const onboardingHasClientSignal = Boolean(onboardingRecommendation && onboardingRecommendation.clientCount > 0);
  const crmReturnHref = `/crm?onboarding=1&segment=${encodeURIComponent(requestedSegment || DEFAULT_ONBOARDING_SEGMENT)}${
    requestedSubscriberId ? `&subscriber=${encodeURIComponent(requestedSubscriberId)}` : ''
  }`;

  const load = useCallback(async () => {
    setStatus('');
    if (!hasAccess) {
      setAllRecommendations([]);
      setHasLoaded(true);
      return;
    }

    setLoading(true);
    try {
      const [recs, planRes] = await Promise.all([api.getContentRecommendations(config), api.getContentPlan(config)]);
      setAllRecommendations(recs.recommendations);
      setPlan(planRes.plan);
      setReadiness(planRes.readiness);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setHasLoaded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, baseUrl, hasAccess]);

  async function generate() {
    setGenerating(true);
    setStatus('');
    try {
      const res = await api.generateContentPlan(config);
      setPlan(res.plan);
    } catch (err) {
      setStatus(errorText(err));
    } finally {
      setGenerating(false);
    }
  }

  function topicUpdated(topic: ContentTopic) {
    setPlan((current) => current && { ...current, topics: current.topics.map((t) => (t.id === topic.id ? topic : t)) });
  }

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

        <div className={styles.intro}><div><h1>О чём снимать, чтобы покупали</h1><p>
          Sonar читает директ: о чём спрашивали те, кто купил, и чем их вопросы отличаются от остальных. Из этого — темы роликов, у каждой цитаты настоящих покупателей.
        </p></div><div className={styles.introMark}>ДИРЕКТ<br />→<br />ТЕМЫ</div></div>

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

        {!onboarding && hasLoaded && hasAccess && (
          <TopicsSection
            config={config}
            plan={plan}
            topics={topics}
            readiness={readiness}
            generating={generating}
            onGenerate={generate}
            onTopicUpdated={topicUpdated}
            onMessage={setStatus}
          />
        )}

        {allRecommendations.length > 0 && (
          <div className={styles.segmentsHead}>
            <h2>Кто покупает</h2>
            <p>Сегменты CRM: сколько контактов с тегом стали клиентами.</p>
            <input
              className={`${controls.input} ${styles.filterInput}`}
              value={segmentFilter}
              onChange={(e) => setSegmentFilter(e.target.value)}
              placeholder="найти сегмент (тег)…"
            />
          </div>
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
        {!onboarding && hasLoaded && !loading && readiness?.ready && allRecommendations.length > 0 && allRecommendations.length < 4 && (
          <div className={styles.emptyHint}>
            <p>
              Чем больше контактов размечено тегами и статусами, тем больше сегментов можно сравнить.
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

function TopicsSection({
  config,
  plan,
  topics,
  readiness,
  generating,
  onGenerate,
  onTopicUpdated,
  onMessage,
}: {
  config: { baseUrl: string; apiKey: string };
  plan: ContentPlan | null;
  topics: ContentTopic[];
  readiness: PlanReadiness | null;
  generating: boolean;
  onGenerate: () => void;
  onTopicUpdated: (topic: ContentTopic) => void;
  onMessage: (message: string) => void;
}) {
  if (!readiness) return null;

  // Not enough of their own data yet: what is missing, in order, and what the
  // page will look like once it is there.
  if (!plan && !readiness.ready) {
    const missing = Math.max(0, MIN_CLIENT_MESSAGES - readiness.clientMessages);
    const steps = [
      {
        done: readiness.instagramConnected,
        title: 'Подключите Instagram',
        text: 'Бот начнёт получать сообщения из директа.',
        href: '/scheduler',
        cta: 'Подключить',
      },
      {
        done: readiness.inboundMessages > 0,
        title: 'Переписки в директе',
        text: readiness.inboundMessages > 0 ? `Сообщений уже: ${readiness.inboundMessages}.` : 'Люди пишут вам — бот сохраняет их вопросы.',
        href: '/bot',
        cta: 'Настроить бота',
      },
      {
        done: readiness.clients > 0 && readiness.taggedSubscribers > 0,
        title: 'Отмечайте, кто купил',
        text: 'В CRM: тег — чем человек интересовался, статус «Клиент» — если купил.',
        href: '/crm',
        cta: 'Открыть CRM',
      },
    ];
    return (
      <section className={styles.topicsBlock}>
        <div className={styles.checklist}>
          <h2>Чтобы план заработал</h2>
          <ol className={styles.steps}>
            {steps.map((step, i) => (
              <li key={step.title} className={`${styles.step} ${step.done ? styles.stepDone : ''}`}>
                <span className={styles.stepMark} aria-hidden="true">{step.done ? '✓' : i + 1}</span>
                <span className={styles.stepBody}>
                  <strong>{step.title}</strong>
                  <span>{step.text}</span>
                </span>
                {!step.done && <Link href={step.href} className={controls.buttonSecondary}>{step.cta}</Link>}
              </li>
            ))}
          </ol>
          {readiness.clientMessages > 0 && missing > 0 && (
            <p className={styles.checklistNote}>Сообщений от купивших: {readiness.clientMessages}. Нужно ещё {missing}, чтобы увидеть закономерность.</p>
          )}
        </div>

        <div className={styles.exampleLabel}>Так будет выглядеть тема · пример</div>
        <TopicCard topic={EXAMPLE_TOPIC} example config={config} onTopicUpdated={onTopicUpdated} onMessage={onMessage} />
      </section>
    );
  }

  if (!plan) {
    return (
      <section className={`${styles.topicsBlock} ${styles.generateCard}`}>
        <h2>Данных уже хватает</h2>
        <p>Сообщений от купивших: {readiness.clientMessages}. Sonar прочитает их и предложит темы роликов — это займёт около минуты.</p>
        <button type="button" className={controls.buttonPrimary} onClick={onGenerate} disabled={generating}>
          {generating ? 'Читаю переписки…' : 'Собрать план'}
        </button>
      </section>
    );
  }

  return (
    <section className={styles.topicsBlock}>
      <div className={styles.planBar}>
        <span>
          План от {new Date(plan.generatedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}
          {plan.stale && <strong className={styles.staleNote}> · появились новые переписки</strong>}
        </span>
        <button
          type="button"
          className={plan.stale ? controls.buttonPrimary : controls.buttonSecondary}
          onClick={onGenerate}
          disabled={generating}
        >
          {generating ? 'Читаю переписки…' : 'Обновить план'}
        </button>
      </div>
      {topics.length === 0 && <p className={styles.checklistNote}>По этому сегменту тем нет.</p>}
      <div className={styles.topicList}>
        {topics.map((topic, i) => (
          <TopicCard key={topic.id} index={i + 1} topic={topic} config={config} onTopicUpdated={onTopicUpdated} onMessage={onMessage} />
        ))}
      </div>
    </section>
  );
}

function TopicCard({
  topic,
  index,
  example = false,
  config,
  onTopicUpdated,
  onMessage,
}: {
  topic: ContentTopic;
  index?: number;
  example?: boolean;
  config: { baseUrl: string; apiKey: string };
  onTopicUpdated: (topic: ContentTopic) => void;
  onMessage: (message: string) => void;
}) {
  const [writing, setWriting] = useState(false);
  const [copied, setCopied] = useState(false);

  async function writeScript() {
    setWriting(true);
    try {
      const res = await api.writeTopicScript(config, topic.id);
      onTopicUpdated(res.topic);
    } catch (err) {
      onMessage(errorText(err));
    } finally {
      setWriting(false);
    }
  }

  async function copy() {
    if (!topic.script) return;
    try {
      await navigator.clipboard.writeText(topic.script);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      onMessage('Не удалось скопировать — выделите текст сценария вручную');
    }
  }

  return (
    <article className={`${styles.topicCard} ${example ? styles.topicExample : ''}`}>
      <div className={styles.topicHead}>
        {index !== undefined && <span className={styles.rank}>{index}</span>}
        <h3>{topic.title}</h3>
      </div>
      <div className={styles.topicMeta}>
        <span className={styles.segmentChip}>{topic.segment}</span>
        <span>купили {topic.clientCount} из {topic.subscriberCount}</span>
      </div>
      {topic.why && <p className={styles.explanation}>{topic.why}</p>}
      {/* Their buyers' own words, in the incoming-message bubble shape —
          the one place on this page that shape belongs: these are real
          messages, the evidence the topic stands on. */}
      <div className={styles.quotes}>
        {topic.quotes.map((q) => (
          <span key={q} className={styles.quote}>{q}</span>
        ))}
      </div>
      {!example && (
        topic.script ? (
          <div className={styles.scriptBox}>
            <textarea className={controls.input} readOnly value={topic.script} rows={8} />
            <div className={styles.scriptActions}>
              <button type="button" className={controls.buttonSecondary} onClick={copy}>{copied ? 'Скопировано ✓' : 'Скопировать'}</button>
              <Link href="/video" className={controls.buttonSecondary}>Смонтировать видео →</Link>
            </div>
          </div>
        ) : (
          <button type="button" className={`${controls.buttonSecondary} ${styles.topicAction}`} onClick={writeScript} disabled={writing}>
            {writing ? 'Пишу сценарий…' : 'Написать сценарий'}
          </button>
        )
      )}
    </article>
  );
}
