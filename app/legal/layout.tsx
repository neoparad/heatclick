/**
 * /legal/* 共通 layout — 利用規約 / プライバシー / お問い合わせ placeholder (続 76 Task E)
 *
 * 親 SSOT §3.6.5
 * 配備理由: Vercel logs に `/legal/{terms,privacy,contact}` 404 多数。
 *   sign-in page (`auth/sign-in/page.tsx:92, 120, 124`) 等から link されており、
 *   middleware は `/legal/` を auth-public 経路として既に許可済 (続 24 配備)。
 *   実コンテンツ未着工のため最低限 placeholder で 404 解消、本ローンチ後の
 *   法務確定までのつなぎ表示。
 */

import type { ReactNode } from 'react'

import Link from 'next/link'

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-muted/30 px-4 py-10 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="border-b border-border pb-4">
          <Link
            href="/"
            className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-3 hover:text-text-1"
          >
            ← UGOKI MAP
          </Link>
        </header>
        <article className="space-y-4 rounded-md border border-border bg-white p-6 shadow-sm sm:p-8">
          {children}
        </article>
        <footer className="flex flex-wrap items-center justify-center gap-4 text-xs text-text-3">
          <Link href="/legal/terms" className="hover:text-text-1 hover:underline">
            利用規約
          </Link>
          <span aria-hidden>·</span>
          <Link href="/legal/privacy" className="hover:text-text-1 hover:underline">
            プライバシー
          </Link>
          <span aria-hidden>·</span>
          <Link href="/legal/contact" className="hover:text-text-1 hover:underline">
            お問い合わせ
          </Link>
        </footer>
      </div>
    </main>
  )
}
