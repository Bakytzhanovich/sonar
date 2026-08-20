'use client';

import dynamic from 'next/dynamic';

const ContentPlanView = dynamic(() => import('@/components/ContentPlanView'), { ssr: false });

export default function Page() {
  return <ContentPlanView />;
}
