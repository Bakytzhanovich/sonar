'use client';

import styles from './Switch.module.css';

// A checkbox the size of a finger. The native control renders at roughly
// 13px next to 15px type — small enough that people miss it, and on a phone
// missing it means scrolling instead of toggling. Here the whole row is the
// target, which is both larger and easier to aim at than any square.
//
// The input stays in the DOM, unstyled and visually hidden: it keeps the
// keyboard behaviour, the focus ring, and what a screen reader announces.
// Only its appearance is replaced.
export default function Switch({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className={styles.row}>
      <span className={styles.text}>
        <span className={styles.label}>{label}</span>
        {hint && <span className={styles.hint}>{hint}</span>}
      </span>
      <input
        type="checkbox"
        className={styles.input}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
    </label>
  );
}
