import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Iris — Your intelligent inbox agent",
  description: "An inbox agent that learns your voice and your priorities.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
