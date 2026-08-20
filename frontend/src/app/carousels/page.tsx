'use client';

import dynamic from 'next/dynamic';

// Fabric.js manipulates a real <canvas> element and browser-only APIs —
// no server rendering, same reasoning as the other dev tool pages.
const CarouselView = dynamic(() => import('@/components/CarouselView'), { ssr: false });

export default function Page() {
  return <CarouselView />;
}
