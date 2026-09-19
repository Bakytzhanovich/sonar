'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Bot, Film, Images, LayoutGrid, Send, Sparkles, Users, Video } from 'lucide-react';
import type { ModuleRoute } from './ModuleNav';
import LogoutButton from './LogoutButton';
import { useSession } from '@/lib/useSession';
import styles from './TabBar.module.css';

// Bottom navigation, phone only. The七 modules previously lived behind a
// hamburger in the top-right corner — the hardest place on a phone to reach
// with a thumb, and two taps away from anywhere. Here they are one tap and
// always visible, which is the single biggest difference between this
// feeling like a site and feeling like an app.
//
// Four tabs, not seven: past four the labels shrink to unreadable and the
// targets stop being thumb-sized. The four are the ones with daily work in
// them; the rest open from "Ещё".
const PRIMARY: { href: ModuleRoute; label: string; Icon: typeof Bot }[] = [
  { href: '/bot', label: 'Бот', Icon: Bot },
  { href: '/crm', label: 'CRM', Icon: Users },
  { href: '/video', label: 'Видео', Icon: Video },
  { href: '/content-plan', label: 'План', Icon: LayoutGrid },
];

const SECONDARY: { href: ModuleRoute; label: string; Icon: typeof Bot }[] = [
  { href: '/reels', label: 'Рилсы', Icon: Film },
  { href: '/carousels', label: 'Карусели', Icon: Images },
  { href: '/scheduler', label: 'Автопостинг', Icon: Send },
];

export default function TabBar({ current }: { current: ModuleRoute }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [session] = useSession();
  const moreIsActive = SECONDARY.some((item) => item.href === current);

  return (
    <>
      {moreOpen && (
        // A sheet rather than a dropdown: it rises from the bar it belongs
        // to, and tapping anywhere outside closes it — the gesture people
        // already expect from a phone.
        <div className={styles.scrim} onClick={() => setMoreOpen(false)}>
          <div className={styles.sheet} onClick={(e) => e.stopPropagation()}>
            <span className={styles.sheetHandle} aria-hidden="true" />
            {SECONDARY.map(({ href, label, Icon }) => (
              <Link
                key={href}
                href={href}
                className={`${styles.sheetItem} ${href === current ? styles.sheetItemActive : ''}`}
                onClick={() => setMoreOpen(false)}
              >
                <Icon size={18} strokeWidth={1.75} />
                {label}
              </Link>
            ))}
            {/* The only way out on a phone. The header's logout is hidden
                below 760px — the tab bar replaces that whole nav — so
                without this there was no way to sign out on the device most
                people use. */}
            {/* Rendered only with a session: LogoutButton returns null
                without one, and the divider would then be a line under
                nothing. */}
            {session && (
              <div className={styles.sheetFooter}>
                <LogoutButton variant="stacked" />
              </div>
            )}
          </div>
        </div>
      )}

      <nav className={styles.bar} aria-label="Разделы">
        {PRIMARY.map(({ href, label, Icon }) => {
          const active = href === current;
          return (
            <Link
              key={href}
              href={href}
              className={`${styles.tab} ${active ? styles.tabActive : ''}`}
              aria-current={active ? 'page' : undefined}
            >
              <Icon size={20} strokeWidth={active ? 2.25 : 1.75} />
              <span className={styles.label}>{label}</span>
            </Link>
          );
        })}

        <button
          type="button"
          className={`${styles.tab} ${moreIsActive ? styles.tabActive : ''}`}
          onClick={() => setMoreOpen((v) => !v)}
          aria-expanded={moreOpen}
        >
          <Sparkles size={20} strokeWidth={moreIsActive ? 2.25 : 1.75} />
          <span className={styles.label}>Ещё</span>
        </button>
      </nav>
    </>
  );
}
