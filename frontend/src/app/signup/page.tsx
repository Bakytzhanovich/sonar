'use client';

import dynamic from 'next/dynamic';

// Same reasoning as CRM/FlowEditor: reads/writes localStorage session state
// client-side, no SEO value.
const SignupView = dynamic(() => import('@/components/SignupView'), { ssr: false });

export default function Page() {
  return <SignupView />;
}
