'use client';

import type { ReactNode } from 'react';
import ModuleNav, { type ModuleRoute } from './ModuleNav';
import layout from './Layout.module.css';
import styles from './PageHeader.module.css';

// The one header every module screen uses. Each screen used to draw its own,
// and they had drifted into three shapes — "● Sonar / CRM", a two-line
// label, an inline one — which made the product read as parts from
// different places. Same shape everywhere now: what section this is, what
// the screen is called, anything live (a pulse of work in progress), then
// the navigation.

export default function PageHeader({
  section,
  title,
  current,
  children,
}: {
  /** The group the screen belongs to, small and in the accent: «ПУБЛИКАЦИЯ». */
  section: string;
  title: string;
  current: ModuleRoute;
  /** Live status between the title and the navigation, e.g. a PulseIndicator. */
  children?: ReactNode;
}) {
  return (
    <header className={`${layout.header} ${styles.header}`}>
      <div className={styles.titleBlock}>
        <span className={styles.section}>{section}</span>
        <span className={styles.title}>{title}</span>
      </div>
      {children}
      <ModuleNav current={current} />
    </header>
  );
}
