'use client';

import dynamic from 'next/dynamic';

// The editor generates ids client-side (crypto.randomUUID) and has no
// SEO value. Keep it on a dedicated product route while the public root
// remains the landing page.
const FlowEditor = dynamic(() => import('@/components/FlowEditor'), { ssr: false });

export default function Page() {
  return <FlowEditor />;
}
