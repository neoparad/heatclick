/**
 * AISEO Phase 1: Analytics > 内部リンク診断 table (read-only)
 *
 * AISEO-Director SSOT: prd.md §1.1 Analytics > 内部リンク診断 / decisions.md 続 AISEO-1 §4 (AISEO-4)
 *
 * - source: lib/aiseo/internal-link-loader.ts (fixture or 実 JSON 直読み)
 * - Phase 1: read-only 表示のみ、Phase 2 で source/target page クリックで詳細 panel + approve link
 * - Evidence Level: 全 row が `inferred` (cosine similarity 由来、agent 単独提案、人手未承認)
 */

import { EvidenceInlineBadge } from './evidence-inline-badge'
import type { InternalLinkProposalsBatch } from '@/lib/aiseo/types'

interface InternalLinkAnalyticsTableProps {
  batch: InternalLinkProposalsBatch
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`
}

function relativeUrl(absoluteUrl: string): string {
  try {
    const u = new URL(absoluteUrl)
    return u.pathname
  } catch {
    return absoluteUrl
  }
}

export function InternalLinkAnalyticsTable({ batch }: InternalLinkAnalyticsTableProps) {
  const { proposals, source, evidence_level, loaded_at, site_id } = batch
  const isFixture = source.startsWith('fixture://')

  if (proposals.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
        <p className="text-sm text-slate-600">内部リンク提案がまだありません。</p>
        <p className="mt-1 text-xs text-slate-500">
          linkscrawl 側で <code className="font-mono">internal_link_agent.py</code>{' '}
          を実行すると、ここに提案一覧が表示されます。
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>
          {proposals.length} 件 · site: <span className="font-mono">{site_id}</span> ·{' '}
          source:{' '}
          <span className="font-mono" title={source}>
            {isFixture ? 'fixture (Phase 1 stub)' : source.split(/[\\/]/).slice(-3).join('/')}
          </span>
        </span>
        <span>loaded: {new Date(loaded_at).toLocaleString('ja-JP')}</span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="min-w-full text-xs" data-aiseo-table="internal-link-analytics">
          <thead className="bg-slate-50">
            <tr className="text-left text-[11px] font-medium uppercase tracking-wider text-slate-500">
              <th className="px-3 py-2">source page</th>
              <th className="px-3 py-2">→ target page</th>
              <th className="px-3 py-2">anchor</th>
              <th className="px-3 py-2 text-right">confidence</th>
              <th className="px-3 py-2 text-center">evidence</th>
              <th className="px-3 py-2 text-center">status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {proposals.map((p) => (
              <tr
                key={p.proposal_id}
                data-proposal-id={p.proposal_id}
                className="hover:bg-slate-50"
              >
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-900">{p.source_title ?? '(no title)'}</div>
                  <div className="font-mono text-[10px] text-slate-500">
                    {relativeUrl(p.source_url)}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-900">{p.target_title ?? '(no title)'}</div>
                  <div className="font-mono text-[10px] text-slate-500">
                    {relativeUrl(p.target_url)}
                  </div>
                </td>
                <td className="px-3 py-2 text-slate-700">{p.anchor_text}</td>
                <td className="px-3 py-2 text-right tabular-nums font-medium text-slate-900">
                  {formatConfidence(p.confidence)}
                </td>
                <td className="px-3 py-2 text-center">
                  <EvidenceInlineBadge level={evidence_level} />
                </td>
                <td className="px-3 py-2 text-center text-[11px] uppercase tracking-wide text-slate-500">
                  {p.status}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-slate-500">
        ※ Phase 1 は read-only viewer。提案の approve / WordPress 適用は Contents タブ
        (Phase 2 で結線予定)。confidence は cosine similarity 由来の推定値で、断定数値ではない
        (Evidence Level: inferred)。
      </p>
    </div>
  )
}
