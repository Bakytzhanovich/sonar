import { createHash } from 'node:crypto';

// generateCarouselMock stands in for a real LLM call (per ТЗ: "LLM для
// текста"). Deterministic from the prompt, same reasoning as
// analyzeReelMock. generateCarouselSlides below is the real entry point —
// it calls OpenAI when a key is configured and falls back to the mock
// (missing key, network error, malformed response) so this feature never
// takes the carousel endpoint down and local dev/tests need no API key.

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

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o-mini';

const SYSTEM_PROMPT =
  'Ты помогаешь блогерам делать карусели для Instagram/TikTok. По теме от пользователя сгенерируй 4-6 слайдов. ' +
  'Ответь СТРОГО валидным JSON без markdown-обёртки: {"slides": [{"headline": string, "body": string}, ...]}. ' +
  'headline — короткий заголовок слайда (до 60 символов), body — 1-3 предложения текста. Пиши по-русски.';

function isSlideContentFields(value: unknown): value is SlideContentFields {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SlideContentFields).headline === 'string' &&
    typeof (value as SlideContentFields).body === 'string'
  );
}

async function generateCarouselWithOpenAI(prompt: string, apiKey: string, fetchImpl: typeof fetch): Promise<SlideContentFields[]> {
  const response = await fetchImpl(OPENAI_CHAT_COMPLETIONS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok) throw new Error(`OpenAI request failed: ${response.status} ${await response.text()}`);

  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('OpenAI response missing message content');

  const parsed = JSON.parse(content);
  const slides = parsed?.slides;
  if (!Array.isArray(slides) || slides.length < SLIDE_COUNT_MIN || !slides.every(isSlideContentFields)) {
    throw new Error('OpenAI response did not contain a valid slides array');
  }

  return slides;
}

// The real entry point api.ts calls. `fetchImpl` is a plain parameter
// (never read from globalThis inside the OpenAI call) so concurrent
// requests on this server can never race over a shared mutable fetch, and
// a test could inject a stub without a network mock library — no test does
// this today since the missing-key fallback below already keeps the whole
// suite offline.
export async function generateCarouselSlides(
  prompt: string,
  apiKey: string | undefined = process.env.OPENAI_API_KEY,
  fetchImpl: typeof fetch = fetch
): Promise<SlideContentFields[]> {
  if (!apiKey) return generateCarouselMock(prompt);

  try {
    return await generateCarouselWithOpenAI(prompt, apiKey, fetchImpl);
  } catch (err) {
    console.warn('generateCarouselSlides: OpenAI call failed, falling back to mock:', err instanceof Error ? err.message : err);
    return generateCarouselMock(prompt);
  }
}
