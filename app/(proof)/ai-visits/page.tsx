'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { CrawlerAcquisitionDrawer } from '@/components/aiseo/crawler-acquisition-drawer'
import { checkDeclarationFiles, looksLikeCoverageGap } from '@/lib/aiseo/declaration-files'
import type { AnalyticsPayload } from '@/lib/aiseo/mock'
import type { AgentStat } from '@/lib/aiseo/risk'

const CAT_LABEL: Record<string, string> = {
  rag_fetcher: 'RAGフェッチャー',
  training_crawler: '学習クローラー',
  agent_executor: '実行エージェント',
  search_crawler: 'AI検索クローラー',
  web_search: 'Web検索エンジン',
  seo_crawler: 'SEOクローラー',
  social_unfurl: 'SNSプレビュー',
  spoof: 'なりすまし',
}

const CAT_CHIP: Record<string, string> = {
  rag_fetcher: 'rag',
  training_crawler: 'train',
  agent_executor: 'exec',
  spoof: 'spoof',
}

function categoryFor(agent: string, agentsList: ReadonlyArray<AgentStat>): string {
  const m = agentsList.find((a) => a.agent === agent)
  return m?.category || ''
}

export default function AiVisitsPage() {
  const [state, setState] = useState<{
    status: 'loading' | 'ok' | 'error'
    data?: AnalyticsPayload
    error?: string
  }>({ status: 'loading' })
  const [inspectUrl, setInspectUrl] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetch('/api/analytics', { cache: 'no-store' })
      .then(async (r) => {
        const body = await r.json()
        if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`)
        return body as AnalyticsPayload
      })
      .then((data) => alive && setState({ status: 'ok', data }))
      .catch((e: unknown) =>
        alive &&
        setState({
          status: 'error',
          error: e instanceof Error ? e.message : String(e),
        }),
      )
    return () => {
      alive = false
    }
  }, [])

  const data = state.data
  const urls = data?.urls?.urls ?? []
  const agents = data?.agents?.agents ?? []
  const dates = data?.urls?.period?.dates ?? []
  const totalHits = agents.reduce((s, a) => s + a.hits, 0)
  const maxHits = urls.reduce((m, u) => Math.max(m, u.hits), 0) || 1
  const catCounts = agents.reduce<Record<string, number>>((acc, a) => {
    const c = a.category || 'unknown'
    acc[c] = (acc[c] || 0) + 1
    return acc
  }, {})
  const catSummary = Object.entries(catCounts)
    .map(([c, n]) => `${CAT_LABEL[c] || c}:${n}`)
    .join(' / ')
  const declFiles = checkDeclarationFiles(urls)
  const coverageGap = looksLikeCoverageGap(declFiles)

  return (
    <div className="ug-page-scroll">
      <div className="wrap">
        <div className="page-header">
          <div>
            <div className="page-title">AIアクセス解析</div>
            <div className="page-subtitle">
              どのAI／エージェントが・どのページを・どれだけ読んだか。URLをクリックすると4面統合診断（行動×構造×検索×AI）へ遷移します。
            </div>
          </div>
          <div className="meta">
            {data?.source === 'live' ? (
              <span className="badge-live">● collector live</span>
            ) : (
              <span className="badge-staging">● staging 速報 / mock</span>
            )}
            <span className="site">◍ {data?.site_label || 'bihadashop.jp'}</span>
          </div>
        </div>

        {state.status === 'loading' && <div className="note">読み込み中…</div>}

        {state.status === 'error' && (
          <div className="err">
            <b>取得失敗:</b> {state.error}
            <div className="err-hint">
              collector が起動しているか、環境変数 AIRECEIPT_COLLECTOR_URL / AIRECEIPT_READ_KEY を確認してください。
            </div>
          </div>
        )}

        {state.status === 'ok' && (
          <>
            <div className="kpi-grid">
              <div className="kpi-card">
                <div className="kpi-label">AIアクセス総数</div>
                <div className="kpi-value">{totalHits.toLocaleString()}</div>
                <div className="kpi-sub neutral">取得リクエスト数</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">対象ページ数</div>
                <div className="kpi-value">{urls.length}</div>
                <div className="kpi-sub neutral">ユニークURL</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">ユニークAgent</div>
                <div className="kpi-value">{agents.length}</div>
                <div className="kpi-sub neutral">{catSummary || '—'}</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">集計期間</div>
                <div className="kpi-value" style={{ fontSize: 14 }}>
                  {dates.join(' 〜 ') || '—'}
                </div>
                <div className="kpi-sub neutral">
                  ruleset {data?.urls?.ruleset_version || '—'}
                </div>
              </div>
            </div>

            <div className="section">
              <div className="section-head">
                <div className="section-title">宣言ファイル到達確認</div>
                <div className="section-tools">
                  <span className="tool">AIが llms.txt / aimap.json 等を実際に取得したか</span>
                </div>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>ファイル</th>
                    <th>到達</th>
                    <th className="right">ヒット</th>
                    <th>主要エージェント</th>
                  </tr>
                </thead>
                <tbody>
                  {declFiles.map((d) => (
                    <tr key={d.path}>
                      <td className="url-cell">{d.label}</td>
                      <td>
                        {d.hit ? (
                          <span className="pill-ok">取得あり</span>
                        ) : (
                          <span className="pill-off">未取得</span>
                        )}
                      </td>
                      <td className="right mono">{d.hit ? d.hits : '—'}</td>
                      <td>
                        <div className="agent-chips">
                          {d.topAgents.map((a) => (
                            <span
                              key={a.agent}
                              className={`chip ${CAT_CHIP[categoryFor(a.agent, agents)] || ''}`}
                            >
                              {a.agent} {a.count}
                            </span>
                          ))}
                          {d.topAgents.length === 0 && <span className="neutral">—</span>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="footnote">
                {coverageGap
                  ? '陽性対照（robots.txt/sitemap.xml）も未取得＝この期間は計測自体が薄い可能性。「AIが宣言ファイルを無視している」と断定しない。'
                  : '陽性対照（robots.txt/sitemap.xml）は取得されている前提での「target」列の未取得＝実際にAIがそのファイルを取りに来ていないと解釈できる。'}
                対象パスは collector が既に持つ URL別データをフィルタしているだけ（新規データ源なし）。
              </div>
            </div>

            <div className="section">
              <div className="section-head">
                <div className="section-title">ページ別（クリックで取得内容・取りこぼしを検査）</div>
                <div className="section-tools">
                  <span className="tool">AIアクセス順 ▼</span>
                </div>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>ページ</th>
                    <th className="right">AIアクセス</th>
                    <th>主要エージェント</th>
                    <th className="right">取得内容・4面診断</th>
                  </tr>
                </thead>
                <tbody>
                  {urls.map((u) => (
                    <tr
                      key={u.url}
                      className={`clickrow ${inspectUrl === u.url ? 'sel' : ''}`}
                      onClick={() => u.url && setInspectUrl(u.url)}
                      data-testid={`ai-visit-url-row-${u.url}`}
                    >
                      <td className="url-cell">{u.url || '(空)'}</td>
                      <td className="right barcell">
                        <span className="b" style={{ width: `${(u.hits / maxHits) * 100}%` }} />
                        <span className="v">{u.hits}</span>
                      </td>
                      <td>
                        <div className="agent-chips">
                          {(u.top_agents || []).map((a) => (
                            <span
                              key={a.agent}
                              className={`chip ${CAT_CHIP[categoryFor(a.agent, agents)] || ''}`}
                            >
                              {a.agent} {a.count}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="right">
                        <div className="inline-flex flex-wrap items-center justify-end gap-1.5">
                          <button
                            type="button"
                            data-testid={`inspect-acquisition-btn-${u.url}`}
                            onClick={(e) => {
                              e.stopPropagation()
                              if (u.url) setInspectUrl(u.url)
                            }}
                            className="chip train"
                            style={{
                              cursor: 'pointer',
                              border: '1px solid rgba(91, 71, 194, 0.28)',
                              fontWeight: 600,
                            }}
                          >
                            🔍 取得内容を検査 (何が取得されたか)
                          </button>
                          <Link
                            href={`/fusion?url=${encodeURIComponent(u.url)}`}
                            onClick={(e) => e.stopPropagation()}
                            className="chip rag"
                            style={{ textDecoration: 'none' }}
                          >
                            行動×構造×AI →
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {urls.length === 0 && (
                    <tr>
                      <td colSpan={4} className="empty">
                        データなし
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="section">
              <div className="section-head">
                <div className="section-title">エージェント別</div>
                <div className="section-tools">
                  <span className="tool">AIアクセス順 ▼</span>
                </div>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>エージェント</th>
                    <th>種別</th>
                    <th className="right">AIアクセス</th>
                    <th className="right">対象ページ数</th>
                  </tr>
                </thead>
                <tbody>
                  {agents.map((a) => {
                    const cat = a.category || 'unknown'
                    return (
                      <tr key={a.agent}>
                        <td className="mono">{a.agent}</td>
                        <td>
                          <span className={`cat cat-${CAT_CHIP[cat] || 'train'}`}>
                            {CAT_LABEL[cat] || cat}
                          </span>
                        </td>
                        <td className="right mono">{a.hits}</td>
                        <td className="right mono">{a.urls_count ?? 0}</td>
                      </tr>
                    )
                  })}
                  {agents.length === 0 && (
                    <tr>
                      <td colSpan={4} className="empty">
                        データなし
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              <div className="footnote">
                staging 速報＝未署名・未確定。確定証拠は WORM＋日次署名（proof）後。取得＝{data?.fetched_at}
              </div>
            </div>
          </>
        )}

        <CrawlerAcquisitionDrawer
          open={Boolean(inspectUrl)}
          url={inspectUrl}
          siteId={data?.site_label?.replace(/\s*\(mock\)\s*$/, '') || 'default'}
          onClose={() => setInspectUrl(null)}
        />
      </div>
    </div>
  )
}
