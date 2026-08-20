import type Database from 'better-sqlite3';

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

export function computeContentRecommendations(db: Database.Database, tenantId: string): ContentRecommendation[] {
  const tags = db.prepare(`SELECT id, name FROM tags WHERE tenant_id = ?`).all(tenantId) as Array<{ id: string; name: string }>;

  // Matched by case-insensitive tag-name == niche equality — a
  // deliberately simple rule for MVP, not fuzzy/semantic matching (that
  // would want pgvector, which we've deferred along with Postgres). The
  // case-fold happens in JS, not SQL: SQLite's built-in LOWER() only
  // handles ASCII a-z — it leaves Cyrillic untouched, so "Фитнес" and
  // "фитнес" would silently fail to match if compared with SQL LOWER().
  const scriptRows = db.prepare(`SELECT niche FROM generated_scripts WHERE tenant_id = ?`).all(tenantId) as Array<{ niche: string }>;
  const scriptCountByNiche = new Map<string, number>();
  for (const row of scriptRows) {
    const key = row.niche.toLowerCase();
    scriptCountByNiche.set(key, (scriptCountByNiche.get(key) ?? 0) + 1);
  }

  const recommendations: ContentRecommendation[] = [];

  for (const tag of tags) {
    const stats = db
      .prepare(
        `SELECT COUNT(*) as total, SUM(CASE WHEN subscribers.lead_status = 'client' THEN 1 ELSE 0 END) as clients
         FROM subscriber_tags
         JOIN subscribers ON subscriber_tags.subscriber_id = subscribers.id
         WHERE subscriber_tags.tag_id = ?`
      )
      .get(tag.id) as { total: number; clients: number | null };

    // No subscribers currently carry this tag — nothing to recommend from.
    if (stats.total === 0) continue;

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
