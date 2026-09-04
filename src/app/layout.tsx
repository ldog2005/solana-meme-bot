import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import TopBar from "@/components/TopBar";

export const metadata: Metadata = {
  title: "Solana Meme-Coin Scanner — Paper Trading",
  description: "Autonomous discovery, safety analysis, scoring and paper trading of Solana meme coins. Live trading disabled by default.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-100 text-slate-900 antialiased">
        <TopBar />
        <main className="mx-auto max-w-[1500px] px-4 py-4">{children}</main>
        <footer className="mx-auto max-w-[1500px] px-4 py-6 text-center text-[11px] text-slate-400">
          No output of this system is a guarantee or financial advice. Scores describe conformity with the current rule set, not future returns.
        </footer>
      </body>
    </html>
  );
}
