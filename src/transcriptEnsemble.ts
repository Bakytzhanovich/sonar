// Recovering a usable transcript for languages no single engine transcribes
// well — Kazakh above all, this product's home market.
//
// The trick is that the engines fail DIFFERENTLY on the same audio:
//
//   whisper-1         ол мұшақ жүргерек, өйбай енерге көтергерек
//   gpt-4o-transcribe ол мұқсат түргірік, қойбай, энергия көтергірік
//   gpt-transcribe    болмуша, жүргөрөк койбай, энергия көтөргөрөк
//
// None is right, but the true words leave a shadow across all three. A text
// model that actually knows Kazakh — which the speech models do not — can
// read the disagreement and reconstruct the sentence:
//
//   → жүру керек, қойбай, энергия көтеру керек, ақша осылай келеді деп
//
// Measured on a real client clip, with no hints given.
//
// LIMIT, and it is a real one: this recovers only what at least one engine
// half-heard. In that same clip the speaker says "10 000 қадам" and every
// engine missed the number entirely, so no amount of reasoning brings it
// back. It also means the model is writing plausible text rather than
// transcribing — see the guard in buildReconstructionPrompt.

import { usageFromResponse, type UsageEntry } from './usage';

const CHAT_URL = 'https://api.openai.com/v1/chat/completions';

// An audio-input chat model, not a transcription endpoint. Measured on a real
// Kazakh clip it is the only OpenAI model that both reads the language and
// preserves code-switching — "Осы успешный адамдар айтады ғой" keeps the
// Russian adjective next to the Kazakh noun, which is how people here speak
// and which every transcription endpoint flattened into nonsense.
//
// It returns no timings, so it can never replace whisper-1 — only supply the
// words that whisper's timings get attached to.
const AUDIO_MODEL = process.env.TRANSCRIPT_AUDIO_MODEL ?? 'gpt-audio';

// The model is not deterministic on this task: across three runs of the same
// clip one said "3-5 адамдар" and two said "успешный/успешные адамдар". That
// is not a defect to work around but the input the reconstruction below needs
// — the disagreement is what identifies the uncertain spots.
const AUDIO_PASSES = Number(process.env.TRANSCRIPT_AUDIO_PASSES ?? 3);

const AUDIO_PROMPT =
  'Это казахская разговорная речь с русскими вставками (code-switching). ' +
  'Запиши ТОЧНО что сказано, сохраняя русские слова по-русски, казахские по-казахски. ' +
  'Только текст, без пояснений.';

export async function transcribeWithAudioModel(
  audioBase64: string,
  format: 'mp3' | 'wav',
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ text: string; usage: UsageEntry }> {
  const response = await fetchImpl(CHAT_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({
      model: AUDIO_MODEL,
      modalities: ['text'],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: AUDIO_PROMPT },
            { type: 'input_audio', input_audio: { data: audioBase64, format } },
          ],
        },
      ],
    }),
  });

  if (!response.ok) throw new Error(`audio model ${response.status}: ${(await response.text()).slice(0, 200)}`);

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string; audio?: { transcript?: string } } }>;
  };
  const message = payload.choices?.[0]?.message;
  return {
    text: (message?.content ?? message?.audio?.transcript ?? '').trim(),
    usage: usageFromResponse(AUDIO_MODEL, payload),
  };
}

export { AUDIO_PASSES };

// Reconstruction is a language-reasoning task, not a cheap classification —
// the mini models produce noticeably flatter Kazakh.
const RECONSTRUCTION_MODEL = process.env.TRANSCRIPT_REPAIR_MODEL ?? 'gpt-4.1';

const REQUEST_TIMEOUT_MS = 60_000;

export interface TranscriptVariant {
  engine: string;
  text: string;
}

export function buildReconstructionPrompt(variants: TranscriptVariant[]): string {
  return [
    'Ниже несколько расшифровок ОДНОЙ И ТОЙ ЖЕ аудиозаписи, сделанных разными',
    'системами распознавания речи. Все содержат ошибки, но ошибаются по-разному.',
    'Речь казахская, разговорная, с русскими вставками ВНУТРИ фразы',
    '(code-switching): русское прилагательное рядом с казахским существительным',
    '— обычное дело («успешный адамдар», «просто айтқанда»). Системы',
    'распознавания калечат такие места сильнее всего.',
    '',
    ...variants.map((v) => `[${v.engine}]\n${v.text}\n`),
    'Восстанови наиболее вероятный исходный текст. Где варианты расходятся —',
    'выбирай тот, который даёт осмысленную фразу; сильное расхождение обычно',
    'означает русскую вставку, которую часть систем не распознала.',
    '',
    // Without this the model happily invents a fluent sentence around the
    // fragments. These captions are burned into a client's video, so a
    // confident fabrication is worse than a rough transcript.
    'ВАЖНО: не придумывай содержание. Опирайся только на то, что есть хотя бы',
    'в одной расшифровке, и на фонетическое сходство между ними. Если слово',
    'нельзя восстановить уверенно — оставь наиболее близкий вариант, а не',
    'подходящее по смыслу слово. Не добавляй фразы, которых нет ни в одном',
    'варианте. Русские вставки оставляй на русском.',
    '',
    'Верни ТОЛЬКО восстановленный текст, без пояснений.',
  ].join('\n');
}

// A reconstruction that drifts too far from what was actually heard is a
// fabrication, not a repair. Word count is a crude but effective proxy: the
// failure mode is the model writing a longer, more eloquent speech than the
// one recorded.
export function isPlausibleReconstruction(variants: TranscriptVariant[], reconstructed: string): boolean {
  const counts = variants.map((v) => v.text.split(/\s+/).filter(Boolean).length).filter((n) => n > 0);
  if (counts.length === 0) return false;

  const longest = Math.max(...counts);
  const got = reconstructed.split(/\s+/).filter(Boolean).length;
  if (got === 0) return false;

  // Shrinking is expected — engines emit filler fragments the repair drops.
  // Growing by more than half means invention.
  return got <= longest * 1.5;
}

export async function reconstructTranscript(
  variants: TranscriptVariant[],
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ text: string | null; usage: UsageEntry | null }> {
  const usable = variants.filter((v) => v.text.trim().length > 0);
  // With one transcript there is no disagreement to reason about, and asking
  // a model to "fix" a lone transcript is pure invention. Nothing is called,
  // so nothing is billed.
  if (usable.length < 2) return { text: null, usage: null };

  const response = await fetchImpl(CHAT_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      model: RECONSTRUCTION_MODEL,
      // Deterministic: the same audio should not caption differently on a retry.
      temperature: 0,
      messages: [{ role: 'user', content: buildReconstructionPrompt(usable) }],
    }),
  });

  if (!response.ok) throw new Error(`transcript repair ${response.status}: ${(await response.text()).slice(0, 200)}`);

  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const usage = usageFromResponse(RECONSTRUCTION_MODEL, payload);
  const text = payload.choices?.[0]?.message?.content?.trim() ?? '';
  // The call was made and billed whether or not its answer was usable, so the
  // usage comes back even when the text does not.
  if (!text) return { text: null, usage };

  return { text: isPlausibleReconstruction(usable, text) ? text : null, usage };
}
