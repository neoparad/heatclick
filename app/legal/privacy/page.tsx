/**
 * /legal/privacy — プライバシーポリシー placeholder (続 76 Task E)
 *
 * Phase 1 dogfood 期間の暫定表示。正式版は本ローンチ前 (Sprint 5 想定) に
 * 法務レビュー + GDPR / 個人情報保護法整合チェックを経て配備予定。
 */

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'プライバシーポリシー — UGOKI MAP',
  robots: { index: false, follow: false },
}

export default function PrivacyPage() {
  return (
    <>
      <h1 className="text-2xl font-bold tracking-tight">プライバシーポリシー</h1>
      <p className="text-sm text-text-2">
        本ページは Phase 1 dogfood 期間の暫定表示です。GDPR・個人情報保護法に
        準拠した正式版は本ローンチ前に公開します。
      </p>

      <section className="space-y-2 text-sm text-text-2">
        <h2 className="text-base font-semibold text-text-1">収集する情報</h2>
        <ul className="ml-5 list-disc space-y-1">
          <li>ページビュー / クリック / スクロール等の匿名化された行動データ</li>
          <li>IP アドレスは /24 (IPv4) / /48 (IPv6) でマスクして保存</li>
          <li>セッションリプレイは Phase 1 範囲外 (§1.7 Anti-Features)</li>
        </ul>
      </section>

      <section className="space-y-2 text-sm text-text-2">
        <h2 className="text-base font-semibold text-text-1">個人情報マスク</h2>
        <ul className="ml-5 list-disc space-y-1">
          <li>
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">input[type=password]</code>{' '}
            は全件マスク
          </li>
          <li>クレジットカード番号は正規表現で自動検出 + マスク</li>
          <li>カスタムセレクタによる追加マスクが可能</li>
        </ul>
      </section>

      <section className="space-y-2 text-sm text-text-2">
        <h2 className="text-base font-semibold text-text-1">第三者提供</h2>
        <p>
          法令に基づく場合を除き、収集データを第三者に提供することはありません。
          利用するサブプロセッサ (Vercel / ClickHouse / Anthropic 等) は本ローンチ前の
          正式版で開示します。
        </p>
      </section>

      <p className="text-xs text-text-3">最終更新: 2026-05-24 (Sprint 3 W2-A)</p>
    </>
  )
}
