import type { Metadata, Viewport } from 'next';
import LandingView from '@/components/LandingView';

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0f14' },
  ],
};

export const metadata: Metadata = {
  title: 'Sonar — из диалога в CRM и контент-план',
  description: 'Пройдите демо-цикл Sonar: сценарий, тестовый диалог, CRM и rule-based приоритет контента. Без подключения соцсетей, карты и автоподписки.',
  alternates: {
    canonical: '/',
  },
  openGraph: {
    title: 'Sonar — из диалога в CRM и контент-план',
    description: 'Четыре шага от демо-диалога до объяснимого приоритета контента.',
    images: ['/hero-content-plan.png'],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Sonar — из диалога в CRM и контент-план',
    description: 'Демо-сценарий, CRM и объяснимый приоритет контента в одной цепочке данных.',
    images: ['/hero-content-plan.png'],
  },
};

export default function Page() {
  return <LandingView />;
}
