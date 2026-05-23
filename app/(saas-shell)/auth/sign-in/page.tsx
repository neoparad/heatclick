/**
 * Sign-in page (mockup 16_login.html を React 化)
 *
 * 親 SSOT §3.6.1 / §6.4 Sprint 1 / Part V §5.5.1 P-01
 *
 * - Magic link auth (Resend 経由)
 * - Brand panel (左) + Form (右) の 2 カラム、< 900px で 1 カラム化
 * - SSO は Sprint 3 以降 (UI のみ disabled で表示、A11y のため意図明示)
 */

import type { Metadata } from 'next'
import Link from 'next/link'

import { SignInForm } from './sign-in-form'

export const metadata: Metadata = {
  title: 'サインイン — UGOKI MAP',
  robots: { index: false, follow: false },
}

const ERROR_MESSAGES: Record<string, string> = {
  'invalid-token': 'リンクが無効、または期限切れです。もう一度メールアドレスを入力してください。',
  'link-used': 'このリンクは既に使用されています。新しいリンクを送信してください。',
  'not-invited':
    'このメールアドレスは現在ご利用いただけません。dogfood 招待後にお試しください。',
}

interface SignInPageProps {
  searchParams: { error?: string; redirect?: string }
}

export default function SignInPage({ searchParams }: SignInPageProps) {
  const error =
    searchParams.error && ERROR_MESSAGES[searchParams.error]
      ? ERROR_MESSAGES[searchParams.error]
      : null
  const redirect = typeof searchParams.redirect === 'string' ? searchParams.redirect : undefined

  return (
    <main className="grid min-h-screen lg:grid-cols-2">
      {/* Brand panel — < 1024px で hidden */}
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-brand-gradient p-12 text-white lg:flex">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/25 bg-white/15 font-mono text-xl font-bold backdrop-blur-md">
            U
          </div>
          <div>
            <p className="text-base font-semibold tracking-tight">UGOKI MAP</p>
            <p className="font-mono text-[11px] opacity-70">behavior · v0.1</p>
          </div>
        </div>

        <div className="relative z-10 max-w-md space-y-6">
          <h2 className="text-4xl font-bold leading-tight tracking-tight">
            サイト改善の<br />
            <span className="bg-gradient-to-br from-white to-yellow-200 bg-clip-text text-transparent">
              すべて
            </span>{' '}
            が、ここに集まる。
          </h2>
          <p className="text-sm leading-relaxed opacity-90">
            ヒートマップ × LLM クローラー × 行動データ AI で、
            <br />
            「次に直すべき施策チケット」が毎週届く。
          </p>

          <ul className="mt-8 space-y-4 text-sm">
            {/* B-3 fix (Reviewer T1 dual 続 10): §1.7 Anti-Features「セッション録画」抵触のため、
                旧コピー「ヒートマップ + セッションリプレイ」は契約違反 + 顧客誤誘導。
                代替: ヒートマップ + 経路 + ペルソナ分析 (実装機能のみ表記)。 */}
            <BrandFeature title="ヒートマップ + 経路 + ペルソナ分析" detail="個人を特定できない統計集計のみ、GDPR / 個人情報保護法準拠" />
            <BrandFeature title="経路分析 AI エージェント" detail="n8n 風 UI で動線を定義、AI が常時監視 + チャット対話" />
            <BrandFeature title="週次 AI 提案チケット" detail="Slack / Notion / Backlog に「次にやること」が自動で届く" />
          </ul>
        </div>

        <div className="flex items-center gap-3 border-t border-white/15 pt-6 font-mono text-[11px] opacity-80">
          <span>SOC 2 Type II 準拠</span>
          <span className="h-1 w-1 rounded-full bg-white/60" />
          <span>個人情報保護法 / GDPR 対応</span>
          <span className="h-1 w-1 rounded-full bg-white/60" />
          <span>東京リージョン</span>
        </div>
      </aside>

      {/* Form panel */}
      <section className="flex flex-col bg-background p-6 sm:p-10">
        <div className="ml-auto text-xs text-text-2">
          アカウントをお持ちでない？{' '}
          <Link href="/legal/contact" className="font-medium text-primary hover:underline">
            お問い合わせ →
          </Link>
        </div>

        <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center">
          <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-text-3">
            Sign in
          </p>
          <h1 className="text-3xl font-bold tracking-tight">おかえりなさい</h1>
          <p className="mt-2 text-sm text-text-2">
            メールアドレスを入力すると、ワンタイムのサインインリンクをお送りします。
          </p>

          <SignInForm error={error} redirect={redirect} />

          <p className="mt-6 text-center text-xs text-text-3">
            サインインすると{' '}
            <Link href="/legal/terms" className="underline">
              利用規約
            </Link>{' '}
            と{' '}
            <Link href="/legal/privacy" className="underline">
              プライバシーポリシー
            </Link>{' '}
            に同意したものとみなされます。
          </p>
        </div>

        <footer className="mt-auto flex items-center justify-between border-t border-border pt-4 text-[11px] text-text-3">
          <span>© 2026 LINKTH Inc.</span>
          <span className="font-mono">JP</span>
        </footer>
      </section>
    </main>
  )
}

function BrandFeature({ title, detail }: { title: string; detail: string }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md border border-white/25 bg-white/15 text-[11px] backdrop-blur-sm">
        ✓
      </span>
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-xs opacity-80">{detail}</p>
      </div>
    </li>
  )
}
