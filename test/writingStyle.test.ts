import { describe, it, expect } from 'vitest';
import { WRITING_RULES } from '../src/writingStyle';
import { generateCarouselSlides } from '../src/carouselGeneration';
import { analyzeReelTranscript, adaptReelScript, type ChatModel } from '../src/reelLlm';
import { scriptFor } from '../src/contentTopics';

// Every prompt that writes words a blogger will post or say on camera carries
// the same style rules. Checked here rather than trusted, because the failure
// is silent: a prompt that lost them still answers, just in the model's own
// recognisable voice.
describe('writing style rules reach every generator', () => {
  async function systemPromptOf(run: (chat: ChatModel) => Promise<unknown>): Promise<string> {
    let seen = '';
    await run(async (system) => {
      seen = system;
      throw new Error('stop');
    }).catch(() => undefined);
    return seen;
  }

  it.each([
    ['carousel slides', (chat: ChatModel) => generateCarouselSlides('5 ошибок новичков в йоге', chat)],
    ['reel breakdown', (chat: ChatModel) => analyzeReelTranscript([{ word: 'привет', start: 0, end: 0.5 }], 10, chat)],
    ['reel script for a niche', (chat: ChatModel) => adaptReelScript({ hook: 'вопрос', structure: [], why: 'интрига' }, 'фитнес', chat)],
    ['content-plan script', (chat: ChatModel) => scriptFor({ title: 'Йога при боли в спине', segment: 'Йога' }, chat)],
  ])('%s', async (_name, run) => {
    expect(await systemPromptOf(run)).toContain(WRITING_RULES);
  });
});
