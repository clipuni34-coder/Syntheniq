import type { Metadata } from 'next';
import { Fraunces, Inter } from 'next/font/google';
import './globals.css';

const fraunces = Fraunces({ subsets: ['latin'], style: ['normal', 'italic'], weight: ['300', '400', '500', '600'], variable: '--font-serif' });
const inter = Inter({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-sans' });

export const metadata: Metadata = {
  title: 'Syntheniq — Long video in. Stories out.',
  description: 'Syntheniq is an AI editing room that understands the story of a long video and cuts it into high-quality vertical shorts.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${inter.variable}`}>
      <body>{children}</body>
    </html>
  );
}
