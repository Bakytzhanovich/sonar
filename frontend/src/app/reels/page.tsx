'use client';

import dynamic from 'next/dynamic';

const ReelsView = dynamic(() => import('@/components/ReelsView'), { ssr: false });

export default function Page() {
  return <ReelsView />;
}
