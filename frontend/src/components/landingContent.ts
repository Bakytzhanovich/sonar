// Landing copy shared by the page (LandingView, a client component) and its
// metadata (app/page.tsx, a server component): the FAQ is rendered on the page
// and also described to search engines as FAQPage data, and the two must say
// the same thing — a search snippet promising what the page does not is the
// kind of mismatch that gets rich results withdrawn.

export const LANDING_FAQ: Array<{ question: string; answer: string }> = [
  {
    question: 'Справится ли ИИ с казахским языком?',
    answer:
      'Да. Монтаж понимает казахский, русский и речь, где они смешаны в одной фразе. Если речь распознана неуверенно, Sonar покажет субтитры на проверку до монтажа.',
  },
  {
    question: 'Что уже работает, а что ещё нет?',
    answer:
      'ИИ-монтаж, контент-план, разбор рилсов и карусели работают уже сейчас. Чат-бот в директ Instagram и автопостинг заработают после проверки приложения в Meta — до этого их можно попробовать в демо, без подключения соцсетей.',
  },
  {
    question: 'Нужно ли давать пароль от Instagram?',
    answer: 'Нет. Подключение — через официальный вход Instagram, Sonar не видит ваш пароль.',
  },
  {
    question: 'Чем Sonar отличается от CapCut и ChatPlace?',
    answer:
      'Директ, ролики и публикации связаны: темы роликов берутся из вопросов тех, кто у вас купил, — с их словами. Не нужно три сервиса и таблица между ними.',
  },
  {
    question: 'Сколько стоит?',
    answer: 'Sonar в раннем доступе: демо бесплатное, карта не нужна. Тарифы объявим до запуска.',
  },
  {
    question: 'Что будет с моими данными?',
    answer: 'Они видны только вам. Удалить аккаунт и всё, что в нём было, можно в один шаг в настройках.',
  },
];
