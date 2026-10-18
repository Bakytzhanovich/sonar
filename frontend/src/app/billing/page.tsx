'use client';

import dynamic from 'next/dynamic';

const BillingView = dynamic(() => import('@/components/BillingView'), { ssr: false });

export default function Page() {
  return <BillingView />;
}
