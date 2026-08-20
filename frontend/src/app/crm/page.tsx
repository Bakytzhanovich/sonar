'use client';

import dynamic from 'next/dynamic';

// Same reasoning as the flow editor: reads live data via client-side
// fetch and has no SEO value, so it's not server-rendered at all.
const CrmView = dynamic(() => import('@/components/CrmView'), { ssr: false });

export default function Page() {
  return <CrmView />;
}
