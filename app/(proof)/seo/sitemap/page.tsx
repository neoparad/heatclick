'use client'

import React, { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

const fmtInt = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString('en-US'))
const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return '未クロール'
  const d = new Date(iso)
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`
}

const VERDICT_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  PASS: { bg: '#dcfce7', fg: '#166534', label: '登録済み' },
  NEUTRAL: { bg: '#fef3c7', fg: '#92400e', label: '除外・未登録' },
  FAIL: { bg: '#fee2e2', fg: '#991b1b', label: 'エラー' },
}

interface CoveragePoint {
  date: string
  indexed: number
  excluded: number
  errors: number
  rate: number
}

function StackedCoverageChart({ data }: { data: CoveragePoint[] }) {
  if (!data?.length) return null
  const W = 880
  const H = 200
  const padL = 42
  const padR = 16
  const padT = 14
  const padB = 26
  const iw = W - padL - padR
  const ih = H - padT - padB
  const maxTot = Math.max(...data.map((d) => d.indexed + d.excluded + d.errors), 1)
  const bw = Math.max(4, iw / data.length - 3)
  const step = Math.max(1, Math.floor(data.length / 7))

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, fontSize: 12, marginBottom: 8, color: 'var(--text-secondary)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: '#10b981' }} /> 登録済み (Indexed)
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: '#f59e0b' }} /> 除外・未登録 (Excluded)
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: '#ef4444' }} /> エラー (Error)
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 200, display: 'block' }}>
        {[0, 0.5, 1].map((t, i) => {
          const y = padT + (1 - t) * ih
          return (
            <g key={i}>
              <line x1={padL} x2={W - padR} y1={y} y2={y} stroke="#f1f5f9" />
              <text x={padL - 6} y={y + 4} textAnchor="end" fontSize="10" fill="#94a3b8">
                {Math.round(t * maxTot)}
              </text>
            </g>
          )
        })}
        {data.map((d, i) => {
          const x = padL + (i / data.length) * iw
          const hIdx = (d.indexed / maxTot) * ih
          const hExc = (d.excluded / maxTot) * ih
          const hErr = (d.errors / maxTot) * ih
          const yIdx = padT + ih - hIdx
          const yExc = yIdx - hExc
          const yErr = yExc - hErr
          return (
            <g key={d.date}>
              <rect x={x} y={yIdx} width={bw} height={hIdx} fill="#10b981" rx="1" />
              <rect x={x} y={yExc} width={bw} height={hExc} fill="#f59e0b" />
              <rect x={x} y={yErr} width={bw} height={hErr} fill="#ef4444" />
              {i % step === 0 && (
                <text x={x + bw / 2} y={H - 8} textAnchor="middle" fontSize="10" fill="#94a3b8">
                  {d.date.slice(5)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

interface SitemapPageItem {
  url: string
  verdict: string
  coverageState: string
  labelJa: string
  indexingState?: string | null
  pageFetchState?: string | null
  robotsTxtState?: string | null
  crawledAs?: string | null
  lastCrawlTime?: string | null
  googleCanonical?: string | null
  userCanonical?: string | null
  inSitemap?: boolean
  referringCount?: number
  error?: string | null
}

interface SitemapResponse {
  source: string
  site: string
  summary?: {
    sitemapUrl?: string
    sitemapSubmitted?: number
    indexed?: number
    excluded?: number
    errors?: number
    lastFetched?: string | null
  }
  breakdown?: Array<{
    key: string
    label: string
    verdict: string
    count: number
    action: string
  }>
  dailyCoverage?: CoveragePoint[]
  pages?: SitemapPageItem[]
}

export default function SeoSitemapPage() {
  const [data, setData] = useState<SitemapResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [verdictFilter, setVerdictFilter] = useState<'ALL' | 'PASS' | 'NEUTRAL' | 'FAIL'>('ALL')
  const [reasonFilter, setReasonFilter] = useState('ALL')
  const [qFilter, setQFilter] = useState('')

  useEffect(() => {
    setLoading(true)
    fetch('/api/seo/sitemap')
      .then((r) => r.json())
      .then((j) => {
        setData(j)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const s = data?.summary || { sitemapSubmitted: 0, indexed: 0, excluded: 0, errors: 0 }
  const total = (s.indexed || 0) + (s.excluded || 0) + (s.errors || 0) || 1
  const indexRate = (s.indexed || 0) / total
  const isMock = data?.source !== 'postgres' && data?.source !== 'gsc'

  const filteredPages = useMemo(() => {
    const rows = data?.pages || []
    const q = qFilter.trim().toLowerCase()
    return rows.filter((r) => {
      if (verdictFilter !== 'ALL' && r.verdict !== verdictFilter) return false
      if (reasonFilter !== 'ALL' && r.coverageState !== reasonFilter) return false
      if (q && !r.url.toLowerCase().includes(q) && !(r.labelJa || '').toLowerCase().includes(q)) return false
      return true
    })
  }, [data, verdictFilter, reasonFilter, qFilter])

  const pathOf = (u: string) => {
    try {
      const x = new URL(u)
      return x.pathname + x.search
    } catch {
      return u
    }
  }

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1440, margin: '0 auto' }}>
      <div className="page-head">
        <div>
          <div className="breadcrumb">SEO分析 / サイトマップ（インデックス登録状況）</div>
          <h1>サイトマップ & インデックス登録状況</h1>
        </div>
        <div className="page-actions" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span
            className="badge"
            style={{
              padding: '4px 10px',
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 600,
              background: isMock ? '#fef3c7' : '#dcfce7',
              color: isMock ? '#92400e' : '#166534',
            }}
          >
            {isMock ? 'デモデータ（URL Inspection API 未接続）' : `GSC 接続中: ${data?.site}`}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }} className="mono">
            {s.sitemapUrl}
          </span>
        </div>
      </div>

      {/* KPI 4 cards */}
      <div className="kpi-grid" style={{ marginBottom: 20 }}>
        <div className="kpi-card">
          <div className="kpi-label">インデックス登録率</div>
          <div className="kpi-val" style={{ color: '#059669' }}>
            {(indexRate * 100).toFixed(1)}%
          </div>
          <div className="kpi-delta">
            サイトマップ送信 <b>{fmtInt(s.sitemapSubmitted)}</b> URL 中
          </div>
        </div>
        <div
          className="kpi-card"
          style={{ cursor: 'pointer' }}
          onClick={() => {
            setVerdictFilter('PASS')
            setReasonFilter('ALL')
          }}
        >
          <div className="kpi-label">登録済み（Indexed）</div>
          <div className="kpi-val">{fmtInt(s.indexed)}</div>
          <div className="kpi-delta" style={{ color: '#059669' }}>
            ● 検索結果に表示可能
          </div>
        </div>
        <div
          className="kpi-card"
          style={{ cursor: 'pointer' }}
          onClick={() => {
            setVerdictFilter('NEUTRAL')
            setReasonFilter('ALL')
          }}
        >
          <div className="kpi-label">除外・未登録（Excluded）</div>
          <div className="kpi-val" style={{ color: '#d97706' }}>
            {fmtInt(s.excluded)}
          </div>
          <div className="kpi-delta">クロール済み未登録 / 検出未登録 / 重複 等</div>
        </div>
        <div
          className="kpi-card"
          style={{ cursor: 'pointer' }}
          onClick={() => {
            setVerdictFilter('FAIL')
            setReasonFilter('ALL')
          }}
        >
          <div className="kpi-label">エラー（Error）</div>
          <div className="kpi-val" style={{ color: '#dc2626' }}>
            {fmtInt(s.errors)}
          </div>
          <div className="kpi-delta">ソフト404 / 5xx / リダイレクトエラー</div>
        </div>
      </div>

      {/* Trend + Breakdown */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 440px', gap: 16, marginBottom: 20 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">インデックスカバレッジ推移（過去30日）</div>
              <div className="card-sub">登録済み / 除外 / エラー URL 数の日次推移</div>
            </div>
          </div>
          {loading ? (
            <div style={{ height: 200, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>
              読み込み中…
            </div>
          ) : (
            <StackedCoverageChart data={data?.dailyCoverage || []} />
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">未登録・除外・エラー理由の内訳</div>
              <div className="card-sub">行クリックで該当 URL を下に絞り込み</div>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 230, overflowY: 'auto' }}>
            {(data?.breakdown || []).map((b) => {
              const st = VERDICT_STYLE[b.verdict] || VERDICT_STYLE.NEUTRAL
              const active = reasonFilter === b.key
              return (
                <div
                  key={b.key}
                  onClick={() => {
                    setVerdictFilter('ALL')
                    setReasonFilter(active ? 'ALL' : b.key)
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    padding: '7px 10px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    background: active ? '#eff6ff' : '#f8fafc',
                    border: active ? '1px solid #60a5fa' : '1px solid transparent',
                    fontSize: 12,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span
                        style={{
                          padding: '1px 6px',
                          borderRadius: 4,
                          fontSize: 10,
                          fontWeight: 700,
                          background: st.bg,
                          color: st.fg,
                        }}
                      >
                        {st.label}
                      </span>
                      <span style={{ fontWeight: 600 }}>{b.label}</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>対処: {b.action}</div>
                  </div>
                  <span className="num" style={{ fontWeight: 700, fontSize: 14 }}>
                    {fmtInt(b.count)}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* URL Inspection table */}
      <div className="card">
        <div className="card-head" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="card-title">URL別 インデックス検査一覧 ({filteredPages.length} 件)</div>
            <div className="seg">
              {(
                [
                  ['ALL', 'すべて'],
                  ['PASS', '登録済み'],
                  ['NEUTRAL', '除外・未登録'],
                  ['FAIL', 'エラー'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  className={verdictFilter === k ? 'active' : ''}
                  onClick={() => {
                    setVerdictFilter(k)
                    setReasonFilter('ALL')
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {reasonFilter !== 'ALL' && (
              <button
                onClick={() => setReasonFilter('ALL')}
                style={{
                  fontSize: 11,
                  padding: '3px 8px',
                  borderRadius: 999,
                  border: '1px solid #60a5fa',
                  background: '#eff6ff',
                  color: '#1d4ed8',
                  cursor: 'pointer',
                }}
              >
                理由フィルタ解除 ✕
              </button>
            )}
          </div>
          <input
            type="search"
            placeholder="URL または ステータスで検索…"
            value={qFilter}
            onChange={(e) => setQFilter(e.target.value)}
            style={{
              padding: '6px 10px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              fontSize: 12,
              width: 240,
            }}
          />
        </div>

        <table className="tbl">
          <thead>
            <tr>
              <th>ステータス</th>
              <th>URL / 正規化（Canonical）</th>
              <th>カバレッジ理由</th>
              <th>sitemap送信</th>
              <th className="num">内部参照元</th>
              <th>最終クロール日時</th>
              <th>統合分析</th>
            </tr>
          </thead>
          <tbody>
            {filteredPages.map((r) => {
              const st = VERDICT_STYLE[r.verdict] || VERDICT_STYLE.NEUTRAL
              const canonicalMismatch = r.googleCanonical && r.userCanonical && r.googleCanonical !== r.userCanonical
              return (
                <tr key={r.url}>
                  <td>
                    <span
                      style={{
                        display: 'inline-block',
                        padding: '3px 8px',
                        borderRadius: 999,
                        fontSize: 11,
                        fontWeight: 700,
                        background: st.bg,
                        color: st.fg,
                      }}
                    >
                      {st.label}
                    </span>
                  </td>
                  <td>
                    <div className="mono" style={{ fontWeight: 600, color: 'var(--accent)' }}>
                      {pathOf(r.url)}
                    </div>
                    {canonicalMismatch && (
                      <div style={{ fontSize: 11, color: '#b45309', marginTop: 2 }}>
                        ⚠ Google選択 Canonical: <span className="mono">{pathOf(r.googleCanonical || '')}</span>
                      </div>
                    )}
                  </td>
                  <td>
                    <div style={{ fontWeight: 600, fontSize: 12.5 }}>{r.labelJa}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      Fetch: {r.pageFetchState} / Indexing: {r.indexingState}
                    </div>
                  </td>
                  <td>
                    {r.inSitemap ? (
                      <span style={{ color: '#059669', fontWeight: 600, fontSize: 12 }}>✓ 送信済</span>
                    ) : (
                      <span style={{ color: '#d97706', fontSize: 12 }}>未送信</span>
                    )}
                  </td>
                  <td
                    className="num"
                    style={{
                      fontWeight: r.referringCount === 0 ? 700 : 400,
                      color: r.referringCount === 0 ? '#dc2626' : undefined,
                    }}
                  >
                    {r.referringCount === 0 ? '0 (孤立)' : fmtInt(r.referringCount)}
                  </td>
                  <td className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {fmtDate(r.lastCrawlTime)}
                  </td>
                  <td>
                    <Link
                      href={`/fusion?url=${encodeURIComponent(r.url)}`}
                      style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}
                    >
                      行動×構造診断 →
                    </Link>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
