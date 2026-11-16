import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Voicebook — AI audiobook reader",
  description: "Upload a PDF, EPUB or text and hear it read with expressive, character-aware voices.",
  applicationName: "Voicebook",
  appleWebApp: { capable: true, title: "Voicebook", statusBarStyle: "black-translucent" },
  icons: { apple: "/icons/apple-180.png" },
};

export const viewport: Viewport = {
  themeColor: "#14110f",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
