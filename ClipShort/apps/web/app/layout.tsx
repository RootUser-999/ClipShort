import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClipShort — Make every moment a short",
  description: "Turn a YouTube video into a vertical clip for Shorts, Reels, and TikTok.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
