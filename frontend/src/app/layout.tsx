import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // Without this, Next.js resolves relative og:image/twitter:image URLs
  // (used on the public root page) against whatever host served the request — in dev
  // that's harmless, but in production without a real domain configured
  // it silently falls back to localhost, breaking every link preview.
  // NEXT_PUBLIC_SITE_URL should be set to the real deployed domain once one exists.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  title: "Sonar",
  description: "Автоматизация продаж и контента для блогеров и агентств",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ru" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
