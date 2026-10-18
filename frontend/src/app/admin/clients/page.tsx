'use client';

import dynamic from 'next/dynamic';

const AdminView = dynamic(() => import('@/components/AdminView'), { ssr: false });

export default function Page() {
  return <AdminView section="clients" />;
}
