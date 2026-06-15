/**
 * Root landing page
 *
 * Sprint 0 では最小限。Sprint 1 でランディング / sign-in 誘導 UI を実装。
 */

import Link from 'next/link'

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background p-8">
      <div className="max-w-2xl space-y-8 text-center">
        <h1 className="brand-gradient-text text-5xl font-bold tracking-tight">
          UGOKI MAP
        </h1>
        <p className="text-lg text-text-2">
          行動 × 検索面 × AI で「なぜ CV しないか」に答えるプラットフォーム
        </p>
        <div className="flex justify-center gap-4">
          <Link
            href="/auth/sign-in"
            className="rounded-md bg-primary px-6 py-3 text-primary-foreground transition hover:opacity-90"
          >
            サインイン
          </Link>
          <Link
            href="/onboarding/install"
            className="rounded-md border border-border px-6 py-3 text-foreground transition hover:bg-secondary"
          >
            無料で始める
          </Link>
        </div>
        <p className="text-sm text-text-3">
          Sprint 0 着工日: 2026-05-17 / Phase 1 進行中
        </p>
      </div>
    </main>
  )
}
