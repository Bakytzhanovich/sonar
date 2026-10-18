'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Check } from 'lucide-react';
import { api, ApiError, type BillingPage, type PlanOffer } from '@/lib/api';
import { API_BASE_URL } from '@/lib/apiConfig';
import { plural } from '@/lib/plural';
import { useSession } from '@/lib/useSession';
import PageHeader from './PageHeader';
import TabBar from './TabBar';
import controls from './Controls.module.css';
import styles from './BillingView.module.css';

// The plan: what the workspace has, how much of it is used, and how to pay
// for more. Payment is a Kaspi invoice sent by hand (src/paidAccess.ts), so
// "Оплатить" asks for the number the invoice goes to and then says plainly
// what happens next — nothing here pretends to take a card.

// Often enough that an opened plan shows while the tab is still open,
// rarely enough to cost nothing.
const RECHECK_MS = 60_000;

const kzt = (n: number) => `${n.toLocaleString('ru-RU')} ₸`;

function formatPhone(phone: string | null): string {
  if (!phone) return '';
  const m = /^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(phone);
  return m ? `+7 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : phone;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function errorText(err: unknown): string {
  const code = err instanceof ApiError && err.body && typeof err.body === 'object' && 'error' in err.body ? String((err.body as { error: unknown }).error) : '';
  if (code === 'invalid_phone') return 'Проверьте номер: нужен казахстанский, в формате +7 701 123 45 67';
  if (err instanceof Error && err.message && err.message !== code) return err.message;
  return 'Не получилось — попробуйте ещё раз через минуту';
}

export default function BillingView() {
  const router = useRouter();
  const params = useSearchParams();
  const reason = params.get('reason');
  const [session] = useSession();
  const [billing, setBilling] = useState<BillingPage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The plan whose card is asking for a number.
  const [choosing, setChoosing] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBilling(await api.getBilling({ baseUrl: API_BASE_URL }));
      setLoadError(null);
    } catch {
      setLoadError('Не удалось загрузить тариф — обновите страницу');
    }
  }, []);

  useEffect(() => {
    if (!session) {
      router.replace('/login');
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const timer = window.setInterval(() => void load(), RECHECK_MS);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [load, router, session]);

  function choose(plan: PlanOffer) {
    setChoosing(plan.id);
    setPhone(formatPhone(billing?.phone ?? null));
    setError(null);
  }

  async function submit(e: React.FormEvent, plan: PlanOffer) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.requestPlan({ baseUrl: API_BASE_URL }, plan.id, phone);
      setChoosing(null);
      await load();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function cancelRequest() {
    setBusy(true);
    try {
      await api.cancelPlanRequest({ baseUrl: API_BASE_URL });
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!session) return null;

  const b = billing;
  const pending = b?.pendingRequest ?? null;

  // Why the person was sent here, in their terms — read against the state,
  // since the same redirect means different things for a trial and a plan.
  const reasonText =
    !b || !reason
      ? null
      : reason === 'limit'
        ? b.state === 'trial'
          ? 'Бесплатный ролик уже смонтирован. Выберите тариф, чтобы монтировать дальше.'
          : b.state === 'active'
            ? `Ролики тарифа «${b.plan?.name}» на эти ${b.periodDays} дней закончились. Возьмите тариф больше — или подождите, пока освободятся.`
            : 'Тариф закончился. Продлите его, чтобы монтировать дальше.'
        : b.state === 'expired'
          ? 'Тариф закончился. Продлите его, чтобы продолжить.'
          : b.state === 'trial'
            ? 'Этот раздел открывается с тарифом.'
            : null;

  return (
    <div className={styles.page}>
      <PageHeader section="Аккаунт" title="Тариф" current="/billing" />

      <main className={styles.main}>
        {loadError && <p className={styles.error} role="alert">{loadError}</p>}
        {!b && !loadError && (
          <div className={styles.loading} role="status">
            <span className="visually-hidden">Загружаю тариф</span>
            <span className="skeleton" style={{ height: 96 }} />
            <span className="skeleton" style={{ height: 280 }} />
          </div>
        )}

        {b && (
          <>
            {reasonText && <p className={styles.reason} role="status">{reasonText}</p>}

            {/* Where the workspace stands. */}
            <section className={styles.current} aria-labelledby="billing-current">
              {b.state === 'unlimited' && (
                <>
                  <h1 id="billing-current" className={styles.currentTitle}>Доступ без ограничений</h1>
                  <p className={styles.muted}>Монтируйте сколько нужно — платить ничего не требуется.</p>
                  <p className={styles.usageText}>
                    Роликов за {b.periodDays} дней: <strong>{b.videos.used}</strong>
                  </p>
                </>
              )}
              {b.state === 'active' && (
                <>
                  <h1 id="billing-current" className={styles.currentTitle}>
                    {b.plan ? `Тариф «${b.plan.name}»` : 'Оплаченный доступ'} до {b.until && formatDate(b.until)}
                  </h1>
                  {b.videos.limit !== null && <Usage used={b.videos.used} limit={b.videos.limit} label={`Роликов за ${b.periodDays} дней`} />}
                </>
              )}
              {b.state === 'trial' && (
                <>
                  <h1 id="billing-current" className={styles.currentTitle}>Пробный доступ</h1>
                  {b.videos.used < (b.videos.limit ?? 0) ? (
                    <p className={styles.muted}>
                      {b.trialVideos === 1 ? 'Один ролик' : `${b.trialVideos} ${plural(b.trialVideos, ['ролик', 'ролика', 'роликов'])}`} можно смонтировать бесплатно — посмотрите, как получится, а потом выберите тариф.{' '}
                      <Link href="/video">Смонтировать ролик</Link>
                    </p>
                  ) : (
                    <p className={styles.muted}>Бесплатный ролик смонтирован. Чтобы продолжить, выберите тариф ниже.</p>
                  )}
                </>
              )}
              {b.state === 'expired' && (
                <>
                  <h1 id="billing-current" className={styles.currentTitle}>
                    {b.plan ? `Тариф «${b.plan.name}» закончился` : 'Доступ закончился'}{b.until && ` ${formatDate(b.until)}`}
                  </h1>
                  <p className={styles.muted}>Ролики и настройки сохранены — продлите тариф, и всё будет на месте.</p>
                </>
              )}
            </section>

            {/* The invoice on its way. */}
            {pending && (
              <section className={styles.request} aria-labelledby="billing-request">
                <h2 id="billing-request" className={styles.requestTitle}>
                  Заявка на тариф «{pending.planName}» — {kzt(pending.amountKzt)}
                </h2>
                <ol className={styles.steps}>
                  <li>Пришлём счёт в Kaspi на номер <strong className={styles.phone}>{formatPhone(pending.phone)}</strong>.</li>
                  <li>Оплатите его в приложении Kaspi.</li>
                  <li>Как только увидим оплату, тариф откроется — эта страница обновится сама.</li>
                </ol>
                <button type="button" className={controls.buttonSecondary} onClick={() => void cancelRequest()} disabled={busy}>
                  Отменить заявку
                </button>
              </section>
            )}

            {/* Every workspace can choose a plan, unlimited ones included —
                paying is the owner's call, not something this page decides. */}
            {(
              <section aria-labelledby="billing-plans">
                <h2 id="billing-plans" className={styles.sectionTitle}>
                  {b.state === 'active' ? 'Продлить или сменить тариф' : 'Тарифы'}
                </h2>
                {b.state === 'unlimited' && (
                  <p className={`${styles.muted} ${styles.planNote}`}>Сейчас у вас доступ без ограничений. Если выберете и оплатите тариф, аккаунт перейдёт на него — с его лимитом роликов.</p>
                )}
                <div className={styles.plans}>
                  {b.plans.map((plan, index) => {
                    const isCurrent = b.state === 'active' && b.plan?.id === plan.id;
                    const isRequested = pending?.planId === plan.id;
                    // One accent on the screen: the larger plan, unless it is
                    // the one already requested.
                    const primary = index === b.plans.length - 1 && !isRequested;
                    return (
                      <article key={plan.id} className={`${styles.plan} ${isCurrent ? styles.planCurrent : ''}`} aria-labelledby={`plan-${plan.id}`}>
                        <div className={styles.planHead}>
                          <h3 id={`plan-${plan.id}`} className={styles.planName}>{plan.name}</h3>
                          {isCurrent && <span className={styles.badge}>Ваш тариф</span>}
                        </div>
                        <p className={styles.price}>
                          <strong>{kzt(plan.priceKzt)}</strong>
                          <span> за {b.periodDays} дней</span>
                        </p>
                        <ul className={styles.features}>
                          {plan.features.map((f) => (
                            <li key={f}><Check size={16} strokeWidth={2.25} aria-hidden="true" />{f}</li>
                          ))}
                        </ul>

                        {choosing === plan.id ? (
                          <form className={styles.payForm} onSubmit={(e) => void submit(e, plan)}>
                            <label className={styles.label} htmlFor={`phone-${plan.id}`}>Номер для счёта в Kaspi</label>
                            <input
                              id={`phone-${plan.id}`}
                              className={controls.input}
                              type="tel"
                              inputMode="tel"
                              autoComplete="tel"
                              placeholder="+7 701 123 45 67"
                              required
                              autoFocus
                              value={phone}
                              onChange={(e) => setPhone(e.target.value)}
                            />
                            {error && <p className={styles.error} role="alert">{error}</p>}
                            <div className={styles.payActions}>
                              <button type="submit" className={controls.buttonPrimary} disabled={busy}>
                                {busy ? 'Отправляем…' : `Получить счёт на ${kzt(plan.priceKzt)}`}
                              </button>
                              <button type="button" className={controls.buttonSecondary} onClick={() => setChoosing(null)}>Отмена</button>
                            </div>
                          </form>
                        ) : (
                          <button
                            type="button"
                            className={`${primary ? controls.buttonPrimary : controls.buttonSecondary} ${styles.planButton}`}
                            onClick={() => choose(plan)}
                            disabled={isRequested}
                          >
                            {isRequested ? 'Заявка отправлена' : isCurrent ? 'Продлить' : 'Оплатить'}
                          </button>
                        )}
                      </article>
                    );
                  })}
                </div>
                <p className={styles.footnote}>
                  Ролик — это новый монтаж: правки и предпросмотр не считаются. Оплата — счётом в Kaspi, без привязки карты.
                  Продление добавляет {b.periodDays} дней к оставшимся.
                </p>
              </section>
            )}
          </>
        )}
      </main>

      <TabBar current="/billing" />
    </div>
  );
}

/** "3 из 10" with a bar — the number is the information, the bar only shows it. */
function Usage({ used, limit, label }: { used: number; limit: number; label: string }) {
  const share = limit > 0 ? Math.min(1, used / limit) : 1;
  return (
    <div className={styles.usage}>
      <p className={styles.usageText}>
        {label}: <strong>{used} из {limit}</strong>
      </p>
      <div className={styles.meter} role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} aria-label={label}>
        <span style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  );
}
