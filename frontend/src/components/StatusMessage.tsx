import styles from './StatusMessage.module.css';

// The one-line "what just happened" feedback after an action (job created,
// tick advanced, error message) — every module screen renders this same
// shape after its own action handlers, previously as a copy-pasted inline
// style object per screen.
export default function StatusMessage({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return <div className={styles.message}>{children}</div>;
}
