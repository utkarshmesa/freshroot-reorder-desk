import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Freshroots Reorder Desk", description: "Weekly replenishment loop" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN">
      <body>{children}</body>
    </html>
  );
}
