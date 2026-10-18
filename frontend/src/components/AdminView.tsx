'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { History, Inbox, LayoutDashboard, Menu, Search, TrendingDown, TrendingUp, Users, X } from 'lucide-react';
import { api, ApiError, type AdminAccount, type AdminAction, type AdminRequest, type AdminStats, type WorkspaceState } from '@/lib/api';
import { API_BASE_URL } from '@/lib/apiConfig';
import { plural } from '@/lib/plural';
import { useSession } from '@/lib/useSession';
import Brand from './Brand';
import LogoutButton from './LogoutButton';
import { DailyBars, Sparkline } from './admin/AdminCharts';
// The same list the server sells from — a pure module, imported, not copied.
import { PLANS as plans } from '@shared/plans';
import controls from './Controls.module.css';
import styles from './AdminView.module.css';

// The admin panel: where the owner of Sonar sees the business and turns a
// paid Kaspi invoice into an open plan (src/paidAccess.ts). Its own shell —
// a sidebar of its sections, not the product's navigation: the admin's work
// is here. Only for ADMIN_EMAILS; the server answers 404 to anyone else, and
// so does this page.

export type AdminSection = 'overview' | 'requests' | 'clients' | 'log';

const SECTIONS: { id: AdminSection; href: string; label: string; Icon: typeof Inbox }[] = [
  { id: 'overview', href: '/admin', label: 'Обзор', Icon: LayoutDashboard },
  { id: 'requests', href: '/admin/requests', label: 'Заявки на оплату', Icon: Inbox },
  { id: 'clients', href: '/admin/clients', label: 'Клиенты', Icon: Users },
  { id: 'log', href: '/admin/log', label: 'Журнал действий', Icon: History },
];

const GRANT_DAYS = 30;
const kzt = (n: number) => `${n.toLocaleString('ru-RU')} ₸`;
const num = (n: number) => n.toLocaleString('ru-RU');
const day = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
const moment = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

function formatPhone(phone: string | null): string {
  if (!phone) return '';
  const m = /^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(phone);
  return m ? `+7 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : phone;
}

export default function AdminView({ section }: { section: AdminSection }) {
  const router = useRouter();
  const params = useSearchParams();
  const [session] = useSession();
  const [requests, setRequests] = useState<AdminRequest[] | null>(null);
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [actions, setActions] = useState<AdminAction[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [search, setSearch] = useState(params.get('q') ?? '');

  const load = useCallback(async () => {
    try {
      const overview = await api.adminOverview({ baseUrl: API_BASE_URL });
      setRequests(overview.requests);
      setAccounts(overview.accounts);
      if (section === 'overview') setStats(await api.adminStats({ baseUrl: API_BASE_URL }));
      if (section === 'log') setActions((await api.adminActions({ baseUrl: API_BASE_URL })).actions);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setForbidden(true);
      else setError('Не удалось загрузить — обновите страницу');
    }
  }, [section]);

  useEffect(() => {
    if (!session) {
      router.replace('/login');
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    // New requests arrive while the panel is open.
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load, router, session]);

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    router.push(`/admin/clients${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ''}`);
  }

  if (!session) return null;

  if (forbidden) {
    return (
      <div className={styles.forbidden}>
        <Brand size="small" />
        <h1 className={styles.pageTitle}>Страница не найдена</h1>
      </div>
    );
  }

  const current = SECTIONS.find((s) => s.id === section)!;
  const pendingCount = requests?.length ?? 0;

  const sidebar = (
    <>
      <div className={styles.sideBrand}>
        <Brand size="small" />
        <span className={styles.sideTag}>Админ-панель</span>
      </div>
      <nav className={styles.sideNav} aria-label="Разделы админ-панели">
        {SECTIONS.map(({ id, href, label, Icon }) => (
          <Link
            key={id}
            href={href}
            className={`${styles.sideLink} ${id === section ? styles.sideLinkOn : ''}`}
            aria-current={id === section ? 'page' : undefined}
            onClick={() => setMenuOpen(false)}
          >
            <Icon size={18} strokeWidth={1.9} aria-hidden="true" />
            <span>{label}</span>
            {id === 'requests' && pendingCount > 0 && <span className={styles.sideBadge} aria-label={`${pendingCount} ждут`}>{pendingCount}</span>}
          </Link>
        ))}
      </nav>
      <div className={styles.sideFoot}>
        <span className={styles.sideEmail}>{session.userEmail}</span>
        <LogoutButton />
      </div>
    </>
  );

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>{sidebar}</aside>

      {menuOpen && (
        <div className={styles.drawerBackdrop} onClick={() => setMenuOpen(false)}>
          <aside className={styles.drawer} onClick={(e) => e.stopPropagation()} aria-label="Меню">
            <button type="button" className={styles.iconButton} onClick={() => setMenuOpen(false)} aria-label="Закрыть меню"><X size={20} /></button>
            {sidebar}
          </aside>
        </div>
      )}

      <div className={styles.content}>
        <header className={styles.topbar}>
          <button type="button" className={`${styles.iconButton} ${styles.menuButton}`} onClick={() => setMenuOpen(true)} aria-label="Меню" aria-expanded={menuOpen}>
            <Menu size={20} />
          </button>
          <h1 className={styles.pageTitle}>{current.label}</h1>
          <form className={styles.search} onSubmit={submitSearch} role="search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              aria-label="Найти клиента по почте или номеру"
              placeholder="Найти клиента"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </form>
        </header>

        <main className={styles.main}>
          <div aria-live="polite" className={styles.live}>
            {notice && <p className={styles.notice}>{notice}</p>}
            {error && <p className={styles.error}>{error}</p>}
          </div>

          {requests === null ? (
            <div className={styles.loading} role="status">
              <span className="visually-hidden">Загружаю</span>
              <span className="skeleton" style={{ height: 110 }} />
              <span className="skeleton" style={{ height: 260 }} />
            </div>
          ) : section === 'overview' ? (
            <Overview stats={stats} pendingCount={pendingCount} />
          ) : section === 'requests' ? (
            <Requests requests={requests} reload={load} setNotice={setNotice} setError={setError} />
          ) : section === 'clients' ? (
            <Clients accounts={accounts} query={params.get('q') ?? ''} reload={load} setNotice={setNotice} setError={setError} />
          ) : (
            <Log actions={actions} />
          )}
        </main>
      </div>
    </div>
  );
}

// ---- Обзор -------------------------------------------------------------------

/** "+12% к прошлым 30 дням", in words and an arrow — never colour alone. */
function Change({ now, before }: { now: number; before: number }) {
  if (before === 0) return <span className={styles.change}>{now > 0 ? 'впервые за 60 дней' : 'пока ничего'}</span>;
  const pct = Math.round(((now - before) / before) * 100);
  const Icon = pct >= 0 ? TrendingUp : TrendingDown;
  return (
    <span className={styles.change}>
      <Icon size={14} aria-hidden="true" />
      {pct > 0 ? '+' : ''}{pct}% к прошлым 30 дням
    </span>
  );
}

function Overview({ stats, pendingCount }: { stats: AdminStats | null; pendingCount: number }) {
  if (!stats) {
    return (
      <div className={styles.loading} role="status">
        <span className="visually-hidden">Загружаю цифры</span>
        <span className="skeleton" style={{ height: 110 }} />
      </div>
    );
  }
  const series = (k: 'revenue' | 'signups' | 'videos' | 'payments') => stats.daily.map((d) => d[k]);
  const revenueTotal = stats.byPlan.reduce((a, p) => a + p.revenue, 0);

  return (
    <div className={styles.overview}>
      {pendingCount > 0 && (
        <Link href="/admin/requests" className={styles.callout}>
          <Inbox size={18} aria-hidden="true" />
          <span>
            <strong>{pendingCount} {plural(pendingCount, ['заявка ждёт', 'заявки ждут', 'заявок ждут'])} счёта в Kaspi</strong>
            <span className={styles.calloutSub}>Открыть заявки</span>
          </span>
        </Link>
      )}

      <section className={styles.tiles} aria-label="Главные цифры за 30 дней">
        <article className={styles.tile}>
          <span className={styles.tileLabel}>Выручка за 30 дней</span>
          <strong className={styles.tileValue}>{kzt(stats.totals.revenue)}</strong>
          <Change now={stats.totals.revenue} before={stats.previous.revenue} />
          <Sparkline points={series('revenue')} label="Выручка по дням" />
        </article>
        <article className={styles.tile}>
          <span className={styles.tileLabel}>Платят сейчас</span>
          <strong className={styles.tileValue}>{num(stats.totals.paying)}</strong>
          <span className={styles.change}>{num(series('payments').reduce((a, b) => a + b, 0))} {plural(series('payments').reduce((a, b) => a + b, 0), ['оплата', 'оплаты', 'оплат'])} за 30 дней</span>
          <Sparkline points={series('payments')} label="Оплаты по дням" />
        </article>
        <article className={styles.tile}>
          <span className={styles.tileLabel}>Регистрации</span>
          <strong className={styles.tileValue}>{num(stats.totals.signups)}</strong>
          <Change now={stats.totals.signups} before={stats.previous.signups} />
          <Sparkline points={series('signups')} label="Регистрации по дням" />
        </article>
        <article className={styles.tile}>
          <span className={styles.tileLabel}>Смонтировано роликов</span>
          <strong className={styles.tileValue}>{num(stats.totals.videos)}</strong>
          <Change now={stats.totals.videos} before={stats.previous.videos} />
          <Sparkline points={series('videos')} label="Ролики по дням" />
        </article>
      </section>

      <div className={styles.charts}>
        <section className={styles.panel}>
          <DailyBars title="Выручка по дням" points={stats.daily.map((d) => ({ day: d.day, value: d.revenue }))} format={kzt} />
        </section>
        <section className={styles.panel}>
          <DailyBars title="Регистрации по дням" points={stats.daily.map((d) => ({ day: d.day, value: d.signups }))} format={num} />
        </section>
      </div>

      <div className={styles.charts}>
        <section className={styles.panel} aria-labelledby="by-plan">
          <h2 id="by-plan" className={styles.panelTitle}>Доход по тарифам за 30 дней</h2>
          <ul className={styles.planBars}>
            {stats.byPlan.map((p) => (
              <li key={p.planId}>
                <div className={styles.planBarHead}>
                  <span>«{p.name}»</span>
                  <span className={styles.planBarValue}>{kzt(p.revenue)} · {p.payments} {plural(p.payments, ['оплата', 'оплаты', 'оплат'])}</span>
                </div>
                <div className={styles.planBarTrack}>
                  <span style={{ width: `${revenueTotal ? (p.revenue / revenueTotal) * 100 : 0}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </section>
        <section className={styles.panel}>
          <DailyBars title="Ролики по дням" points={stats.daily.map((d) => ({ day: d.day, value: d.videos }))} format={num} />
        </section>
      </div>
    </div>
  );
}

// ---- Заявки ------------------------------------------------------------------

type Feedback = { reload: () => Promise<void>; setNotice: (s: string | null) => void; setError: (s: string | null) => void };

function useAction({ reload, setNotice, setError }: Feedback) {
  const [busy, setBusy] = useState<string | null>(null);
  // Destructive actions confirm on a second press, on the same button.
  const [confirming, setConfirming] = useState<string | null>(null);
  async function act(key: string, run: () => Promise<unknown>, done: string, fail: string) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await run();
      setNotice(done);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? 'Это уже обработали — список обновлён' : fail);
    } finally {
      await reload();
      setBusy(null);
      setConfirming(null);
    }
  }
  const confirmOr = (key: string, run: () => void) => (confirming === key ? run() : setConfirming(key));
  const unconfirm = (key: string) => setConfirming((c) => (c === key ? null : c));
  return { busy, confirming, act, confirmOr, unconfirm };
}

function Requests({ requests, ...feedback }: { requests: AdminRequest[] } & Feedback) {
  const { busy, confirming, act, confirmOr, unconfirm } = useAction(feedback);

  async function copy(phone: string) {
    try {
      await navigator.clipboard.writeText(phone);
      feedback.setNotice(`Номер ${formatPhone(phone)} скопирован`);
    } catch {
      feedback.setNotice(`Номер: ${formatPhone(phone)}`);
    }
  }

  return (
    <div className={styles.stack}>
      <ol className={styles.howto}>
        <li>Выставьте счёт в Kaspi на номер клиента — на указанную сумму.</li>
        <li>Когда оплата придёт, нажмите «Оплата получена».</li>
        <li>Тариф откроется на {GRANT_DAYS} дней, клиент увидит это сам.</li>
      </ol>
      {requests.length === 0 ? (
        <p className={styles.empty}>Новых заявок нет. Когда клиент выберет тариф, заявка появится здесь.</p>
      ) : (
        <ul className={styles.requests}>
          {requests.map((r) => (
            <li key={r.id} className={styles.request}>
              <div className={styles.requestWhat}>
                <strong className={styles.amount}>{kzt(r.amountKzt)}</strong>
                <span>Тариф «{r.planName}»</span>
              </div>
              <div className={styles.requestWho}>
                <span className={styles.email}>{r.email}</span>
                <span className={styles.phoneRow}>
                  <a className={styles.phone} href={`tel:${r.phone}`}>{formatPhone(r.phone)}</a>
                  <button type="button" className={styles.textButton} onClick={() => void copy(r.phone)}>Скопировать</button>
                </span>
                <span className={styles.muted}>Заявка {moment(r.createdAt)}</span>
              </div>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={controls.buttonPrimary}
                  disabled={busy !== null}
                  onClick={() => void act(`paid-${r.id}`, () => api.adminMarkPaid({ baseUrl: API_BASE_URL }, r.id), `${r.email}: тариф «${r.planName}» открыт на ${GRANT_DAYS} дней`, 'Не получилось отметить оплату')}
                >
                  {busy === `paid-${r.id}` ? 'Открываю…' : 'Оплата получена'}
                </button>
                <button
                  type="button"
                  className={controls.buttonSecondary}
                  disabled={busy !== null}
                  onBlur={() => unconfirm(`cancel-${r.id}`)}
                  onClick={() => confirmOr(`cancel-${r.id}`, () => void act(`cancel-${r.id}`, () => api.adminCancelRequest({ baseUrl: API_BASE_URL }, r.id), `Заявка ${r.email} отменена`, 'Не получилось отменить'))}
                >
                  {confirming === `cancel-${r.id}` ? 'Точно отменить?' : 'Отменить'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- Клиенты -----------------------------------------------------------------

type Filter = 'all' | WorkspaceState;
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Все' },
  { id: 'active', label: 'Платят' },
  { id: 'trial', label: 'Пробный' },
  { id: 'expired', label: 'Закончился' },
  { id: 'unlimited', label: 'Без ограничений' },
];

function statusLine(a: AdminAccount): string {
  if (a.isAdmin) return 'Админ';
  switch (a.state) {
    case 'unlimited':
      return 'Без ограничений';
    case 'active':
      return `${a.planName ? `«${a.planName}»` : 'Оплачено'} до ${a.until ? day(a.until) : '—'}`;
    case 'trial':
      return a.videos.used >= (a.videos.limit ?? 1) ? 'Пробный, ролик смонтирован' : 'Пробный, ещё не монтировал';
    case 'expired':
      return `${a.planName ? `«${a.planName}» ` : ''}закончился ${a.until ? day(a.until) : ''}`.trim();
  }
}

function Clients({ accounts, query, ...feedback }: { accounts: AdminAccount[]; query: string } & Feedback) {
  const { busy, confirming, act, confirmOr, unconfirm } = useAction(feedback);
  const [filter, setFilter] = useState<Filter>('all');

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: accounts.length, active: 0, trial: 0, expired: 0, unlimited: 0 };
    for (const a of accounts) c[a.state] += 1;
    return c;
  }, [accounts]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    return accounts.filter(
      (a) =>
        (filter === 'all' || a.state === filter) &&
        (!q || a.email.toLowerCase().includes(q) || (digits.length >= 3 && (a.phone ?? '').includes(digits)))
    );
  }, [accounts, filter, query]);

  return (
    <div className={styles.stack}>
      <div className={styles.filters} role="group" aria-label="Показать">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`${styles.filter} ${filter === f.id ? styles.filterOn : ''}`}
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.label} <span className={styles.filterCount}>{counts[f.id]}</span>
          </button>
        ))}
      </div>
      {query && <p className={styles.muted}>Поиск: «{query}» — <Link href="/admin/clients">сбросить</Link></p>}

      {visible.length === 0 ? (
        <p className={styles.empty}>Никого не нашлось.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Клиент</th>
                <th scope="col">Тариф</th>
                <th scope="col">Ролики</th>
                <th scope="col">С нами с</th>
                <th scope="col"><span className="visually-hidden">Действия</span></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((a) => (
                <tr key={a.id}>
                  <td data-label="Клиент">
                    <span className={styles.email}>{a.email}</span>
                    {a.phone && <a className={styles.phoneSmall} href={`tel:${a.phone}`}>{formatPhone(a.phone)}</a>}
                  </td>
                  <td data-label="Тариф" className={a.state === 'expired' ? styles.statusWarn : undefined}>{statusLine(a)}</td>
                  <td data-label="Ролики" className={styles.numCell}>
                    {a.videos.limit !== null && a.state === 'active' ? `${a.videos.used} из ${a.videos.limit}` : a.videos.used}
                  </td>
                  <td data-label="С нами с" className={styles.muted}>{day(a.createdAt)}</td>
                  <td className={styles.actionsCell}>
                    {!a.isAdmin && (
                      <div className={styles.actions}>
                        {/* A period always has a plan, or it has no video
                            limit at all: an account that never had one is
                            opened on a chosen plan, not just given days. */}
                        {a.state !== 'unlimited' && a.planId && (
                          <button
                            type="button"
                            className={controls.buttonSecondary}
                            disabled={busy !== null}
                            onClick={() => void act(`grant-${a.id}`, () => api.adminGrant({ baseUrl: API_BASE_URL }, a.id, GRANT_DAYS), `${a.email}: +${GRANT_DAYS} дней`, 'Не получилось продлить')}
                          >
                            +{GRANT_DAYS} дней
                          </button>
                        )}
                        {a.state !== 'unlimited' && !a.planId && plans.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            className={controls.buttonSecondary}
                            disabled={busy !== null}
                            onClick={() => void act(`grant-${a.id}-${p.id}`, () => api.adminGrant({ baseUrl: API_BASE_URL }, a.id, GRANT_DAYS, p.id), `${a.email}: «${p.name}» на ${GRANT_DAYS} дней`, 'Не получилось открыть доступ')}
                          >
                            «{p.name}» на {GRANT_DAYS} дней
                          </button>
                        ))}
                        {(a.state === 'active' || a.state === 'unlimited') && (
                          <button
                            type="button"
                            className={`${controls.buttonSecondary} ${styles.danger}`}
                            disabled={busy !== null}
                            onBlur={() => unconfirm(`revoke-${a.id}`)}
                            onClick={() => confirmOr(`revoke-${a.id}`, () => void act(`revoke-${a.id}`, () => api.adminRevoke({ baseUrl: API_BASE_URL }, a.id), `${a.email}: доступ закрыт`, 'Не получилось закрыть доступ'))}
                          >
                            {confirming === `revoke-${a.id}` ? 'Точно закрыть?' : 'Закрыть доступ'}
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Журнал ------------------------------------------------------------------

function actionText(a: AdminAction): string {
  if (a.action.startsWith('paid:')) return `Оплата получена — тариф открыт на ${a.days ?? GRANT_DAYS} дней`;
  switch (a.action) {
    case 'grant':
      return `Продлено вручную на ${a.days} ${plural(a.days ?? 0, ['день', 'дня', 'дней'])}`;
    case 'revoke':
      return 'Доступ закрыт';
    case 'cancel_request':
      return 'Заявка отменена';
    default:
      return a.action;
  }
}

function Log({ actions }: { actions: AdminAction[] | null }) {
  if (actions === null) return <p className={styles.muted} role="status">Загружаю журнал…</p>;
  if (actions.length === 0) return <p className={styles.empty}>Пока никаких действий. Здесь будет каждая оплата, продление и закрытие доступа.</p>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr><th scope="col">Когда</th><th scope="col">Что</th><th scope="col">Клиент</th><th scope="col">Кто</th></tr>
        </thead>
        <tbody>
          {actions.map((a) => (
            <tr key={a.id}>
              <td data-label="Когда" className={styles.muted}>{moment(a.createdAt)}</td>
              <td data-label="Что">{actionText(a)}</td>
              <td data-label="Клиент">{a.tenantEmail ?? <span className={styles.muted}>аккаунт удалён</span>}</td>
              <td data-label="Кто" className={styles.muted}>{a.adminEmail ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
