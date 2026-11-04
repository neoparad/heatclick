'use client'

import { useEffect, useMemo, useState } from 'react'
import { CrawlerAcquisitionDrawer } from '@/components/aiseo/crawler-acquisition-drawer'
import { generateMockJourney, type JourneyPayload } from '@/lib/aiseo/mock'
import {
  buildJourneys,
  summarizeJourneys,
  pathOf,
  fmtTime,
  fmtDuration,
  eventTs,
} from '@/lib/aiseo/journey'

const nf = (n: number | undefined | null) => Number(n || 0).toLocaleString()
const CAT_LABEL: Record<string, string> = {
  rag_fetcher: 'RAGフェッチャー',
  training_crawler: '学習クローラー',
  agent_executor: '実行エージェント',
  search_crawler: 'AI検索クローラー',
  web_search: 'Web検索エンジン',
  seo_crawler: 'SEOクローラー',
  social_unfurl: 'SNSプレビュー',
  spoof: 'なりすまし',
  unknown: '不明',
}

function statusClass(code: number | undefined): string {
  const c = Number(code) || 200
  if (c >= 500) return 'cov-bad'
  if (c >= 400) return 'cov-bad'
  if (c >= 300) return 'cov-warn'
  return 'cov-ok'
}

export default function AgentJourneyPage() {
  const mock = useMemo(() => generateMockJourney(), [])
  const [data, setData] = useState<JourneyPayload>(mock)
  const [source, setSource] = useState<'mock' | 'live'>('mock')
  const [picked, setPicked] = useState<string | null>(null)
  const [inspectUrl, setInspectUrl] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetch('/api/journey?days=30', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: JourneyPayload | null) => {
        if (alive && d && Array.isArray(d.events)) {
          setData(d)
          setSource(d.source === 'live' ? 'live' : 'mock')
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const agents = data.agents || []
  const LEGIT = new Set([
    'rag_fetcher',
    'training_crawler',
    'agent_executor',
    'search_crawler',
    'web_search',
  ])
  const defaultAgent =
    (agents.find((a) => LEGIT.has(a.category || '')) || agents[0])?.agent || null
  const activeAgent = picked && agents.some((a) => a.agent === picked) ? picked : defaultAgent
  const activeMeta = agents.find((a) => a.agent === activeAgent)

  const sessions = useMemo(
    () => (activeAgent ? buildJourneys(data.events, activeAgent) : []),
    [data.events, activeAgent],
  )
  const sum = useMemo(() => summarizeJourneys(sessions), [sessions])

  return (
    <div className="ug-page-scroll">
      <div className="wrap">
        <div className="page-header">
          <div>
            <div className="page-title">エージェント・ジャーニー</div>
            <div className="page-subtitle">
              1体のAIエージェントが、サイト内をどう辿って何を読んだかの動線。時系列をセッション化して再現。
            </div>
          </div>
          <div className="meta">
            {source === 'live' ? (
              <span className="badge-live">● collector live</span>
            ) : (
              <span className="badge-staging">● mock（collector未接続）</span>
            )}
            <span className="site">◍ {data.site_label}</span>
          </div>
        </div>

        <div className="section">
          <div className="section-head">
            <div className="section-title">エージェントを選択</div>
            <div className="section-tools">
              <span className="tool">
                期間 {data.range?.from} 〜 {data.range?.to}
                {data.truncated ? '・一部省略' : ''}
              </span>
            </div>
          </div>
          <div className="cond-form">
            <select
              className="ctl grow"
              value={activeAgent || ''}
              onChange={(e) => setPicked(e.target.value)}
            >
              {agents.map((a) => (
                <option key={a.agent} value={a.agent}>
                  {a.agent}（{CAT_LABEL[a.category || ''] || a.category || '—'}・{a.hits}件）
                </option>
              ))}
              {agents.length === 0 && <option>エージェントなし</option>}
            </select>
          </div>
          <div className="footnote">
            セッション = 連続アクセスの間隔が30分以内のまとまり（collector に session_id が無いため時間ギャップで復元）。
          </div>
        </div>

        <div className="kpi-grid">
          <div className="kpi-card">
            <div className="kpi-label">種別</div>
            <div className="kpi-value" style={{ fontSize: 16 }}>
              {CAT_LABEL[activeMeta?.category || ''] || activeMeta?.category || '—'}
            </div>
            <div className="kpi-sub neutral">{activeAgent || '—'}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">セッション数</div>
            <div className="kpi-value">{nf(sum.sessionCount)}</div>
            <div className="kpi-sub neutral">来訪回数</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">取得ページ</div>
            <div className="kpi-value">{nf(sum.totalPages)}</div>
            <div className="kpi-sub neutral">ユニーク {nf(sum.uniquePages)}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">最終来訪</div>
            <div className="kpi-value" style={{ fontSize: 13 }}>
              {sum.lastTs ? fmtTime(sum.lastTs) : '—'}
            </div>
            <div className="kpi-sub neutral">
              初回 {sum.firstTs ? fmtTime(sum.firstTs).slice(0, 10) : '—'}
            </div>
          </div>
        </div>

        {sessions.map((s) => (
          <div className="section" key={s.id}>
            <div className="section-head">
              <div className="section-title">
                セッション #{s.id}{' '}
                <span className="neutral" style={{ fontWeight: 400, fontSize: 11 }}>
                  — {fmtTime(s.startTs)}
                </span>
              </div>
              <div className="section-tools">
                <span className="tool">
                  {s.pages}ページ / 滞在 {fmtDuration(s.durationMs)}
                </span>
              </div>
            </div>
            <div className="jrny">
              {s.steps.map((st, i) => (
                <div
                  className="jrny-step clickrow"
                  key={i}
                  data-testid={`journey-step-${s.id}-${i}`}
                  onClick={() => st.url && setInspectUrl(st.url)}
                  style={{ borderRadius: 8, padding: '4px 6px' }}
                >
                  <div className="jrny-rail">
                    <span className="jrny-num">{i + 1}</span>
                    {i < s.steps.length - 1 && <span className="jrny-line" />}
                  </div>
                  <div className="jrny-body">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="jrny-url">{pathOf(st.url)}</div>
                      {st.url && (
                        <button
                          type="button"
                          data-testid={`journey-inspect-btn-${s.id}-${i}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (st.url) setInspectUrl(st.url)
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
                      )}
                    </div>
                    <div className="jrny-meta">
                      <span className={'cov ' + statusClass(st.status_code)}>
                        {st.status_code}
                      </span>
                      <span className="chip">{st.claim || '—'}</span>
                      <span className="neutral mono" style={{ fontSize: 10 }}>
                        {fmtTime(eventTs(st)).slice(11)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="footnote">
              入口 <span className="mono">{pathOf(s.entry)}</span> → 離脱{' '}
              <span className="mono">{pathOf(s.exit)}</span>
            </div>
          </div>
        ))}
        {sessions.length === 0 && (
          <div className="section">
            <div className="empty">このエージェントの動線データがありません</div>
          </div>
        )}

        <CrawlerAcquisitionDrawer
          open={Boolean(inspectUrl)}
          url={inspectUrl}
          siteId={data.site_label?.replace(/\s*\(mock\)\s*$/, '') || 'default'}
          onClose={() => setInspectUrl(null)}
        />
      </div>
    </div>
  )
}
