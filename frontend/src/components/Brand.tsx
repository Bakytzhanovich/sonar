import styles from './Brand.module.css';

// The wordmark with its accent dot, as the landing page draws it — so the
// first screens after the landing (sign-up, log-in, first run) carry the
// same mark rather than the bare word.
export default function Brand({ size = 'large' }: { size?: 'large' | 'small' }) {
  return (
    <span className={`${styles.brand} ${size === 'small' ? styles.small : ''}`}>
      <span className={styles.mark} aria-hidden="true" />
      Sonar
    </span>
  );
}
