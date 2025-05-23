import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css'; // Import global styles

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Gaza Name Project',
  description: 'Record and preserve Palestinian names',
  icons: {
    icon: '/favicon.ico',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/favicon.ico" sizes="any" />
      </head>
      {/* You might want to add Tailwind classes to body if needed, e.g., for dark mode default bg */}
      <body className={inter.className}>{children}</body>
    </html>
  )
}
