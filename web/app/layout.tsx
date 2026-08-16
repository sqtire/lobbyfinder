import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MP Pool Scanner",
  description: "Scans osu! multiplayer lobbies for tournament beatmap pools.",
};

// Applied before paint so a light-mode user never sees a dark flash (and vice versa).
const themeInit = `try{var t=localStorage.getItem("lf:theme");document.documentElement.setAttribute("data-theme",t==="light"?"light":"dark")}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
