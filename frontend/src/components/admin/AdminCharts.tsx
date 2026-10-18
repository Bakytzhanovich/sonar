'use client';

import { useId, useState } from 'react';
import styles from './AdminCharts.module.css';

// The admin overview's two chart forms, in plain SVG — no chart library for
// two shapes. Single series each: the title names the series, so there is no
// legend, and the mark wears the one accent. Values and labels stay in text
// colours; the colour only marks the data.

export interface DayPoint {
  day: string; // YYYY-MM-DD
  value: number;
}

const dayLabel = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

/** A tile's trend: the shape of the last 30 days, no axes — the number beside it is the information. */
export function Sparkline({ points, label }: { points: number[]; label: string }) {
  const w = 120;
  const h = 36;
  const max = Math.max(1, ...points);
  const step = points.length > 1 ? w / (points.length - 1) : w;
  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - 3 - (v / max) * (h - 6)).toFixed(1)}`).join(' ');
  return (
    <svg className={styles.sparkline} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <path d={d} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * Thirty days as bars, one per day, rounded at the data end and anchored to
 * the baseline. Hover or focus a day for its value; the table beside it is
 * the same numbers for anyone who would rather read them.
 */
export function DailyBars({ points, title, format }: { points: DayPoint[]; title: string; format: (n: number) => string }) {
  const [active, setActive] = useState<number | null>(null);
  const tableId = useId();
  const w = 600;
  const h = 180;
  const padTop = 8;
  const padBottom = 22;
  const plotH = h - padTop - padBottom;
  const rawMax = Math.max(0, ...points.map((p) => p.value));
  // A round top for the grid, so the gridline values are numbers people say.
  const max = rawMax === 0 ? 1 : niceCeil(rawMax);
  const slot = w / points.length;
  const barW = Math.max(2, slot - 2); // a 2px gap of surface between days
  const total = points.reduce((a, p) => a + p.value, 0);
  const shown = active !== null ? points[active] : null;

  return (
    <figure className={styles.figure}>
      <figcaption className={styles.caption}>
        <span className={styles.title}>{title}</span>
        <span className={styles.readout} aria-live="polite">
          {shown ? `${dayLabel(shown.day)}: ${format(shown.value)}` : `за 30 дней: ${format(total)}`}
        </span>
      </figcaption>
      <span className={styles.scale} aria-hidden="true">шкала до {format(max)}</span>

      <svg
        className={styles.chart}
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${title}: ${format(total)} за 30 дней`}
        aria-describedby={tableId}
        onMouseLeave={() => setActive(null)}
      >
        {[0, 0.5, 1].map((f) => {
          const y = padTop + plotH * (1 - f);
          return <line key={f} className={styles.grid} x1={0} x2={w} y1={y} y2={y} vectorEffect="non-scaling-stroke" />;
        })}
        {points.map((p, i) => {
          const bh = p.value > 0 ? Math.max(3, (p.value / max) * plotH) : 0;
          const x = i * slot + (slot - barW) / 2;
          const y = padTop + plotH - bh;
          const r = Math.min(4, barW / 2, bh);
          return (
            <g key={p.day}>
              {bh > 0 && (
                <path
                  className={`${styles.bar} ${active === i ? styles.barActive : ''}`}
                  d={`M${x},${padTop + plotH} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${padTop + plotH} Z`}
                />
              )}
              {/* The hit target is the whole day's column, not the bar. */}
              <rect
                className={styles.hit}
                x={i * slot}
                y={0}
                width={slot}
                height={h - padBottom}
                tabIndex={0}
                aria-label={`${dayLabel(p.day)}: ${format(p.value)}`}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
              />
            </g>
          );
        })}
        <line className={styles.baseline} x1={0} x2={w} y1={padTop + plotH} y2={padTop + plotH} vectorEffect="non-scaling-stroke" />
      </svg>

      <div className={styles.axis} aria-hidden="true">
        <span>{points[0] && dayLabel(points[0].day)}</span>
        <span>{points[Math.floor(points.length / 2)] && dayLabel(points[Math.floor(points.length / 2)].day)}</span>
        <span>сегодня</span>
      </div>

      <details className={styles.tableToggle}>
        <summary>Таблицей</summary>
        <table id={tableId} className={styles.table}>
          <thead><tr><th scope="col">День</th><th scope="col">{title}</th></tr></thead>
          <tbody>
            {points.filter((p) => p.value > 0).reverse().map((p) => (
              <tr key={p.day}><td>{dayLabel(p.day)}</td><td>{format(p.value)}</td></tr>
            ))}
            {points.every((p) => p.value === 0) && <tr><td colSpan={2}>За 30 дней ничего</td></tr>}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

function niceCeil(n: number): number {
  const mag = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 2.5, 5, 10]) if (n <= m * mag) return m * mag;
  return 10 * mag;
}
