'use client'

import React, { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  dirOf,
  filterPages,
  filterQueries,
  groupDirectories,
  pathnameOf,
  rollupTotals,
  type SeoPageRow,
  type SeoPairRow,
  type SeoQueryRow,
} from '@/lib/seo/filter'

const fmtInt = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString('en-US'))
const fmtPct = (n: number | null | undefined) => (n == null ? '—' : `${(Number(n) * 100).toFixed(2)}%`)
const fmtPos = (n: number | null | undefined) => (n == null ? '—' : Number(n).toFixed(1))

function Delta({ v, invert = false, isPos = false }: { v: number | null | undefined; invert?: boolean; isPos?: boolean }) {
  if (v == null) return <span className="num">—</span>
  const good = invert ? v < 0 : v > 0
  const zero = Math.abs(v) < 0.001
  const cls = zero ? '' : good ? 'delta-up' : 'delta-down'
  const arrow = zero ? '±' : v > 0 ? '▲' : '▼'
  const txt = isPos
    ? `${arrow} ${Math.abs(v).toFixed(1)}位`
    : `${arrow} ${(Math.abs(v) * 100).toFixed(1)}%`
  return <span className={`num ${cls}`}>{txt}</span>
}

function DualLineChart({
  data,
  m1,
  m2,
  label1,
  label2,
}: {
  data: Array<Record<string, unknown>>
  m1: string
  m2: string
  label1: string
  label2: string
}) {
  if (!data?.length) return null
  const W = 880
  const H = 220
  const padL = 48
  const padR = 48
  const padT = 16
  const padB = 28
  const iw = W - padL - padR
  const ih = H - padT - padB

  const v1 = data.map((d) => Number(d[m1]) || 0)
  const v2 = data.map((d) => Number(d[m2]) || 0)
  const max1 = Math.max(...v1, 1)
  const max2 = Math.max(...v2, 1)
  const inv1 = m1 === 'position'
  const inv2 = m2 === 'position'

  const xAt = (i: number) => padL + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw)
  const y1At = (v: number) => padT + (inv1 ? (v / max1) * ih : ih - (v / max1) * ih)
  const y2At = (v: number) => padT + (inv2 ? (v / max2) * ih : ih - (v / max2) * ih)

  const p1 = v1.map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${y1At(v).toFixed(1)}`).join(' ')
  const p2 = v2.map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${y2At(v).toFixed(1)}`).join(' ')
  const area1 = `${p1} L${xAt(v1.length - 1).toFixed(1)},${padT + ih} L${xAt(0).toFixed(1)},${padT + ih} Z`

  const ticks = 4
  const step = Math.max(1, Math.floor(data.length / 7))

  return (
    <div>
      <div style={{ display: 'flex', gap: 18, fontSize: 12, marginBottom: 8, color: 'var(--text-secondary)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: '#0ea5e9' }} />
          <b style={{ color: 'var(--text-primary)' }}>{label1}</b>（左軸）
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: '#8b5cf6' }} />
          <b style={{ color: 'var(--text-primary)' }}>{label2}</b>（右軸）
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 220, display: 'block' }}>
        <defs>
          <linearGradient id="gscArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0ea5e9" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0.0" />
          </linearGradient>
        </defs>
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const y = padT + (i / ticks) * ih
          const l1 = inv1 ? ((i / ticks) * max1).toFixed(1) : Math.round((1 - i / ticks) * max1)
          const l2 = inv2 ? ((i / ticks) * max2).toFixed(1) : Math.round((1 - i / ticks) * max2)
          return (
            <g key={i}>
              <line x1={padL} x2={W - padR} y1={y} y2={y} stroke="#f1f5f9" />
              <text x={padL - 6} y={y + 4} textAnchor="end" fontSize="10" fill="#94a3b8">
                {l1}
              </text>
              <text x={W - padR + 6} y={y + 4} textAnchor="start" fontSize="10" fill="#94a3b8">
                {l2}
              </text>
            </g>
          )
        })}
        <path d={area1} fill="url(#gscArea)" />
        <path d={p1} fill="none" stroke="#0ea5e9" strokeWidth="2.2" />
        <path d={p2} fill="none" stroke="#8b5cf6" strokeWidth="2" strokeDasharray="4 3" />
        {data.map((d, i) =>
          i % step === 0 ? (
            <text key={i} x={xAt(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="#94a3b8">
              {String(d.date || '').slice(5)}
            </text>
          ) : null
        )}
      </svg>
    </div>
  )
}

interface SeoAccessData {
  source: string
  site: string
  range?: { startDate?: string; endDate?: string; days?: number }
  totals?: {
    clicks: number
    impressions: number
    ctr: number
    position: number
    clicksDelta?: number | null
    impressionsDelta?: number | null
    ctrDelta?: number | null
    positionDelta?: number | null
  }
  daily?: Array<Record<string, unknown>>
  queries?: SeoQueryRow[]
  pages?: SeoPageRow[]
  pairs?: SeoPairRow[]
  devices?: Array<{ device: string; clicks: number; impressions: number; ctr: number; position: number }>
  error?: string
}

export default function SeoAccessPage() {
  const [days, setDays] = useState(28)
  const [data, setData] = useState<SeoAccessData | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'queries' | 'pages' | 'dirs'>('queries')
  const [m1, setM1] = useState('clicks')
  const [m2, setM2] = useState('impressions')
  const [qFilter, setQFilter] = useState('')
  const [sortBy, setSortBy] = useState<'clicks' | 'impressions' | 'ctr' | 'position'>('clicks')
  const [selectedPage, setSelectedPage] = useState<string | null>(null)
  const [selectedDir, setSelectedDir] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/seo/access?days=${days}`)
      .then((r) => r.json())
      .then((j) => {
        setData(j)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [days])

  const dirs = useMemo(() => groupDirectories(data?.pages), [data])

  const filteredQueries = useMemo(() => {
    const rows = filterQueries(data?.queries, {
      dir: selectedDir,
      page: selectedPage,
      q: qFilter,
      pairs: data?.pairs,
    })
    return [...rows].sort((a, b) =>
      sortBy === 'position'
        ? (a.position || 999) - (b.position || 999)
        : (Number(b[sortBy]) || 0) - (Number(a[sortBy]) || 0)
    )
  }, [data, qFilter, sortBy, selectedDir, selectedPage])

  const filteredPages = useMemo(() => {
    const rows = filterPages(data?.pages, { dir: selectedDir, q: qFilter })
    return [...rows].sort((a, b) =>
      sortBy === 'position'
        ? (a.position || 999) - (b.position || 999)
        : (Number(b[sortBy]) || 0) - (Number(a[sortBy]) || 0)
    )
  }, [data, qFilter, sortBy, selectedDir])

  const scopedTotals = useMemo(() => {
    if (!selectedDir && !selectedPage) return null
    if (selectedPage) {
      const p = (data?.pages || []).find((x) => x.page === selectedPage)
      return p ? rollupTotals([p]) : null
    }
    return rollupTotals(filterPages(data?.pages, { dir: selectedDir }))
  }, [data, selectedDir, selectedPage])

  const metricLabel: Record<string, string> = {
    clicks: 'クリック数',
    impressions: '表示回数',
    ctr: 'CTR',
    position: '平均掲載順位',
  }

  const t = data?.totals || { clicks: 0, impressions: 0, ctr: 0, position: 0 }
  const kpi = scopedTotals || t
  const hasScope = Boolean(selectedDir || selectedPage)
  const isMock = data?.source !== 'gsc'

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1440, margin: '0 auto' }}>
      <div className="page-head">
        <div>
          <div className="breadcrumb">SEO分析 / アクセス数分析（Google Search Console）</div>
          <h1>SEO アクセス数分析</h1>
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
            {isMock ? `デモデータ（GSC未接続）` : `GSC 接続中: ${data?.site}`}
          </span>
          <div className="seg">
            {[7, 28, 90].map((d) => (
              <button key={d} className={days === d ? 'active' : ''} onClick={() => setDays(d)}>
                過去{d}日
              </button>
            ))}
          </div>
        </div>
      </div>

      {data?.error && (
        <div
          className="card"
          style={{
            marginBottom: 16,
            borderColor: '#fde68a',
            background: '#fffbeb',
            fontSize: 12,
            color: '#92400e',
          }}
        >
          GSC API エラー（デモデータへフォールバック中）: {data.error}
        </div>
      )}

      {hasScope && (
        <div
          className="card"
          style={{
            marginBottom: 14,
            padding: '10px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: '#f0f9ff',
            borderColor: '#bae6fd',
            fontSize: 12,
          }}
        >
          <span style={{ fontWeight: 600, color: '#0369a1' }}>絞り込み中:</span>
          {selectedDir && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: '#fff',
                border: '1px solid #7dd3fc',
                borderRadius: 999,
                padding: '2px 10px',
              }}
            >
              ディレクトリ: <b className="mono">{selectedDir}</b>
              <button
                onClick={() => setSelectedDir(null)}
                style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#0369a1' }}
              >
                ✕
              </button>
            </span>
          )}
          {selectedPage && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: '#fff',
                border: '1px solid #7dd3fc',
                borderRadius: 999,
                padding: '2px 10px',
              }}
            >
              ページ: <b className="mono">{pathnameOf(selectedPage)}</b>
              <button
                onClick={() => setSelectedPage(null)}
                style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#0369a1' }}
              >
                ✕
              </button>
            </span>
          )}
          <button
            onClick={() => {
              setSelectedDir(null)
              setSelectedPage(null)
            }}
            style={{
              marginLeft: 'auto',
              border: 'none',
              background: 'none',
              color: '#0369a1',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            すべて解除
          </button>
        </div>
      )}

      {/* KPI 4 cards */}
      <div className="kpi-grid" style={{ marginBottom: 20 }}>
        <div className="kpi-card">
          <div className="kpi-label">合計クリック数 {hasScope && '（絞込）'}</div>
          <div className="kpi-val">{fmtInt(kpi.clicks)}</div>
          <div className="kpi-delta">
            {hasScope ? <span className="num">全体 {fmtInt(t.clicks)}</span> : <>前期間比 <Delta v={t.clicksDelta} /></>}
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">合計表示回数 {hasScope && '（絞込）'}</div>
          <div className="kpi-val">{fmtInt(kpi.impressions)}</div>
          <div className="kpi-delta">
            {hasScope ? (
              <span className="num">全体 {fmtInt(t.impressions)}</span>
            ) : (
              <>前期間比 <Delta v={t.impressionsDelta} /></>
            )}
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">平均 CTR {hasScope && '（絞込）'}</div>
          <div className="kpi-val">{fmtPct(kpi.ctr)}</div>
          <div className="kpi-delta">
            {hasScope ? <span className="num">全体 {fmtPct(t.ctr)}</span> : <>前期間比 <Delta v={t.ctrDelta} /></>}
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">平均掲載順位 {hasScope && '（絞込）'}</div>
          <div className="kpi-val">{fmtPos(kpi.position)}</div>
          <div className="kpi-delta">
            {hasScope ? (
              <span className="num">全体 {fmtPos(t.position)}</span>
            ) : (
              <>前期間比 <Delta v={t.positionDelta} invert isPos /></>
            )}
          </div>
        </div>
      </div>

      {/* Trend + Device split */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 16, marginBottom: 20 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">検索パフォーマンス推移</div>
              <div className="card-sub">
                {data?.range?.startDate} 〜 {data?.range?.endDate}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
              <select
                value={m1}
                onChange={(e) => setM1(e.target.value)}
                style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)' }}
              >
                {Object.entries(metricLabel).map(([k, v]) => (
                  <option key={k} value={k}>
                    左軸: {v}
                  </option>
                ))}
              </select>
              <select
                value={m2}
                onChange={(e) => setM2(e.target.value)}
                style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)' }}
              >
                {Object.entries(metricLabel).map(([k, v]) => (
                  <option key={k} value={k}>
                    右軸: {v}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {loading ? (
            <div style={{ height: 220, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>
              読み込み中…
            </div>
          ) : (
            <DualLineChart
              data={data?.daily || []}
              m1={m1}
              m2={m2}
              label1={metricLabel[m1]}
              label2={metricLabel[m2]}
            />
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">デバイス別内訳</div>
              <div className="card-sub">クリック数シェア</div>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 8 }}>
            {(data?.devices || []).map((d) => {
              const share = t.clicks > 0 ? d.clicks / t.clicks : 0
              const label =
                d.device === 'MOBILE' ? 'モバイル' : d.device === 'DESKTOP' ? 'デスクトップ' : 'タブレット'
              return (
                <div key={d.device}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                    <span style={{ fontWeight: 600 }}>{label}</span>
                    <span className="num">
                      {fmtInt(d.clicks)} ({(share * 100).toFixed(0)}%)
                    </span>
                  </div>
                  <div className="bar" style={{ height: 8 }}>
                    <span style={{ width: `${Math.min(100, share * 100)}%`, background: 'var(--accent)' }} />
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 11,
                      color: 'var(--text-muted)',
                      marginTop: 3,
                    }}
                  >
                    <span>表示 {fmtInt(d.impressions)}</span>
                    <span>CTR {fmtPct(d.ctr)}</span>
                    <span>順位 {fmtPos(d.position)}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Queries / Pages / Directories table */}
      <div className="card">
        <div className="card-head" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="seg">
            <button
              className={tab === 'queries' ? 'active' : ''}
              onClick={() => {
                setTab('queries')
                setSelectedPage(null)
              }}
            >
              検索クエリ ({filteredQueries.length})
            </button>
            <button className={tab === 'pages' ? 'active' : ''} onClick={() => setTab('pages')}>
              ページ（URL） ({filteredPages.length})
            </button>
            <button className={tab === 'dirs' ? 'active' : ''} onClick={() => setTab('dirs')}>
              ディレクトリ ({dirs.length})
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select
              value={selectedDir || ''}
              onChange={(e) => {
                setSelectedDir(e.target.value || null)
                setSelectedPage(null)
              }}
              style={{
                padding: '6px 10px',
                borderRadius: 6,
                border: '1px solid var(--border)',
                fontSize: 12,
              }}
            >
              <option value="">全ディレクトリ</option>
              {dirs.map((d) => (
                <option key={d.dir} value={d.dir}>
                  {d.dir} ({d.pages}ページ / {fmtInt(d.clicks)} click)
                </option>
              ))}
            </select>
            <input
              type="search"
              placeholder={tab === 'queries' ? 'キーワードで絞り込み…' : 'URLパスで絞り込み…'}
              value={qFilter}
              onChange={(e) => setQFilter(e.target.value)}
              style={{
                padding: '6px 10px',
                borderRadius: 6,
                border: '1px solid var(--border)',
                fontSize: 12,
                width: 220,
              }}
            />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'clicks' | 'impressions' | 'ctr' | 'position')}
              style={{
                padding: '6px 10px',
                borderRadius: 6,
                border: '1px solid var(--border)',
                fontSize: 12,
              }}
            >
              <option value="clicks">並び替え: クリック数</option>
              <option value="impressions">並び替え: 表示回数</option>
              <option value="ctr">並び替え: CTR</option>
              <option value="position">並び替え: 掲載順位（上位順）</option>
            </select>
          </div>
        </div>

        {tab === 'queries' ? (
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 36 }}>#</th>
                <th>検索クエリ</th>
                <th className="num">クリック数</th>
                <th className="num">前期比</th>
                <th className="num">表示回数</th>
                <th className="num">CTR</th>
                <th className="num">平均順位</th>
                <th className="num">順位変動</th>
              </tr>
            </thead>
            <tbody>
              {filteredQueries.map((r, i) => (
                <tr key={r.query}>
                  <td className="num" style={{ color: 'var(--text-muted)' }}>
                    {i + 1}
                  </td>
                  <td style={{ fontWeight: 600 }}>{r.query}</td>
                  <td className="num" style={{ fontWeight: 700 }}>
                    {fmtInt(r.clicks)}
                  </td>
                  <td className="num">
                    <Delta v={r.clicksDelta} />
                  </td>
                  <td className="num">{fmtInt(r.impressions)}</td>
                  <td className="num">{fmtPct(r.ctr)}</td>
                  <td className="num">{fmtPos(r.position)}</td>
                  <td className="num">
                    <Delta v={r.positionDelta} invert isPos />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : tab === 'pages' ? (
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 36 }}>#</th>
                <th>ページ URL（クリックで流入クエリ・行動×構造を分析）</th>
                <th className="num">流入クエリ数</th>
                <th className="num">クリック数</th>
                <th className="num">前期比</th>
                <th className="num">表示回数</th>
                <th className="num">CTR</th>
                <th className="num">平均順位</th>
                <th>統合分析</th>
              </tr>
            </thead>
            <tbody>
              {filteredPages.map((r, i) => {
                const open = selectedPage === r.page
                return (
                  <React.Fragment key={r.page}>
                    <tr
                      onClick={() => setSelectedPage(open ? null : r.page)}
                      style={{ cursor: 'pointer', background: open ? '#f8fafc' : undefined }}
                    >
                      <td className="num" style={{ color: 'var(--text-muted)' }}>
                        {i + 1}
                      </td>
                      <td>
                        <div className="mono" style={{ fontWeight: 600, color: 'var(--accent)' }}>
                          {pathnameOf(r.page)}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          <span
                            onClick={(e) => {
                              e.stopPropagation()
                              setSelectedDir(dirOf(r.page))
                            }}
                            style={{
                              display: 'inline-block',
                              background: '#f1f5f9',
                              padding: '1px 6px',
                              borderRadius: 4,
                              marginRight: 6,
                              cursor: 'pointer',
                            }}
                            title="このディレクトリで絞り込む"
                          >
                            {dirOf(r.page)}
                          </span>
                          {r.page}
                        </div>
                      </td>
                      <td className="num">{fmtInt(r.queryCount)}</td>
                      <td className="num" style={{ fontWeight: 700 }}>
                        {fmtInt(r.clicks)}
                      </td>
                      <td className="num">
                        <Delta v={r.clicksDelta} />
                      </td>
                      <td className="num">{fmtInt(r.impressions)}</td>
                      <td className="num">{fmtPct(r.ctr)}</td>
                      <td className="num">{fmtPos(r.position)}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <Link
                          href={`/fusion?url=${encodeURIComponent(r.page)}`}
                          style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}
                        >
                          行動×構造診断 →
                        </Link>
                      </td>
                    </tr>
                    {open && r.topQueries?.length ? (
                      <tr>
                        <td />
                        <td colSpan={8} style={{ background: '#f8fafc', padding: '10px 16px' }}>
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              marginBottom: 6,
                            }}
                          >
                            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>
                              このページの主要流入クエリ Top {r.topQueries.length}
                            </div>
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                setTab('queries')
                              }}
                              style={{
                                fontSize: 11,
                                color: 'var(--accent)',
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                fontWeight: 600,
                              }}
                            >
                              このページの全クエリを検索クエリタブで見る →
                            </button>
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                            {r.topQueries.map((q) => (
                              <span
                                key={q.query}
                                style={{
                                  background: '#fff',
                                  border: '1px solid var(--border)',
                                  borderRadius: 6,
                                  padding: '4px 10px',
                                  fontSize: 12,
                                }}
                              >
                                <b>{q.query}</b>
                                <span style={{ color: 'var(--text-muted)', marginLeft: 8 }} className="num">
                                  {q.clicks} click / {q.impressions} imp / {q.position}位
                                </span>
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 36 }}>#</th>
                <th>ディレクトリ（クリックでこの配下のクエリ・ページに絞り込み）</th>
                <th className="num">ページ数</th>
                <th className="num">クリック数</th>
                <th className="num">シェア</th>
                <th className="num">表示回数</th>
                <th className="num">CTR</th>
                <th className="num">平均順位</th>
              </tr>
            </thead>
            <tbody>
              {dirs.map((d, i) => {
                const share = t.clicks > 0 ? d.clicks / t.clicks : 0
                const active = selectedDir === d.dir
                return (
                  <tr
                    key={d.dir}
                    onClick={() => {
                      setSelectedDir(active ? null : d.dir)
                      setSelectedPage(null)
                      setTab('pages')
                    }}
                    style={{ cursor: 'pointer', background: active ? '#f0f9ff' : undefined }}
                  >
                    <td className="num" style={{ color: 'var(--text-muted)' }}>
                      {i + 1}
                    </td>
                    <td>
                      <span className="mono" style={{ fontWeight: 700, color: 'var(--accent)' }}>
                        {d.dir}
                      </span>
                    </td>
                    <td className="num">{fmtInt(d.pages)}</td>
                    <td className="num" style={{ fontWeight: 700 }}>
                      {fmtInt(d.clicks)}
                    </td>
                    <td className="num" style={{ width: 160 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                        <div className="bar" style={{ width: 80, height: 6 }}>
                          <span
                            style={{ width: `${Math.min(100, share * 100)}%`, background: 'var(--accent)' }}
                          />
                        </div>
                        <span>{(share * 100).toFixed(1)}%</span>
                      </div>
                    </td>
                    <td className="num">{fmtInt(d.impressions)}</td>
                    <td className="num">{fmtPct(d.ctr)}</td>
                    <td className="num">{fmtPos(d.position)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
