'use client';

import dynamic from 'next/dynamic';

// next/dynamic with ssr:false isn't allowed directly inside a Server
// Component (layout.tsx) — this thin client wrapper is what makes that
// legal, same reasoning as every other page's dynamic-import shell.
const NotificationBell = dynamic(() => import('./NotificationBell'), { ssr: false });

export default function NotificationBellLoader() {
  return <NotificationBell />;
}
