'use client';

import dynamic from 'next/dynamic';

const SchedulerView = dynamic(() => import('@/components/SchedulerView'), { ssr: false });

export default function Page() {
  return <SchedulerView />;
}
