/**
 * /legal/contact — お問い合わせ placeholder (続 76 Task E)
 *
 * Phase 1 dogfood 期間の暫定表示。正式版は本ローンチ前 (Sprint 5 想定) に
 * 自動チケット発行 + Linear/Slack 連携を含めて配備予定。
 */

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'お問い合わせ — UGOKI MAP',
  robots: { index: false, follow: false },
}

const CONTACT_EMAIL = 'support@linkth.com'

export default function ContactPage() {
  return (
    <>
      <h1 className="text-2xl font-bold tracking-tight">お問い合わせ</h1>
      <p className="text-sm text-text-2">
        本ページは Phase 1 dogfood 期間の暫定表示です。フォーム経由のお問い合わせは
        本ローンチ前に配備予定です。
      </p>

      <section className="space-y-3 text-sm text-text-2">
        <h2 className="text-base font-semibold text-text-1">現在のご連絡先</h2>
        <p>
          サービスに関するお問い合わせ・不具合報告は下記までメールでご連絡ください。
        </p>
        <p>
          <a
            className="font-mono text-sm font-semibold text-primary hover:underline"
            href={`mailto:${CONTACT_EMAIL}`}
          >
            {CONTACT_EMAIL}
          </a>
        </p>
      </section>

      <section className="space-y-2 text-sm text-text-2">
        <h2 className="text-base font-semibold text-text-1">いただきたい情報</h2>
        <ul className="ml-5 list-disc space-y-1">
          <li>tracking_id (例: <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">CIP_xxxx</code>)</li>
          <li>発生日時 (タイムゾーン明記推奨)</li>
          <li>再現手順 (1-2 文で OK)</li>
          <li>ブラウザ + OS (chrome 135 / macOS 等)</li>
        </ul>
      </section>

      <p className="text-xs text-text-3">最終更新: 2026-05-24 (Sprint 3 W2-A)</p>
    </>
  )
}
