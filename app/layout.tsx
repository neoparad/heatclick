import type { Metadata } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'
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
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'https://ugokimap.com'),
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
