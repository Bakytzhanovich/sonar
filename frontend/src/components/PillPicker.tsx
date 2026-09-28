'use client';

import styles from './PillPicker.module.css';

// A row of choices you can see all of at once, instead of a dropdown you have
// to open to find out what is in it.
//
// Worth the component rather than a <select> because of what these lists are:
// seven typefaces, seven colours, three sizes — things you choose by
// comparing, and a dropdown shows exactly one of them at a time. The colour
// list makes it plain: a menu reading "Янтарь / Лазурь / Лайм" is a list of
// words, while the same names each with their own dot is a palette.
//
// Scrolls horizontally rather than wrapping. On a phone a wrapped row of
// seven pills eats a third of the screen; scrolling keeps every picker one
// line tall, so the video above stays the biggest thing on the page.

export interface PillOption {
  id: string;
  label: string;
  description?: string;
  /** Painted as a dot before the label. Used by the colour picker. */
  hex?: string;
}

export default function PillPicker({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  options: PillOption[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  if (options.length === 0) return null;
  const chosen = options.find((o) => o.id === value);

  return (
    <div className={`${styles.picker} ${disabled ? styles.disabled : ''}`}>
      <div className={styles.head}>
        <span className={styles.label}>{label}</span>
        {/* The chosen option's own words, which is where a description can
            live without giving every pill a second line of text. */}
        {chosen?.description && <span className={styles.hint}>{chosen.description}</span>}
      </div>
      <div className={styles.row} role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={option.id === value}
            className={`${styles.pill} ${option.id === value ? styles.pillOn : ''}`}
            disabled={disabled}
            onClick={() => onChange(option.id)}
          >
            {/* Only where a colour is the thing being chosen. An empty hex is
                the "as the style says" option, which has no colour of its own
                to show. */}
            {option.hex ? (
              <span className={styles.dot} style={{ background: option.hex }} aria-hidden="true" />
            ) : null}
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
