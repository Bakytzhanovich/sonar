// What one render actually cost, in the units the bills are written in.
//
// Every chat-completions response carries a `usage` block, and the code was
// parsing `choices` and throwing the rest away — so the exact numbers were
// arriving on every call and being discarded. Asking "what does a video cost"
// then had no answer but arithmetic on a price list, which is a guess about
// our own system.
//
// Two units, not one, because the two APIs are billed differently. The
// transcription endpoint charges by length of audio and reports no tokens at
// all; the chat models charge by token, and for an audio model most of those
// tokens are the recording itself. Adding them together would produce a
// number that means nothing.

/** One paid call, as it will appear on the invoice. */
export interface UsageEntry {
  model: string;
  /** How many times this model was called with these characteristics. */
  calls: number;
  /** Absent for the transcription endpoint, which reports no tokens. */
  inputTokens?: number;
  outputTokens?: number;
  /**
   * The part of inputTokens that was audio rather than text. Broken out
   * because it is priced separately and is where a Kazakh render's cost
   * actually goes — three passes of a ten-minute recording.
   */
  audioTokens?: number;
  /** For endpoints billed by length rather than by token. */
  audioSeconds?: number;
}

export interface JobUsage {
  entries: UsageEntry[];
}

/** The shape OpenAI returns. Every field optional: it is someone else's. */
interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { audio_tokens?: number; text_tokens?: number };
}

/**
 * Reads the usage block out of a response body.
 *
 * Returns an entry with zeroes rather than nothing when the block is absent:
 * a call that happened is a call that was billed, and recording it as "0
 * tokens" keeps the call count honest while making it obvious that the
 * numbers did not arrive.
 */
export function usageFromResponse(model: string, body: unknown): UsageEntry {
  const usage = (body as { usage?: OpenAIUsage } | null)?.usage;
  return {
    model,
    calls: 1,
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    audioTokens: usage?.prompt_tokens_details?.audio_tokens ?? 0,
  };
}

/** A call billed by audio length, which reports no tokens. */
export function usageFromSeconds(model: string, audioSeconds: number): UsageEntry {
  return { model, calls: 1, audioSeconds: Math.round(audioSeconds * 100) / 100 };
}

/**
 * Collapses many calls into one line per model.
 *
 * Three passes of the same audio model are one row saying "3 calls", not
 * three rows: the question this answers is what a video costs, and a list of
 * identical entries makes that harder to read, not more precise.
 */
export function summarizeUsage(entries: UsageEntry[]): JobUsage {
  const byModel = new Map<string, UsageEntry>();
  for (const entry of entries) {
    const existing = byModel.get(entry.model);
    if (!existing) {
      byModel.set(entry.model, { ...entry });
      continue;
    }
    existing.calls += entry.calls;
    if (entry.inputTokens !== undefined) existing.inputTokens = (existing.inputTokens ?? 0) + entry.inputTokens;
    if (entry.outputTokens !== undefined) existing.outputTokens = (existing.outputTokens ?? 0) + entry.outputTokens;
    if (entry.audioTokens !== undefined) existing.audioTokens = (existing.audioTokens ?? 0) + entry.audioTokens;
    if (entry.audioSeconds !== undefined) {
      existing.audioSeconds = Math.round(((existing.audioSeconds ?? 0) + entry.audioSeconds) * 100) / 100;
    }
  }
  // Most expensive-looking first, so the line that explains the bill is the
  // one read first.
  return {
    entries: [...byModel.values()].sort((a, b) => (b.audioTokens ?? b.inputTokens ?? 0) - (a.audioTokens ?? a.inputTokens ?? 0)),
  };
}
