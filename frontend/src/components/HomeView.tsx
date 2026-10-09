'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { CalendarClock, Captions, Clapperboard, Lightbulb, MessageCircle } from 'lucide-react';
import { plural } from '@/lib/plural';
import { api, type HomeState, type NextStep } from '@/lib/api';
import { useApiAccess } from '@/lib/useApiAccess';
import PageHeader from './PageHeader';
import PulseIndicator from './PulseIndicator';
import TabBar from './TabBar';
import NoticeBanner, { MISSING_API_KEY_MESSAGE } from './NoticeBanner';
import StatusMessage from './StatusMessage';
import controls from './Controls.module.css';
import styles from './HomeView.module.css';

// The first screen after signing in. Not a dashboard of every number: one
// thing worth doing now, chosen server-side (home.ts) by what is lost by
// waiting, a short list of what else is pending, and on a wide screen the
// live direct and the week's path from a question to a published video.

const PLATFORM: Record<string, string> = { instagram: 'Instagram', tiktok: 'TikTok', youtube_shorts: 'YouTube Shorts' };

function hoursUntil(iso: string, now: number): number {
  return Math.max(1, Math.ceil((new Date(iso).getTime() - now) / 3_600_000));
}

function when(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

/** One line for "Ещё сегодня": what it is, why it matters, where to go. */
function pendingRow(step: NextStep, now: number): { key: string; title: string; detail: string; href: string; Icon: typeof MessageCircle } | null {
  switch (step.kind) {
    case 'reply': {
      const n = step.others + 1;
      return {
        key: 'reply',
        title: `${n} ${plural(n, ['вопрос', 'вопроса', 'вопросов'])} без ответа`,
        detail: `Первый ждёт ${step.question.name} — окно Instagram закроется через ${hoursUntil(step.question.windowClosesAt, now)} ч`,
        href: `/crm?subscriber=${encodeURIComponent(step.question.subscriberId)}`,
        Icon: MessageCircle,
      };
    }
    case 'review_captions':
      return { key: `review-${step.job.id}`, title: 'Проверьте субтитры', detail: `«${step.job.title}» — речь распознана неуверенно`, href: '/video', Icon: Captions };
    case 'film_topic':
      return { key: 'topic', title: 'Тема для ролика', detail: step.topic.title, href: '/content-plan', Icon: Lightbulb };
    default:
      return null;
  }
}

export default function HomeView() {
  const { config, hasAccess } = useApiAccess();
  const [data, setData] = useState<{ state: HomeState; step: NextStep; more: NextStep[] } | null>(null);
  const [status, setStatus] = useState('');
  // Captured with the data, so "через N ч" is computed against the moment the
  // answer arrived rather than reading the clock during render.
  const [loadedAt, setLoadedAt] = useState(0);

  const load = useCallback(async () => {
    if (!hasAccess) return;
    try {
      const res = await api.getHome(config);
      setData(res);
      setLoadedAt(Date.now());
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAccess, config.apiKey, config.baseUrl]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const state = data?.state;
  const rendering = state?.jobs.filter((j) => j.status === 'processing') ?? [];
  const rows = [
    ...(data?.more ?? []).map((s) => pendingRow(s, loadedAt)).filter((r) => r !== null),
    ...rendering.map((j) => ({ key: `job-${j.id}`, title: `«${j.title}» монтируется`, detail: `Готово на ${j.progress}%`, href: '/video', Icon: Clapperboard })),
    ...(state?.nextPost
      ? [{ key: 'post', title: `Пост ${when(state.nextPost.scheduledAt)}`, detail: `${PLATFORM[state.nextPost.platform] ?? state.nextPost.platform} · ${state.nextPost.caption.slice(0, 60)}`, href: '/scheduler', Icon: CalendarClock }]
      : []),
  ];

  return (
    <div className={styles.page}>
      <PageHeader section="Сегодня" title="Главная" current="/home">
        {state && state.activeDialogs > 0 && (
          <PulseIndicator count={state.activeDialogs} label={plural(state.activeDialogs, ['диалог активен', 'диалога активны', 'диалогов активны'])} />
        )}
      </PageHeader>

      <main className={styles.main}>
        {!hasAccess && <NoticeBanner>{MISSING_API_KEY_MESSAGE}</NoticeBanner>}
        <StatusMessage>{status}</StatusMessage>

        {hasAccess && !data && !status && <p className={styles.loading}>Собираю, что происходит…</p>}

        {data && state && (
          <>
            <div className={styles.top}>
              <section className={styles.next} aria-labelledby="next-step">
                <span className={styles.nextLabel}>Следующий шаг</span>
                <NextStepCard step={data.step} now={loadedAt} />
              </section>

              {/* The live direct, where there is one. Hidden rather than
                  shown empty for a workspace that has no bot: the chat-bot
                  part can be switched off, and an empty box for it reads as
                  something broken. */}
              {state.hasBot && state.recentMessages.length > 0 && (
                <aside className={`${styles.direct} ${rows.length > 0 ? styles.directOptional : ''}`} aria-label="Директ">
                  <div className={styles.directHead}>
                    <h2>Директ</h2>
                    <Link href="/crm">Открыть CRM</Link>
                  </div>
                  <ul className={styles.messages}>
                    {state.recentMessages.map((m, i) => (
                      <li key={i} className={styles.message}>
                        <span className={styles.avatar} aria-hidden="true">{m.name.replace(/^@/, '').charAt(0).toLocaleUpperCase('ru')}</span>
                        <span className={styles.messageBody}>
                          <span className={styles.messageMeta}>{m.name}</span>
                          <span className={styles.bubbleIn}>{m.text}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </aside>
              )}
            </div>

            {rows.length > 0 && (
              <section className={styles.pending} aria-labelledby="pending-title">
                <h2 id="pending-title">Ещё сегодня</h2>
                <ul>
                  {rows.map(({ key, title, detail, href, Icon }) => (
                    <li key={key}>
                      <Link href={href} className={styles.pendingRow}>
                        <span className={styles.pendingIcon} aria-hidden="true"><Icon size={18} strokeWidth={2} /></span>
                        <span className={styles.pendingText}>
                          <strong>{title}</strong>
                          <span>{detail}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* The week as the path a question takes to a published video —
                the thing Sonar connects that a bot-builder or a reels
                analyser alone does not. Wide screens only: on a phone it
                would push the list above off the first screen. */}
            <section className={styles.loop} aria-label="Неделя">
              <Link href="/crm" className={styles.loopStage}><span>Директ</span><strong>{state.week.inbound}</strong><small>{plural(state.week.inbound, ['сообщение', 'сообщения', 'сообщений'])} за неделю</small></Link>
              <Link href="/crm" className={styles.loopStage}><span>Купили</span><strong>{state.week.clients}</strong><small>отмечены в CRM</small></Link>
              <Link href="/content-plan" className={styles.loopStage}><span>Темы</span><strong>{state.topicCount}</strong><small>из вопросов купивших</small></Link>
              <Link href="/video" className={styles.loopStage}><span>Монтаж</span><strong>{rendering.length}</strong><small>в работе</small></Link>
              <Link href="/scheduler" className={styles.loopStage}><span>Публикация</span><strong>{state.nextPost ? when(state.nextPost.scheduledAt) : '—'}</strong><small>{state.nextPost ? PLATFORM[state.nextPost.platform] ?? state.nextPost.platform : 'ничего не запланировано'}</small></Link>
            </section>
          </>
        )}
      </main>

      <TabBar current="/home" />
    </div>
  );
}

function NextStepCard({ step, now }: { step: NextStep; now: number }) {
  switch (step.kind) {
    case 'reply':
      return (
        <>
          <h1 id="next-step">Ответьте: {step.question.name}</h1>
          <p className={styles.nextWhy}>
            Окно Instagram для ответа закроется через {hoursUntil(step.question.windowClosesAt, now)} ч — потом написать в директ будет нельзя.
            {step.others > 0 && ` Ещё ${step.others} ${plural(step.others, ['вопрос', 'вопроса', 'вопросов'])} ждут ответа.`}
          </p>
          <div className={styles.quotes}><span className={styles.bubbleIn}>{step.question.text}</span></div>
          <div className={styles.actions}>
            <Link href={`/crm?subscriber=${encodeURIComponent(step.question.subscriberId)}`} className={`${controls.buttonPrimary} ${styles.primary}`}>Открыть диалог</Link>
          </div>
        </>
      );
    case 'review_captions':
      return (
        <>
          <h1 id="next-step">Проверьте субтитры</h1>
          <p className={styles.nextWhy}>
            В ролике «{step.job.title}» речь распознана неуверенно. Поправьте слова — и монтаж продолжится: субтитры вжигаются в видео, исправить их потом нельзя.
          </p>
          <div className={styles.actions}>
            <Link href="/video" className={`${controls.buttonPrimary} ${styles.primary}`}>Проверить субтитры</Link>
          </div>
        </>
      );
    case 'film_topic':
      return (
        <>
          <h1 id="next-step">Снимите ролик: {step.topic.title}</h1>
          <p className={styles.nextWhy}>
            Об этом спрашивают в сегменте «{step.topic.segment}» — там купили {step.topic.clientCount} из {step.topic.subscriberCount}. Их слова:
          </p>
          <div className={styles.quotes}>
            {step.topic.quotes.slice(0, 3).map((q) => (
              <span key={q} className={styles.bubbleIn}>{q}</span>
            ))}
          </div>
          <div className={styles.actions}>
            <Link href="/content-plan" className={`${controls.buttonPrimary} ${styles.primary}`}>Написать сценарий</Link>
            <Link href="/content-plan" className={`${controls.buttonSecondary} ${styles.secondary}`}>Другие темы</Link>
          </div>
        </>
      );
    default:
      return (
        <>
          <h1 id="next-step">Смонтируйте новый ролик</h1>
          <p className={styles.nextWhy}>Загрузите запись — Sonar вырежет паузы и слова-паразиты и наложит субтитры.</p>
          <div className={styles.actions}>
            <Link href="/video" className={`${controls.buttonPrimary} ${styles.primary}`}>Загрузить видео</Link>
          </div>
        </>
      );
  }
}
