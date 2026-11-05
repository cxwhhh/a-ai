import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

// 品牌字体 Manrope（开源 OFL 授权，只用于 logo 旁的 “A.ai” 字样）。
// 用 next/font/local 加载仓库里的字体文件：构建时不用连 Google，Docker 构建也不会因为网络失败
const brandFont = localFont({
  src: "./fonts/Manrope-latin.woff2",
  weight: "600 800",
  variable: "--font-brand",
  display: "swap",
});

export const metadata: Metadata = {
  title: "A.ai",
  description: "极简、高效的 AI agent",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0c" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className={brandFont.variable}>
      <body>{children}</body>
    </html>
  );
}
