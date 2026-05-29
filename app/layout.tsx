import type { Metadata } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'

import { resolveAppUrl } from '@/lib/app-url'

import './globals.css'

// Sprint 0 scaffold drift fix (Frontend P-03 着工時、next/font/google が Geist を
// 公式 export していないため、システムフォント (Geist) 指定は globals.css の
// font-family stack で行い、ここでは Latin 拡張カバレッジ用に Inter / JetBrains Mono
// を CSS variable 経由でロードする)。
const geistSans = Inter({
  variable: '--font-geist-sans',
  subsets: ['latin'],
  display: 'swap',
})

const geistMono = JetBrains_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'UGOKI MAP — Behavior × SEO × AIO Platform',
  description:
    'ページ内行動とページ構造を突合し、なぜ離脱したかと何を直すべきかを根拠付きで出す UX 改善 AI。AIO/LLMO レポート同梱。',
  // 続 117 white-screen root-fix: 旧実装は `NEXT_PUBLIC_APP_URL ?? fallback` だったが、
  // `??` は空文字 ("") を弾かないため env が "" のとき `new URL("")` が throw し全ページが
  // metadata 生成で crash (= 白画面 / build 失敗) していた。resolveAppUrl() は空文字・未設定・
  // Vercel・localhost を一元解決し、必ず有効な URL 文字列を返す。
  metadataBase: new URL(resolveAppUrl()),
  openGraph: {
    title: 'UGOKI MAP',
    description: 'Behavior × SEO × AIO Platform',
    url: '/',
    siteName: 'UGOKI MAP',
    locale: 'ja_JP',
    type: 'website',
  },
  robots: {
    index: process.env.NODE_ENV === 'production',
    follow: process.env.NODE_ENV === 'production',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="ja" suppressHydrationWarning>
      {/*
        続 117 white-screen 続報 (2026-05-30 実機検証):
        本番 deploy dpl_9ZpZFBGDLyzfiB7i1UbUZ5DP9xmz を clean browser (拡張なし) で開くと
        sign-in は完全描画・React #418/#423 ゼロ。同一 deploy で Owner 実ブラウザのみ白画面 +
        hydration error → 原因は「DOM を書き換えるブラウザ拡張」(Grammarly / パスワード管理 /
        ダークモード系等) が <body> に属性注入し SSR HTML と client が不一致になるため。
        React 公式 #418 の原因列挙にも "browser extension that modified the HTML" が明記。
        <body> の suppressHydrationWarning で拡張由来の属性差分を hydration mismatch 扱いしない
        (= 白画面化を防ぐ防御層)。<html> 側 suppression は 1 階層しか及ばないため <body> にも明示。
      */}
      <body
        suppressHydrationWarning
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  )
}
