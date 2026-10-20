// The model's half of the "Тема" look (topicLayout.ts): one request per
// render, over the finished caption phrases, asking only what needs meaning
// — where a topic starts and what one word names it, where each phrase's
// lead-in ends, which few words carry feeling.
//
// Never throws. A model that is down, slow or answers nonsense returns null,
// and the render lays the captions out with the plain fallback instead: a
// caption look must not be a new way for a paid render to fail.

import type { ChatModel } from './reelLlm';
import type { SubtitleChunk } from './subtitles';
import { validateMarkup, type CaptionMarkup } from './topicLayout';

const SYSTEM = [
  'Ты монтажёр коротких вертикальных видео. Тебе дают фразы субтитров ролика по порядку, с номерами.',
  'Верни JSON с тремя полями:',
  '- "topics": массив {"from", "to", "keyword"} — подряд идущие фразы об одном и том же (номера from..to включительно, без пропусков и наложений, по порядку) и ОДНО слово, которое называет тему. Слово — существительное или яркое слово из этих фраз, не служебное. Обычно тема — 2–4 фразы.',
  '- "keyStart": массив чисел, по одному на каждую фразу — номер слова (с нуля), с которого начинается главная часть фразы, после вводных слов. Если вводной части нет — 0.',
  '- "accents": массив {"chunk", "word"} — номер фразы и номер слова в ней для эмоционального слова. Редко: не больше одного на 10 секунд, лучше меньше.',
  'Только JSON, без пояснений.',
].join('\n');

export async function markupCaptions(chat: ChatModel, chunks: SubtitleChunk[]): Promise<CaptionMarkup | null> {
  if (chunks.length === 0) return null;
  const user = chunks
    .map((c, i) => `${i} [${c.start.toFixed(1)}с]: ${c.words.map((w, j) => `${j}:${w.word}`).join(' ')}`)
    .join('\n');
  try {
    const answer = await chat(SYSTEM, user);
    return validateMarkup(JSON.parse(answer), chunks);
  } catch (err) {
    console.warn(`[caption-markup] falling back to the plain layout: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
    return null;
  }
}
