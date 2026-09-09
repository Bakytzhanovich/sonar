'use client';

import { useState } from 'react';
import Link from 'next/link';
import NotificationBellLoader from './NotificationBellLoader';
import styles from './ModuleNav.module.css';

// '/onboarding' is a valid `current` value (the guided first-run screen)
// but deliberately has no entry in ITEMS below — it isn't one of the seven
// module screens, so passing it just renders the nav with nothing marked
// active, letting onboarding link out to every module without claiming to
// be one.
export type ModuleRoute = '/bot' | '/crm' | '/reels' | '/carousels' | '/scheduler' | '/content-plan' | '/video' | '/onboarding';

const ITEMS: { href: ModuleRoute; label: string }[] = [
  { href: '/bot', label: 'Редактор бота' },
  { href: '/crm', label: 'CRM' },
  { href: '/reels', label: 'Рилсы' },
  { href: '/carousels', label: 'Карусели' },
  { href: '/scheduler', label: 'Автопостинг' },
  { href: '/content-plan', label: 'Контент-план' },
  { href: '/video', label: 'Видео' },
];

// Shared across all 7 module screens so hover/active nav styling (var(--accent))
// is defined once instead of re-specified per view's inline header. Below
// 720px this switches from a wrapping link row (which ate multiple header
// lines on a phone) to a hamburger + dropdown — same links, same active
// styling, just collapsed.
export default function ModuleNav({ current }: { current: ModuleRoute }) {
  const [open, setOpen] = useState(false);

  return (
    // The bell used to live in its own position:fixed overlay in the root
    // layout, independent of this row — on a wide-enough viewport it never
    // visibly collided with the nav links, but it was never actually
    // reserving space for itself: at 1400px it measurably overlapped the
    // "Видео" link's own bounding box (confirmed via getBoundingClientRect,
    // not just eyeballed), and on mobile, over the hamburger button. Making
    // it a real flex sibling here means it can never sit on top of
    // anything else, at any width, because the browser lays it out instead
    // of two independent absolute-positioned things landing in the same
    // corner by coincidence.
    <div className={styles.wrapper}>
      <nav className={styles.nav}>
        {ITEMS.map((item) =>
          item.href === current ? (
            <span key={item.href} className={styles.active} aria-current="page">
              {item.label}
            </span>
          ) : (
            <Link key={item.href} href={item.href} className={styles.link}>
              {item.label}
            </Link>
          )
        )}
      </nav>

      <div className={styles.navMobile}>
        <button className={styles.hamburger} onClick={() => setOpen((v) => !v)} aria-label="Меню разделов" aria-expanded={open}>
          ☰
        </button>
        {open && (
          <div className={styles.mobileMenu}>
            {ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`${styles.mobileLink} ${item.href === current ? styles.mobileActive : ''}`}
                aria-current={item.href === current ? 'page' : undefined}
                onClick={() => setOpen(false)}
              >
                {item.label}
              </Link>
            ))}
          </div>
        )}
      </div>

      <NotificationBellLoader />
    </div>
  );
}
