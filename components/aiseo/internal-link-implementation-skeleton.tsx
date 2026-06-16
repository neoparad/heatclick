/**
 * AISEO Phase 1: Contents > 内部リンク実装 skeleton (approve flow disabled)
 *
 * AISEO-Director SSOT: prd.md §1.1 Contents > 内部リンク実装 / decisions.md 続 AISEO-1 §4 (AISEO-5)
 *
 * Phase 1: pending 提案を list 表示し、approve button は disabled。
 * Phase 2 で:
 *   - approve button → app/api/aiseo/proposals/[id]/approve POST → ClickHouse UPDATE
 *   - apply button → WordPress API 経由で実 anchor 挿入 (linkscrawl/scripts/apply_proposals 連動)
 */

import { EvidenceInlineBadge } from './evidence-inline-badge'
import type { InternalLinkProposalsBatch } from '@/lib/aiseo/types'

interface InternalLinkImplementationSkeletonProps {
  batch: InternalLinkProposalsBatch
}

function relativeUrl(absoluteUrl: string): string {
  try {
    return new URL(absoluteUrl).pathname
  } catch {
    return absoluteUrl
  }
}

export function InternalLinkImplementationSkeleton({
  batch,
}: InternalLinkImplementationSkeletonProps) {
  const pending = batch.proposals.filter((p) => p.status === 'pending')

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
        <strong className="font-semibold">Phase 1 skeleton:</strong>{' '}
        approve / apply ボタンは Phase 2 で結線予定 (ClickHouse{' '}
        <code className="font-mono">aiseo_internal_link_proposals</code> + WordPress API)。
        現在は未実装一覧の表示のみ。
      </div>

      {pending.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
          <p className="text-sm text-slate-600">承認待ちの提案はありません。</p>
        </div>
      ) : (
        <ul className="space-y-2" data-aiseo-list="internal-link-pending">
          {pending.map((p) => (
            <li
              key={p.proposal_id}
              className="rounded-lg border border-slate-200 bg-white p-3"
              data-proposal-id={p.proposal_id}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <EvidenceInlineBadge level={batch.evidence_level} />
                    <span className="text-[11px] uppercase tracking-wider text-slate-500">
                      {p.status}
                    </span>
                    <span className="text-[11px] text-slate-400">
                      confidence: {Math.round(p.confidence * 100)}%
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs text-slate-700">
                    <span className="font-mono text-slate-500">
                      {relativeUrl(p.source_url)}
                    </span>{' '}
                    内に
                    <span className="mx-1 rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-900">
                      {p.anchor_text}
                    </span>
                    リンク (→{' '}
                    <span className="font-mono text-slate-500">
                      {relativeUrl(p.target_url)}
                    </span>
                    ) を追加
                  </p>
                  {p.context_snippet ? (
                    <p className="mt-1 text-[11px] text-slate-500">
                      文脈: {p.context_snippet}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button
                    type="button"
                    disabled
                    aria-disabled="true"
                    title="Phase 2 で結線予定"
                    className="rounded border border-slate-300 bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-400 cursor-not-allowed"
                  >
                    approve
                  </button>
                  <button
                    type="button"
                    disabled
                    aria-disabled="true"
                    title="Phase 2 で結線予定"
                    className="rounded border border-slate-300 bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-400 cursor-not-allowed"
                  >
                    reject
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
