import type { TranscriptWord } from './smartCut';

// Module 3 — what a reel does, read from what is said in it.
//
// The analysis works from the speech alone: the transcript with a time on
// every word. That is where a reel's hook and structure almost always live,
// and it is the one thing we can read honestly. Text drawn on screen would
// need a vision model over the frames — a separate cost per reel — so the
// first version does not pretend to have it.
//
// The model is injected as a plain function, the same way the video pipeline
// takes its transcriber: the rules that matter here — how the transcript is
// laid out for the model, and what counts as an acceptable answer — are pure
// and testable without a network.
//
// Unlike carouselGeneration.ts there is deliberately NO mock fallback. The
// whole reason this module was rewritten is that the old one handed clients a
// made-up analysis of a video it never opened. An analysis that fails says
// so; it does not quietly become a fake one.

export interface ReelBeat {
  /** Short name of the part — «Хук», «Проблема», «Решение», «Призыв». */
  label: string;
  /** When it starts, in seconds of the original reel. */
  timestampSeconds: number;
  /** What happens in this part, in a sentence. */
  summary: string;
}

export interface ReelAnalysisResult {
  hook: string;
  structure: ReelBeat[];
  /** Why this works — the mechanic someone can reuse. */
  why: string;
}

/** Sends a system and a user message, returns the model's text. */
export type ChatModel = (system: string, user: string) => Promise<string>;

export class ReelAnalysisError extends Error {
  constructor(readonly reason: 'llm_not_configured' | 'llm_failed' | 'llm_invalid_answer', detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'ReelAnalysisError';
  }
}

// ---- Laying the transcript out for the model ------------------------------

const LINE_BREAK_PAUSE_SEC = 0.6;
const MAX_WORDS_PER_LINE = 14;

function stamp(sec: number): string {
  const whole = Math.max(0, sec);
  const m = Math.floor(whole / 60);
  const s = (whole - m * 60).toFixed(1).padStart(4, '0');
  return `${String(m).padStart(2, '0')}:${s}`;
}

/**
 * The transcript as timed lines: "[00:03.2] а теперь главное ...".
 *
 * A line breaks on a pause or after a handful of words. Giving the model a
 * time on every line is what lets it place the structure at real seconds of
 * the reel instead of inventing them — which is exactly what the old
 * analysis did.
 */
export function formatTimedTranscript(words: TranscriptWord[]): string {
  const lines: string[] = [];
  let current: TranscriptWord[] = [];

  const flush = () => {
    if (current.length === 0) return;
    lines.push(`[${stamp(current[0].start)}] ${current.map((w) => w.word.trim()).join(' ')}`);
    current = [];
  };

  for (const word of words) {
    const previous = current[current.length - 1];
    if (previous && (word.start - previous.end > LINE_BREAK_PAUSE_SEC || current.length >= MAX_WORDS_PER_LINE)) {
      flush();
    }
    current.push(word);
  }
  flush();
  return lines.join('\n');
}

// ---- Checking what comes back ---------------------------------------------

const MAX_BEATS = 8;
const MIN_BEATS = 2;

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, max) : null;
}

/**
 * Turns the model's JSON into an analysis, or throws if it is not one.
 *
 * Strict on shape, forgiving on detail: a timestamp past the end of the reel
 * is clamped rather than rejected, beats are put in order, but an answer with
 * no hook or fewer than two parts is refused — that is not an analysis of a
 * reel, and saving it would put something made-up in front of a client.
 */
export function parseReelAnalysis(content: string, durationSec: number): ReelAnalysisResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ReelAnalysisError('llm_invalid_answer', 'not JSON');
  }
  const body = parsed as { hook?: unknown; structure?: unknown; why?: unknown };

  const hook = cleanText(body.hook, 300);
  if (!hook) throw new ReelAnalysisError('llm_invalid_answer', 'no hook');

  if (!Array.isArray(body.structure)) throw new ReelAnalysisError('llm_invalid_answer', 'no structure');
  const limit = Math.max(0, durationSec);
  const structure: ReelBeat[] = body.structure
    .map((raw: unknown) => {
      const beat = raw as { label?: unknown; timestampSeconds?: unknown; summary?: unknown };
      const label = cleanText(beat.label, 40);
      const at = typeof beat.timestampSeconds === 'number' && Number.isFinite(beat.timestampSeconds) ? beat.timestampSeconds : null;
      if (!label || at === null) return null;
      return {
        label,
        timestampSeconds: Math.round(Math.min(Math.max(at, 0), limit) * 10) / 10,
        summary: cleanText(beat.summary, 300) ?? '',
      };
    })
    .filter((beat): beat is ReelBeat => beat !== null)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds)
    .slice(0, MAX_BEATS);

  if (structure.length < MIN_BEATS) throw new ReelAnalysisError('llm_invalid_answer', 'fewer than two parts');

  return { hook, structure, why: cleanText(body.why, 800) ?? '' };
}

/**
 * A script's line breaks, as line breaks. Models asked for JSON sometimes
 * escape a newline twice, and the text arrives with a literal "\\n\\n"
 * between its parts — which is what the person would then copy into their
 * notes. Only undone when the text has no real line break at all, so a
 * script that genuinely mentions "\\n" keeps it.
 */
export function unescapeLineBreaks(text: string): string {
  return text.includes('\n') || !text.includes('\\n') ? text : text.replace(/(\\r)?\\n/g, '\n');
}

export function parseScript(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ReelAnalysisError('llm_invalid_answer', 'not JSON');
  }
  const script = (parsed as { script?: unknown }).script;
  if (typeof script !== 'string' || !script.trim()) throw new ReelAnalysisError('llm_invalid_answer', 'no script');
  return unescapeLineBreaks(script.trim()).slice(0, 4000);
}

// ---- The two questions ----------------------------------------------------

const ANALYSIS_SYSTEM =
  'Ты разбираешь короткие вертикальные видео (Reels, TikTok, Shorts) для блогеров. ' +
  'Тебе дают расшифровку речи с таймкодами. Найди повторяемую механику ролика. ' +
  'Опирайся ТОЛЬКО на расшифровку: не придумывай того, чего в ней нет. ' +
  'Ответь строго JSON без markdown: ' +
  '{"hook": string, "structure": [{"label": string, "timestampSeconds": number, "summary": string}], "why": string}. ' +
  'hook — чем ролик цепляет в первые секунды, своими словами, одним предложением. ' +
  'structure — 2–6 частей ролика по порядку; label — короткое название части (Хук, Проблема, История, Решение, Призыв и т.п.), ' +
  'timestampSeconds — секунда начала части, взятая из таймкодов расшифровки, summary — что происходит в части, одним предложением. ' +
  'why — 2–3 предложения, почему это работает и что можно повторить. Пиши по-русски.';

const SCRIPT_SYSTEM =
  'Ты пишешь сценарии коротких вертикальных видео для блогеров. ' +
  'Тебе дают разбор чужого ролика и нишу. Перенеси механику ролика в эту нишу: та же структура и тот же приём, ' +
  'но своё содержание — не пересказывай исходный ролик. ' +
  'Пиши так, чтобы это можно было сразу произнести на камеру: по частям, с названием каждой части. ' +
  'Ответь строго JSON без markdown: {"script": string}. Пиши по-русски.';

export async function analyzeReelTranscript(
  words: TranscriptWord[],
  durationSec: number,
  chat: ChatModel
): Promise<ReelAnalysisResult> {
  const user = `Длительность ролика: ${durationSec.toFixed(1)} с.\nРасшифровка:\n${formatTimedTranscript(words)}`;
  return parseReelAnalysis(await chat(ANALYSIS_SYSTEM, user), durationSec);
}

export async function adaptReelScript(
  analysis: { hook: string; structure: ReelBeat[]; why: string },
  niche: string,
  chat: ChatModel
): Promise<string> {
  const beats = analysis.structure.map((b) => `- ${b.label} (${b.timestampSeconds} с): ${b.summary}`).join('\n');
  const user =
    `Ниша: ${niche}\n\nХук исходного ролика: ${analysis.hook}\n\nСтруктура:\n${beats}\n\n` +
    `Почему работает: ${analysis.why}`;
  return parseScript(await chat(SCRIPT_SYSTEM, user));
}

// ---- The real model -------------------------------------------------------

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o-mini';
// Longer than the carousel's 20s: the prompt carries a whole transcript.
const OPENAI_TIMEOUT_MS = 45_000;

/**
 * The OpenAI chat model, or a model that refuses when no key is configured.
 *
 * Refusing rather than returning null keeps the caller's code path single,
 * and the refusal carries a reason the screen can explain. It never falls
 * back to anything canned — see the note at the top of this file.
 */
export function openAiChatFromEnv(
  apiKey: string | undefined = process.env.OPENAI_API_KEY,
  fetchImpl: typeof fetch = fetch
): ChatModel {
  return async (system, user) => {
    if (!apiKey) throw new ReelAnalysisError('llm_not_configured');
    let response: Response;
    try {
      response = await fetchImpl(OPENAI_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          temperature: 0.4,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
    } catch (err) {
      throw new ReelAnalysisError('llm_failed', err instanceof Error ? err.message : String(err));
    }
    if (!response.ok) throw new ReelAnalysisError('llm_failed', `${response.status} ${await response.text()}`);
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new ReelAnalysisError('llm_failed', 'no message content');
    return content;
  };
}
