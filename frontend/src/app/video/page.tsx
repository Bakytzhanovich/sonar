'use client';

import dynamic from 'next/dynamic';

const VideoEditView = dynamic(() => import('@/components/VideoEditView'), { ssr: false });

export default function Page() {
  return <VideoEditView />;
}
