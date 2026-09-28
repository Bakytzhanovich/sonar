import type { KeepSegment, TranscriptWord } from './smartCut';

// Which few seconds of a video to render as a preview of the caption style.
//
// The choice is not "the first four seconds". A preview exists to show what
// the captions look like, so a window with no speech in it proves nothing —
// it renders, it comes back, and it is four seconds of someone silently
// looking at the camera. Worse than useless: it looks like the captions are
// broken.
//
// So the window has to contain words, and it has to be inside the cut — the
// preview must show the video as it will actually be, not footage this edit
// throws away.
//
// Pure, and therefore testable without a video or a worker, like emphasis.ts
// and smartCut.ts.

/** Fewer than this and the window may catch a single word with silence
 *  around it, which shows the typeface but not the rhythm. */
const MIN_WORDS = 2;

export function pickPreviewWindow(
  segments: KeepSegment[],
  words: TranscriptWord[],
  targetSec = 4
): KeepSegment | null {
  if (segments.length === 0) return null;

  for (const segment of segments) {
    const inside = words.filter((w) => w.start >= segment.start && w.start < segment.end);
    if (inside.length === 0) continue;

    // Start at the first word rather than at the segment's edge: a kept
    // segment usually opens with the padding Smart Cut left around the
    // speech, and spending a second of a four-second preview on it is a
    // quarter of the preview showing nothing.
    const start = Math.max(segment.start, inside[0].start - 0.15);
    const end = Math.min(segment.end, start + targetSec);
    // A segment too short to hold the target is used whole rather than
    // skipped — a two-second preview of real speech beats hunting for a
    // longer one further into the video, which is also further from what the
    // person is looking at.
    if (end - start < 0.5) continue;

    const covered = inside.filter((w) => w.start < end).length;
    // Enough words in this window, or the segment simply has no more to give
    // — in which case this is still the best window that exists.
    if (covered >= MIN_WORDS || covered === inside.length) {
      return { start, end };
    }
  }

  // Speech-free footage: a music clip, or a cut that kept only silence. The
  // caller renders nothing rather than a preview that would misrepresent it.
  return null;
}
