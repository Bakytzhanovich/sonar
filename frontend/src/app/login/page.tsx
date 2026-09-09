'use client';

import dynamic from 'next/dynamic';

const LoginView = dynamic(() => import('@/components/LoginView'), { ssr: false });

export default function Page() {
  return <LoginView />;
}
