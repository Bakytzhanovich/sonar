'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, type ConversationMessage, type LeadStatus, type Note, type Subscriber, type Tag } from '@/lib/api';
import { useDevConfig } from '@/lib/useDevConfig';
import ModuleNav from './ModuleNav';
import PulseIndicator, { LiveDot } from './PulseIndicator';
import styles from './CrmView.module.css';
import controls from './Controls.module.css';
import layout from './Layout.module.css';

const LEAD_STATUSES: LeadStatus[] = ['new', 'in_progress', 'client'];
const STATUS_LABEL: Record<LeadStatus, string> = { new: 'Новый', in_progress: 'В работе', client: 'Клиент' };
const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_ONBOARDING_SEGMENT = 'запуск';
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
const SHORT_DATE_FORMATTER = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });

type ViewMode = 'table' | 'kanban';
type DetailTab = 'conversation' | 'notes';

function normalizeSegment(value: string): string {
  return value.trim().toLocaleLowerCase('ru');
}

// Server timestamps can land slightly ahead of the browser clock (the two
// clocks are independent, and a contact created seconds ago is the most
// likely one to be looked at). Requiring elapsed >= 0 dropped exactly those
// contacts out of the signature "N диалогов активны сейчас" counter, so a
// small negative skew counts as "just now" instead.
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

function hasRecentActivity(subscriber: Subscriber, now: number): boolean {
  const elapsed = now - new Date(subscriber.last_interacted_at).getTime();
  return elapsed >= -CLOCK_SKEW_TOLERANCE_MS && elapsed < ACTIVE_WINDOW_MS;
}

function contactInitial(identifier: string): string {
  return identifier.trim().charAt(0).toLocaleUpperCase('ru') || '•';
}

function formatRelativeTime(value: string, now: number): string {
  const timestamp = new Date(value).getTime();
  const difference = Math.max(0, now - timestamp);
  const minutes = Math.floor(difference / 60_000);

  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} дн назад`;

  return SHORT_DATE_FORMATTER.format(new Date(value));
}

function statusClassName(status: LeadStatus): string {
  if (status === 'client') return styles.statusClient;
  if (status === 'in_progress') return styles.statusProgress;
  return styles.statusNew;
}

function friendlyError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? `${fallback} ${error.message}` : fallback;
}

function StatusBadge({ status, decorative = false }: { status: LeadStatus; decorative?: boolean }) {
  return (
    <span className={`${styles.statusBadge} ${statusClassName(status)}`} aria-hidden={decorative || undefined}>
      <span className={styles.statusDot} aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

function TagSummary({ tags, limit = 2 }: { tags: Tag[]; limit?: number }) {
  if (tags.length === 0) return <span className={styles.noTags}>Без тегов</span>;

  const visibleTags = tags.slice(0, limit);
  const remaining = tags.length - visibleTags.length;

  return (
    <span className={styles.tagSummary}>
      {visibleTags.map((tag) => (
        <span key={tag.id} className={styles.tagChip}>{tag.name}</span>
      ))}
      {remaining > 0 && <span className={styles.tagOverflow}>+{remaining}</span>}
    </span>
  );
}

function EmptyRadar() {
  return (
    <svg className={styles.emptyRadar} viewBox="0 0 160 100" aria-hidden="true">
      <circle cx="80" cy="50" r="13" />
      <circle cx="80" cy="50" r="28" />
      <circle cx="80" cy="50" r="43" />
      <path d="M25 50h110M80 8v84" />
      <circle className={styles.emptyRadarPoint} cx="106" cy="31" r="4" />
      <circle className={styles.emptyRadarPoint} cx="59" cy="67" r="3" />
      <circle className={styles.emptyRadarPoint} cx="118" cy="68" r="3" />
    </svg>
  );
}

export default function CrmView() {
  const searchParams = useSearchParams();
  const onboarding = searchParams.get('onboarding') === '1';
  const requestedSubscriberId = searchParams.get('subscriber')?.trim() || null;
  const onboardingSegment = searchParams.get('segment')?.trim() || DEFAULT_ONBOARDING_SEGMENT;

  const [devConfig, setDevConfig] = useDevConfig();
  const { baseUrl, apiKey, botId, devMode } = devConfig;
  const setBotId = (value: string) => setDevConfig((current) => ({ ...current, botId: value }));
  const setDevMode = (value: boolean) => setDevConfig((current) => ({ ...current, devMode: value }));

  // Every piece of state below that scopes to the selected bot (list data,
  // filters, selection, message/note panes) is reset by hand in
  // changeBotId() further down — there's no single source of truth for
  // "the initial/empty value of per-bot state", so a new field added here
  // needs a matching reset line there too, or it'll silently carry over a
  // stale value from the previous bot after a switch.
  const [view, setView] = useState<ViewMode>('table');
  const [searchQuery, setSearchQuery] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [leadStatusFilter, setLeadStatusFilter] = useState<LeadStatus | ''>('');
  const [subscribers, setSubscribers] = useState<Subscriber[]>([]);
  const [allSubscribers, setAllSubscribers] = useState<Subscriber[]>([]);
  const [aggregateBotId, setAggregateBotId] = useState('');
  const [knownTags, setKnownTags] = useState<Tag[]>([]);
  const [listLoading, setListLoading] = useState(Boolean(botId));
  const [listLoaded, setListLoaded] = useState(false);
  const [listError, setListError] = useState('');

  const [selected, setSelected] = useState<Subscriber | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const autoSelectedSubscriberRef = useRef<string | null>(null);
  const listRequestRef = useRef(0);
  const messagesRequestRef = useRef(0);
  const notesRequestRef = useRef(0);
  const aggregateRequestRef = useRef(0);
  const botIdRef = useRef(botId);
  const detailBackRef = useRef<HTMLButtonElement | null>(null);
  const selectionTriggerRef = useRef<HTMLButtonElement | null>(null);
  const contactsHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const backendFilterRef = useRef({ tagFilter, leadStatusFilter });
  const [detailTab, setDetailTab] = useState<DetailTab>('conversation');
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [notesLoading, setNotesLoading] = useState(false);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [messagesError, setMessagesError] = useState('');
  const [notesError, setNotesError] = useState('');
  const [newNote, setNewNote] = useState('');
  const [newTag, setNewTag] = useState(() => (onboarding ? onboardingSegment : ''));
  const [savingAction, setSavingAction] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  const config = useMemo(() => ({ baseUrl, apiKey }), [apiKey, baseUrl]);
  const selectedContactId = selected?.id ?? null;
  const selectedIsClient = selected?.lead_status === 'client';
  const selectedHasSegment =
    selected?.tags.some((tag) => normalizeSegment(tag.name) === normalizeSegment(onboardingSegment)) ?? false;
  const onboardingComplete = Boolean(selected && selectedIsClient && selectedHasSegment);
  const contentPlanHref = `/content-plan?segment=${encodeURIComponent(onboardingSegment)}&onboarding=1${
    selected ? `&subscriber=${encodeURIComponent(selected.id)}` : ''
  }`;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const activeNow = useMemo(
    () => (aggregateBotId === botId ? allSubscribers : subscribers).filter((subscriber) => hasRecentActivity(subscriber, now)).length,
    [aggregateBotId, allSubscribers, botId, now, subscribers]
  );
  const clientCount = useMemo(
    () => (aggregateBotId === botId ? allSubscribers : subscribers).filter((subscriber) => subscriber.lead_status === 'client').length,
    [aggregateBotId, allSubscribers, botId, subscribers]
  );
  const totalCount = aggregateBotId === botId ? allSubscribers.length : subscribers.length;

  const visibleSubscribers = useMemo(() => {
    const query = normalizeSegment(searchQuery);
    if (!query) return subscribers;

    return subscribers.filter(
      (subscriber) =>
        normalizeSegment(subscriber.external_user_id).includes(query) ||
        subscriber.tags.some((tag) => normalizeSegment(tag.name).includes(query))
    );
  }, [searchQuery, subscribers]);

  const hasFilters = Boolean(searchQuery.trim() || tagFilter || leadStatusFilter);

  const conversationRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = conversationRef.current;
    if (element && detailTab === 'conversation') element.scrollTop = element.scrollHeight;
  }, [detailTab, messages]);

  const loadMessagesForSubscriber = useCallback(
    async (subscriber: Subscriber) => {
      const requestId = ++messagesRequestRef.current;
      setMessagesLoading(true);
      setMessages([]);
      setMessagesError('');

      try {
        const response = await api.getMessages({ baseUrl, apiKey }, subscriber.id);
        if (messagesRequestRef.current !== requestId || selectedIdRef.current !== subscriber.id) return;
        setMessages(response.messages);
      } catch (error) {
        if (messagesRequestRef.current === requestId && selectedIdRef.current === subscriber.id) {
          setMessagesError(friendlyError(error, 'Не удалось загрузить переписку.'));
        }
      } finally {
        if (messagesRequestRef.current === requestId && selectedIdRef.current === subscriber.id) {
          setMessagesLoading(false);
        }
      }
    },
    [apiKey, baseUrl]
  );

  const loadNotesForSubscriber = useCallback(
    async (subscriber: Subscriber) => {
      const requestId = ++notesRequestRef.current;
      setNotesLoading(true);
      setNotes([]);
      setNotesError('');

      try {
        const response = await api.getNotes({ baseUrl, apiKey }, subscriber.id);
        if (notesRequestRef.current !== requestId || selectedIdRef.current !== subscriber.id) return;
        setNotes(response.notes);
      } catch (error) {
        if (notesRequestRef.current === requestId && selectedIdRef.current === subscriber.id) {
          setNotesError(friendlyError(error, 'Не удалось загрузить заметки.'));
        }
      } finally {
        if (notesRequestRef.current === requestId && selectedIdRef.current === subscriber.id) {
          setNotesLoading(false);
        }
      }
    },
    [apiKey, baseUrl]
  );

  const selectSubscriber = useCallback(
    async (
      subscriber: Subscriber,
      nextTab: DetailTab = 'conversation',
      trigger: HTMLButtonElement | null = null
    ) => {
      if (trigger) selectionTriggerRef.current = trigger;
      selectedIdRef.current = subscriber.id;
      setSelected(subscriber);
      setDetailTab(nextTab);
      setNewNote('');
      setNewTag(onboarding ? onboardingSegment : '');
      setStatus('');

      await Promise.all([loadMessagesForSubscriber(subscriber), loadNotesForSubscriber(subscriber)]);
    },
    [loadMessagesForSubscriber, loadNotesForSubscriber, onboarding, onboardingSegment, setStatus]
  );

  useEffect(() => {
    if (!selectedContactId || !window.matchMedia('(max-width: 720px)').matches) return;
    detailBackRef.current?.focus();
  }, [selectedContactId]);

  const closeSelected = useCallback(() => {
    const restoreTarget = selectionTriggerRef.current;
    messagesRequestRef.current += 1;
    notesRequestRef.current += 1;
    selectedIdRef.current = null;
    setSelected(null);
    setMessagesLoading(false);
    setNotesLoading(false);
    setMessages([]);
    setNotes([]);
    setMessagesError('');
    setNotesError('');
    setNewNote('');
    setNewTag(onboarding ? onboardingSegment : '');

    if (window.matchMedia('(max-width: 720px)').matches) {
      window.requestAnimationFrame(() => (restoreTarget ?? contactsHeadingRef.current)?.focus());
    }
  }, [onboarding, onboardingSegment]);

  const loadSubscribers = useCallback(async () => {
    const currentBotId = botIdRef.current;
    if (!currentBotId) return;

    const requestId = ++listRequestRef.current;
    setListLoading(true);
    setListError('');

    try {
      const response = await api.listSubscribers({ baseUrl, apiKey }, currentBotId, {
        tag: backendFilterRef.current.tagFilter || undefined,
        leadStatus: backendFilterRef.current.leadStatusFilter || undefined,
      });

      if (listRequestRef.current !== requestId) return;

      setSubscribers(response.subscribers);
      setListLoaded(true);

      const currentSelectedId = selectedIdRef.current;
      if (currentSelectedId) {
        const refreshedSelected = response.subscribers.find((subscriber) => subscriber.id === currentSelectedId);
        if (refreshedSelected) setSelected(refreshedSelected);
      }

      const requestedSubscriber = requestedSubscriberId
        ? response.subscribers.find((subscriber) => subscriber.id === requestedSubscriberId)
        : onboarding && !currentSelectedId
          ? response.subscribers[0]
          : undefined;

      if (requestedSubscriber && autoSelectedSubscriberRef.current !== requestedSubscriber.id) {
        autoSelectedSubscriberRef.current = requestedSubscriber.id;
        void selectSubscriber(requestedSubscriber);
      }
    } catch (error) {
      if (listRequestRef.current === requestId) {
        setListError(friendlyError(error, 'Не удалось загрузить контакты.'));
      }
    } finally {
      if (listRequestRef.current === requestId) setListLoading(false);
    }
  }, [apiKey, baseUrl, onboarding, requestedSubscriberId, selectSubscriber]);

  useEffect(() => {
    void loadSubscribers();
  }, [loadSubscribers]);

  const loadAllSubscribers = useCallback(async () => {
    if (!botId) return;
    const requestedBotId = botId;
    const requestId = ++aggregateRequestRef.current;
    try {
      const response = await api.listSubscribers({ baseUrl, apiKey }, requestedBotId, {});
      if (aggregateRequestRef.current !== requestId) return;
      setAllSubscribers(response.subscribers);
      setAggregateBotId(requestedBotId);

      const selectedId = selectedIdRef.current;
      if (selectedId) {
        const refreshedSelected = response.subscribers.find((subscriber) => subscriber.id === selectedId);
        if (refreshedSelected) setSelected(refreshedSelected);
      }

      if (!backendFilterRef.current.tagFilter && !backendFilterRef.current.leadStatusFilter) {
        setSubscribers(response.subscribers);
        setListLoaded(true);
      }
    } catch {
      // This aggregate refresh is best-effort; the main list owns visible errors.
    }
  }, [apiKey, baseUrl, botId]);

  useEffect(() => {
    // `now` (updated every 30s purely to refresh "active recently" labels)
    // deliberately isn't a dependency here — this effect should only
    // refetch when the identity of loadAllSubscribers itself changes
    // (botId/apiKey/baseUrl), not on every relative-time tick.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadAllSubscribers();
  }, [loadAllSubscribers]);

  useEffect(() => {
    if (!botId) return;
    let cancelled = false;

    api
      .listTags({ baseUrl, apiKey }, botId)
      .then((response) => {
        if (!cancelled) setKnownTags(response.tags);
      })
      .catch(() => {
        // Tag suggestions are optional; manual input remains available.
      });

    return () => {
      cancelled = true;
    };
  }, [apiKey, baseUrl, botId]);

  // subscribers/allSubscribers/selected are three independently-maintained
  // copies of subscriber data (not derivable from one another — `selected`
  // can be set from a subscriber fetched individually, e.g. by id from a
  // URL param, before either list has loaded it). This is the ONLY
  // sanctioned way to mutate a subscriber's fields: every new mutation
  // (tag/note/status change) must go through this function, never call
  // setSubscribers/setAllSubscribers/setSelected directly for a field
  // update, or the slices silently drift out of sync until the next full
  // reload.
  function updateSubscriberEverywhere(id: string, update: (subscriber: Subscriber) => Subscriber) {
    aggregateRequestRef.current += 1;
    setSubscribers((current) => current.map((subscriber) => (subscriber.id === id ? update(subscriber) : subscriber)));
    setAllSubscribers((current) => current.map((subscriber) => (subscriber.id === id ? update(subscriber) : subscriber)));
    setSelected((current) => (current?.id === id ? update(current) : current));
  }

  async function changeLeadStatus(id: string, leadStatus: LeadStatus) {
    const action = `status:${id}`;
    setSavingAction(action);
    setStatus('');
    try {
      await api.updateLeadStatus(config, id, leadStatus);
      updateSubscriberEverywhere(id, (subscriber) => ({ ...subscriber, lead_status: leadStatus }));
      await loadSubscribers();
    } catch (error) {
      setStatus(friendlyError(error, 'Не удалось изменить статус.'));
    } finally {
      setSavingAction(null);
    }
  }

  async function addTagToSelected(value: string, action: string) {
    if (!selected || !value.trim()) return;

    const subscriberId = selected.id;
    const name = value.trim();
    setSavingAction(action);
    setStatus('');

    try {
      const response = await api.addTag(config, subscriberId, name);
      updateSubscriberEverywhere(subscriberId, (subscriber) =>
        subscriber.tags.some((tag) => tag.id === response.tag.id)
          ? subscriber
          : { ...subscriber, tags: [...subscriber.tags, response.tag] }
      );
      setKnownTags((current) =>
        current.some((tag) => tag.id === response.tag.id)
          ? current
          : [...current, response.tag].sort((first, second) => first.name.localeCompare(second.name, 'ru'))
      );
      if (selectedIdRef.current === subscriberId) setNewTag('');
      await loadSubscribers();
    } catch (error) {
      setStatus(friendlyError(error, 'Не удалось добавить тег.'));
    } finally {
      setSavingAction(null);
    }
  }

  async function addTag(event?: React.FormEvent) {
    event?.preventDefault();
    await addTagToSelected(newTag, 'tag:add');
  }

  async function addOnboardingSegment() {
    if (selectedHasSegment) return;
    await addTagToSelected(onboardingSegment, 'tag:onboarding');
  }

  async function removeTag(tagId: string) {
    if (!selected) return;

    const subscriberId = selected.id;
    setSavingAction(`tag:remove:${tagId}`);
    setStatus('');
    try {
      await api.removeTag(config, subscriberId, tagId);
      updateSubscriberEverywhere(subscriberId, (subscriber) => ({
        ...subscriber,
        tags: subscriber.tags.filter((tag) => tag.id !== tagId),
      }));
      await loadSubscribers();
    } catch (error) {
      setStatus(friendlyError(error, 'Не удалось удалить тег.'));
    } finally {
      setSavingAction(null);
    }
  }

  async function addNote(event?: React.FormEvent) {
    event?.preventDefault();
    if (!selected || !newNote.trim()) return;

    const subscriberId = selected.id;
    const noteBody = newNote.trim();
    setSavingAction('note:add');
    setStatus('');
    try {
      await api.addNote(config, subscriberId, noteBody);
    } catch (error) {
      setStatus(friendlyError(error, 'Не удалось добавить заметку.'));
      setSavingAction(null);
      return;
    }

    if (selectedIdRef.current === subscriberId) setNewNote('');

    try {
      const response = await api.getNotes(config, subscriberId);
      if (selectedIdRef.current === subscriberId) {
        setNotes(response.notes);
        setNotesError('');
      }
    } catch {
      setStatus('Заметка сохранена, но список не обновился. Откройте контакт повторно.');
    } finally {
      setSavingAction(null);
    }
  }

  function applyTagFilter(event: React.FormEvent) {
    event.preventDefault();
    const nextTag = tagDraft.trim();
    backendFilterRef.current = { ...backendFilterRef.current, tagFilter: nextTag };
    setTagFilter(nextTag);
    void loadSubscribers();
  }

  function changeStatusFilter(value: LeadStatus | '') {
    aggregateRequestRef.current += 1;
    backendFilterRef.current = { ...backendFilterRef.current, leadStatusFilter: value };
    setLeadStatusFilter(value);
    void loadSubscribers();
  }

  function clearFilters() {
    aggregateRequestRef.current += 1;
    backendFilterRef.current = { tagFilter: '', leadStatusFilter: '' };
    setSearchQuery('');
    setTagDraft('');
    setTagFilter('');
    setLeadStatusFilter('');
    void loadSubscribers();
  }

  // Mirrors the per-bot state declared at the top of the component — see
  // the comment above the `view` useState. Keep this list in sync by hand
  // whenever a new per-bot field is added up there.
  function changeBotId(value: string) {
    listRequestRef.current += 1;
    messagesRequestRef.current += 1;
    notesRequestRef.current += 1;
    aggregateRequestRef.current += 1;
    selectedIdRef.current = null;
    autoSelectedSubscriberRef.current = null;
    selectionTriggerRef.current = null;
    botIdRef.current = value;
    backendFilterRef.current = { tagFilter: '', leadStatusFilter: '' };
    setSubscribers([]);
    setAllSubscribers([]);
    setAggregateBotId('');
    setKnownTags([]);
    setSelected(null);
    setMessagesLoading(false);
    setNotesLoading(false);
    setMessages([]);
    setNotes([]);
    setMessagesError('');
    setNotesError('');
    setListError('');
    setListLoaded(false);
    setListLoading(Boolean(value));
    setSearchQuery('');
    setTagDraft('');
    setTagFilter('');
    setLeadStatusFilter('');
    setBotId(value);
    if (value) void loadSubscribers();
  }

  function handleDetailTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, currentTab: DetailTab) {
    const tabs: DetailTab[] = ['conversation', 'notes'];
    const currentIndex = tabs.indexOf(currentTab);
    let nextIndex = currentIndex;

    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else return;

    event.preventDefault();
    const nextTab = tabs[nextIndex];
    setDetailTab(nextTab);
    document.getElementById(`${nextTab}-tab`)?.focus();
  }

  const initialListLoading = listLoading && !listLoaded;
  const selectedActive = selected ? hasRecentActivity(selected, now) : false;

  return (
    <div className={styles.page}>
      <header className={`${layout.header} ${styles.topbar}`}>
        <div className={styles.appIdentity}>
          <span className={styles.brandMark} aria-hidden="true" />
          <span className={styles.brandName}>Sonar</span>
          <span className={styles.identityDivider} aria-hidden="true">/</span>
          <strong>CRM</strong>
        </div>
        <ModuleNav current="/crm" />
      </header>

      <div className={`${layout.twoPane} ${styles.workspace} ${selected ? styles.workspaceWithSelection : ''}`}>
        <main className={`${layout.main} ${styles.mainPane}`}>
          <div className={styles.mainInner}>
            <section className={styles.pageIntro} aria-labelledby="crm-title">
              <div>
                <p className={styles.eyebrow}>АУДИТОРИЯ</p>
                <h1 id="crm-title">Контакты и диалоги</h1>
                <p className={styles.pageLead}>Смотрите историю общения, фиксируйте статус лида и объединяйте контакты по темам.</p>
              </div>
              {botId && (
                <div className={styles.audienceMeta} aria-label="Сводка CRM">
                  <span><strong>{totalCount}</strong> контактов</span>
                  <span><strong>{clientCount}</strong> клиентов</span>
                  {activeNow > 0 && <PulseIndicator count={activeNow} label="взаимодействовали за 15 минут" />}
                </div>
              )}
            </section>

            {!botId ? (
              <section className={styles.workspaceEmpty} aria-labelledby="workspace-empty-title">
                <EmptyRadar />
                <div>
                  <h2 id="workspace-empty-title">Рабочее пространство ещё не подготовлено</h2>
                  <p>Завершите первый запуск — Sonar создаст демо-сценарий и свяжет его с CRM.</p>
                </div>
                <Link href="/onboarding" className={controls.buttonPrimary}>Продолжить настройку</Link>
              </section>
            ) : (
              <>
                {onboarding && (
                  <section className={styles.onboardingCard} aria-labelledby="crm-onboarding-title">
                    <div className={styles.onboardingHeading}>
                      <div>
                        <span className={styles.onboardingEyebrow}>Шаг 3 из 4 · CRM</span>
                        <h2 id="crm-onboarding-title" className={styles.onboardingTitle}>Зафиксируйте результат диалога</h2>
                      </div>
                      {selected && <span className={styles.onboardingContact}>{selected.external_user_id}</span>}
                    </div>

                    <p className={styles.onboardingDescription}>
                      Отметьте результат и тему контакта — эти два признака использует текущий MVP контент-плана.
                    </p>

                    <ol className={styles.onboardingTasks}>
                      <li className={`${styles.onboardingTask} ${selectedIsClient ? styles.onboardingTaskDone : ''}`}>
                        <span className={styles.taskMarker} aria-hidden="true">{selectedIsClient ? '✓' : '1'}</span>
                        <span className={styles.taskCopy}>
                          <strong>Статус «Клиент»</strong>
                          <span>Фиксирует текущий результат работы с контактом.</span>
                        </span>
                        {!selectedIsClient && (
                          <button
                            type="button"
                            className={controls.buttonSecondary}
                            onClick={() => selected && void changeLeadStatus(selected.id, 'client')}
                            disabled={!selected || savingAction !== null}
                          >
                            {selected && savingAction === `status:${selected.id}` ? 'Сохраняем…' : 'Отметить'}
                          </button>
                        )}
                      </li>

                      <li className={`${styles.onboardingTask} ${selectedHasSegment ? styles.onboardingTaskDone : ''}`}>
                        <span className={styles.taskMarker} aria-hidden="true">{selectedHasSegment ? '✓' : '2'}</span>
                        <span className={styles.taskCopy}>
                          <strong>Тег «{onboardingSegment}»</strong>
                          <span>Объединяет контакты по интересу для rule-based сравнения.</span>
                        </span>
                        {!selectedHasSegment && (
                          <button
                            type="button"
                            className={controls.buttonSecondary}
                            onClick={() => void addOnboardingSegment()}
                            disabled={!selected || savingAction !== null}
                          >
                            {savingAction === 'tag:onboarding' ? 'Добавляем…' : 'Добавить'}
                          </button>
                        )}
                      </li>
                    </ol>

                    {!selected && (
                      <p className={styles.onboardingNotice}>
                        {listLoading
                          ? 'Загружаем контакт из тестового диалога…'
                          : requestedSubscriberId
                            ? 'Демо-контакт не найден. Проверьте рабочее пространство или повторите шаг onboarding.'
                            : 'Выберите контакт в списке, чтобы завершить шаг.'}
                      </p>
                    )}

                    {onboardingComplete && (
                      <div className={styles.onboardingReady}>
                        <span>Готово: CRM знает результат и тему демо-контакта.</span>
                        <Link href={contentPlanHref} className={`${controls.buttonPrimary} ${styles.onboardingCta}`}>
                          Посмотреть рекомендацию
                        </Link>
                      </div>
                    )}
                  </section>
                )}

                <section className={styles.crmPanel} aria-labelledby="contacts-title" aria-busy={listLoading}>
                  <div className={styles.panelHeader}>
                    <div>
                      <h2 id="contacts-title" ref={contactsHeadingRef} tabIndex={-1}>Контакты</h2>
                      <p aria-live="polite">
                        {listLoading && listLoaded ? 'Обновляем список…' : `Показано ${visibleSubscribers.length}`}
                      </p>
                    </div>

                    <div className={styles.viewToggle} role="group" aria-label="Представление контактов">
                      <button
                        type="button"
                        className={view === 'table' ? styles.viewButtonActive : styles.viewButton}
                        aria-pressed={view === 'table'}
                        onClick={() => setView('table')}
                      >
                        Таблица
                      </button>
                      <button
                        type="button"
                        className={view === 'kanban' ? styles.viewButtonActive : styles.viewButton}
                        aria-pressed={view === 'kanban'}
                        onClick={() => setView('kanban')}
                      >
                        Kanban
                      </button>
                    </div>
                  </div>

                  <div className={styles.toolbar}>
                    <label className={styles.filterField}>
                      <span>Поиск</span>
                      <input
                        className={`${controls.input} ${styles.filterInput}`}
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        placeholder="ID контакта или тег"
                        type="search"
                      />
                    </label>

                    <label className={styles.filterField}>
                      <span>Статус</span>
                      <select
                        className={`${controls.input} ${styles.filterInput}`}
                        value={leadStatusFilter}
                        onChange={(event) => changeStatusFilter(event.target.value as LeadStatus | '')}
                      >
                        <option value="">Все статусы</option>
                        {LEAD_STATUSES.map((leadStatus) => (
                          <option key={leadStatus} value={leadStatus}>{STATUS_LABEL[leadStatus]}</option>
                        ))}
                      </select>
                    </label>

                    <form className={styles.tagFilterForm} onSubmit={applyTagFilter}>
                      <label className={styles.filterField}>
                        <span>Точный тег</span>
                        <input
                          className={`${controls.input} ${styles.filterInput}`}
                          value={tagDraft}
                          onChange={(event) => setTagDraft(event.target.value)}
                          placeholder="Например, запуск"
                          list="crm-tag-options"
                        />
                      </label>
                      <button type="submit" className={`${controls.buttonSecondary} ${styles.applyFilterButton}`}>Применить</button>
                    </form>

                    {hasFilters && (
                      <button type="button" className={styles.clearFilters} onClick={clearFilters}>Сбросить</button>
                    )}
                  </div>

                  <datalist id="crm-tag-options">
                    {knownTags.map((tag) => <option key={tag.id} value={tag.name} />)}
                  </datalist>

                  {hasFilters && (
                    <div className={styles.activeFilters} aria-label="Активные фильтры">
                      <span className={styles.activeFiltersLabel}>Фильтры:</span>
                      {searchQuery.trim() && <span className={styles.filterChip}>Поиск: {searchQuery.trim()}</span>}
                      {leadStatusFilter && <span className={styles.filterChip}>Статус: {STATUS_LABEL[leadStatusFilter]}</span>}
                      {tagFilter && <span className={styles.filterChip}>Тег: {tagFilter}</span>}
                    </div>
                  )}

                  {listError && listLoaded && (
                    <div className={styles.inlineError} role="alert">
                      <span>{listError}</span>
                      <button type="button" className={controls.buttonSecondary} onClick={() => void loadSubscribers()}>Повторить</button>
                    </div>
                  )}

                  {initialListLoading ? (
                    <div className={styles.listSkeleton} aria-label="Загружаем контакты">
                      {Array.from({ length: 5 }, (_, index) => <span key={index} />)}
                    </div>
                  ) : listError && !listLoaded ? (
                    <div className={styles.listEmpty} role="alert">
                      <EmptyRadar />
                      <h3>Контакты не загрузились</h3>
                      <p>{listError}</p>
                      <button type="button" className={controls.buttonSecondary} onClick={() => void loadSubscribers()}>Повторить</button>
                    </div>
                  ) : visibleSubscribers.length === 0 ? (
                    <div className={styles.listEmpty}>
                      <EmptyRadar />
                      <h3>{hasFilters ? 'По этим условиям контактов нет' : 'Контактов пока нет'}</h3>
                      <p>
                        {hasFilters
                          ? 'Измените поиск или сбросьте фильтры.'
                          : 'Создайте демо-диалог в onboarding — контакт и переписка появятся здесь.'}
                      </p>
                      {hasFilters ? (
                        <button type="button" className={controls.buttonSecondary} onClick={clearFilters}>Сбросить фильтры</button>
                      ) : (
                        <Link href="/onboarding" className={controls.buttonSecondary}>Перейти в onboarding</Link>
                      )}
                    </div>
                  ) : view === 'table' ? (
                    <>
                      <div className={styles.tableScroll}>
                        <table className={styles.contactTable}>
                          <caption className={styles.visuallyHidden}>Контакты CRM</caption>
                          <thead>
                            <tr>
                              <th scope="col">Контакт</th>
                              <th scope="col">Статус</th>
                              <th scope="col">Теги</th>
                              <th scope="col">Последняя активность</th>
                            </tr>
                          </thead>
                          <tbody>
                            {visibleSubscribers.map((subscriber) => {
                              const active = hasRecentActivity(subscriber, now);
                              const isSelected = subscriber.id === selected?.id;
                              return (
                                <tr key={subscriber.id} className={isSelected ? styles.tableRowSelected : styles.tableRow}>
                                  <td>
                                    <button
                                      type="button"
                                      className={styles.contactButton}
                                      onClick={(event) => void selectSubscriber(subscriber, 'conversation', event.currentTarget)}
                                      aria-label={`Открыть контакт ${subscriber.external_user_id}`}
                                      aria-current={isSelected ? 'true' : undefined}
                                    >
                                      <span className={styles.contactAvatar} aria-hidden="true">{contactInitial(subscriber.external_user_id)}</span>
                                      <span className={styles.contactText}>
                                        <strong>{subscriber.external_user_id}</strong>
                                        <span>
                                          {active ? (
                                            <>
                                              <span className={styles.recentDot} aria-hidden="true" />
                                              Недавняя активность
                                            </>
                                          ) : `Первый контакт ${SHORT_DATE_FORMATTER.format(new Date(subscriber.first_seen_at))}`}
                                        </span>
                                      </span>
                                    </button>
                                  </td>
                                  <td><StatusBadge status={subscriber.lead_status} /></td>
                                  <td><TagSummary tags={subscriber.tags} /></td>
                                  <td>
                                    <time dateTime={subscriber.last_interacted_at} title={DATE_TIME_FORMATTER.format(new Date(subscriber.last_interacted_at))}>
                                      {formatRelativeTime(subscriber.last_interacted_at, now)}
                                    </time>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      <ul className={styles.mobileContactList} aria-label="Контакты CRM">
                        {visibleSubscribers.map((subscriber) => {
                          const active = hasRecentActivity(subscriber, now);
                          return (
                            <li key={subscriber.id}>
                              <button
                                type="button"
                                className={`${styles.mobileContactCard} ${subscriber.id === selected?.id ? styles.mobileContactCardSelected : ''}`}
                                onClick={(event) => void selectSubscriber(subscriber, 'conversation', event.currentTarget)}
                                aria-current={subscriber.id === selected?.id ? 'true' : undefined}
                              >
                                <span className={styles.mobileContactHeading}>
                                  <span className={styles.contactAvatar} aria-hidden="true">{contactInitial(subscriber.external_user_id)}</span>
                                  <span className={styles.contactText}>
                                    <strong>{subscriber.external_user_id}</strong>
                                    <span>{active ? 'Активность за 15 минут' : formatRelativeTime(subscriber.last_interacted_at, now)}</span>
                                  </span>
                                  <StatusBadge status={subscriber.lead_status} />
                                </span>
                                <TagSummary tags={subscriber.tags} limit={3} />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  ) : (
                    <div className={styles.kanban} aria-label="Контакты по статусам">
                      {LEAD_STATUSES.map((columnStatus) => {
                        const columnSubscribers = visibleSubscribers.filter((subscriber) => subscriber.lead_status === columnStatus);
                        return (
                          <section key={columnStatus} className={styles.kanbanColumn} aria-labelledby={`kanban-${columnStatus}`}>
                            <header className={styles.kanbanHeader}>
                              <div>
                                <StatusBadge status={columnStatus} decorative />
                                <h3 id={`kanban-${columnStatus}`}>{STATUS_LABEL[columnStatus]}</h3>
                              </div>
                              <span className={styles.kanbanCount}>{columnSubscribers.length}</span>
                            </header>

                            <div className={styles.kanbanCards}>
                              {columnSubscribers.length === 0 ? (
                                <p className={styles.kanbanEmpty}>В этой колонке пока нет контактов</p>
                              ) : (
                                columnSubscribers.map((subscriber) => (
                                  <article key={subscriber.id} className={`${styles.kanbanCard} ${subscriber.id === selected?.id ? styles.kanbanCardSelected : ''}`}>
                                    <button
                                      type="button"
                                      className={styles.kanbanCardOpen}
                                      onClick={(event) => void selectSubscriber(subscriber, 'conversation', event.currentTarget)}
                                      aria-current={subscriber.id === selected?.id ? 'true' : undefined}
                                    >
                                      <span className={styles.kanbanContact}>
                                        <span className={styles.contactAvatar} aria-hidden="true">{contactInitial(subscriber.external_user_id)}</span>
                                        <span>
                                          <strong>{subscriber.external_user_id}</strong>
                                          <time dateTime={subscriber.last_interacted_at}>{formatRelativeTime(subscriber.last_interacted_at, now)}</time>
                                        </span>
                                      </span>
                                      <TagSummary tags={subscriber.tags} />
                                    </button>
                                    <label className={styles.kanbanMove}>
                                      <span>Переместить</span>
                                      <select
                                        className={controls.input}
                                        value={subscriber.lead_status}
                                        onChange={(event) => void changeLeadStatus(subscriber.id, event.target.value as LeadStatus)}
                                        disabled={savingAction !== null}
                                      >
                                        {LEAD_STATUSES.map((leadStatus) => (
                                          <option key={leadStatus} value={leadStatus}>{STATUS_LABEL[leadStatus]}</option>
                                        ))}
                                      </select>
                                    </label>
                                  </article>
                                ))
                              )}
                            </div>
                          </section>
                        );
                      })}
                    </div>
                  )}
                </section>

              </>
            )}

            <div className={styles.developerArea}>
              <button className={controls.devToggle} onClick={() => setDevMode(!devMode)}>
                {devMode ? '▾' : '▸'} Режим разработчика
              </button>
              {devMode && (
                <div className={controls.devPanel}>
                  <label className={styles.developerField}>
                    <span>Bot ID</span>
                    <input className={controls.input} value={botId} onChange={(event) => changeBotId(event.target.value)} />
                  </label>
                </div>
              )}
            </div>
          </div>
        </main>

        <aside className={`${layout.sidebar} ${styles.detailPane}`} aria-label="Карточка контакта">
          {!selected ? (
            <div className={styles.emptyInspector}>
              <EmptyRadar />
              <h2>Выберите контакт</h2>
              <p>Здесь появятся статус, теги, история диалога и заметки.</p>
            </div>
          ) : (
            <>
              <div className={styles.detailTopbar}>
                <span>{onboarding ? 'Шаг 3 из 4 · Карточка контакта' : 'Карточка контакта'}</span>
                <button
                  ref={detailBackRef}
                  type="button"
                  className={styles.detailClose}
                  onClick={closeSelected}
                  aria-label="Закрыть карточку контакта"
                >
                  <span aria-hidden="true">←</span>
                  <span className={styles.detailCloseLabel}>К контактам</span>
                </button>
              </div>

              <header className={styles.contactHeader}>
                <span className={`${styles.contactAvatar} ${styles.contactAvatarLarge}`} aria-hidden="true">{contactInitial(selected.external_user_id)}</span>
                <div className={styles.contactHeaderCopy}>
                  <h2 title={selected.external_user_id}>{selected.external_user_id}</h2>
                  <span className={styles.activityState}>
                    {selectedActive ? <><LiveDot label="взаимодействовал за последние 15 минут" />Недавняя активность</> : `Последний диалог ${formatRelativeTime(selected.last_interacted_at, now)}`}
                  </span>
                </div>
              </header>

              <dl className={styles.contactMeta}>
                <div>
                  <dt>Первый контакт</dt>
                  <dd><time dateTime={selected.first_seen_at}>{DATE_TIME_FORMATTER.format(new Date(selected.first_seen_at))}</time></dd>
                </div>
                <div>
                  <dt>Последний диалог</dt>
                  <dd><time dateTime={selected.last_interacted_at}>{DATE_TIME_FORMATTER.format(new Date(selected.last_interacted_at))}</time></dd>
                </div>
              </dl>

              <section className={styles.profileControls} aria-label="Данные лида">
                <label className={styles.detailField}>
                  <span>Статус лида</span>
                  <select
                    className={`${controls.input} ${styles.detailSelect}`}
                    value={selected.lead_status}
                    onChange={(event) => void changeLeadStatus(selected.id, event.target.value as LeadStatus)}
                    disabled={savingAction !== null}
                  >
                    {LEAD_STATUSES.map((leadStatus) => (
                      <option key={leadStatus} value={leadStatus}>{STATUS_LABEL[leadStatus]}</option>
                    ))}
                  </select>
                </label>

                <div className={styles.tagsSection}>
                  <div className={styles.sectionLabel}>Теги</div>
                  <div className={styles.editableTags}>
                    {selected.tags.length === 0 && <span className={styles.noTags}>Тегов пока нет</span>}
                    {selected.tags.map((tag) => (
                      <span key={tag.id} className={styles.editableTag}>
                        {tag.name}
                        <button
                          type="button"
                          className={styles.tagRemove}
                          onClick={() => void removeTag(tag.id)}
                          disabled={savingAction !== null}
                          aria-label={`Удалить тег ${tag.name}`}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>

                  <form className={styles.addTagForm} onSubmit={(event) => void addTag(event)}>
                    <label className={styles.visuallyHidden} htmlFor="crm-new-tag">Новый тег</label>
                    <input
                      id="crm-new-tag"
                      className={`${controls.input} ${styles.addTagInput}`}
                      value={newTag}
                      onChange={(event) => setNewTag(event.target.value)}
                      placeholder="Добавить тег"
                      list="crm-tag-options"
                    />
                    <button type="submit" className={controls.buttonSecondary} disabled={!newTag.trim() || savingAction !== null}>
                      {savingAction === 'tag:add' ? 'Добавляем…' : 'Добавить'}
                    </button>
                  </form>
                </div>
              </section>

              {onboarding && (
                <div className={styles.detailOnboardingGuide} aria-label="Задачи шага CRM">
                  <div>
                    <span className={styles.detailOnboardingEyebrow}>Шаг 3 из 4</span>
                    <strong>{onboardingComplete ? 'Данные зафиксированы' : 'Отметьте результат и тему'}</strong>
                  </div>
                  <ul>
                    <li className={selectedIsClient ? styles.detailTaskDone : ''}>
                      <span aria-hidden="true">{selectedIsClient ? '✓' : '1'}</span>
                      Статус «Клиент»
                    </li>
                    <li className={selectedHasSegment ? styles.detailTaskDone : ''}>
                      <span aria-hidden="true">{selectedHasSegment ? '✓' : '2'}</span>
                      Тег «{onboardingSegment}»
                    </li>
                  </ul>
                  {onboardingComplete ? (
                    <Link href={contentPlanHref} className={controls.buttonPrimary}>К рекомендации</Link>
                  ) : (
                    <p>Используйте поля статуса и тегов выше — прогресс обновится автоматически.</p>
                  )}
                </div>
              )}

              <div className={styles.detailTabs} role="tablist" aria-label="Разделы карточки контакта">
                <button
                  id="conversation-tab"
                  type="button"
                  role="tab"
                  aria-selected={detailTab === 'conversation'}
                  aria-controls="conversation-panel"
                  className={detailTab === 'conversation' ? styles.detailTabActive : styles.detailTab}
                  onClick={() => setDetailTab('conversation')}
                  onKeyDown={(event) => handleDetailTabKeyDown(event, 'conversation')}
                  tabIndex={detailTab === 'conversation' ? 0 : -1}
                >
                  Диалог <span>{messages.length}</span>
                </button>
                <button
                  id="notes-tab"
                  type="button"
                  role="tab"
                  aria-selected={detailTab === 'notes'}
                  aria-controls="notes-panel"
                  className={detailTab === 'notes' ? styles.detailTabActive : styles.detailTab}
                  onClick={() => setDetailTab('notes')}
                  onKeyDown={(event) => handleDetailTabKeyDown(event, 'notes')}
                  tabIndex={detailTab === 'notes' ? 0 : -1}
                >
                  Заметки <span>{notes.length}</span>
                </button>
              </div>

              {detailTab === 'conversation' ? (
                <section id="conversation-panel" role="tabpanel" aria-labelledby="conversation-tab" className={styles.detailPanel}>
                  {messagesLoading ? (
                    <div className={styles.detailSkeleton} aria-label="Загружаем переписку"><span /><span /><span /></div>
                  ) : messagesError ? (
                    <div className={styles.detailError} role="alert">
                      <p>{messagesError}</p>
                      <button type="button" className={controls.buttonSecondary} onClick={() => void loadMessagesForSubscriber(selected)}>Повторить</button>
                    </div>
                  ) : (
                    <div ref={conversationRef} className={styles.conversation} aria-label="История диалога" tabIndex={0}>
                      {messages.length === 0 ? (
                        <div className={styles.sectionEmpty}><p>Сообщений пока нет</p><span>Новые входящие и исходящие сообщения появятся здесь.</span></div>
                      ) : (
                        messages.map((message, index) => {
                          const isFirstInGroup = index === 0 || messages[index - 1].direction !== message.direction;
                          const isLastInGroup = index === messages.length - 1 || messages[index + 1].direction !== message.direction;
                          return (
                            <div
                              key={`${message.created_at}-${message.direction}-${index}`}
                              className={`${styles.bubbleRow} ${message.direction === 'in' ? styles.bubbleRowIn : styles.bubbleRowOut} ${!isFirstInGroup ? styles.bubbleRowGrouped : ''}`}
                            >
                              <span className={styles.visuallyHidden}>{message.direction === 'in' ? 'Входящее сообщение' : 'Исходящее сообщение'}:</span>
                              <span className={`${styles.bubble} ${message.direction === 'in' ? styles.bubbleIn : styles.bubbleOut} ${message.direction === 'in' && !isLastInGroup ? styles.bubbleNoTail : ''}`}>
                                {message.content}
                                {isLastInGroup && (
                                  <time className={styles.bubbleTime} dateTime={message.created_at} title={DATE_TIME_FORMATTER.format(new Date(message.created_at))}>
                                    {new Date(message.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                                  </time>
                                )}
                              </span>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </section>
              ) : (
                <section id="notes-panel" role="tabpanel" aria-labelledby="notes-tab" className={styles.detailPanel}>
                  <form className={styles.noteForm} onSubmit={(event) => void addNote(event)}>
                    <label htmlFor="crm-new-note">Новая заметка</label>
                    <textarea
                      id="crm-new-note"
                      className={`${controls.input} ${styles.noteInput}`}
                      value={newNote}
                      onChange={(event) => setNewNote(event.target.value)}
                      rows={3}
                      placeholder="Контекст, договорённость или следующий шаг"
                    />
                    <button type="submit" className={controls.buttonPrimary} disabled={!newNote.trim() || savingAction !== null}>
                      {savingAction === 'note:add' ? 'Сохраняем…' : 'Добавить заметку'}
                    </button>
                  </form>

                  {notesLoading ? (
                    <div className={styles.detailSkeleton} aria-label="Загружаем заметки"><span /><span /></div>
                  ) : notesError ? (
                    <div className={styles.detailError} role="alert">
                      <p>{notesError}</p>
                      <button type="button" className={controls.buttonSecondary} onClick={() => void loadNotesForSubscriber(selected)}>Повторить</button>
                    </div>
                  ) : notes.length === 0 ? (
                    <div className={styles.sectionEmpty}><p>Заметок пока нет</p><span>Сохраните важный контекст, чтобы не потерять следующий шаг.</span></div>
                  ) : (
                    <ol className={styles.noteList} tabIndex={0} aria-label="Сохранённые заметки">
                      {notes.map((note) => (
                        <li key={note.id}>
                          <p>{note.body}</p>
                          <time dateTime={note.created_at}>{DATE_TIME_FORMATTER.format(new Date(note.created_at))}</time>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              )}
            </>
          )}
        </aside>
      </div>

      {status && (
        <div className={styles.statusToast} role="alert">
          <span>{status}</span>
          <button type="button" onClick={() => setStatus('')} aria-label="Закрыть сообщение">×</button>
        </div>
      )}
    </div>
  );
}
