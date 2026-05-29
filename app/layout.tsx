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
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  )
}
