/**
 * Owner / dogfood 専用・メール不要ログイン page (続 119)
 *
 * 親 SSOT §3.6.1 / §6.4 Sprint 1
 *
 * - `OWNER_LOGIN_SECRET` env が未設定 (または弱い) 場合は notFound() = ページごと存在しない。
 *   → 本番で env を入れない限り、この URL は 404。攻撃面ゼロ。
 * - 有効時のみ、email + 合言葉 (secret) を POST /api/auth/dev-login する最小フォームを表示。
 * - middleware では `/auth/` prefix = auth-public のため未認証で到達可能 (magic-link と同じ扱い)。
 */

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { isOwnerLoginEnabled } from '@/lib/auth/owner-login'
import { sanitizeLocalRedirect } from '@/lib/auth/safe-redirect'

import { DevLoginForm } from './dev-login-form'

export const metadata: Metadata = {
  title: 'Owner ログイン — UGOKI MAP',
  robots: { index: false, follow: false },
}

interface DevLoginPageProps {
  searchParams: { redirect?: string }
}

export default function DevLoginPage({ searchParams }: DevLoginPageProps) {
  // env 未設定 / 弱い secret = 機能無効 → ページごと 404
  if (!isOwnerLoginEnabled()) {
    notFound()
  }

  // API (api/auth/dev-login) と同一の検証を使い、片方だけ緩い状態を作らない (続 119)
  const redirect = sanitizeLocalRedirect(searchParams.redirect)

  return (
    <main className="flex min-h-screen flex-col bg-background p-6 sm:p-10">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center">
        <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-text-3">
          Owner login
        </p>
        <h1 className="text-3xl font-bold tracking-tight">合言葉でサインイン</h1>
        <p className="mt-2 text-sm text-text-2">
          検証用のメール不要ログインです。招待済みメールアドレスと、Vercel
          環境変数に設定した合言葉を入力してください。今見ているドメインにそのまま
          ログインします。
        </p>

        <DevLoginForm redirect={redirect} />

        <p className="mt-6 text-center text-xs text-text-3">
          通常のサインインは{' '}
          <a href="/auth/sign-in" className="underline">
            magic link
          </a>{' '}
          をご利用ください。
        </p>
      </div>

      <footer className="mt-auto flex items-center justify-between border-t border-border pt-4 text-[11px] text-text-3">
        <span>© 2026 LINKTH Inc.</span>
        <span className="font-mono">Owner / dogfood only</span>
      </footer>
    </main>
  )
}
