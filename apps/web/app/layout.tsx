import type { ReactNode } from 'react';
import './globals.css';
import Nav from './Nav';
import TopBar from './TopBar';

export const metadata = {
  title: 'StockTruth',
  description: 'Know what stock you have. Know why you believe it.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <body>
        <div className="shell">
          <Nav />
          <div className="workspace">
            <TopBar />
            <main className="content">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
