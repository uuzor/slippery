import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Parlay Vault — DeepBook Predict on Sui",
  description: "A composable parlay vault on DeepBook Predict. LPs earn yield from PLP + losing slips. Users combine 2-4 prediction markets with correct joint probability pricing.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}