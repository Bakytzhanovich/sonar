// What Sonar sells, in one place. The billing page, the admin page and the
// server's limits all read this — change a price or a limit here and nothing
// else needs to follow.
//
// Paid by a Kaspi invoice sent by hand (src/paidAccess.ts), so a plan is a
// price, a period and how many videos fit in it — no provider plan ids.

export interface Plan {
  id: string;
  name: string;
  priceKzt: number;
  /** New edits per rolling PERIOD_DAYS. Revisions and previews are free. */
  videosPerPeriod: number;
  /** What the card lists, in the customer's words. */
  features: string[];
}

export const PERIOD_DAYS = 30;

/** Edits a new workspace may make before paying — enough to see the result. */
export const TRIAL_VIDEOS = 1;

export const PLANS: Plan[] = [
  {
    id: 'start',
    name: 'Старт',
    priceKzt: 6900,
    videosPerPeriod: 10,
    features: ['10 роликов в месяц', 'Вырезает паузы и слова-паразиты', 'Субтитры на казахском и русском', 'Правки монтажа без лимита'],
  },
  {
    id: 'pro',
    name: 'Про',
    priceKzt: 19900,
    videosPerPeriod: 40,
    features: ['40 роликов в месяц', 'Всё, что в «Старт»', 'Разбор рилсов и сценарии', 'Автопостинг в Instagram'],
  },
];

export function planById(id: string | null | undefined): Plan | null {
  return PLANS.find((p) => p.id === id) ?? null;
}
