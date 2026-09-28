// Module 8, level 3 — which word in a caption gets blown up.
//
// The poster caption style everyone in this category now uses (Submagic,
// Captions, and the app a client pointed us at) puts one word of each line at
// two or three times the size of its neighbours, in colour. The look lives or
// dies on that choice: a caption shouting «И» reads as broken software, which
// is worse than a caption that shouts nothing.
//
// Deliberately a heuristic and not an LLM call. A model would judge better,
// but it would add money, latency and a new way to fail to every render — for
// a decision that has a safe answer when it is unsure. This returns null
// rather than guess, and a null line renders flat.
//
// Pure, like smartCut.ts and for the same reason: the interesting part is the
// rule, and a rule is worth testing without a video or a network.

// Words that carry no weight when shouted. Conjunctions, prepositions,
// particles and pronouns across the three languages this product actually
// sees: Russian, Kazakh and the English that shows up mid-sentence.
//
// Kept as a set of whole words rather than a prefix rule: Russian prefixes
// collide badly — «на» is a preposition, «например» is not.
const STOPWORDS = new Set([
  // Russian — prepositions and conjunctions
  'и', 'а', 'но', 'да', 'или', 'либо', 'что', 'чтобы', 'как', 'когда', 'если',
  'в', 'во', 'на', 'за', 'по', 'из', 'от', 'до', 'для', 'при', 'про', 'над',
  'под', 'без', 'у', 'о', 'об', 'с', 'со', 'к', 'ко', 'же', 'ли', 'бы',
  // Russian — pronouns and particles
  'я', 'ты', 'он', 'она', 'оно', 'мы', 'вы', 'они', 'это', 'этот', 'эта',
  'тот', 'та', 'то', 'те', 'мой', 'твой', 'свой', 'наш', 'ваш', 'их', 'его',
  'её', 'ему', 'ей', 'им', 'вам', 'нам', 'меня', 'тебя', 'себя', 'не', 'ни',
  'уже', 'ещё', 'еще', 'там', 'тут', 'здесь', 'так', 'вот', 'ну', 'вс',
  // Kazakh — particles, postpositions and common pronouns
  'және', 'бірақ', 'немесе', 'үшін', 'кейін', 'дейін', 'сияқты', 'туралы',
  'мен', 'сен', 'ол', 'біз', 'сіз', 'олар', 'бұл', 'сол', 'осы', 'ма', 'ме',
  'ба', 'бе', 'па', 'пе', 'да', 'де', 'та', 'те', 'ғой', 'қой',
  // English
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at',
  'for', 'with', 'is', 'are', 'was', 'were', 'be', 'it', 'this', 'that',
  'i', 'you', 'he', 'she', 'we', 'they', 'my', 'your', 'not', 'no',
]);

// Below this a word is not worth the gesture. Three letters set three times
// larger is a graphic accident, not an emphasis, and short words are almost
// always grammar rather than meaning.
const MIN_EMPHASIS_LENGTH = 4;

// Strips the punctuation a transcript carries so «результат!» and «результат»
// are the same word, and lowercases for the stopword lookup. Kept separate
// from the caller because what is measured and what is displayed differ: the
// displayed word keeps its punctuation.
function normalize(word: string): string {
  return word.trim().toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/**
 * The index of the word to set large, or null when none of them earns it.
 *
 * Longest wins, and on a tie the later one: in Russian and Kazakh the new
 * information tends to sit at the end of the phrase, which is also where a
 * speaker's stress lands. Length is a crude stand-in for meaning, but it is
 * the one signal available without asking a model — and it correlates, since
 * the grammar words a line does not want emphasised are the short ones.
 */
export function pickEmphasis(words: string[]): number | null {
  let best: number | null = null;
  let bestLength = 0;

  for (let i = 0; i < words.length; i++) {
    const normalized = normalize(words[i]);
    if (normalized.length < MIN_EMPHASIS_LENGTH) continue;
    if (STOPWORDS.has(normalized)) continue;
    // A token with no letters at all — a number, a stray symbol — is not a
    // word to shout.
    if (!/\p{L}/u.test(normalized)) continue;
    if (normalized.length >= bestLength) {
      best = i;
      bestLength = normalized.length;
    }
  }

  return best;
}
