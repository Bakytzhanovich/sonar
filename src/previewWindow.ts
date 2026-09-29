import type { KeepSegment, TranscriptWord } from './smartCut';

// Which few seconds of a video to render as a preview of the caption style.
//
// The choice is not "the first four seconds". A preview exists to show what
// the captions look like, so a window with no speech in it proves nothing —
// it renders, it comes back, and it is four seconds of someone silently
// looking at the camera. Worse than useless: it looks like the captions are
// broken.
//
// Nor is it four seconds of one segment. An edited video is made of many
// short pieces — a real recording cut by Smart Cut came out as five segments
// of between 0.8 and 2.1 seconds — and taking the preview from whichever one
// happens to hold speech first gave a 0.76-second flash. The preview is of
// the CUT, where those pieces play back to back, so it spans as many of them
// as four seconds needs. That it then contains a join is a feature: joins are
// what the edit does, and seeing one is part of seeing the result.
//
// Pure, and therefore testable without a video or a worker, like emphasis.ts
// and smartCut.ts.

/** Below this a preview is a flash rather than something anyone can read. */
const MIN_USEFUL_SEC = 1.2;

export function pickPreviewWindow(
  segments: KeepSegment[],
  words: TranscriptWord[],
  targetSec = 4
): KeepSegment[] | null {
  // Start where the speaking starts. Everything before it is the padding
  // Smart Cut left around the speech, and spending a quarter of a preview on
  // it is a quarter of the preview showing nothing.
  const firstSpokenAt = segments.reduce<number | null>((found, segment) => {
    if (found !== null) return found;
    const inside = words.filter((w) => w.start >= segment.start && w.start < segment.end);
    return inside.length > 0 ? Math.max(segment.start, inside[0].start - 0.15) : null;
  }, null);

  // Speech-free footage: a music clip, or a cut that kept only silence. The
  // caller renders nothing rather than a preview that would misrepresent it.
  if (firstSpokenAt === null) return null;

  const window: KeepSegment[] = [];
  let taken = 0;

  for (const segment of segments) {
    if (segment.end <= firstSpokenAt) continue;
    const start = Math.max(segment.start, firstSpokenAt);
    const remaining = targetSec - taken;
    if (remaining <= 0) break;

    const end = Math.min(segment.end, start + remaining);
    if (end - start <= 0.01) continue;
    window.push({ start, end });
    taken += end - start;
  }

  if (window.length === 0) return null;
  // A cut with barely any speech left in it has nothing worth previewing —
  // and a render of under a second reads as a glitch, not as an answer.
  if (taken < MIN_USEFUL_SEC) return null;
  return window;
}
