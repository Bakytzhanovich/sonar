'use client';

import dynamic from 'next/dynamic';

// Live data through client-side fetch, nothing to index — same as the other
// product screens.
const HomeView = dynamic(() => import('@/components/HomeView'), { ssr: false });

export default function Page() {
  return <HomeView />;
}
