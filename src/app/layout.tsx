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

// 代码字体（2026-10-29）：6 款开源等宽字体（都是 OFL 授权），文件放在仓库里（只含拉丁字符，每个 15~40KB），
// 同样用 next/font/local，构建和运行都不用连外网。用户在 设置 → 外观 → 代码字体 里选，默认 JetBrains Mono。
// 只有默认的那款 preload；其余的只是声明了 @font-face，选中了浏览器才会去下载。
// 每款字体生成一个 CSS 变量（--font-code-xxx），globals.css 里按 <html data-code-font> 把 --mono 指到对应变量
const codeJetbrains = localFont({ src: "./fonts/JetBrainsMono-latin.woff2", weight: "100 800", variable: "--font-code-jetbrains", display: "swap", adjustFontFallback: false });
const codeFira = localFont({ src: "./fonts/FiraCode-latin.woff2", weight: "300 700", variable: "--font-code-fira", display: "swap", preload: false, adjustFontFallback: false });
const codePlex = localFont({
  src: [
    { path: "./fonts/IBMPlexMono-latin-400.woff2", weight: "400" },
    { path: "./fonts/IBMPlexMono-latin-500.woff2", weight: "500" },
  ],
  variable: "--font-code-plex",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});
const codeSource = localFont({ src: "./fonts/SourceCodePro-latin.woff2", weight: "200 900", variable: "--font-code-source", display: "swap", preload: false, adjustFontFallback: false });
const codeGeist = localFont({ src: "./fonts/GeistMono-latin.woff2", weight: "100 900", variable: "--font-code-geist", display: "swap", preload: false, adjustFontFallback: false });
const codeRoboto = localFont({ src: "./fonts/RobotoMono-latin.woff2", weight: "100 700", variable: "--font-code-roboto", display: "swap", preload: false, adjustFontFallback: false });
// adjustFontFallback: false —— 不让 next/font 往字体名后面自动加 Arial 的替身字体和 monospace，
// 后备字体统一由 globals.css 里的 --mono 决定（中文要先落到苹方 / 雅黑，不能先落到 monospace，否则 Windows 上又是宋体）
// next/font 要求每个字体都单独赋给模块顶层的 const，不能写在数组里，所以这里再收集一次
const codeFonts = [codeJetbrains, codeFira, codePlex, codeSource, codeGeist, codeRoboto];

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
    <html lang="zh-CN" className={[brandFont.variable, ...codeFonts.map((f) => f.variable)].join(" ")}>
      <body>{children}</body>
    </html>
  );
}
