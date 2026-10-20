// The end card: the last two seconds of the video as a call to action — a
// pink frame, a white rounded card like a messenger post with the text in
// condensed capitals and the brand in burgundy, and a black pill under it
// with the call to action.
//
// Drawn as ASS vector shapes (\p1), so it needs nothing but the subtitles
// filter the render already runs, and it is burned last, over everything.

import type { FrameSize } from './aspect';
import { escapeAssText, formatAssTime } from './subtitles';
import { sanitizeHeadline } from './headline';

export const END_CARD_SECONDS = 2;
export const END_CARD_TEXT_MAX = 60;
export const END_CARD_BRAND_MAX = 24;
export const END_CARD_CTA_MAX = 30;

export interface EndCardContent {
  text: string | null;
  brand: string | null;
  cta: string | null;
}

/** Cleaned and capped like a headline; all three empty means no card. */
export function cleanEndCard(raw: { text?: unknown; brand?: unknown; cta?: unknown }): EndCardContent {
  const clean = (v: unknown, max: number) => (typeof v === 'string' ? sanitizeHeadline(v).slice(0, max) || null : null);
  return { text: clean(raw.text, END_CARD_TEXT_MAX), brand: clean(raw.brand, END_CARD_BRAND_MAX), cta: clean(raw.cta, END_CARD_CTA_MAX) };
}

export function hasEndCard(c: EndCardContent): boolean {
  return Boolean(c.text || c.brand || c.cta);
}

const PINK = '&H00CCC4F4'; // #F4C4CC
const WHITE = '&H00FFFFFF';
const BLACK = '&H00000000';
const BURGUNDY = '&H001C148C'; // #8C141C

/**
 * Greedy wrap at maxChars, every word kept. Not wrapHeadline: that one stops
 * at three lines, which here dropped the last words of a longer card text
 * without a sign. The text's own cap (END_CARD_TEXT_MAX) bounds the lines.
 */
function wrapWords(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const last = lines[lines.length - 1];
    if (last !== undefined && `${last} ${word}`.length <= maxChars) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines;
}

/** A rounded rectangle as an ASS drawing path, corners as quarter Béziers. */
function roundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const R = Math.min(r, w / 2, h / 2);
  const [x2, y2] = [x + w, y + h];
  const n = (v: number) => Math.round(v);
  return [
    `m ${n(x + R)} ${n(y)}`,
    `l ${n(x2 - R)} ${n(y)}`,
    `b ${n(x2)} ${n(y)} ${n(x2)} ${n(y)} ${n(x2)} ${n(y + R)}`,
    `l ${n(x2)} ${n(y2 - R)}`,
    `b ${n(x2)} ${n(y2)} ${n(x2)} ${n(y2)} ${n(x2 - R)} ${n(y2)}`,
    `l ${n(x + R)} ${n(y2)}`,
    `b ${n(x)} ${n(y2)} ${n(x)} ${n(y2)} ${n(x)} ${n(y2 - R)}`,
    `l ${n(x)} ${n(y + R)}`,
    `b ${n(x)} ${n(y)} ${n(x)} ${n(y)} ${n(x + R)} ${n(y)}`,
  ].join(' ');
}

/**
 * The card's events, for a video `durationSec` long. Layers 10–12, so they
 * cover anything else in the same file (the headline).
 */
export function buildEndCardEvents(frame: FrameSize, durationSec: number, content: EndCardContent): string[] {
  if (!hasEndCard(content)) return [];
  const W = frame.width;
  const H = frame.height;
  const unit = Math.min(W, H) / 1080;
  const start = formatAssTime(Math.max(0, durationSec - END_CARD_SECONDS));
  // Past the end on purpose: the last frame must still have the card on it.
  const end = formatAssTime(durationSec + 1);
  const line = (layer: number, tags: string, body: string) => `Dialogue: ${layer},${start},${end},Headline,,0,0,0,,{${tags}}${body}`;

  const textSize = Math.round(84 * unit);
  const ctaSize = Math.round(30 * unit);
  const pad = Math.round(56 * unit);
  const lines = content.text ? wrapWords(content.text.toLocaleUpperCase('ru'), 16) : [];
  const textLines = [...lines.map((l) => ({ text: l, colour: BLACK })), ...(content.brand ? [{ text: content.brand.toLocaleUpperCase('ru'), colour: BURGUNDY }] : [])];
  const lineHeight = Math.round(textSize * 1.08);
  const pillH = content.cta ? Math.round(ctaSize * 2.4) : 0;
  const gap = textLines.length && content.cta ? Math.round(36 * unit) : 0;
  const cardW = Math.round(W * 0.82);
  const cardH = pad * 2 + textLines.length * lineHeight + gap + pillH;
  const cardX = Math.round((W - cardW) / 2);
  const cardY = Math.round((H - cardH) / 2);

  const events = [
    line(10, `\\an7\\pos(0,0)\\p1\\bord0\\shad0\\c${PINK}`, `m 0 0 l ${W} 0 ${W} ${H} 0 ${H}`),
    line(11, `\\an7\\pos(0,0)\\p1\\bord0\\shad0\\c${WHITE}`, roundedRect(cardX, cardY, cardW, cardH, 40 * unit)),
  ];
  textLines.forEach((l, i) => {
    const y = cardY + pad + i * lineHeight + Math.round(lineHeight / 2);
    events.push(line(12, `\\an5\\pos(${Math.round(W / 2)},${y})\\fnOswald\\b1\\fs${textSize}\\c${l.colour}\\bord0\\shad0`, escapeAssText(l.text)));
  });
  if (content.cta) {
    const cta = content.cta.toLocaleUpperCase('ru');
    // Width by character count: the pill only has to be roomy, not exact.
    const pillW = Math.min(cardW - pad * 2, Math.round(cta.length * ctaSize * 0.72 + ctaSize * 2.4));
    const pillX = Math.round((W - pillW) / 2);
    const pillY = cardY + pad + textLines.length * lineHeight + gap;
    events.push(line(12, `\\an7\\pos(0,0)\\p1\\bord0\\shad0\\c${BLACK}`, roundedRect(pillX, pillY, pillW, pillH, pillH / 2)));
    events.push(line(13, `\\an5\\pos(${Math.round(W / 2)},${pillY + Math.round(pillH / 2)})\\fnMontserrat\\b1\\fs${ctaSize}\\fsp${Math.round(ctaSize * 0.12)}\\c${WHITE}\\bord0\\shad0`, escapeAssText(cta)));
  }
  return events;
}

/** A file of its own for the card, when there is no headline to share one with. */
export function endCardAss(frame: FrameSize, events: string[]): string {
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${frame.width}`,
    `PlayResY: ${frame.height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Headline,Oswald,60,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}
