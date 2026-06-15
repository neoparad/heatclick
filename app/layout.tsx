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
  // 続 117 v4: Chrome/Google 翻訳に「このページは翻訳しない」と最上位で宣言する
  // (<meta name="google" content="notranslate">)。翻訳プロンプト自体を抑止し、
  // 翻訳由来の <font> ラップ → React hydration #418/#423 → 白画面 を入口で防ぐ。
  other: {
    google: 'notranslate',
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
      {/*
        続 117 v4 white-screen root-fix (2026-05-30 chrome-devtools 実機再現で確定):
        clean browser では sign-in が完全描画・React #418/#423 ゼロ。一方「ページ内テキストを
        <font> で包み直す DOM mutation」を hydration 前に注入すると Owner と同一の
        React #418 (×9) + #423 を 100% 再現できた。<font> ラップは Chrome 内蔵「このページを翻訳」
        (Google 翻訳) の署名そのもので、拡張機能 OFF でも動き・シークレットでは既定 OFF という
        Owner 観測 (拡張 OFF でも白 / incognito は平気) と完全一致する。翻訳や Grammarly 系が
        React 管理下の DOM を継続的に書き換えると、React の hydration recovery と無限に競合し
        白画面化する。これを根本から断つため、アプリ UI は翻訳・校正ツールの DOM 改変対象から外す:
          - translate="no" + class="notranslate": Google 翻訳に「この subtree を翻訳するな」と宣言
            (= <font> ラップ自体が起きないので hydration mismatch の発生源が消える)
          - data-gramm* / data-enable-grammarly: Grammarly に編集 overlay 注入を抑止
        suppressHydrationWarning / error boundary (error.tsx, global-error.tsx) / chunk-recovery は
        残置の防御層 (万一の mismatch でも白画面にせず復旧 UI を出す)。
      */}
      <body
        suppressHydrationWarning
        translate="no"
        data-gramm="false"
        data-gramm_editor="false"
        data-enable-grammarly="false"
        className={`notranslate ${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  )
}
