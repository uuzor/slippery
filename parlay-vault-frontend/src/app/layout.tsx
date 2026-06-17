import type { Metadata } from 'next';
import './globals.css';
import { ZkLoginProvider } from './lib/zklogin';

export const metadata: Metadata = {
  title: 'Parlay Vault — Sports Parlay Betting on Sui',
  description:
    'Pick 2–4 sports outcomes, stack them into one parlay slip, win big. Backed by DeepBook Predict on Sui. Sign in with Google. Zero gas fees.',
  openGraph: {
    title: 'Parlay Vault',
    description: 'Sports parlay betting powered by DeepBook Predict on Sui.',
    siteName: 'Parlay Vault',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ background: '#0a0a0a' }}>
        <ZkLoginProvider>
          {children}
        </ZkLoginProvider>
      </body>
    </html>
  );
}
