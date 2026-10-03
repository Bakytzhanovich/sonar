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
  description: 'Чат-бот, CRM, ИИ-монтаж и автопостинг — и контент-план из вопросов ваших покупателей. Демо без карты и подключения соцсетей.',
  alternates: {
    canonical: '/',
  },
  openGraph: {
    title: 'Sonar — из диалога в CRM и контент-план',
    description: 'Темы роликов из вопросов тех, кто купил, — с их дословными цитатами.',
    images: ['/landing-topic.png'],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Sonar — из диалога в CRM и контент-план',
    description: 'Чат-бот, CRM, ИИ-монтаж, автопостинг и контент-план из вопросов покупателей.',
    images: ['/landing-topic.png'],
  },
};

export default function Page() {
  return <LandingView />;
}
