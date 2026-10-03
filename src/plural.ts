/**
 * The Russian form of a word for a count: 1 публикация, 2 публикации,
 * 5 публикаций — and 11–14 always take the third form (11 публикаций).
 *
 * `forms` is [one, few, many]: the word after 1, after 2, after 5.
 */
export function plural(n: number, forms: [string, string, string]): string {
  const n10 = Math.abs(n) % 10;
  const n100 = Math.abs(n) % 100;
  if (n10 === 1 && n100 !== 11) return forms[0];
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return forms[1];
  return forms[2];
}

/** The count and its word together: «3 публикации». */
export function count(n: number, forms: [string, string, string]): string {
  return `${n} ${plural(n, forms)}`;
}
