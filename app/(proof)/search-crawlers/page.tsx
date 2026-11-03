'use client'

import { useEffect, useState } from 'react'
import { LineChart } from '@/components/aiseo/AccessCharts'
import type { CloudflareCrawlerSummary } from '@/lib/aiseo/cloudflare'
import type { AgentStat } from '@/lib/aiseo/risk'

const nf = (n: number | undefined | null) => Number(n || 0).toLocaleString('ja-JP')
const STATUS = ['2xx', '3xx', '4xx', '429', '5xx']

interface SearchCrawlersResponse {
  fetched_at: string
  site_label?: string
  cloudflare?: {
    configured: boolean
    error?: string
  } & Partial<CloudflareCrawlerSummary>
  collector?: {
    configured: boolean
    error?: string
    agents?: AgentStat[]
  }
}

export default function SearchCrawlersPage() {
  const [days, setDays] = useState(7)
  const [state, setState] = useState<{
    status: 'loading' | 'ok' | 'error'
    data?: SearchCrawlersResponse
    error?: string
  }>({ status: 'loading' })

  useEffect(() => {
    let alive = true
    setState({ status: 'loading' })
    fetch(`/api/search-crawlers?days=${days}`, { cache: 'no-store' })
      .then(async (r) => {
        const body = await r.json()
        if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`)
        return body as SearchCrawlersResponse
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
  }, [days])

  const cf = state.data?.cloudflare
  const col = state.data?.collector

  return (
    <div className="ug-page-scroll">
      <div className="wrap">
        <div className="page-header">
          <div>
            <div className="page-title">検索クローラー解析</div>
            <div className="page-subtitle">
              GoogleとBingのクローラーが、どのページをどれだけ取得し、サイトが何を返したか。
            </div>
          </div>
          <div className="seg">
            {[7, 14, 30].map((d) => (
              <button
                key={d}
                className={`seg-b${days === d ? ' on' : ''}`}
                onClick={() => setDays(d)}
              >
                {d}日
              </button>
            ))}
          </div>
        </div>

        {state.status === 'loading' && <div className="note">読み込み中…</div>}
        {state.status === 'error' && (
          <div className="err">取得できませんでした：{state.error}</div>
        )}

        {state.status === 'ok' && (
          <>
            <CloudflarePanel cf={cf} />
            <CollectorPanel col={col} />
            <div className="footnote">
              クローラー名はアクセス元が名乗った値です。Google・Bing が公表しているIPの範囲との照合は、まだ行っていません。
              Cloudflare 連携とサーバ側の記録は取得の範囲が違うため、件数を足し合わせていません。
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function CloudflarePanel({ cf }: { cf: SearchCrawlersResponse['cloudflare'] }) {
  if (!cf?.configured) {
    return (
      <div className="section">
        <div className="section-head">
          <div className="section-title">Cloudflare 連携</div>
          <span className="badge-soon">未接続</span>
        </div>
        <div className="stub-v">
          Cloudflare を使っているサイトは、読み取り専用の連携で、キャッシュが返した分も含めて集計できます。
          連携の設定画面は準備中です。現在は当社側で設定します。
        </div>
      </div>
    )
  }
  if (cf.error) {
    return (
      <div className="section">
        <div className="section-head">
          <div className="section-title">Cloudflare 連携</div>
          <span className="cov cov-bad">取得失敗</span>
        </div>
        <div className="err">{cf.error}</div>
      </div>
    )
  }
  const agents = cf.agents || []
  const daily = cf.daily || []
  const paths = cf.paths || []
  const total = agents.reduce((s, a) => s + a.hits, 0)
  const google = daily.map((d) => ({ date: d.date, value: d.Google }))
  const bing = daily.map((d) => ({ date: d.date, value: d.Bing }))
  const errs = agents.reduce(
    (s, a) => s + (a.status['5xx'] || 0) + (a.status['429'] || 0),
    0,
  )

  return (
    <>
      <div className="kpi-grid">
        <Kpi label="取得件数（合計）" value={nf(total)} />
        <Kpi
          label="Google 系"
          value={nf(
            agents.filter((a) => a.family === 'Google').reduce((s, a) => s + a.hits, 0),
          )}
        />
        <Kpi
          label="Bing 系"
          value={nf(
            agents.filter((a) => a.family === 'Bing').reduce((s, a) => s + a.hits, 0),
          )}
        />
        <Kpi label="5xx・429 を返した件数" value={nf(errs)} tone={errs ? 't-bad' : ''} />
      </div>

      <div className="section">
        <div className="section-head">
          <div className="section-title">日別の取得件数（Cloudflare）</div>
          <span className="tool">Google</span>
        </div>
        <LineChart series={google} color="var(--chart-1)" valueFmt={nf} />
        <div className="section-head" style={{ marginTop: 16 }}>
          <span />
          <span className="tool">Bing</span>
        </div>
        <LineChart series={bing} color="var(--chart-2)" valueFmt={nf} />
      </div>

      <div className="section">
        <div className="section-head">
          <div className="section-title">クローラー別・返したステータス</div>
        </div>
        <table>
          <thead>
            <tr>
              <th>クローラー</th>
              <th className="right">件数</th>
              {STATUS.map((s) => (
                <th key={s} className="right">
                  {s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {agents.length === 0 && (
              <tr>
                <td colSpan={2 + STATUS.length} className="empty">
                  この期間の取得はありません
                </td>
              </tr>
            )}
            {agents.map((a) => (
              <tr key={a.agent}>
                <td>{a.agent}</td>
                <td className="right mono">{nf(a.hits)}</td>
                {STATUS.map((s) => (
                  <td
                    key={s}
                    className={`right mono${(s === '5xx' || s === '429') && a.status[s] ? ' t-bad' : ''}`}
                  >
                    {nf(a.status[s])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section">
        <div className="section-head">
          <div className="section-title">よく取得されたパス（上位）</div>
        </div>
        <table>
          <thead>
            <tr>
              <th>パス</th>
              <th className="right">件数</th>
            </tr>
          </thead>
          <tbody>
            {paths.map((p) => (
              <tr key={p.path}>
                <td className="url-cell">{p.path}</td>
                <td className="right mono">{nf(p.hits)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function CollectorPanel({ col }: { col: SearchCrawlersResponse['collector'] }) {
  const agents = col?.agents || []
  return (
    <div className="section">
      <div className="section-head">
        <div className="section-title">サーバ側の記録（WordPress プラグイン）</div>
        {!col?.configured && <span className="badge-soon">未接続</span>}
      </div>
      {!col?.configured && <div className="stub-v">サーバ側の記録は未接続です。</div>}
      {col?.error && <div className="err">{col.error}</div>}
      {col?.configured && !col.error && (
        agents.length === 0 ? (
          <div className="stub-v">
            この期間の記録はありません。プラグイン 0.2.2（記録ルール r2）から Googlebot・Bingbot を記録します。
            それより前の版、キャッシュが返したページ、静的ファイルは記録されません。
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>クローラー</th>
                <th className="right">件数</th>
                <th className="right">URL数</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.agent}>
                  <td>{a.agent}</td>
                  <td className="right mono">{nf(a.hits)}</td>
                  <td className="right mono">{nf(a.urls_count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
    </div>
  )
}

function Kpi({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${tone}`}>{value}</div>
    </div>
  )
}
