import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Syntheniq — Long video in. Stories out.',
  description: 'Syntheniq is an AI editing room that understands the story of a long video and cuts it into high-quality vertical shorts.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
