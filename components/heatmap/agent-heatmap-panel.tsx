'use client'

import React, { useEffect, useState } from 'react'
import {
  AGENT_SUBTYPE_OPTIONS,
  buildAgentHybridInsights,
  fetchAgentHybridInsightsClient,
  type AgentHybridInsightsPayload,
  type AgentSubtype,
} from '@/lib/heatmap/agent-heatmap-client'

export interface AgentHeatmapPanelProps {
  siteId: string
  pageUrl: string
  device?: string
  agentSubtype: AgentSubtype
  onAgentSubtypeChange: (next: AgentSubtype) => void
  onSelectCoordinate?: (yPx: number) => void
}

type ActivePanelTab = 'summary' | 'friction' | 'crawler_overlay'

export function AgentHeatmapPanel({
  siteId,
  pageUrl,
  device = 'desktop',
  agentSubtype,
  onAgentSubtypeChange,
  onSelectCoordinate,
}: AgentHeatmapPanelProps) {
  const [insights, setInsights] = useState<AgentHybridInsightsPayload>(() =>
    buildAgentHybridInsights({ siteId, pageUrl, agentSubtype }),
  )
  const [activeTab, setActiveTab] = useState<ActivePanelTab>('friction')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    // Immediate deterministic baseline so UI is never blank
    setInsights(buildAgentHybridInsights({ siteId, pageUrl, agentSubtype }))

    const ctrl = new AbortController()
    setLoading(true)
    fetchAgentHybridInsightsClient({
      siteId,
      pageUrl,
      device,
      agentSubtype,
      signal: ctrl.signal,
    })
      .then((res) => {
        if (ctrl.signal.aborted) return
        if (res) {
          setInsights(res)
        }
        setLoading(false)
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })

    return () => ctrl.abort()
  }, [siteId, pageUrl, device, agentSubtype])

  const { summary, frictionHotspots, crawlerSectionOverlays, subtypeCounts } = insights

  return (
    <section
      data-testid="agent-heatmap-panel"
      aria-label="ブラウザ操作AIエージェント × HTTPクローラー ハイブリッド解析パネル"
      className="rounded-lg border border-violet-300 bg-gradient-to-br from-violet-50/90 via-white to-indigo-50/60 p-4 shadow-sm"
    >
      {/* Top Bar: Title + Agent Subtype Filter Pills */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-violet-200/80 pb-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-violet-700 px-2.5 py-0.5 font-mono text-[10.5px] font-bold text-white">
              🤖 Dual-Layer AI Agent Heatmap
            </span>
            <span className="font-mono text-[11px] font-semibold text-violet-900">
              Layer 1: ブラウザ操作エージェント DOMヒートマップ × Layer 2: HTTPクローラー可読性帯
            </span>
            {loading && (
              <span className="font-mono text-[10px] text-violet-600">同期中…</span>
            )}
          </div>
          <p className="mt-1 text-xs text-slate-600">
            Playwright / ChatGPT Operator / HeadlessChrome 等のブラウザ操作エージェントが「どこをクリックし・どこで操作詰まり（Dead Click）を起こしたか」と、GPTBot等のHTTPクローラーの「CSR不可視ゾーン」を重ねて診断します。
          </p>
        </div>

        {/* Subtype Selector */}
        <div
          role="radiogroup"
          aria-label="エージェント種別フィルタ"
          data-testid="agent-subtype-selector"
          className="flex flex-wrap items-center gap-1.5"
        >
          <span className="mr-1 font-mono text-[10px] font-bold uppercase tracking-wider text-violet-800">
            Agent種別:
          </span>
          {AGENT_SUBTYPE_OPTIONS.map((opt) => {
            const active = agentSubtype === opt.key
            const count = subtypeCounts?.[opt.key] ?? 0
            return (
              <button
                key={opt.key}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`agent-subtype-btn-${opt.key}`}
                onClick={() => onAgentSubtypeChange(opt.key)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ${
                  active
                    ? 'border-violet-700 bg-violet-700 text-white shadow-sm'
                    : 'border-violet-200 bg-white text-violet-900 hover:bg-violet-100/70'
                }`}
              >
                <span>{opt.shortLabel}</span>
                <span
                  className={`rounded-full px-1.5 py-0.2 font-mono text-[10px] ${
                    active ? 'bg-violet-900/60 text-violet-100' : 'bg-violet-100 text-violet-800'
                  }`}
                >
                  {count}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Not Collected Banner */}
      {insights.status === 'not_collected' && (
        <div
          data-testid="agent-panel-not-collected"
          className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600"
        >
          {insights.reason || 'ブラウザ操作型AIエージェントの実測データは未収集です (not_collected)。'}
        </div>
      )}

      {/* KPI Strip */}
      <div className="mt-3 grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <div className="rounded-md border border-violet-200 bg-white px-3 py-2">
          <div className="text-[10.5px] font-semibold text-slate-500">
            ブラウザ操作Agentセッション
          </div>
          <div
            data-testid="agent-kpi-sessions"
            className="font-mono text-lg font-extrabold text-violet-800"
          >
            {summary.totalAgentSessions.toLocaleString()} sessions
          </div>
          <div className="text-[10.5px] text-slate-500">
            総DOMクリック {summary.totalAgentClicks.toLocaleString()}回
          </div>
        </div>

        <div className="rounded-md border border-rose-200 bg-white px-3 py-2">
          <div className="text-[10.5px] font-semibold text-rose-800">
            AIエージェント操作詰まり (Dead/Rage)
          </div>
          <div
            data-testid="agent-kpi-friction"
            className="font-mono text-lg font-extrabold text-rose-600"
          >
            Dead {summary.totalDeadClicks}回 / Rage {summary.totalRageClicks}回
          </div>
          <div className="text-[10.5px] text-rose-700">
            非セマンティックDOM・オーバーレイ阻害
          </div>
        </div>

        <div className="rounded-md border border-indigo-200 bg-white px-3 py-2">
          <div className="text-[10.5px] font-semibold text-slate-500">
            Agent平均スクロール到達深度
          </div>
          <div className="font-mono text-lg font-extrabold text-indigo-700">
            {summary.avgScrollDepthPct}%
          </div>
          <div className="text-[10.5px] text-slate-500">
            上位: {summary.topAgentTypes[0]?.name.split(' ')[0] || '未収集'}
          </div>
        </div>

        <div className="rounded-md border border-amber-200 bg-white px-3 py-2">
          <div className="text-[10.5px] font-semibold text-amber-900">
            HTTPクローラー可読性ギャップ
          </div>
          <div className="font-mono text-lg font-extrabold text-amber-700">
            {
              crawlerSectionOverlays.filter((s) => s.httpCrawlerStatus !== 'extracted')
                .length
            }{' '}
            / {crawlerSectionOverlays.length} セクション要注意
          </div>
          <div className="text-[10.5px] text-amber-800">
            CSR空白地帯・見出しチャンク汚染
          </div>
        </div>
      </div>

      {/* Section Switcher Tabs */}
      <div className="mt-3.5 flex flex-wrap gap-1.5 border-b border-violet-200 pb-2">
        <button
          type="button"
          data-testid="agent-panel-tab-friction"
          onClick={() => setActiveTab('friction')}
          className={`rounded-md px-3 py-1.5 text-xs font-bold transition ${
            activeTab === 'friction'
              ? 'bg-rose-600 text-white shadow-sm'
              : 'bg-white text-slate-700 hover:bg-rose-50'
          }`}
        >
          ② AIエージェント操作詰まり / Dead-Click ({frictionHotspots.length}箇所)
        </button>
        <button
          type="button"
          data-testid="agent-panel-tab-crawler-overlay"
          onClick={() => setActiveTab('crawler_overlay')}
          className={`rounded-md px-3 py-1.5 text-xs font-bold transition ${
            activeTab === 'crawler_overlay'
              ? 'bg-emerald-700 text-white shadow-sm'
              : 'bg-white text-slate-700 hover:bg-emerald-50'
          }`}
        >
          ③ HTTP型AIクローラー × セクション可読性マップ ({crawlerSectionOverlays.length}帯域)
        </button>
        <button
          type="button"
          data-testid="agent-panel-tab-summary"
          onClick={() => setActiveTab('summary')}
          className={`rounded-md px-3 py-1.5 text-xs font-bold transition ${
            activeTab === 'summary'
              ? 'bg-violet-700 text-white shadow-sm'
              : 'bg-white text-slate-700 hover:bg-violet-50'
          }`}
        >
          ① ブラウザ操作エージェント行動サマリー＆標的CTA
        </button>
      </div>

      {/* Tab Content 1: Summary */}
      {activeTab === 'summary' && (
        <div
          data-testid="agent-panel-content-summary"
          className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2"
        >
          <div className="rounded-md border border-slate-200 bg-white p-3">
            <div className="text-xs font-bold text-slate-800">
              エージェント種別ごとのセッション内訳
            </div>
            <div className="mt-2 space-y-2">
              {summary.topAgentTypes.map((t) => (
                <div key={t.subtype} className="text-xs">
                  <div className="flex justify-between font-medium text-slate-700">
                    <span>{t.name}</span>
                    <span className="font-mono font-bold text-violet-800">
                      {t.sessions}回 ({t.sharePct}%)
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-violet-600"
                      style={{ width: `${t.sharePct}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-md border border-slate-200 bg-white p-3">
            <div className="text-xs font-bold text-slate-800">
              ブラウザ操作エージェントが標的とした主要CTA・操作成功率
            </div>
            <div className="mt-2 space-y-2">
              {summary.targetedCtas.map((cta) => (
                <div
                  key={cta.selector}
                  className="flex items-center justify-between rounded border border-slate-100 bg-slate-50 px-2.5 py-1.5 text-xs"
                >
                  <div className="min-w-0 flex-1 pr-2">
                    <div className="truncate font-semibold text-slate-800">{cta.label}</div>
                    <div className="truncate font-mono text-[10.5px] text-slate-500">
                      {cta.selector}
                    </div>
                  </div>
                  <div className="text-right font-mono">
                    <div className="font-bold text-slate-900">{cta.clicks} clicks</div>
                    <div
                      className={`text-[10.5px] font-bold ${
                        cta.successRatePct >= 75 ? 'text-emerald-600' : 'text-rose-600'
                      }`}
                    >
                      成功率 {cta.successRatePct}%
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Tab Content 2: Agent Friction / Dead Clicks */}
      {activeTab === 'friction' && (
        <div data-testid="agent-panel-content-friction" className="mt-3 space-y-2.5">
          {frictionHotspots.map((spot, idx) => (
            <div
              key={`${spot.selector}-${idx}`}
              data-testid={`agent-friction-spot-${idx}`}
              className="rounded-md border border-rose-200 bg-white p-3 shadow-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-rose-600 px-2 py-0.5 font-mono text-[10.5px] font-bold text-white">
                    Dead Click {spot.deadClickCount}回 / Rage {spot.rageClickCount}回
                  </span>
                  <span className="text-xs font-bold text-slate-900">{spot.label}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-[10.5px] text-slate-700">
                    座標: (x={spot.x}px, y={spot.y}px)
                  </span>
                  {onSelectCoordinate && (
                    <button
                      type="button"
                      onClick={() => onSelectCoordinate(spot.y)}
                      className="rounded bg-violet-100 px-2 py-0.5 text-[10.5px] font-bold text-violet-800 hover:bg-violet-200"
                    >
                      キャンバス位置へ移動 ↓
                    </button>
                  )}
                </div>
              </div>

              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-rose-800">
                  {spot.selector}
                </code>
                {spot.agentTypes.map((ag) => (
                  <span
                    key={ag}
                    className="rounded-full bg-violet-50 px-2 py-0.5 font-mono text-[10px] font-semibold text-violet-800"
                  >
                    🤖 {ag}
                  </span>
                ))}
              </div>

              <p className="mt-2 text-xs leading-relaxed text-slate-700">
                <b className="text-rose-700">詰まり原因:</b> {spot.failureReason}
              </p>
              <div className="mt-1.5 rounded bg-indigo-50/80 px-2.5 py-1.5 text-xs text-indigo-950">
                <b className="text-indigo-700">ARIA / セマンティックHTML修正処方:</b>{' '}
                {spot.fixRecommendation}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tab Content 3: HTTP Crawler Section Extractability Overlay */}
      {activeTab === 'crawler_overlay' && (
        <div data-testid="agent-panel-content-crawler-overlay" className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-600">
            <span className="inline-flex items-center gap-1 font-semibold text-emerald-700">
              <span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-500" />
              SSR取得済み (Green: HTTPクローラー完全可読)
            </span>
            <span className="inline-flex items-center gap-1 font-semibold text-rose-700">
              <span className="inline-block h-2.5 w-2.5 rounded-sm bg-rose-500" />
              CSR不可視・AI空白地帯 (Red: JS描画/画像依存で欠落)
            </span>
            <span className="inline-flex items-center gap-1 font-semibold text-amber-700">
              <span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-500" />
              チャンク汚染 (Amber: 装飾&lt;h&gt;混入・遅延ロード)
            </span>
          </div>

          {crawlerSectionOverlays.map((sec, idx) => {
            const isOk = sec.httpCrawlerStatus === 'extracted'
            const isCsr = sec.httpCrawlerStatus === 'csr_blind_spot'
            return (
              <div
                key={`${sec.sectionSelector}-${idx}`}
                data-testid={`crawler-overlay-band-${idx}`}
                className={`rounded-md border p-2.5 ${
                  isOk
                    ? 'border-emerald-200 bg-emerald-50/50'
                    : isCsr
                    ? 'border-rose-300 bg-rose-50/60'
                    : 'border-amber-300 bg-amber-50/60'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded px-2 py-0.5 font-mono text-[10px] font-bold ${
                        isOk
                          ? 'bg-emerald-600 text-white'
                          : isCsr
                          ? 'bg-rose-600 text-white'
                          : 'bg-amber-600 text-white'
                      }`}
                    >
                      {isOk
                        ? '✓ SSR取得済み (extracted)'
                        : isCsr
                        ? '✕ CSR不可視・空白地帯 (csr_blind_spot)'
                        : '⚠ チャンク汚染 (chunk_corrupted)'}
                    </span>
                    <span className="text-xs font-bold text-slate-900">{sec.headingText}</span>
                  </div>
                  <span className="font-mono text-[11px] font-semibold text-slate-600">
                    Y={sec.yStartPx}px 〜 {sec.yEndPx}px · クロール {sec.crawlHits}回
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-700">
                  <span>{sec.note}</span>
                  <div className="flex flex-wrap gap-1">
                    {sec.botNames.map((b) => (
                      <span
                        key={b}
                        className="rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-600"
                      >
                        {b}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
