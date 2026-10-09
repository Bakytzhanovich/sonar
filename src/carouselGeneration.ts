import { ReelAnalysisError, type ChatModel } from './reelLlm';
import { WRITING_RULES } from './writingStyle';

// Module 4 — a carousel's text from one prompt.
//
// There is deliberately NO fallback to template slides. There used to be:
// with no key, or when the model failed or answered nonsense, the person got
// "Пункт 1 / Пункт 2 / [мок] текст слайда" and was told the carousel had been
// generated. That is the same failure Module 3 was rewritten to remove — a
// made-up result presented as the real one. Now a failure says so, and the
// person can simply press the button again.
//
// The model is the same injected ChatModel the reel and content-plan
// modules use, so tests never reach the network and every LLM feature
// fails the same, explainable way.

export interface SlideContentFields {
  headline: string;
  body: string;
}

const MIN_SLIDES = 4;
const MAX_SLIDES = 8;
const MAX_HEADLINE = 80;
const MAX_BODY = 400;

const SYSTEM_PROMPT =
  'Ты помогаешь блогерам делать карусели для Instagram и TikTok. По теме от пользователя сделай 4–6 слайдов. ' +
  'Первый слайд — цепляющий заголовок темы, последний — призыв (сохранить, написать в директ). ' +
  'Ответь строго JSON без markdown: {"slides": [{"headline": string, "body": string}]}. ' +
  'headline — короткий заголовок слайда (до 60 символов), body — 1–3 предложения. Пиши по-русски.' +
  ' ' +
  WRITING_RULES;

function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/[ \t]+/g, ' ');
  return text ? text.slice(0, max) : null;
}

/**
 * The model's answer as slides, or a refusal. Forgiving on detail — an
 * overlong headline is cut, extra slides are dropped — strict on shape: a
 * slide without a headline is not a slide, and fewer than four is not a
 * carousel.
 */
export function parseSlides(content: string): SlideContentFields[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ReelAnalysisError('llm_invalid_answer', 'not JSON');
  }
  const raw = (parsed as { slides?: unknown }).slides;
  if (!Array.isArray(raw)) throw new ReelAnalysisError('llm_invalid_answer', 'no slides');
  const slides = raw
    .map((s: unknown) => {
      const slide = s as { headline?: unknown; body?: unknown };
      const headline = clean(slide.headline, MAX_HEADLINE);
      return headline ? { headline, body: clean(slide.body, MAX_BODY) ?? '' } : null;
    })
    .filter((s): s is SlideContentFields => s !== null)
    .slice(0, MAX_SLIDES);
  if (slides.length < MIN_SLIDES) throw new ReelAnalysisError('llm_invalid_answer', `only ${slides.length} slides`);
  return slides;
}

export async function generateCarouselSlides(prompt: string, chat: ChatModel): Promise<SlideContentFields[]> {
  return parseSlides(await chat(SYSTEM_PROMPT, prompt));
}
