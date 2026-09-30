import { HEADLINE_FONTS } from './headlineStyles';
import { familyNameOf, fontFileFor } from './fontMetrics';

/**
 * Fails loudly if a typeface the catalogue offers is missing, misnamed, or too
 * light for the bold every style asks for.
 *
 * Run by the Docker build rather than only by the tests, because this is the
 * image that renders, and a test suite can be skipped where a build cannot.
 *
 * The misnaming case is the one that cost us. assets/fonts/Montserrat.ttf was
 * the variable font's Thin default instance: family "Montserrat Thin", weight
 * 100. Every caption and headline style asks for "Montserrat" in bold, libass
 * found nothing to match, and silently drew in Helvetica — for as long as the
 * feature existed, in every render, with the file sitting right there and the
 * old "does it exist" check passing.
 */
export function assertFontsUsable(): void {
  const problems: string[] = [];

  for (const font of HEADLINE_FONTS) {
    const file = fontFileFor(font.family);
    try {
      const { family, weight } = familyNameOf(file);
      if (family !== font.family) {
        problems.push(`${file}: внутри «${family}», а стили просят «${font.family}» — libass молча возьмёт другой шрифт`);
      }
      // Both captions and headlines set Bold. A face declaring itself Thin is
      // not one libass will use for that, whatever its family name says.
      if (weight < 400) {
        problems.push(`${file}: вес ${weight} — слишком лёгкий для жирного начертания, которое просят все стили`);
      }
    } catch (err) {
      problems.push(`${file}: не читается (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  if (problems.length > 0) {
    console.error('Шрифты непригодны:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  console.log(`Шрифты в порядке: ${HEADLINE_FONTS.map((f) => f.family).join(', ')}`);
}
