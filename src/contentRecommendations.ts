import { queryAll, type Db } from './db';

// The actual differentiator (per CLAUDE.md and the Notion ТЗ): ties
// Module 2's CRM data (who actually converts, by tag/segment) to Module
// 3's library (what content already exists for that niche). No new
// tables — this is a read-only pipeline over data those two modules
// already own.

export interface ContentRecommendation {
  segment: string;
  subscriberCount: number;
  clientCount: number;
  conversionRate: number; // 0..1
  matchingScriptCount: number;
  explanation: string;
}

export async function computeContentRecommendations(db: Db, tenantId: string): Promise<ContentRecommendation[]> {
  const tags = await queryAll<{ id: string; name: string }>(db, `SELECT id, name FROM tags WHERE tenant_id = ?`, tenantId);

  // Matched by case-insensitive tag-name == niche equality — a
  // deliberately simple rule for MVP, not fuzzy/semantic matching (that
  // would want pgvector, which we've deferred even though we're now on
  // Postgres). The case-fold happens in JS, not SQL, to keep this
  // behavior identical to before the migration (Postgres's LOWER() does
  // handle Cyrillic correctly, unlike SQLite's, but there was never a
  // functional need to move the fold into SQL).
  const scriptRows = await queryAll<{ niche: string }>(db, `SELECT niche FROM generated_scripts WHERE tenant_id = ?`, tenantId);
  const scriptCountByNiche = new Map<string, number>();
  for (const row of scriptRows) {
    const key = row.niche.toLowerCase();
    scriptCountByNiche.set(key, (scriptCountByNiche.get(key) ?? 0) + 1);
  }

  // One GROUP BY across every tag, not an awaited query per tag — each
  // was a separate Postgres round-trip (cheap in-process under the old
  // synchronous SQLite driver, a real network hop now). A tag with zero
  // subscribers just doesn't appear in the grouped result, same effect
  // as the old per-tag "stats.total === 0, skip" check.
  const statsByTagId = new Map<string, { total: number; clients: number | null }>();
  if (tags.length > 0) {
    const placeholders = tags.map(() => '?').join(',');
    const statsRows = await queryAll<{ tagId: string; total: number; clients: number | null }>(
      db,
      `SELECT subscriber_tags.tag_id as "tagId", COUNT(*) as total, SUM(CASE WHEN subscribers.lead_status = 'client' THEN 1 ELSE 0 END) as clients
       FROM subscriber_tags
       JOIN subscribers ON subscriber_tags.subscriber_id = subscribers.id
       WHERE subscriber_tags.tag_id IN (${placeholders})
       GROUP BY subscriber_tags.tag_id`,
      ...tags.map((t) => t.id)
    );
    for (const row of statsRows) statsByTagId.set(row.tagId, row);
  }

  const recommendations: ContentRecommendation[] = [];

  for (const tag of tags) {
    const stats = statsByTagId.get(tag.id);

    // No subscribers currently carry this tag — nothing to recommend from.
    if (!stats || stats.total === 0) continue;

    const clients = stats.clients ?? 0;
    const conversionRate = clients / stats.total;
    const matchingScriptCount = scriptCountByNiche.get(tag.name.toLowerCase()) ?? 0;

    recommendations.push({
      segment: tag.name,
      subscriberCount: stats.total,
      clientCount: clients,
      conversionRate,
      matchingScriptCount,
      explanation: buildExplanation(tag.name, stats.total, clients, conversionRate, matchingScriptCount),
    });
  }

  return recommendations.sort((a, b) => rankScore(b) - rankScore(a));
}

function rankScore(r: ContentRecommendation): number {
  return r.conversionRate * 100 + r.matchingScriptCount;
}

// Stands in for the LLM call the ТЗ asks for ("LLM для формулировки
// рекомендаций") — a template, not a real model call. Same mocking
// pattern as every other module: the rule/data logic is real, only the
// text formulation is faked.
function buildExplanation(segment: string, total: number, clients: number, rate: number, scriptCount: number): string {
  const pct = Math.round(rate * 100);
  const conversionLine = `Сегмент "${segment}": ${clients} из ${total} подписчиков с этим тегом стали клиентами (${pct}%).`;
  const contentLine =
    scriptCount > 0
      ? `Уже есть ${scriptCount} готовых сценариев по этой теме (Модуль 3) — можно публиковать сразу.`
      : 'Готовых сценариев по этой теме пока нет — стоит сделать разбор рилса в Модуле 3.';
  return `${conversionLine} ${contentLine}`;
}
