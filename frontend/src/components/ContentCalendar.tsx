'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type CalendarEntry, type ScheduledPost } from '@/lib/api';
import PillPicker from './PillPicker';
import controls from './Controls.module.css';
import styles from './ContentCalendar.module.css';

// Module 6 — the week the topics are filmed in.
//
// Days are worked out here, in the viewer's own time zone, and sent to the
// server as plain dates: a Monday in Almaty must stay a Monday whatever zone
// the server runs in.
//
// No drag and drop: the product runs on phones as much as on laptops, and a
// long-press drag across a scrolling list is the least reliable gesture
// there is. Moving is a choice of day.

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const PER_WEEK_OPTIONS = [
  { id: '2', label: '2' },
  { id: '3', label: '3', description: 'Пн, Ср, Пт — темп, который реально держать' },
  { id: '5', label: '5' },
  { id: '7', label: 'каждый день' },
];
const PER_WEEK_KEY = 'sonar-calendar-per-week';
const PLATFORM_LABEL: Record<string, string> = { instagram: 'Instagram', tiktok: 'TikTok', youtube_shorts: 'YouTube Shorts' };

/** YYYY-MM-DD in the viewer's own zone. toISOString would give UTC's date. */
function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function mondayOf(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

function shift(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** Mirrors weekOffsets in src/contentCalendar.ts — only to word a message;
 *  the server decides the days. */
function weekDayChosen(perWeek: number, index: number): boolean {
  const n = Math.min(7, Math.max(1, perWeek));
  return Array.from({ length: n }, (_, i) => Math.floor((i * 7) / n)).includes(index);
}

function readPerWeek(): string {
  try {
    const saved = window.localStorage.getItem(PER_WEEK_KEY);
    if (saved && PER_WEEK_OPTIONS.some((o) => o.id === saved)) return saved;
  } catch {
    // Private mode or blocked storage: the default is fine.
  }
  return '3';
}

export default function ContentCalendar({
  config,
  hasPlan,
  onMessage,
  onScriptWritten,
  refreshKey,
}: {
  config: { baseUrl: string; apiKey: string };
  hasPlan: boolean;
  onMessage: (message: string) => void;
  /** A script written here is saved onto its topic too; the page re-reads
   *  the plan so the topic card above shows it. */
  onScriptWritten: () => void;
  /** Bumped by the page when a script is written on a topic card, so the
   *  calendar shows it without a reload. */
  refreshKey: number;
}) {
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const [perWeek, setPerWeek] = useState(readPerWeek);
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [posts, setPosts] = useState<ScheduledPost[]>([]);
  const [filling, setFilling] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [writingId, setWritingId] = useState<string | null>(null);
  // Said next to the button that caused it, not at the foot of a long page.
  const [notice, setNotice] = useState('');

  const days = Array.from({ length: 7 }, (_, i) => shift(weekStart, i));
  const from = localDay(days[0]);
  const to = localDay(days[6]);
  const today = localDay(new Date());

  const load = useCallback(async () => {
    try {
      const [cal, scheduled] = await Promise.all([api.listCalendar(config, from, to), api.listScheduledPosts(config)]);
      setEntries(cal.entries);
      setPosts(scheduled.posts);
    } catch (err) {
      onMessage(err instanceof Error ? err.message : String(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.apiKey, config.baseUrl, from, to]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load, refreshKey]);

  function choosePerWeek(id: string) {
    setPerWeek(id);
    try {
      window.localStorage.setItem(PER_WEEK_KEY, id);
    } catch {
      // Remembering the choice is a convenience, not a requirement.
    }
  }

  async function fill() {
    setFilling(true);
    setNotice('');
    try {
      const before = entries.length;
      const res = await api.autoFillWeek(config, from, Number(perWeek), today);
      setEntries(res.entries);
      if (res.entries.length === before) {
        // Two different reasons, two different fixes: say which.
        const daysLeft = days.some((d, i) => localDay(d) >= today && weekDayChosen(Number(perWeek), i));
        setNotice(
          daysLeft
            ? 'Свободных тем не осталось — обновите план или уберите что-то из календаря'
            : 'Дни публикаций на этой неделе уже прошли — перейдите на следующую неделю ›'
        );
      }
    } catch (err) {
      onMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setFilling(false);
    }
  }

  async function move(entry: CalendarEntry, day: string) {
    try {
      await api.moveCalendarEntry(config, entry.id, day);
      await load();
    } catch (err) {
      onMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(entry: CalendarEntry) {
    try {
      await api.removeCalendarEntry(config, entry.id);
      setEntries((list) => list.filter((e) => e.id !== entry.id));
    } catch (err) {
      onMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function writeScript(entry: CalendarEntry) {
    setWritingId(entry.id);
    try {
      const { script } = await api.writeCalendarScript(config, entry.id);
      setEntries((list) => list.map((e) => (e.id === entry.id ? { ...e, script } : e)));
      setOpenId(entry.id);
      onScriptWritten();
    } catch (err) {
      onMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setWritingId(null);
    }
  }

  async function copy(script: string) {
    try {
      await navigator.clipboard.writeText(script);
      setNotice('Сценарий скопирован');
    } catch {
      setNotice('Не удалось скопировать — выделите текст вручную');
    }
  }

  const weekLabel = `${days[0].toLocaleDateString('ru-RU', { day: 'numeric', month: days[0].getMonth() === days[6].getMonth() ? undefined : 'long' })} – ${days[6].toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}`;
  const isThisWeek = from === localDay(mondayOf(new Date()));

  // A notice is about the week it was given for.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNotice('');
  }, [from]);

  return (
    <section className={styles.calendar}>
      <div className={styles.head}>
        <h2>Неделя</h2>
        <div className={styles.nav}>
          <button type="button" className={styles.navButton} onClick={() => setWeekStart(shift(weekStart, -7))} aria-label="Предыдущая неделя">‹</button>
          <span className={styles.weekLabel}>{weekLabel}</span>
          <button type="button" className={styles.navButton} onClick={() => setWeekStart(shift(weekStart, 7))} aria-label="Следующая неделя">›</button>
          {!isThisWeek && (
            <button type="button" className={styles.todayButton} onClick={() => setWeekStart(mondayOf(new Date()))}>Эта неделя</button>
          )}
        </div>
      </div>

      {hasPlan && (
        <div className={styles.controls}>
          <PillPicker label="Роликов в неделю" options={PER_WEEK_OPTIONS} value={perWeek} onChange={choosePerWeek} />
          <button type="button" className={controls.buttonPrimary} onClick={fill} disabled={filling}>
            {filling ? 'Раскладываю…' : 'Разложить темы по неделе'}
          </button>
        </div>
      )}

      {notice && <p className={styles.notice} role="status">{notice}</p>}

      <ol className={styles.days}>
        {days.map((date, i) => {
          const day = localDay(date);
          const dayEntries = entries.filter((e) => e.day === day);
          const dayPosts = posts.filter((p) => localDay(new Date(p.scheduled_at)) === day && p.status !== 'rejected');
          const empty = dayEntries.length === 0 && dayPosts.length === 0;
          return (
            <li key={day} className={`${styles.day} ${day === today ? styles.today : ''} ${empty ? styles.dayEmpty : ''}`}>
              <div className={styles.dayHead}>
                <span>{WEEKDAYS[i]}</span>
                <strong>{date.getDate()}</strong>
              </div>

              {dayEntries.map((entry) => (
                <div key={entry.id} className={styles.entry}>
                  <div className={styles.entryTitle}>{entry.title}</div>
                  <span className={styles.segment}>{entry.segment}</span>
                  <div className={styles.entryActions}>
                    {entry.script ? (
                      <button type="button" className={styles.linkButton} onClick={() => setOpenId(openId === entry.id ? null : entry.id)}>
                        {openId === entry.id ? 'Скрыть сценарий' : 'Сценарий готов ✓'}
                      </button>
                    ) : (
                      <button type="button" className={styles.linkButton} onClick={() => writeScript(entry)} disabled={writingId === entry.id}>
                        {writingId === entry.id ? 'Пишу…' : 'Написать сценарий'}
                      </button>
                    )}
                    <select
                      className={styles.moveSelect}
                      value={entry.day}
                      onChange={(e) => move(entry, e.target.value)}
                      aria-label="Перенести на день"
                    >
                      {days.map((d, j) => (
                        <option key={localDay(d)} value={localDay(d)}>{`${WEEKDAYS[j]} ${d.getDate()}`}</option>
                      ))}
                    </select>
                    <button type="button" className={styles.removeButton} onClick={() => remove(entry)} aria-label="Убрать из календаря">×</button>
                  </div>
                  {openId === entry.id && entry.script && (
                    <div className={styles.script}>
                      <p>{entry.script}</p>
                      <div className={styles.scriptActions}>
                        <button type="button" className={controls.buttonSecondary} onClick={() => copy(entry.script!)}>Скопировать</button>
                        <Link href="/video" className={controls.buttonSecondary}>Смонтировать →</Link>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {/* What is actually queued for this day in the scheduler, next
                  to what was planned: the gap between the two is the work
                  still to do. */}
              {dayPosts.map((post) => (
                <Link key={post.id} href="/scheduler" className={styles.post}>
                  <span className={styles.postDot} aria-hidden="true" />
                  {PLATFORM_LABEL[post.platform] ?? post.platform} · {new Date(post.scheduled_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                </Link>
              ))}

              {empty && <span className={styles.nothing}>—</span>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
