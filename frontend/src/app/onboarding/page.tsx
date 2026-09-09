'use client';

import dynamic from 'next/dynamic';

// This route reads the browser session/workspace from localStorage before
// the first render, so keep it client-only like the product screens.
const OnboardingView = dynamic(() => import('@/components/OnboardingView'), { ssr: false });

export default function Page() {
  return <OnboardingView />;
}
