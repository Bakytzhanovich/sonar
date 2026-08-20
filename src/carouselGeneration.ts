import { createHash } from 'node:crypto';

// Stands in for a real LLM call (per ТЗ: "LLM для текста"). Deterministic
// from the prompt, same reasoning as analyzeReelMock — only this function
// changes when a real LLM call replaces it.

export interface SlideContentFields {
  headline: string;
  body: string;
}

const SLIDE_COUNT_MIN = 4;
const SLIDE_COUNT_RANGE = 3; // 4..6 slides

const HEADLINE_TEMPLATES = [
  (n: number, prompt: string) => (n === 0 ? prompt : `Пункт ${n}`),
  (n: number, prompt: string) => (n === 0 ? `Всё про: ${prompt}` : `Шаг ${n}`),
];

export function generateCarouselMock(prompt: string): SlideContentFields[] {
  const hash = createHash('sha256').update(prompt).digest();
  const slideCount = SLIDE_COUNT_MIN + (hash[0] % SLIDE_COUNT_RANGE);
  const templateIndex = hash[1] % HEADLINE_TEMPLATES.length;
  const template = HEADLINE_TEMPLATES[templateIndex];

  const slides: SlideContentFields[] = [];
  for (let i = 0; i < slideCount; i++) {
    slides.push({
      headline: template(i, prompt),
      body: i === slideCount - 1 ? '[мок] Сохрани и поделись, если было полезно' : `[мок] текст слайда ${i + 1} по теме "${prompt}"`,
    });
  }
  return slides;
}
