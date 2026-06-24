import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MP Pool Scanner",
  description: "Scans osu! multiplayer lobbies for a beatmap pool.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
