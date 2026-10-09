// How generated text should sound, shared by every prompt that writes words a
// blogger will post or say on camera: carousel slides, reel scripts, content
// topics and the reel breakdown.
//
// Left alone, the model writes in its own default register — "это не просто
// X, это Y", "давайте разберёмся", three bullet points whatever the content —
// and a blogger's audience recognises that voice at once. Posting it costs the
// blogger exactly the trust the post was meant to earn.
//
// The list is a Russian adaptation of the strongest patterns from Wikipedia's
// "Signs of AI writing" (via the humanizer skill), not a translation of it: the
// em-dash rule is left out because in Russian the dash is grammar ("Алматы —
// город"), and a hook is kept because in a reel it is the genre, not a tic.
// Kept short on purpose: it rides along on every request, and a long style
// guide costs tokens on each one and dilutes the instructions that matter.
export const WRITING_RULES =
  'Как писать: живым языком автора, а не языком нейросети. ' +
  'Не противопоставляй ради веса («это не просто X, а Y», «не X — а Y», «не только X, но и Y», «это путь, а не гонка»), если X никто не утверждал: говори сразу Y. ' +
  'Без разгона перед сутью («давайте разберёмся», «вот что важно знать», «правда в том, что», «секрет в том, что»). ' +
  'Без фраз-концовок, которые повторяют сказанное («И это главное.», «Запомните это.», «Всё просто.»), и без афоризмов вместо мысли. ' +
  'Пунктов столько, сколько есть по смыслу, — не три по привычке. ' +
  'Без раздутых слов и штампов: «ключевой», «ключ к успеху», «уникальный», «каждый уникален», «невероятный», «мощный», «настоящий прорыв», «важно отметить», «играет ключевую роль», «погрузимся», «волнует многих». ' +
  'Слово «важно» — не чаще одного раза на весь текст: вместо «важно делать X» просто «делайте X» и почему. ' +
  'Без рекламного тона и обещаний: факты, цифры и примеры — только из того, что дано, ничего не выдумывай. ' +
  'Без эмодзи и без жирных ярлыков с двоеточием в начале пунктов. ' +
  'Чередуй короткие и длинные предложения; пиши так, как человек говорит, а не как пишут пресс-релиз. ' +
  'Хук в начале допустим, но он про конкретную вещь из темы, а не «Вы не поверите…». ' +
  // A model holds a list of don'ts loosely while writing and far better when
  // asked to check its own draft against it: measured on gpt-4o-mini, the
  // list alone still let "каждое тело уникально" and "не только…, но и" through.
  'Перед ответом перечитай свой текст и перепиши каждую фразу, которая нарушает эти правила.';
