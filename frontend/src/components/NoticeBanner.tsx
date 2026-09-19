import { STAFF_BOOTSTRAP_AVAILABLE } from '../lib/useApiAccess';
import styles from './NoticeBanner.module.css';

// A heads-up banner, not an inline error — used across every dev-panel
// screen for the same "нет apiKey" message, and generic enough for any
// other "you can't do anything useful here yet" notice.
export default function NoticeBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.banner} role="status">
      <span className={styles.icon} aria-hidden="true">
        !
      </span>
      <span>{children}</span>
    </div>
  );
}

// Sending a visitor to "Быстрый старт" is only useful where that button can
// actually mint a key. On a deployed site it 404s, so the banner has to name
// the route that does work there instead.
export const MISSING_API_KEY_MESSAGE = STAFF_BOOTSTRAP_AVAILABLE
  ? 'Нет apiKey — зайди через редактор бота и нажми «Быстрый старт», чтобы протестировать этот раздел.'
  : 'Нужен аккаунт — войдите или зарегистрируйтесь, чтобы пользоваться этим разделом.';
