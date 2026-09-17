'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError, type DemoWorkspace, type RunFlowOutcome } from '@/lib/api';
import { API_BASE_URL } from '@/lib/apiConfig';
import { useDevConfig } from '@/lib/useDevConfig';
import { ONBOARDING_PROGRESS_KEY } from '@/lib/useLogout';
import { useSession } from '@/lib/useSession';
import LogoutButton from './LogoutButton';
import ModuleNav from './ModuleNav';
import controls from './Controls.module.css';
import styles from './OnboardingView.module.css';

const DEFAULT_KEYWORD = 'план';
const DEFAULT_REPLY = 'Отправлю чек-лист. Подскажите, вы запускаете курс или консультацию?';
const PREVIEW_USER_ID = 'sonar-onboarding-preview';
const PROGRESS_STORAGE_KEY = ONBOARDING_PROGRESS_KEY;

type BusyAction = 'recover' | 'create' | 'preview' | 'interaction' | null;

interface StoredProgress {
  tenantId: string;
  flowId: string;
  previewOutcome: RunFlowOutcome;
}

function readStoredProgress(tenantId: string, flowId: string): RunFlowOutcome | null {
  try {
    const raw = localStorage.getItem(PROGRESS_STORAGE_KEY);
    if (!raw) return null;
    const progress = JSON.parse(raw) as StoredProgress;
    return progress.tenantId === tenantId && progress.flowId === flowId ? progress.previewOutcome : null;
  } catch {
    return null;
  }
}

function writeStoredProgress(progress: StoredProgress | null) {
  try {
    if (progress) localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(progress));
    else localStorage.removeItem(PROGRESS_STORAGE_KEY);
  } catch {
    // Progress can be repeated safely if storage is unavailable.
  }
}

function replyFromWorkspace(workspace: DemoWorkspace): string | null {
  const messageNode = workspace.flow.definition.nodes.find((node) => node.type === 'send_message');
  return messageNode && 'text' in messageNode.data && typeof messageNode.data.text === 'string' ? messageNode.data.text : null;
}

function outcomeCopy(outcome: RunFlowOutcome) {
  switch (outcome.status) {
    case 'completed':
      return { label: 'Сценарий сработал', tone: 'success' as const };
    case 'duplicate_today':
      return { label: 'Диалог уже создан сегодня', tone: 'success' as const };
    case 'no_trigger_match':
      return { label: 'Ключевое слово не найдено', tone: 'warning' as const };
    case 'failed':
      return { label: 'Сценарий не завершился', tone: 'warning' as const };
  }
}

function OutcomePanel({ outcome, dryRun }: { outcome: RunFlowOutcome; dryRun: boolean }) {
  const copy = outcomeCopy(outcome);

  return (
    <div className={`${styles.outcome} ${copy.tone === 'success' ? styles.outcomeSuccess : styles.outcomeWarning}`} aria-live="polite">
      <div className={styles.outcomeRow}>
        <span>Результат</span>
        <strong>{copy.label}</strong>
      </div>

      {outcome.status === 'completed' && (
        <div className={styles.replyList}>
          {outcome.sentMessages.map((message, index) => (
            <div className={styles.replyItem} key={`${message.channel}-${index}`}>
              <span>{message.channel === 'dm' ? 'Ответ в директ' : 'Ответ в комментариях'}</span>
              <p>{message.content}</p>
            </div>
          ))}
        </div>
      )}

      {outcome.status === 'failed' && <p className={styles.outcomeHint}>Причина: {outcome.failureReason}</p>}
      {outcome.status === 'no_trigger_match' && (
        <p className={styles.outcomeHint}>Проверьте ключевое слово сценария и повторите тест.</p>
      )}
      {dryRun && <p className={styles.outcomeHint}>Эта проверка не создаёт контакт и сообщения в CRM.</p>}
    </div>
  );
}

function Step({ number, title, state }: { number: number; title: string; state: 'done' | 'current' | 'next' }) {
  return (
    <li className={`${styles.step} ${state === 'done' ? styles.stepDone : ''} ${state === 'current' ? styles.stepCurrent : ''}`} aria-current={state === 'current' ? 'step' : undefined}>
      <span className={styles.stepMark}>{state === 'done' ? '✓' : number}</span>
      <span>{title}</span>
    </li>
  );
}

function friendlyError(error: unknown, fallback: string) {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Сессия закончилась. Войдите ещё раз.';
    if (error.status >= 500) return 'Сервис временно недоступен. Попробуйте ещё раз.';
  }
  return fallback;
}

export default function OnboardingView() {
  const router = useRouter();
  const [session, setSession] = useSession();
  const [, setDevConfig] = useDevConfig();

  const [keyword, setKeyword] = useState(DEFAULT_KEYWORD);
  const [replyText, setReplyText] = useState(DEFAULT_REPLY);
  const [workspace, setWorkspace] = useState<DemoWorkspace | null>(null);
  const [previewOutcome, setPreviewOutcome] = useState<RunFlowOutcome | null>(null);
  const [interactionOutcome, setInteractionOutcome] = useState<RunFlowOutcome | null>(null);
  const [busy, setBusy] = useState<BusyAction>('recover');
  const [recoveryComplete, setRecoveryComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyWorkspace = useCallback(
    (nextWorkspace: DemoWorkspace) => {
      if (!session) return;

      setWorkspace(nextWorkspace);
      setKeyword(nextWorkspace.trigger.keyword);
      const savedReply = replyFromWorkspace(nextWorkspace);
      if (savedReply) setReplyText(savedReply);
      setPreviewOutcome(readStoredProgress(session.tenantId, nextWorkspace.flow.id));

      // Product screens still read useDevConfig. Store the authenticated
      // session token and recovered demo ids before any navigation happens.
      setDevConfig((current) => ({
        ...current,
        baseUrl: API_BASE_URL,
        botId: nextWorkspace.bot.id,
        externalAccountId: nextWorkspace.bot.external_account_id ?? '',
      }));
    },
    [session, setDevConfig]
  );

  const clearInvalidSession = useCallback(() => {
    if (!session) return;
    setSession(null);
    writeStoredProgress(null);
    router.replace('/login');
  }, [router, session, setSession]);

  const recoverWorkspace = useCallback(async () => {
    if (!session) {
      router.replace('/login');
      return;
    }

    try {
      const config = { baseUrl: API_BASE_URL };
      await api.me(config);
      const { bots } = await api.listBots(config);
      const demoAccountId = `demo:${session.tenantId}`;
      const existingDemoBot = bots.find((bot) => bot.external_account_id === demoAccountId);

      if (existingDemoBot) {
        // The bootstrap endpoint is idempotent. On repeat it returns the
        // original flow/trigger, which GET /api/bots intentionally omits.
        const recovered = await api.createDemoWorkspace(config, DEFAULT_KEYWORD, DEFAULT_REPLY);
        applyWorkspace(recovered);
      }
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        clearInvalidSession();
        return;
      }
      setError(friendlyError(caught, 'Не удалось проверить демо-пространство. Можно повторить или создать его заново.'));
    } finally {
      setRecoveryComplete(true);
      setBusy(null);
    }
  }, [applyWorkspace, clearInvalidSession, router, session]);

  useEffect(() => {
    // Recovery updates UI only after its API requests settle; this is the
    // standard client-side fetch-on-mount case, not a derived-state effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void recoverWorkspace();
  }, [recoverWorkspace]);

  function retryRecovery() {
    setBusy('recover');
    setError(null);
    void recoverWorkspace();
  }

  async function createWorkspace(event: React.FormEvent) {
    event.preventDefault();
    if (!session) return router.replace('/login');

    const cleanKeyword = keyword.trim();
    const cleanReply = replyText.trim();
    if (!cleanKeyword || !cleanReply) {
      setError('Заполните ключевое слово и ответ бота.');
      return;
    }

    setBusy('create');
    setError(null);
    setPreviewOutcome(null);
    setInteractionOutcome(null);
    try {
      const created = await api.createDemoWorkspace(
        { baseUrl: API_BASE_URL },
        cleanKeyword,
        cleanReply
      );
      applyWorkspace(created);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return clearInvalidSession();
      setError(friendlyError(caught, 'Не удалось создать демо-пространство. Попробуйте ещё раз.'));
    } finally {
      setBusy(null);
    }
  }

  async function runPreview() {
    if (!session || !workspace) return;
    setBusy('preview');
    setError(null);
    setInteractionOutcome(null);
    try {
      const result = await api.testRun(
        { baseUrl: API_BASE_URL },
        workspace.bot.id,
        { externalUserId: PREVIEW_USER_ID, messageText: workspace.trigger.keyword }
      );
      setPreviewOutcome(result.outcome);
      if (result.outcome.status === 'completed') {
        writeStoredProgress({ tenantId: session.tenantId, flowId: workspace.flow.id, previewOutcome: result.outcome });
      } else {
        writeStoredProgress(null);
      }
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return clearInvalidSession();
      setError(friendlyError(caught, 'Не удалось проверить сценарий. Попробуйте ещё раз.'));
    } finally {
      setBusy(null);
    }
  }

  async function createInteraction() {
    if (!session || !workspace || previewOutcome?.status !== 'completed') return;
    setBusy('interaction');
    setError(null);
    setInteractionOutcome(null);
    try {
      const result = await api.createDemoInteraction(
        { baseUrl: API_BASE_URL },
        workspace.bot.id,
        workspace.trigger.keyword
      );
      setInteractionOutcome(result.outcome);

      if (result.outcome.status === 'completed' || result.outcome.status === 'duplicate_today') {
        const params = new URLSearchParams({
          subscriber: result.subscriberId,
          onboarding: '1',
          segment: workspace.trigger.keyword,
        });
        router.push(`/crm?${params.toString()}`);
        return;
      }

      setError('Демо-контакт создан, но сценарий не завершился. Повторите проверку перед переходом в CRM.');
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return clearInvalidSession();
      setError(friendlyError(caught, 'Не удалось создать демо-диалог в CRM. Попробуйте ещё раз.'));
    } finally {
      setBusy(null);
    }
  }



  if (!session || (!recoveryComplete && busy === 'recover')) {
    return (
      <main className={styles.loadingPage}>
        <span className={styles.brand}>Sonar</span>
        <p>{session ? 'Проверяем демо-пространство…' : 'Переходим ко входу…'}</p>
      </main>
    );
  }

  const previewComplete = previewOutcome?.status === 'completed';
  const completedSteps = workspace ? (previewComplete ? 2 : 1) : 0;

  return (
    <main className={styles.page}>
      <header className={styles.topbar}>
        <Link href="/" className={styles.brand} aria-label="Sonar — на главную">
          Sonar
        </Link>
        <div className={styles.topbarRight}>
          <ModuleNav current="/onboarding" />
          <div className={styles.account}>
            <span>{session.userEmail}</span>
            <LogoutButton />
          </div>
        </div>
      </header>

      <div className={styles.container}>
        <section className={styles.intro} aria-labelledby="onboarding-title">
          <p className={styles.eyebrow}>ДЕМО · РАННИЙ MVP</p>
          <h1 id="onboarding-title">Пройдите первый цикл Sonar</h1>
          <p className={styles.lead}>
            Соберите простой ответ, проверьте его без записи данных, затем создайте один демо-диалог и продолжите работу с лидом в CRM.
          </p>
          <div className={styles.honestyNote}>
            Социальные аккаунты пока не подключаются. Все действия здесь работают только в тестовом пространстве и не отправляют сообщения реальным людям.
          </div>
        </section>

        <div className={styles.layout}>
          <aside className={styles.checklist} aria-label="Шаги первого запуска">
            <div className={styles.checklistHeader}>
              <span>Первый запуск</span>
              <strong>{completedSteps} из 4</strong>
            </div>
            <div className={styles.progressTrack} aria-hidden="true">
              <span style={{ width: `${completedSteps * 25}%` }} />
            </div>
            <ol className={styles.steps}>
              <Step number={1} title="Демо-пространство" state={workspace ? 'done' : 'current'} />
              <Step number={2} title="Проверка сценария" state={previewComplete ? 'done' : workspace ? 'current' : 'next'} />
              <Step number={3} title="Демо-диалог в CRM" state={previewComplete ? 'current' : 'next'} />
              <Step number={4} title="Сигнал для контента" state="next" />
            </ol>
            <p className={styles.checklistHint}>Следующие два шага продолжатся внутри CRM и контент-плана.</p>
          </aside>

          <div className={styles.content}>
            {error && (
              <div className={styles.error} role="alert">
                <span>{error}</span>
                {!workspace && (
                  <button type="button" className={controls.buttonSecondary} onClick={retryRecovery} disabled={busy !== null}>
                    Проверить ещё раз
                  </button>
                )}
              </div>
            )}

            <section className={styles.card} aria-labelledby="workspace-title">
              <div className={styles.cardHeading}>
                <span className={styles.cardNumber}>01</span>
                <div>
                  <h2 id="workspace-title">Подготовьте демо-сценарий</h2>
                  <p>Когда человек пишет ключевое слово, бот отправляет заданный ответ.</p>
                </div>
              </div>

              <form className={styles.form} onSubmit={createWorkspace}>
                <label className={styles.field}>
                  <span>Ключевое слово</span>
                  <input
                    className={`${controls.input} ${styles.input}`}
                    value={keyword}
                    onChange={(event) => setKeyword(event.target.value)}
                    disabled={workspace !== null || busy !== null}
                    autoComplete="off"
                  />
                  <small>Для демо достаточно одного понятного слова, например «план».</small>
                </label>

                <label className={styles.field}>
                  <span>Ответ бота</span>
                  <textarea
                    className={`${controls.input} ${styles.textarea}`}
                    value={replyText}
                    onChange={(event) => setReplyText(event.target.value)}
                    disabled={workspace !== null || busy !== null}
                    rows={4}
                  />
                </label>

                {workspace ? (
                  <div className={styles.readyState}>
                    <span className={styles.readyMark}>✓</span>
                    <div>
                      <strong>Демо-пространство готово</strong>
                      <p>Сценарий опубликован и привязан к тестовому боту.</p>
                    </div>
                  </div>
                ) : (
                  <button type="submit" className={`${controls.buttonPrimary} ${styles.actionButton}`} disabled={busy !== null}>
                    {busy === 'create' ? 'Создаём…' : 'Создать демо-пространство'}
                  </button>
                )}
              </form>
            </section>

            <section className={`${styles.card} ${!workspace ? styles.cardDisabled : ''}`} aria-labelledby="preview-title">
              <div className={styles.cardHeading}>
                <span className={styles.cardNumber}>02</span>
                <div>
                  <h2 id="preview-title">Проверьте ответ без записи в CRM</h2>
                  <p>Безопасная проверка запускает сценарий, но не создаёт контакт, сообщения или сделку.</p>
                </div>
              </div>

              <div className={styles.previewMessage}>
                <span>Тестовое входящее сообщение</span>
                <strong>{workspace?.trigger.keyword ?? keyword}</strong>
              </div>

              <button
                type="button"
                className={`${previewComplete ? controls.buttonSecondary : controls.buttonPrimary} ${styles.actionButton}`}
                onClick={() => void runPreview()}
                disabled={!workspace || busy !== null}
              >
                {busy === 'preview' ? 'Проверяем…' : previewComplete ? 'Проверить ещё раз' : 'Проверить сценарий'}
              </button>

              {previewOutcome && <OutcomePanel outcome={previewOutcome} dryRun />}
            </section>

            <section className={`${styles.card} ${!previewComplete ? styles.cardDisabled : ''}`} aria-labelledby="crm-title">
              <div className={styles.cardHeading}>
                <span className={styles.cardNumber}>03</span>
                <div>
                  <h2 id="crm-title">Создайте первый демо-диалог</h2>
                  <p>Этот шаг уже запишет тестовый контакт и переписку в CRM. Контакт будет явно демо, а не реальным подписчиком.</p>
                </div>
              </div>

              <button
                type="button"
                className={`${controls.buttonPrimary} ${styles.actionButton}`}
                onClick={() => void createInteraction()}
                disabled={!previewComplete || busy !== null}
              >
                {busy === 'interaction' ? 'Создаём диалог…' : 'Создать демо-контакт и открыть CRM'}
              </button>

              {interactionOutcome && <OutcomePanel outcome={interactionOutcome} dryRun={false} />}
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}
