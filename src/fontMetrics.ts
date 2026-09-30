import fs from 'node:fs';
import path from 'node:path';

// Same default and same override as ffmpeg.ts's, deliberately not imported
// from it: this module must stay loadable without pulling in the process
// spawning that makes ffmpeg.ts what it is.
const FONTS_DIR = process.env.FONTS_DIR ?? path.resolve(__dirname, '..', 'assets', 'fonts');

// How wide a line of text will actually be, read from the font itself.
//
// Captions are currently broken into lines by counting characters — 25 of
// them, see DEFAULT_CHUNK_OPTIONS. That holds only while every line is one
// size in one family. The poster style sets one word two or three times
// larger than its neighbours, and the moment sizes and families mix, a
// character count stops predicting width.
//
// The failure mode is the reason this exists rather than a fudge factor:
// libass does not complain when a line runs past the frame. It draws it, the
// render succeeds, and the words are simply gone off the edge of a video
// somebody is about to publish. Same shape of bug as the missing font — no
// error anywhere, just a wrong result.
//
// Parsed here rather than with a font library, for the same reason storage.ts
// signs its own S3 requests: what is needed is three tables and about a
// hundred lines, against a dependency that parses outlines, hinting and
// layout features this never looks at.
//
// Kerning (GPOS/kern) is deliberately ignored. It almost always pulls letters
// closer, so ignoring it overestimates — and an overestimate breaks a line
// one word early, while an underestimate runs it off the screen. Only one of
// those is recoverable.

export interface FontMetrics {
  /** Font design units per em — every advance below is in these. */
  unitsPerEm: number;
  /**
   * How big the em comes out when libass is asked for a given size: an ASS
   * "Fontsize" of 100 draws an em of 100 × this, not 100.
   *
   * libass sizes a face the way GDI does — the whole of winAscent+winDescent
   * from the OS/2 table is fitted into the requested size — whereas a browser,
   * and measureText below, treat the size as the em itself. For the families
   * we ship that puts the em at 0.59 to 0.71 of the size, so anything that
   * measured or drew at the raw size was 40-70% too large. Found by laying a
   * browser preview beside a real render: the geometry matched to the pixel
   * and the headline came out nearly twice the size.
   */
  assEmRatio: number;
  /** Advance width of a code point, in font units. */
  advanceOf(codePoint: number): number;
}

interface TableRecord {
  offset: number;
  length: number;
}

function readTableDirectory(buf: Buffer): Map<string, TableRecord> {
  const tables = new Map<string, TableRecord>();
  const numTables = buf.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16;
    const tag = buf.toString('ascii', record, record + 4);
    tables.set(tag, { offset: buf.readUInt32BE(record + 8), length: buf.readUInt32BE(record + 12) });
  }
  return tables;
}

// Picks the best character map available. Format 12 covers everything;
// format 4 covers the Basic Multilingual Plane, which is all of Cyrillic,
// Latin and Kazakh — so a font with only format 4 is perfectly usable here
// and must not be rejected.
function selectCmapSubtable(buf: Buffer, cmapOffset: number): { offset: number; format: number } | null {
  const numTables = buf.readUInt16BE(cmapOffset + 2);
  let best: { offset: number; format: number } | null = null;
  for (let i = 0; i < numTables; i++) {
    const record = cmapOffset + 4 + i * 8;
    const subtable = cmapOffset + buf.readUInt32BE(record + 4);
    if (subtable + 2 > buf.length) continue;
    const format = buf.readUInt16BE(subtable);
    if (format !== 4 && format !== 12) continue;
    // Format 12 wins when both are present: it is a superset.
    if (!best || (format === 12 && best.format !== 12)) best = { offset: subtable, format };
  }
  return best;
}

function glyphIdFormat4(buf: Buffer, subtable: number, codePoint: number): number {
  if (codePoint > 0xffff) return 0;
  const segCountX2 = buf.readUInt16BE(subtable + 6);
  const endCodes = subtable + 14;
  // The +2 skips reservedPad, which sits between the end codes and the start
  // codes and is the single easiest thing to get wrong in this table.
  const startCodes = endCodes + segCountX2 + 2;
  const idDeltas = startCodes + segCountX2;
  const idRangeOffsets = idDeltas + segCountX2;

  for (let seg = 0; seg < segCountX2 / 2; seg++) {
    const end = buf.readUInt16BE(endCodes + seg * 2);
    if (codePoint > end) continue;
    const start = buf.readUInt16BE(startCodes + seg * 2);
    if (codePoint < start) return 0;

    const idRangeOffset = buf.readUInt16BE(idRangeOffsets + seg * 2);
    if (idRangeOffset === 0) {
      return (codePoint + buf.readInt16BE(idDeltas + seg * 2)) & 0xffff;
    }
    // The indirection this table is notorious for: the offset is counted in
    // bytes from the position of the offset entry itself, not from the start
    // of the table.
    const glyphAddress = idRangeOffsets + seg * 2 + idRangeOffset + (codePoint - start) * 2;
    if (glyphAddress + 2 > buf.length) return 0;
    const glyph = buf.readUInt16BE(glyphAddress);
    return glyph === 0 ? 0 : (glyph + buf.readInt16BE(idDeltas + seg * 2)) & 0xffff;
  }
  return 0;
}

function glyphIdFormat12(buf: Buffer, subtable: number, codePoint: number): number {
  const numGroups = buf.readUInt32BE(subtable + 12);
  for (let i = 0; i < numGroups; i++) {
    const group = subtable + 16 + i * 12;
    const start = buf.readUInt32BE(group);
    const end = buf.readUInt32BE(group + 4);
    if (codePoint < start) return 0;
    if (codePoint > end) continue;
    return buf.readUInt32BE(group + 8) + (codePoint - start);
  }
  return 0;
}

// Parsed fonts are cached by path: the files run to hundreds of kilobytes and
// a render measures thousands of words against the same two or three of them.
const cache = new Map<string, FontMetrics>();

export function loadFontMetrics(filePath: string): FontMetrics {
  const cached = cache.get(filePath);
  if (cached) return cached;

  const buf = fs.readFileSync(filePath);
  const tables = readTableDirectory(buf);
  const head = tables.get('head');
  const hhea = tables.get('hhea');
  const hmtx = tables.get('hmtx');
  const cmap = tables.get('cmap');
  if (!head || !hhea || !hmtx || !cmap) {
    throw new Error(`${filePath}: not a usable font — missing head/hhea/hmtx/cmap`);
  }

  const unitsPerEm = buf.readUInt16BE(head.offset + 18);

  // The OS/2 win metrics are what libass fits into the size (set_font_metrics
  // there mimics GDI). Without a usable OS/2 table libass keeps FreeType's
  // own ascender/descender, which come from hhea — so that is the fallback
  // here too, and only a font with neither is measured at the raw size.
  const os2 = tables.get('OS/2');
  const winHeight = os2 && os2.length >= 78 ? buf.readUInt16BE(os2.offset + 74) + buf.readUInt16BE(os2.offset + 76) : 0;
  const hheaHeight = buf.readInt16BE(hhea.offset + 4) - buf.readInt16BE(hhea.offset + 6);
  const lineHeight = winHeight > 0 ? winHeight : hheaHeight > 0 ? hheaHeight : unitsPerEm;
  const assEmRatio = unitsPerEm / lineHeight;
  const numberOfHMetrics = buf.readUInt16BE(hhea.offset + 34);
  const subtable = selectCmapSubtable(buf, cmap.offset);
  if (!subtable) throw new Error(`${filePath}: no character map this code can read (need format 4 or 12)`);

  const advanceForGlyph = (glyph: number): number => {
    // Monospaced-tail fonts store one advance for every glyph past the last
    // full metric, so anything beyond the table reuses the final entry.
    const index = Math.min(glyph, numberOfHMetrics - 1);
    const at = hmtx.offset + index * 4;
    if (at + 2 > buf.length) return 0;
    return buf.readUInt16BE(at);
  };

  const glyphCache = new Map<number, number>();
  const metrics: FontMetrics = {
    unitsPerEm,
    assEmRatio,
    advanceOf(codePoint: number): number {
      const hit = glyphCache.get(codePoint);
      if (hit !== undefined) return hit;
      const glyph =
        subtable.format === 12
          ? glyphIdFormat12(buf, subtable.offset, codePoint)
          : glyphIdFormat4(buf, subtable.offset, codePoint);
      // Glyph 0 is .notdef, whose advance is what libass will draw for a
      // character this font does not have — so measuring it is correct, not a
      // fallback.
      const advance = advanceForGlyph(glyph);
      glyphCache.set(codePoint, advance);
      return advance;
    },
  };

  cache.set(filePath, metrics);
  return metrics;
}

/**
 * Width of `text` in pixels when set at `fontSizePx`.
 *
 * Iterated by code point rather than by UTF-16 unit so a character outside
 * the BMP is measured once rather than as two halves of a surrogate pair,
 * each of which would resolve to .notdef.
 */
export function measureText(text: string, metrics: FontMetrics, fontSizePx: number): number {
  let units = 0;
  for (const char of text) {
    units += metrics.advanceOf(char.codePointAt(0)!);
  }
  return (units / metrics.unitsPerEm) * fontSizePx;
}

/**
 * Width of `text` when libass draws it at ASS size `assSize` — the number
 * written into a Style line or a \\fs override, which is not the em (see
 * assEmRatio). This is the one to use for anything that ends up in an .ass
 * file; measureText is for callers that mean the em.
 */
export function measureAssText(text: string, metrics: FontMetrics, assSize: number): number {
  return measureText(text, metrics, assSize * metrics.assEmRatio);
}

/**
 * The largest size at which `text` still fits `maxWidthPx`, capped at
 * `maxSizePx` and never below `minSizePx`.
 *
 * Computed rather than searched: width is linear in size, so one division
 * gives the answer exactly. Returning minSizePx when even that overflows is
 * deliberate — the caller wants a number it can render, and a caption
 * slightly too wide is recoverable where a thrown error mid-render is not.
 */
export function fitFontSize(
  text: string,
  metrics: FontMetrics,
  maxWidthPx: number,
  maxSizePx: number,
  minSizePx: number
): number {
  const widthAtOneP = measureText(text, metrics, 1);
  if (widthAtOneP <= 0) return maxSizePx;
  const fits = maxWidthPx / widthAtOneP;
  return Math.max(minSizePx, Math.min(maxSizePx, Math.floor(fits)));
}

/**
 * The file behind a family name.
 *
 * The convention is the one assets/fonts already follows and that
 * headlineStyles.test.ts enforces: the filename is the family with its spaces
 * removed, so "Playfair Display" lives in PlayfairDisplay.ttf. Keeping it a
 * rule rather than a second list means a font cannot be added to the
 * catalogue and forgotten here.
 */
export function fontFileFor(family: string): string {
  return path.join(FONTS_DIR, `${family.replace(/\s+/g, '')}.ttf`);
}

/**
 * The family name recorded inside the file — what libass matches a Style's
 * Fontname against, which is not the filename and not always what you expect.
 *
 * Exists because of a bug the "does the file exist" check could not see: the
 * committed Montserrat.ttf was the variable font's Thin default instance,
 * whose family name is "Montserrat Thin" and whose weight is 100. Every style
 * asks for "Montserrat" bold, libass found no match, and quietly rendered
 * captions and headlines in Helvetica — for as long as the feature has
 * existed. The file was there the whole time.
 */
export function familyNameOf(filePath: string): { family: string; weight: number } {
  const buf = fs.readFileSync(filePath);
  const tables = readTableDirectory(buf);
  const name = tables.get('name');
  const os2 = tables.get('OS/2');
  if (!name) throw new Error(`${filePath}: no name table`);

  const count = buf.readUInt16BE(name.offset + 2);
  const storage = name.offset + buf.readUInt16BE(name.offset + 4);
  let family = '';
  for (let i = 0; i < count; i++) {
    const record = name.offset + 6 + i * 12;
    const platform = buf.readUInt16BE(record);
    const nameId = buf.readUInt16BE(record + 6);
    // Platform 3 (Windows) name 1 (family) in UTF-16BE is the one every
    // renderer reads; ID 16 is the typographic family, which libass does not
    // match on, so it is deliberately not consulted here.
    if (platform !== 3 || nameId !== 1 || family) continue;
    const length = buf.readUInt16BE(record + 8);
    const offset = buf.readUInt16BE(record + 10);
    // UTF-16BE, which Node reads by swapping to LE first. Copied before the
    // swap: swap16 mutates in place, and this buffer is the whole font.
    family = Buffer.from(buf.subarray(storage + offset, storage + offset + length)).swap16().toString('utf16le');
  }
  return { family, weight: os2 ? buf.readUInt16BE(os2.offset + 4) : 400 };
}
