import { describe, it, expect } from 'vitest';
import { pickEmphasis } from '../src/emphasis';

// The word that gets set three times larger. What matters is not that the
// rule is clever — it is that it never picks something that makes the caption
// look broken, and says so instead when nothing earns the gesture.
describe('pickEmphasis', () => {
  it('picks the longest meaningful word', () => {
    const words = ['дают', 'большой', 'результат'];
    expect(pickEmphasis(words)).toBe(2);
  });

  // Grammar words are exactly what must never be shouted: a caption reading
  // «И» in 82px is how software looks broken.
  it('never picks a conjunction, preposition or pronoun', () => {
    expect(pickEmphasis(['и', 'в', 'на'])).toBeNull();
    expect(pickEmphasis(['это', 'для', 'меня'])).toBeNull();
    // Kazakh particles too — the product's audience switches mid-sentence.
    expect(pickEmphasis(['бұл', 'үшін', 'және'])).toBeNull();
  });

  it('leaves a line of short words flat rather than forcing a choice', () => {
    expect(pickEmphasis(['да', 'нет', 'ок'])).toBeNull();
    expect(pickEmphasis([])).toBeNull();
  });

  // Longest loses to nothing, but a stopword that happens to be long still
  // loses: «чтобы» is five letters of pure grammar.
  it('skips long stopwords in favour of a shorter real word', () => {
    expect(pickEmphasis(['чтобы', 'деньги'])).toBe(1);
  });

  // Russian and Kazakh put the new information at the end of the phrase,
  // which is also where the speaker's stress lands.
  it('takes the later word when two are equally long', () => {
    expect(pickEmphasis(['лето', 'зима'])).toBe(1);
  });

  it('ignores the punctuation a transcript carries', () => {
    expect(pickEmphasis(['ну,', 'результат!'])).toBe(1);
    // …including when the punctuation is what made it look long enough.
    expect(pickEmphasis(['—', '...', 'да!'])).toBeNull();
  });

  it('does not shout a number', () => {
    expect(pickEmphasis(['было', '2026'])).toBe(0);
  });

  it('handles a stopword written in caps by the model', () => {
    expect(pickEmphasis(['ЭТО', 'работает'])).toBe(1);
  });
});
