/**
 * /legal/terms — 利用規約 placeholder (続 76 Task E)
 *
 * Phase 1 dogfood 期間の暫定表示。正式版は本ローンチ前 (Sprint 5 想定) に
 * 法務レビューを経て配備予定 (Director / Owner 確定待ち)。
 */

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: '利用規約 — UGOKI MAP',
  robots: { index: false, follow: false },
}

export default function TermsPage() {
  return (
    <>
      <h1 className="text-2xl font-bold tracking-tight">利用規約</h1>
      <p className="text-sm text-text-2">
        本ページは Phase 1 dogfood 期間の暫定表示です。正式な利用規約は
        本ローンチ前に法務レビューを経て公開します。
      </p>
      <section className="space-y-2 text-sm text-text-2">
        <h2 className="text-base font-semibold text-text-1">現在の運用方針</h2>
        <ul className="ml-5 list-disc space-y-1">
          <li>本サービスは LinkTH 内部関係者のみが利用する dogfood 環境です。</li>
          <li>取得した行動データはアクセス解析の改善目的にのみ使用します。</li>
          <li>個人情報マスク (続 76 Sprint 3 W2 配備予定) を適用予定です。</li>
          <li>不具合・問い合わせはお問い合わせフォーム経由でご連絡ください。</li>
        </ul>
      </section>
      <p className="text-xs text-text-3">最終更新: 2026-05-24 (Sprint 3 W2-A)</p>
    </>
  )
}
