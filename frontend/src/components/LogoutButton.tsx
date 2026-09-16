'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLogout } from '@/lib/useLogout';
import { useSession } from '@/lib/useSession';
import styles from './LogoutButton.module.css';

// One component for every place the app offers a way out, so the confirm step
// cannot exist on one screen and be missing on another.
//
// The confirm is a centred modal, the way a phone app asks: the question
// owns the screen, the two answers are side by side, and the button that was
// pressed stays where it was instead of mutating into something else.
export default function LogoutButton({ variant = 'inline' }: { variant?: 'inline' | 'stacked' }) {
  const [session] = useSession();
  const logout = useLogout();
  const [asking, setAsking] = useState(false);

  const close = useCallback(() => setAsking(false), []);

  useEffect(() => {
    if (!asking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    // A dialog that leaves the page scrolling behind it reads as broken on a
    // phone, where the sheet is most of the screen.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [asking, close]);

  if (!session) return null;

  return (
    <>
      <button
        type="button"
        className={variant === 'stacked' ? styles.triggerStacked : styles.trigger}
        onClick={() => setAsking(true)}
      >
        Выйти
      </button>

      {asking && (
        <div
          className={styles.overlay}
          // Tapping outside cancels, as it does in any phone dialog. The
          // check keeps a click that started inside the card from closing it.
          onClick={(e) => { if (e.target === e.currentTarget) close(); }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="logout-title"
        >
          <div className={styles.sheet}>
            <h2 id="logout-title" className={styles.title}>Выйти из аккаунта?</h2>
            <p className={styles.body}>
              {session.userEmail}
              <br />
              Незавершённые монтажи не пропадут — они продолжат рендериться.
            </p>
            <div className={styles.actions}>
              <button type="button" className={styles.cancel} onClick={close} autoFocus>
                Отмена
              </button>
              <button type="button" className={styles.confirm} onClick={logout}>
                Выйти
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
