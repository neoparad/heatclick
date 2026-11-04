'use client'

import React, { useEffect, useState } from 'react'
import Link from 'next/link'
import type {
  CrawlerPageAcquisitionReport,
  MissedSectionReason,
} from '@/lib/aiseo/crawler-acquisition'

export interface CrawlerAcquisitionDrawerProps {
  open: boolean
  url: string | null
  siteId?: string
  prefetchedReport?: CrawlerPageAcquisitionReport | null
  onClose: () => void
}

type InspectorTab = 'bots' | 'acquired' | 'missed'

const REASON_LABEL: Record<MissedSectionReason, string> = {
  client_side_rendered: 'CSR / クライアントJS描画依存',
  lazy_loaded_without_noscript: '遅延ロード (noscriptフォールバック無)',
  div_table_unstructured: '非構造化 <div> スープ (<table> 未化)',
  image_missing_alt: '画像のみ・alt / figcaption 欠落',
  nosnippet_or_robots: 'data-nosnippet / robots 制限',
}

const FAMILY_BADGE: Record<string, { label: string; bg: string; fg: string }> = {
  openai: { label: 'OpenAI', bg: '#ecfdf5', fg: '#047857' },
  anthropic: { label: 'Anthropic', bg: '#fffbeb', fg: '#b45309' },
  perplexity: { label: 'Perplexity', bg: '#eff6ff', fg: '#1d4ed8' },
  google: { label: 'Google AI', bg: '#fef2f2', fg: '#b91c1c' },
  other: { label: 'Other Bot', bg: '#f1f5f9', fg: '#475569' },
}

export function CrawlerAcquisitionDrawer({
  open,
  url,
  siteId = 'default',
  prefetchedReport = null,
  onClose,
}: CrawlerAcquisitionDrawerProps) {
  const [tab, setTab] = useState<InspectorTab>('acquired')
  const [report, setReport] = useState<CrawlerPageAcquisitionReport | null>(prefetchedReport)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)

  useEffect(() => {
    if (!open || !url) return
    if (prefetchedReport && prefetchedReport.url === url) {
      setReport(prefetchedReport)
      setError(null)
      return
    }

    let alive = true
    setLoading(true)
    setError(null)
    const qs = new URLSearchParams({
      site_id: siteId,
      url,
    })
    fetch(`/api/aiseo/acquisition?${qs.toString()}`, { cache: 'no-store' })
      .then(async (res) => {
        const body = await res.json()
        if (!res.ok || !body.ok) {
          throw new Error(body.error || `HTTP ${res.status}`)
        }
        return body.data as CrawlerPageAcquisitionReport
      })
      .then((data) => {
        if (!alive) return
        setReport(data)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })

    return () => {
      alive = false
    }
  }, [open, url, siteId, prefetchedReport])

  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  if (!open || !url) return null

  const handleCopyPatch = (patch: string, idx: number) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(patch).catch(() => {})
    }
    setCopiedIdx(idx)
    setTimeout(() => setCopiedIdx(null), 1800)
  }

  const ssrScore = report?.ssrVisibilityScore ?? 0
  const ssrColor = ssrScore >= 80 ? '#059669' : ssrScore >= 60 ? '#d97706' : '#dc2626'
  const ssrBg = ssrScore >= 80 ? '#ecfdf5' : ssrScore >= 60 ? '#fffbeb' : '#fef2f2'

  return (
    <div
      data-testid="crawler-acquisition-drawer-backdrop"
      className="fixed inset-0 z-50 flex justify-end bg-slate-950/45 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <aside
        data-testid="crawler-acquisition-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="AIクローラー取得内容インスペクター"
        className="flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-slate-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="border-b border-slate-200 bg-slate-50 px-6 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-indigo-600 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-white">
                  AI Crawler Acquisition Inspector
                </span>
                {report && (
                  <span className="rounded border border-slate-300 bg-white px-2 py-0.5 font-mono text-[10.5px] font-semibold text-slate-700">
                    Confidence: {report.confidence.toUpperCase()} ({report.dataSource})
                  </span>
                )}
              </div>
              <h2 className="mt-1.5 text-base font-bold text-slate-900">
                どのページで何を取得でき、何を取りこぼしたか
              </h2>
              <div
                data-testid="inspector-target-url"
                className="mt-1 truncate font-mono text-xs text-slate-600"
                title={report?.url || url}
              >
                対象URL: {report?.url || url}
              </div>
            </div>

            <button
              type="button"
              data-testid="close-acquisition-drawer-btn"
              onClick={onClose}
              className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100"
            >
              ✕ 閉じる
            </button>
          </div>

          {/* Score Badges */}
          {report && (
            <div className="mt-3.5 grid grid-cols-3 gap-2.5">
              <div
                className="rounded-lg border px-3 py-2"
                style={{ background: ssrBg, borderColor: `${ssrColor}40` }}
              >
                <div className="text-[10.5px] font-semibold text-slate-600">
                  SSR可視率 (HTTP AI可読率)
                </div>
                <div
                  data-testid="inspector-ssr-score"
                  className="font-mono text-lg font-extrabold"
                  style={{ color: ssrColor }}
                >
                  SSR可視率: {report.ssrVisibilityScore}%
                </div>
              </div>

              <div className="rounded-lg border border-indigo-200 bg-indigo-50/70 px-3 py-2">
                <div className="text-[10.5px] font-semibold text-indigo-900">
                  AI引用準備度 (Citation Readiness)
                </div>
                <div className="font-mono text-lg font-extrabold text-indigo-700">
                  {report.semanticAuditSummary.citationReadinessScore}点{' '}
                  <span className="text-xs font-normal text-indigo-900">
                    ({report.semanticAuditSummary.pageType})
                  </span>
                </div>
              </div>

              <div className="rounded-lg border border-rose-200 bg-rose-50/70 px-3 py-2">
                <div className="text-[10.5px] font-semibold text-rose-900">
                  CSR取りこぼしセクション
                </div>
                <div className="font-mono text-lg font-extrabold text-rose-700">
                  {report.missedContent.csrHiddenSections.length}箇所{' '}
                  <span className="text-xs font-normal text-rose-800">要パッチ</span>
                </div>
              </div>
            </div>
          )}

          {/* Navigation Tabs */}
          <div className="mt-4 flex gap-1.5 border-b border-slate-200 pb-1">
            <button
              type="button"
              data-testid="inspector-tab-acquired"
              onClick={() => setTab('acquired')}
              className={`rounded-t-md px-3 py-1.5 text-xs font-bold transition ${
                tab === 'acquired'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'bg-white text-slate-600 hover:bg-slate-100'
              }`}
            >
              ② 取得できた内容 ({report?.acquiredContent.headingChunks.filter((h) => h.readableByHttpCrawler).length ?? 0})
            </button>
            <button
              type="button"
              data-testid="inspector-tab-missed"
              onClick={() => setTab('missed')}
              className={`rounded-t-md px-3 py-1.5 text-xs font-bold transition ${
                tab === 'missed'
                  ? 'bg-rose-600 text-white shadow-sm'
                  : 'bg-white text-slate-600 hover:bg-slate-100'
              }`}
            >
              ③ 取りこぼし・未取得箇所 ({report?.missedContent.csrHiddenSections.length ?? 0})
            </button>
            <button
              type="button"
              data-testid="inspector-tab-bots"
              onClick={() => setTab('bots')}
              className={`rounded-t-md px-3 py-1.5 text-xs font-bold transition ${
                tab === 'bots'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'bg-white text-slate-600 hover:bg-slate-100'
              }`}
            >
              ① Bot別取得ステータス ({report?.crawlerAccessSummary.length ?? 0})
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading && (
            <div className="py-12 text-center text-sm text-slate-500">
              AIクローラー取得内容を解析中…
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-xs text-rose-800">
              <b>取得エラー:</b> {error}
            </div>
          )}

          {!loading && !error && report && (
            <div className="space-y-5">
              {/* TAB 1: Bot別取得ステータス */}
              {tab === 'bots' && (
                <div className="space-y-4" data-testid="inspector-section-bots">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                    HTTPフェッチ型AIクローラー（JS非実行）がこのURLへアクセスした際のHTTPステータス・推定取得サイズ・抽出結果です。
                  </div>

                  <div className="overflow-hidden rounded-lg border border-slate-200">
                    <table className="w-full border-collapse text-left text-xs">
                      <thead className="bg-slate-100 text-[11px] font-semibold text-slate-600">
                        <tr>
                          <th className="px-3 py-2">AIクローラー</th>
                          <th className="px-3 py-2">系統</th>
                          <th className="px-3 py-2 text-right">ヒット数</th>
                          <th className="px-3 py-2 text-center">HTTP</th>
                          <th className="px-3 py-2">抽出ステータス</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {report.crawlerAccessSummary.map((b) => {
                          const fam = FAMILY_BADGE[b.family] || FAMILY_BADGE.other
                          return (
                            <tr key={b.botName} className="hover:bg-slate-50">
                              <td className="px-3 py-2.5 font-mono font-bold text-slate-900">
                                {b.botName}
                                <div className="font-sans text-[10px] font-normal text-slate-500">
                                  最終: {b.lastSeenAt.slice(0, 16).replace('T', ' ')}
                                </div>
                              </td>
                              <td className="px-3 py-2.5">
                                <span
                                  className="rounded px-2 py-0.5 text-[10.5px] font-semibold"
                                  style={{ background: fam.bg, color: fam.fg }}
                                >
                                  {fam.label}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 text-right font-mono font-semibold">
                                {b.hits}回
                                <div className="text-[10px] font-normal text-slate-500">
                                  ~{Math.round(b.bytesFetchedEstimate / 1024)}KB
                                </div>
                              </td>
                              <td className="px-3 py-2.5 text-center font-mono">
                                <span
                                  className={`rounded px-1.5 py-0.5 text-[10.5px] font-bold ${
                                    b.statusCode >= 400
                                      ? 'bg-rose-100 text-rose-800'
                                      : 'bg-emerald-100 text-emerald-800'
                                  }`}
                                >
                                  {b.statusCode}
                                </span>
                              </td>
                              <td className="px-3 py-2.5">
                                {b.extractionStatus === 'full_ssr' ? (
                                  <span className="inline-flex items-center rounded bg-emerald-100 px-2 py-0.5 text-[10.5px] font-bold text-emerald-800">
                                    ✓ full_ssr (完全取得)
                                  </span>
                                ) : b.extractionStatus === 'partial_csr_loss' ? (
                                  <span className="inline-flex items-center rounded bg-amber-100 px-2 py-0.5 text-[10.5px] font-bold text-amber-900">
                                    ⚠ partial_csr_loss (CSR欠落あり)
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center rounded bg-rose-100 px-2 py-0.5 text-[10.5px] font-bold text-rose-800">
                                    ✕ blocked_or_error
                                  </span>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* TAB 2: 取得できた内容 (Acquired by AI) */}
              {tab === 'acquired' && (
                <div className="space-y-4" data-testid="inspector-section-acquired">
                  {/* Meta & Title */}
                  <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3.5">
                    <div className="text-xs font-bold text-slate-800">
                      初期SSR HTMLから抽出されたメタデータ
                    </div>
                    <dl className="mt-2 space-y-1.5 text-xs">
                      <div className="flex gap-2">
                        <dt className="w-28 shrink-0 font-mono text-slate-500">&lt;title&gt;</dt>
                        <dd className="font-semibold text-slate-900">
                          {report.acquiredContent.title}
                        </dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="w-28 shrink-0 font-mono text-slate-500">meta description</dt>
                        <dd className="text-slate-700">
                          {report.acquiredContent.metaDescription || '（未設定）'}
                        </dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="w-28 shrink-0 font-mono text-slate-500">canonical</dt>
                        <dd className="font-mono text-slate-700">
                          {report.acquiredContent.canonicalUrl || '（未設定）'}
                        </dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="w-28 shrink-0 font-mono text-slate-500">SSR内部リンク数</dt>
                        <dd className="font-mono font-bold text-indigo-700">
                          {report.acquiredContent.extractedInternalLinksCount}本（&lt;a href&gt; としてクローラーが辿れるリンク）
                        </dd>
                      </div>
                    </dl>
                  </div>

                  {/* JSON-LD Schemas */}
                  <div>
                    <div className="mb-2 text-xs font-bold text-slate-800">
                      抽出された JSON-LD 構造化データ ({report.acquiredContent.jsonLdSchemas.length}件)
                    </div>
                    {report.acquiredContent.jsonLdSchemas.length === 0 ? (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                        初期HTML内に JSON-LD (`application/ld+json`) が検出されませんでした。
                      </div>
                    ) : (
                      <div className="space-y-2.5">
                        {report.acquiredContent.jsonLdSchemas.map((schema, i) => (
                          <div
                            key={`${schema.type}-${i}`}
                            className="rounded-lg border border-slate-200 bg-white p-3"
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-mono text-xs font-bold text-indigo-700">
                                @type: {schema.type}
                              </span>
                              <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[10.5px] font-semibold text-slate-700">
                                フィールド充足率: {schema.completenessScore}%
                              </span>
                            </div>
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {schema.fieldsExtracted.map((f) => (
                                <span
                                  key={f}
                                  className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] text-emerald-800"
                                >
                                  ✓ {f}
                                </span>
                              ))}
                            </div>
                            <pre className="mt-2 overflow-x-auto rounded bg-slate-900 p-2 font-mono text-[10.5px] text-slate-100">
                              {JSON.stringify(schema.rawPreview, null, 2)}
                            </pre>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Heading Chunks */}
                  <div>
                    <div className="mb-2 text-xs font-bold text-slate-800">
                      H1〜H3 セマンティックチャンク＆HTTPクローラー可読判定
                    </div>
                    <div className="space-y-2">
                      {report.acquiredContent.headingChunks.map((chunk, idx) => (
                        <div
                          key={idx}
                          className={`rounded-lg border p-3 ${
                            chunk.readableByHttpCrawler
                              ? 'border-emerald-200 bg-emerald-50/40'
                              : 'border-rose-200 bg-rose-50/50'
                          }`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] font-bold text-white">
                                {chunk.level}
                              </span>
                              <span className="text-xs font-bold text-slate-900">
                                {chunk.text}
                              </span>
                            </div>
                            {chunk.readableByHttpCrawler ? (
                              <span className="rounded bg-emerald-100 px-2 py-0.5 font-mono text-[10px] font-bold text-emerald-800">
                                ✓ SSR取得済 ({chunk.charCount}字)
                              </span>
                            ) : (
                              <span className="rounded bg-rose-100 px-2 py-0.5 font-mono text-[10px] font-bold text-rose-800">
                                ✕ HTTPクローラー未取得 (CSR/非構造)
                              </span>
                            )}
                          </div>
                          <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-600">
                            <span>意味役割: {chunk.semanticRole}</span>
                            <span className="font-mono text-[10.5px] text-slate-500">
                              Y座標: {chunk.yRangePx[0]}px 〜 {chunk.yRangePx[1]}px
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 3: 取りこぼし・未取得箇所 (Missed due to CSR / Structure) */}
              {tab === 'missed' && (
                <div className="space-y-4" data-testid="inspector-section-missed">
                  {report.semanticAuditSummary.topBlockers.length > 0 && (
                    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
                      <div className="text-xs font-bold text-amber-950">
                        AI引用・RAG抽出の主要ブロッカー
                      </div>
                      <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs text-amber-900">
                        {report.semanticAuditSummary.topBlockers.map((b, i) => (
                          <li key={i}>{b}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {report.missedContent.csrHiddenSections.length === 0 ? (
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-xs font-semibold text-emerald-900">
                      このページはプレーンテキストまたは完全SSRで構成されており、CSR起因の取りこぼしセクションはありません。
                    </div>
                  ) : (
                    report.missedContent.csrHiddenSections.map((sec, idx) => (
                      <div
                        key={idx}
                        data-testid={`missed-section-card-${idx}`}
                        className="rounded-lg border border-rose-200 bg-white p-4 shadow-sm"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span
                              className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase ${
                                sec.impactLevel === 'high'
                                  ? 'bg-rose-600 text-white'
                                  : 'bg-amber-500 text-white'
                              }`}
                            >
                              Impact: {sec.impactLevel}
                            </span>
                            <span className="text-sm font-bold text-slate-900">
                              {sec.sectionName}
                            </span>
                          </div>
                          <span className="rounded bg-rose-50 px-2 py-0.5 font-mono text-[10.5px] font-semibold text-rose-800">
                            {REASON_LABEL[sec.reason] || sec.reason}
                          </span>
                        </div>

                        <div className="mt-1.5 flex flex-wrap items-center gap-4 font-mono text-[11px] text-slate-500">
                          <span>Selector: {sec.selector}</span>
                          <span>
                            Y座標帯: {sec.yRangePx[0]}px 〜 {sec.yRangePx[1]}px
                          </span>
                        </div>

                        <p className="mt-2.5 text-xs leading-relaxed text-slate-700">
                          {sec.missedInformationSummary}
                        </p>

                        <div className="mt-3">
                          <div className="flex items-center justify-between">
                            <span className="font-mono text-[11px] font-bold text-indigo-700">
                              推奨 SSR HTML / JSON-LD 修正パッチ
                            </span>
                            <button
                              type="button"
                              data-testid={`copy-remediation-patch-${idx}`}
                              onClick={() => handleCopyPatch(sec.remediationPatch, idx)}
                              className="rounded border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[11px] font-semibold text-indigo-700 hover:bg-indigo-100"
                            >
                              {copiedIdx === idx ? '✓ コピーしました' : '📋 パッチをコピー'}
                            </button>
                          </div>
                          <pre className="mt-1.5 overflow-x-auto rounded-md bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-emerald-300">
                            {sec.remediationPatch}
                          </pre>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-6 py-3">
          <div className="text-[11px] text-slate-500">
            ヒートマップの「🤖 AIエージェント」モードでY座標帯の重なりを視覚確認できます
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/heatmap?url=${encodeURIComponent(report?.url || url)}`}
              className="rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-xs font-bold text-violet-800 hover:bg-violet-100"
              style={{ textDecoration: 'none' }}
            >
              🤖 AIヒートマップで見る →
            </Link>
            <Link
              href={`/fusion?url=${encodeURIComponent(report?.url || url)}`}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-700"
              style={{ textDecoration: 'none' }}
            >
              4面統合診断へ →
            </Link>
          </div>
        </div>
      </aside>
    </div>
  )
}
