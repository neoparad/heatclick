'use client'

import React, { useEffect, useState } from 'react'
import Link from 'next/link'

interface HubPage {
  url: string
  title?: string
  inbound_count: number
  outbound_count: number
  depth: number
  page_rank?: number
}

interface DirectoryStat {
  directory: string
  page_count: number
  avg_inbound: number
  avg_outbound: number
  avg_depth: number
}

interface InternalLinksResponse {
  source: string
  jobId: string
  structure: {
    total_pages: number
    max_depth: number
    orphan_count: number
    hub_pages: HubPage[]
    depth_distribution: Record<string, number>
    directory_stats: DirectoryStat[]
  }
  orphans: Array<{
    source_url: string
    description: string
  }>
  error?: string
}

export default function SeoInternalLinksPage() {
  const [data, setData] = useState<InternalLinksResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/seo/internal-links')
      .then((r) => r.json())
      .then((j) => {
        if (j.error && !j.structure) setErr(j.error)
        else setData(j)
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div style={{ padding: 24 }}>読み込み中...</div>
  if (err && !data) {
    return (
      <div style={{ padding: 24 }}>
        <div className="page-head">
          <div>
            <div className="breadcrumb">SEO分析 / 内部リンク構造</div>
            <h1>内部リンク構造（linkscrawl）</h1>
          </div>
        </div>
        <div className="card" style={{ borderColor: '#fca5a5', background: '#fef2f2' }}>
          <div style={{ fontWeight: 600, color: '#991b1b', marginBottom: 4 }}>取得エラー</div>
          <div className="mono" style={{ fontSize: 12, color: '#7f1d1d' }}>
            {err}
          </div>
        </div>
      </div>
    )
  }

  const s = data?.structure || {
    total_pages: 0,
    max_depth: 0,
    orphan_count: 0,
    hub_pages: [],
    depth_distribution: {},
    directory_stats: [],
  }
  const orphans = data?.orphans || []
  const depthEntries = Object.entries(s.depth_distribution || {}).sort((a, b) => Number(a[0]) - Number(b[0]))
  const maxDepthCount = Math.max(1, ...depthEntries.map(([, v]) => v))
  const isMock = data?.source !== 'linkscrawl'

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1440, margin: '0 auto' }}>
      <div className="page-head">
        <div>
          <div className="breadcrumb">SEO分析 / 内部リンク構造</div>
          <h1>内部リンク構造</h1>
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
            {isMock ? 'デモデータ（linkscrawl API 未接続）' : 'linkscrawl 接続中'}
          </span>
          <span className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            job: {data?.jobId}
          </span>
          <Link
            href="/aiseo/analytics/internal-links"
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--accent)',
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              background: '#fff',
            }}
          >
            内部リンク提案一覧へ →
          </Link>
        </div>
      </div>

      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">解析ページ数</div>
          <div className="kpi-val">{s.total_pages ?? 0}</div>
          <div className="kpi-delta">クロール完了ページ</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">最大クリック深度</div>
          <div className="kpi-val">{s.max_depth ?? 0}</div>
          <div className="kpi-delta">トップからの最短ホップ</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">孤立ページ（被リンク0）</div>
          <div className="kpi-val" style={{ color: (s.orphan_count || 0) > 0 ? 'var(--danger)' : undefined }}>
            {s.orphan_count ?? 0}
          </div>
          <div className="kpi-delta">内部リンクが1本も無いページ</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">ハブページ数</div>
          <div className="kpi-val">{(s.hub_pages || []).length}</div>
          <div className="kpi-delta">PageRank上位</div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">クリック深度の分布</div>
              <div className="card-sub">深さ3以下が理想（クローラビリティ目安）</div>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {depthEntries.map(([depth, count]) => (
              <div
                key={depth}
                style={{ display: 'grid', gridTemplateColumns: '72px 1fr 56px', alignItems: 'center', gap: 10 }}
              >
                <span className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  depth {depth}
                </span>
                <div className="bar">
                  <span style={{ width: `${(count / maxDepthCount) * 100}%` }} />
                </div>
                <span className="num" style={{ fontSize: 12, textAlign: 'right' }}>
                  {count}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">ディレクトリ別集計</div>
              <div className="card-sub">第1階層パスごとの平均被リンク・発リンク・深度</div>
            </div>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>ディレクトリ</th>
                <th className="num">ページ数</th>
                <th className="num">平均被</th>
                <th className="num">平均発</th>
                <th className="num">平均深度</th>
              </tr>
            </thead>
            <tbody>
              {(s.directory_stats || []).slice(0, 10).map((d) => (
                <tr key={d.directory}>
                  <td className="mono">{d.directory}</td>
                  <td className="num">{d.page_count}</td>
                  <td className="num">{d.avg_inbound}</td>
                  <td className="num">{d.avg_outbound}</td>
                  <td className="num">{d.avg_depth}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <div>
            <div className="card-title">ハブページ上位（サイト内PageRank順）</div>
            <div className="card-sub">内部リンクの起点・終点として重要なページ</div>
          </div>
        </div>
        <table className="tbl">
          <thead>
            <tr>
              <th>URL / タイトル</th>
              <th className="num">被リンク</th>
              <th className="num">発リンク</th>
              <th className="num">深度</th>
              <th className="num">PageRank</th>
              <th>統合分析</th>
            </tr>
          </thead>
          <tbody>
            {(s.hub_pages || []).map((p) => (
              <tr key={p.url}>
                <td>
                  <div style={{ fontWeight: 500 }}>{p.title || '(no title)'}</div>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {p.url}
                  </div>
                </td>
                <td className="num">{p.inbound_count}</td>
                <td className="num">{p.outbound_count}</td>
                <td className="num">{p.depth}</td>
                <td className="num">{p.page_rank?.toFixed(2) ?? '-'}</td>
                <td>
                  <Link
                    href={`/fusion?url=${encodeURIComponent(p.url)}`}
                    style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}
                  >
                    行動×構造診断 →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">孤立ページ（被リンク 0）</div>
            <div className="card-sub">サイト内から辿れないため、人間・検索・AIクローラーのすべてが見つけにくいページ</div>
          </div>
        </div>
        {orphans.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '8px 0' }}>
            孤立ページは検出されませんでした。
          </div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>URL</th>
                <th>説明</th>
                <th>統合分析</th>
              </tr>
            </thead>
            <tbody>
              {orphans.map((o, i) => (
                <tr key={i}>
                  <td className="mono">{o.source_url}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{o.description}</td>
                  <td>
                    <Link
                      href={`/fusion?url=${encodeURIComponent(o.source_url)}`}
                      style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}
                    >
                      行動×構造診断 →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
