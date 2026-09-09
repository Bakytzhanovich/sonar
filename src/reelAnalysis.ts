import { createHash } from 'node:crypto';
import type { ReelAnalysis, StructureBeat } from './types';

// Deterministic fake analysis derived from the URL (same URL always
// produces the same "analysis" — useful for tests and demos). This is
// the ONLY thing that needs to be replaced with real yt-dlp + Whisper +
// an LLM call later; the storage/API contract around it (schema.sql,
// api.ts) stays identical — same pattern as the mock Instagram webhook.

const HOOK_TEMPLATES = [
  'Ты делаешь это неправильно — вот почему',
  '3 ошибки, которые убивают твой результат',
  'Никто не говорит тебе эту правду',
  'Я попробовал это 30 дней — вот что случилось',
];

const STRUCTURE_TEMPLATES: StructureBeat[][] = [
  [
    { label: 'Хук', timestampSeconds: 0 },
    { label: 'Проблема', timestampSeconds: 3 },
    { label: 'Решение', timestampSeconds: 10 },
    { label: 'Призыв к действию', timestampSeconds: 25 },
  ],
  [
    { label: 'Хук', timestampSeconds: 0 },
    { label: 'История', timestampSeconds: 4 },
    { label: 'Вывод', timestampSeconds: 18 },
    { label: 'Призыв к действию', timestampSeconds: 28 },
  ],
];

export type ReelAnalysisFields = Pick<ReelAnalysis, 'source_url' | 'hook' | 'duration_seconds' | 'on_screen_text' | 'structure'>;

export function analyzeReelMock(sourceUrl: string): ReelAnalysisFields {
  const hash = createHash('sha256').update(sourceUrl).digest();
  const hook = HOOK_TEMPLATES[hash[0] % HOOK_TEMPLATES.length];
  const structure = STRUCTURE_TEMPLATES[hash[1] % STRUCTURE_TEMPLATES.length];
  const durationSeconds = 20 + (hash[2] % 40);

  return {
    source_url: sourceUrl,
    hook,
    duration_seconds: durationSeconds,
    on_screen_text: `[мок] экранный текст разбора для ${sourceUrl}`,
    structure,
  };
}

export function generateScriptMock(analysis: ReelAnalysis, niche: string): string {
  const beatLines = analysis.structure.map((b) => `- ${b.label} (${b.timestampSeconds}с)`).join('\n');

  return [
    `[мок сценарий, адаптирован под нишу "${niche}"]`,
    `Хук: ${analysis.hook}`,
    '',
    'Структура:',
    beatLines,
    '',
    `Замени примеры на кейсы из ниши "${niche}" и запиши свою версию по этой структуре.`,
  ].join('\n');
}
