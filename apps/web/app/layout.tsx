import type { ReactNode } from 'react';
import './globals.css';
import Nav from './Nav';

export const metadata = {
  title: 'StockTruth',
  description: 'An event-driven inventory truth engine. A total is a conclusion drawn from evidence.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <body>
        <div className="shell">
          <Nav />
          <div className="content">{children}</div>
        </div>
      </body>
    </html>
  );
}
