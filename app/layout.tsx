import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'UGOKI MAP - ヒートマップ＆クリック分析ツール',
  description: 'WordPressサイトを中心としたWebサイトのクリック行動とヒートマップを可視化・分析し、AIによる自動診断と改善提案を行う次世代SEO特化型ヒートマップツール',
  keywords: ['ヒートマップ', 'クリック分析', 'SEO', 'UX分析', 'AI分析'],
  authors: [{ name: 'UGOKI MAP Team' }],
  creator: 'UGOKI MAP',
  publisher: 'UGOKI MAP',
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
  metadataBase: new URL('https://ugokimap.com'),
  openGraph: {
    title: 'UGOKI MAP - ヒートマップ＆クリック分析ツール',
    description: 'AIによる自動診断と改善提案を行う次世代SEO特化型ヒートマップツール',
    url: 'https://ugokimap.com',
    siteName: 'UGOKI MAP',
    locale: 'ja_JP',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'UGOKI MAP - ヒートマップ＆クリック分析ツール',
    description: 'AIによる自動診断と改善提案を行う次世代SEO特化型ヒートマップツール',
    creator: '@ugokimap',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="ja">
      <body className={inter.className}>
        <div id="root">
          {children}
        </div>
      </body>
    </html>
  )
}

