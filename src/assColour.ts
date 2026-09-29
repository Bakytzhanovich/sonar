/**
 * #RRGGBB to the &HAABBGGRR that ASS wants — alpha first, then BLUE, GREEN,
 * RED, which is the reverse of what everyone expects.
 *
 * A function rather than hand-written constants precisely because the mistake
 * is silent: a colour written backwards is still a valid colour, the render
 * succeeds, and the text simply comes out blue when it was meant to be amber.
 * Written once, it can be tested once.
 *
 * Its own module so both the caption palette and the headline one can use it
 * without importing each other — subtitleAxes.ts already takes the typeface
 * list from headlineStyles.ts, and the reverse edge would close a cycle.
 */
export function rgbToAss(hex: string): string {
  const clean = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) throw new Error(`не цвет: ${hex}`);
  const rr = clean.slice(0, 2);
  const gg = clean.slice(2, 4);
  const bb = clean.slice(4, 6);
  return `&H00${bb}${gg}${rr}`.toUpperCase();
}

/**
 * The reverse: &HAABBGGRR back to #RRGGBB.
 *
 * Needed because the browser preview has to draw the same colours the
 * renderer will burn in, and the presets carry them in the renderer's form.
 * Deriving the hex rather than keeping a second list is the whole point —
 * two lists would let the preview and the render disagree about what
 * "Классика" looks like.
 */
export function assToRgb(ass: string): string {
  const m = /^&H[0-9a-fA-F]{2}([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(ass.trim());
  if (!m) throw new Error(`не ASS-цвет: ${ass}`);
  const [, bb, gg, rr] = m;
  return `#${rr}${gg}${bb}`.toUpperCase();
}
