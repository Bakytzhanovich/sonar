import type { Metadata, Viewport } from 'next';
import LandingView from '@/components/LandingView';
import { LANDING_FAQ } from '@/components/landingContent';

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fcf8fa' },
    { media: '(prefers-color-scheme: dark)', color: '#151217' },
  ],
};

const TITLE = 'ИИ-монтаж рилсов, чат-бот для Instagram и контент-план — Sonar';
const DESCRIPTION =
  'Sonar монтирует рилсы с субтитрами, вырезает паузы, понимает казахский и русский, отвечает в директ Instagram и подсказывает темы роликов из вопросов покупателей. Попробуйте бесплатно.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    'монтаж рилсов нейросетью',
    'субтитры для reels',
    'ИИ-монтаж видео',
    'чат-бот для инстаграм',
    'автоответ в директ',
    'контент-план для блогера',
    'автопостинг reels',
    'Казахстан',
  ],
  alternates: { canonical: '/' },
  openGraph: {
    title: TITLE,
    description: 'Директ, рилсы и публикации — в одном сервисе для Instagram. Темы роликов из вопросов тех, кто купил.',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Sonar — ИИ-монтаж рилсов, чат-бот и контент-план' }],
    type: 'website',
    locale: 'ru_RU',
    siteName: 'Sonar',
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: ['/og.png'],
  },
};

// Structured data for search engines: what the product is, and the same FAQ
// the page shows. No price — there is none to state yet.
const STRUCTURED_DATA = [
  {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Sonar',
    applicationCategory: 'MultimediaApplication',
    operatingSystem: 'Web',
    inLanguage: 'ru',
    description: DESCRIPTION,
  },
  {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: LANDING_FAQ.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  },
];

export default function Page() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }} />
      <LandingView />
    </>
  );
}
