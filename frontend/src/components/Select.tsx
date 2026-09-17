'use client';

import { ChevronDown } from 'lucide-react';
import styles from './Select.module.css';

// A dropdown that matches the rest of the product.
//
// The native <select> is drawn by the operating system: its font, its arrow,
// its focus ring, none of which follow the theme — it is the one control on
// these screens that visibly belongs to something else. On a phone it also
// opens a full-screen OS picker.
//
// The approach here is to keep the native element and restyle its frame
// rather than rebuild it in divs. That keeps everything a select already
// does correctly and would be laborious and easy to get wrong otherwise:
// keyboard navigation, type-ahead, screen-reader semantics, and — on a
// phone — the native picker, which is genuinely better than any list a web
// page can draw. Only the closed state is ours: the frame, the type, and a
// chevron that is not the system's.
export interface SelectOption {
  value: string;
  label: string;
}

export default function Select({
  value,
  onChange,
  options,
  className,
  disabled,
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  options: SelectOption[];
  className?: string;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  return (
    <span className={`${styles.wrap} ${className ?? ''}`}>
      <select
        className={styles.select}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-label={ariaLabel}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {/* Decorative: the real arrow is suppressed by appearance:none, and
          pointer-events:none keeps this one from swallowing the click. */}
      <ChevronDown className={styles.chevron} size={16} strokeWidth={2} aria-hidden="true" />
    </span>
  );
}
