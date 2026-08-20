'use client';

import dynamic from 'next/dynamic';

// The editor generates ids client-side (crypto.randomUUID) and has no
// SEO value — server-rendering it would just produce output that can
// never match what the client mounts, so it's disabled outright rather
// than patched around.
const FlowEditor = dynamic(() => import('@/components/FlowEditor'), { ssr: false });

export default function Page() {
  return <FlowEditor />;
}
