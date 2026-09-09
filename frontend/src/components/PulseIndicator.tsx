import styles from './PulseIndicator.module.css';

interface PulseIndicatorProps {
  count: number;
  label: string;
}

/**
 * The product's signature moment — a live radar-style ping, not a static
 * dot. Two staggered rings expand and fade from a solid center dot; honors
 * prefers-reduced-motion by dropping to just the dot.
 */
export default function PulseIndicator({ count, label }: PulseIndicatorProps) {
  return (
    <div className={styles.wrapper}>
      <span className={styles.rings} aria-hidden="true">
        <span className={styles.dot} />
        <span className={styles.ring} />
        <span className={styles.ring} />
      </span>
      <span className={styles.label}>
        <strong>{count}</strong> {label}
      </span>
    </div>
  );
}

// The same rings/dot, without the count+label — a per-row signal that this
// contact interacted within the product's explicit 15-minute activity
// window. This is recency, not an online/presence claim.
export function LiveDot({ label = 'взаимодействовал за последние 15 минут' }: { label?: string } = {}) {
  return (
    <span className={styles.inlineDot} role="img" aria-label={label} title={label}>
      <span className={styles.rings} aria-hidden="true">
        <span className={styles.dot} />
        <span className={styles.ring} />
        <span className={styles.ring} />
      </span>
    </span>
  );
}
