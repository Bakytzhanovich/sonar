import { randomUUID } from 'node:crypto';
import { queryAll, type Db } from './db';
import type { ContentTopic } from './contentTopics';

// Module 6 — the week the topics are filmed in.
//
// Entries carry their own copy of the topic's title and segment. Topics get
// fresh ids every time the plan is rebuilt, and a week someone has laid out
// must not empty itself because the plan behind it was refreshed — the entry
// keeps saying what was planned, and loses only the link back to its topic.
//
// Days are calendar dates (YYYY-MM-DD), not instants, chosen by the browser
// in the person's own time zone. A Monday in Almaty is a Monday; computed on
// a UTC server it could land on Sunday evening.

export interface CalendarEntry {
  id: string;
  day: string;
  topic_id: string | null;
  title: string;
  segment: string;
  script: string | null;
  created_at: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Which days of a week get a video, as offsets from its first day.
 *
 * Spread as evenly as the count allows: three a week is Monday, Wednesday,
 * Friday rather than three days in a row, which is what someone filming
 * their own content can actually keep up with.
 */
export function weekOffsets(perWeek: number): number[] {
  const n = Math.min(7, Math.max(1, Math.round(perWeek)));
  const offsets = Array.from({ length: n }, (_, i) => Math.floor((i * 7) / n));
  return [...new Set(offsets)];
}

/**
 * Topics in the order to film them: the plan's own order (strongest first),
 * except that the next topic is taken from a different segment than the
 * last one when there is one to take. Three videos in a row for the same
 * audience leaves every other buyer with nothing that week.
 */
export function alternateSegments<T extends { segment: string }>(topics: T[]): T[] {
  const left = [...topics];
  const ordered: T[] = [];
  while (left.length > 0) {
    const previous = ordered[ordered.length - 1]?.segment;
    const index = left.findIndex((t) => t.segment !== previous);
    ordered.push(...left.splice(index === -1 ? 0 : index, 1));
  }
  return ordered;
}

/**
 * Lays topics onto a week: the chosen days that are still free, the topics
 * not already somewhere in the calendar. Pure — the route below does the
 * reading and writing.
 */
export function spreadTopics(
  topics: ContentTopic[],
  weekStart: string,
  perWeek: number,
  takenDays: Set<string>,
  plannedTopics: { topicIds: Set<string>; titles: Set<string> },
  /** The viewer's today. Days before it are not offered — a video cannot be
   *  filmed on a Monday that has already gone. */
  notBefore?: string
): Array<{ day: string; topic: ContentTopic }> {
  const freeDays = weekOffsets(perWeek)
    .map((offset) => addDays(weekStart, offset))
    .filter((day) => !takenDays.has(day) && (!notBefore || day >= notBefore));
  const unplanned = alternateSegments(
    topics.filter((t) => !plannedTopics.topicIds.has(t.id) && !plannedTopics.titles.has(t.title.toLocaleLowerCase('ru')))
  );
  return freeDays.slice(0, unplanned.length).map((day, i) => ({ day, topic: unplanned[i] }));
}

export async function listEntries(db: Db, tenantId: string, from: string, to: string): Promise<CalendarEntry[]> {
  // day::text: a DATE read back as a JavaScript Date is midnight in the
  // server's zone, and turned into a string it can shift by a day.
  return queryAll<CalendarEntry>(
    db,
    `SELECT id, day::text AS day, topic_id, title, segment, script, created_at
     FROM content_calendar WHERE tenant_id = ? AND day BETWEEN ?::date AND ?::date
     ORDER BY day, created_at`,
    tenantId,
    from,
    to
  );
}

export async function autoFillWeek(
  db: Db,
  tenantId: string,
  topics: ContentTopic[],
  weekStart: string,
  perWeek: number,
  notBefore?: string
): Promise<CalendarEntry[]> {
  const weekEnd = addDays(weekStart, 6);
  const inWeek = await listEntries(db, tenantId, weekStart, weekEnd);
  const everywhere = await queryAll<{ topic_id: string | null; title: string }>(
    db,
    `SELECT topic_id, title FROM content_calendar WHERE tenant_id = ?`,
    tenantId
  );
  const placements = spreadTopics(topics, weekStart, perWeek, new Set(inWeek.map((e) => e.day)), {
    topicIds: new Set(everywhere.map((e) => e.topic_id).filter((id): id is string => Boolean(id))),
    titles: new Set(everywhere.map((e) => e.title.toLocaleLowerCase('ru'))),
  }, notBefore);
  for (const { day, topic } of placements) {
    await queryAll(
      db,
      `INSERT INTO content_calendar (id, tenant_id, day, topic_id, title, segment, script) VALUES (?, ?, ?::date, ?, ?, ?, ?)`,
      randomUUID(),
      tenantId,
      day,
      topic.id,
      topic.title,
      topic.segment,
      topic.script ?? null
    );
  }
  return listEntries(db, tenantId, weekStart, weekEnd);
}
