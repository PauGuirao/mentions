import './global.css';
import DefaultSearchDialog from 'fumadocs-ui/components/dialog/search-default';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import type { ReactNode } from 'react';

const sans = Geist({ subsets: ['latin'] });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: {
    default: 'Mentions API Documentation',
    template: '%s | Mentions Docs',
  },
  description:
    'Keyword and brand mention tracking across dev platforms. REST API and MCP server documentation.',
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.className} ${mono.variable}`} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider
          theme={{ enabled: true, defaultTheme: 'light', attribute: 'class' }}
          search={{ SearchDialog: DefaultSearchDialog }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
