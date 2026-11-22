'use client'

import React, { useMemo, useState } from 'react'
import Link from 'next/link'
import {
  runHypothesisTest,
  type HypothesisTestResult,
  type HypothesisVerdict,
} from '@/lib/experiments/hypothesis-testing'

export interface SegmentBreakdown {
  segment: string
  badge: string
  controlSessions: number
  controlCv: number
  variantSessions: number
  variantCv: number
}

export interface HypothesisExperimentItem {
  id: string
  code: string
  title: string
  hypothesisH1: string
  nullHypothesisH0: string
  sourcePrescription: {
    module: 'サイトドック' | 'M Agent' | 'ページ速度分析' | 'ページパフォーマンス分析'
    href: string
    issueCode: string
    reason: string
  }
  targetUrl: string
  primaryMetricLabel: string
  mdeRelative: number
  controlSessions: number
  controlConversions: number
  variantSessions: number
  variantConversions: number
  segments: SegmentBreakdown[]
}

const PRESCRIPTION_TEMPLATES = [
  {
    id: 'tpl-fv-cta',
    module: 'ページパフォーマンス分析' as const,
    issueCode: 'Friction Hotspot × CTA導線改善',
    title: 'H1: ファーストビュー直下へのマイクロCTA設置による途中離脱抑制・CVR改善',
    targetUrl: '/',
    hypothesisH1:
      '比較検討セクション直下にアンカー付きマイクロCTAを設置することで、非リンク領域のデッドクリックを吸収しCVRを引き上げる',
    mdeRelative: 0.25,
  },
  {
    id: 'tpl-m-agent-ai',
    module: 'M Agent' as const,
    issueCode: '迷い(Hesitation)シグナル × 要約介入',
    title: 'H1: AI検索流入ユーザーへの「要点3行＋比較表ジャンプ」バナー介入',
    targetUrl: '/',
    hypothesisH1:
      'AI参照元から着地しスクロール速度が低下した訪問者に要約CTAバナーを表示し、CVRを改善する',
    mdeRelative: 0.25,
  },
  {
    id: 'tpl-sitedoc-cls',
    module: 'サイトドック' as const,
    issueCode: 'IMG寸法明示 × モバイル固定CTA',
    title: 'H1: 画像のwidth/height明示によるCLS低減とモバイル固定CTAバーによる誤タップ解消',
    targetUrl: '/',
    hypothesisH1:
      '未指定画像にwidth/heightを適用しモバイル固定CTAを出すことで、誤タップ離脱を防ぎコンバージョン完了率を改善する',
    mdeRelative: 0.2,
  },
]

const VERDICT_BADGE: Record<
  HypothesisVerdict,
  { label: string; bg: string; fg: string; border: string }
> = {
  significant_winner: {
    label: '有意に改善 (Winner / H0棄却)',
    bg: '#ecfdf5',
    fg: '#065f46',
    border: '#6ee7b7',
  },
  underpowered: {
    label: '検出力不足 / 計測待機中 (Power Gate 保留)',
    bg: '#fffbeb',
    fg: '#92400e',
    border: '#fcd34d',
  },
  significant_loser: {
    label: '有意に悪化 (Loser / 停止推奨)',
    bg: '#fef2f2',
    fg: '#991b1b',
    border: '#fca5a5',
  },
  inconclusive: {
    label: '有意差なし (H0棄却できず)',
    bg: '#f8fafc',
    fg: '#334155',
    border: '#cbd5e1',
  },
}

export function HypothesisAbDashboard({
  siteId,
  initialExperiments = [],
}: {
  siteId: string
  initialExperiments?: HypothesisExperimentItem[]
}) {
  const [items, setItems] = useState<HypothesisExperimentItem[]>(initialExperiments)
  const [selectedId, setSelectedId] = useState<string>(initialExperiments[0]?.id ?? '')

  // インタラクティブ検出力・必要サンプルサイズ計算機用state（実測データとは独立した計算ツール）
  const [simControlN, setSimControlN] = useState(1000)
  const [simControlCv, setSimControlCv] = useState(30)
  const [simVariantN, setSimVariantN] = useState(1000)
  const [simVariantCv, setSimVariantCv] = useState(40)
  const [simMdePct, setSimMdePct] = useState(25)

  const selected = useMemo(
    () => items.find((x) => x.id === selectedId) ?? items[0] ?? null,
    [items, selectedId],
  )

  const selectedTest: HypothesisTestResult | null = useMemo(
    () =>
      selected
        ? runHypothesisTest({
            controlSessions: selected.controlSessions,
            controlConversions: selected.controlConversions,
            variantSessions: selected.variantSessions,
            variantConversions: selected.variantConversions,
            mdeRelative: selected.mdeRelative,
          })
        : null,
    [selected],
  )

  const simResult: HypothesisTestResult = useMemo(
    () =>
      runHypothesisTest({
        controlSessions: simControlN,
        controlConversions: simControlCv,
        variantSessions: simVariantN,
        variantConversions: simVariantCv,
        mdeRelative: simMdePct / 100,
      }),
    [simControlN, simControlCv, simVariantN, simVariantCv, simMdePct],
  )

  const createFromPrescription = (tpl: (typeof PRESCRIPTION_TEMPLATES)[number]) => {
    const newId = `exp-hyp-${Date.now()}`
    const newItem: HypothesisExperimentItem = {
      id: newId,
      code: `EXP-DRAFT-${items.length + 1}`,
      title: tpl.title,
      hypothesisH1: tpl.hypothesisH1,
      nullHypothesisH0: 'H0（帰無仮説）: Control群とVariant群のCVRに母集団上の差はない（p_v = p_c）',
      sourcePrescription: {
        module: tpl.module,
        href: tpl.module === 'サイトドック' ? '/site-doc' : tpl.module === 'M Agent' ? '/scenarios' : '/fusion',
        issueCode: tpl.issueCode,
        reason: `${tpl.module} の診断処方箋から起票（実測トラフィック収集前: 0 sessions）`,
      },
      targetUrl: tpl.targetUrl,
      primaryMetricLabel: 'CVR（コンバージョン率）',
      mdeRelative: tpl.mdeRelative,
      controlSessions: 0,
      controlConversions: 0,
      variantSessions: 0,
      variantConversions: 0,
      segments: [],
    }
    setItems((prev) => [newItem, ...prev])
    setSelectedId(newId)
    setSimMdePct(Math.round(tpl.mdeRelative * 100))
  }

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-indigo-600">
              <span>Hypothesis-Tested A/B Testing Engine</span>
              <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-[11px] font-bold text-indigo-700">
                Two-Proportion Z-Test · 95% CI · Power Gate (1-β ≥ 80%)
              </span>
            </div>
            <h1 className="mt-1 text-xl font-bold text-slate-900">
              統計的仮説検定付き A/Bテスト（偽陽性防止 Power Gate 搭載）
            </h1>
            <p className="mt-1 text-xs text-slate-600">
              サイトドック・ページ速度分析・M Agent の処方箋から仮説（H1）を起票し、
              両側 p値・95%信頼区間・統計的検出力（1-β）で効果を検証します。対象サイト:{' '}
              <code className="font-mono font-semibold text-slate-800">{siteId}</code>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/scenarios"
              className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
            >
              M Agent シナリオへ →
            </Link>
            <Link
              href="/site-doc"
              className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
            >
              サイトドック処方箋へ →
            </Link>
          </div>
        </div>

        {/* One-Click Hypothesis Templates from Prescriptions */}
        <div className="mt-4 rounded-lg border border-indigo-100 bg-indigo-50/50 p-3.5">
          <div className="text-xs font-bold text-indigo-950">
            ⚡ 診断処方箋テンプレートから仮説ドラフト（初期値 0 sessions / 未計測）を作成:
          </div>
          <div className="mt-2 grid grid-cols-1 gap-2.5 md:grid-cols-3">
            {PRESCRIPTION_TEMPLATES.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                onClick={() => createFromPrescription(tpl)}
                className="flex flex-col justify-between rounded-lg border border-indigo-200/80 bg-white p-3 text-left transition hover:border-indigo-500 hover:shadow-sm"
              >
                <div>
                  <div className="flex items-center justify-between gap-1">
                    <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-bold text-indigo-800">
                      {tpl.module}
                    </span>
                    <span className="font-mono text-[10px] text-slate-500">{tpl.targetUrl}</span>
                  </div>
                  <div className="mt-1.5 text-xs font-bold text-slate-900 line-clamp-2">{tpl.title}</div>
                </div>
                <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-1.5 text-[11px] font-semibold text-indigo-600">
                  <span>{tpl.issueCode}</span>
                  <span>ドラフト起票 ＋</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {items.length === 0 || !selected || !selectedTest ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center shadow-sm">
          <div className="text-sm font-bold text-slate-800">
            実測A/Bテストデータはまだ収集されていません（not_collected）
          </div>
          <p className="mt-1.5 text-xs text-slate-600">
            対象サイト（<code className="font-mono">{siteId}</code>）で稼働中または集計済みの実験データはありません。
            上の処方箋テンプレートから仮説ドラフトを作成するか、M Agent シナリオ配信を開始すると実測セッション・CV数が反映されます。
          </p>
        </div>
      ) : (
        <>
          {/* Experiment Selector Cards */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {items.map((item) => {
              const res = runHypothesisTest({
                controlSessions: item.controlSessions,
                controlConversions: item.controlConversions,
                variantSessions: item.variantSessions,
                variantConversions: item.variantConversions,
                mdeRelative: item.mdeRelative,
              })
              const vb = VERDICT_BADGE[res.verdict]
              const isSelected = item.id === selected.id
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(item.id)
                    if (item.controlSessions > 0 || item.variantSessions > 0) {
                      setSimControlN(item.controlSessions)
                      setSimControlCv(item.controlConversions)
                      setSimVariantN(item.variantSessions)
                      setSimVariantCv(item.variantConversions)
                    }
                    setSimMdePct(Math.round(item.mdeRelative * 100))
                  }}
                  style={{
                    borderColor: isSelected ? '#4f46e5' : undefined,
                    boxShadow: isSelected ? '0 0 0 2px rgba(79,70,229,0.18)' : undefined,
                  }}
                  className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-4 text-left transition hover:border-slate-300"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-bold text-slate-500">{item.code}</span>
                      <span
                        style={{
                          background: vb.bg,
                          color: vb.fg,
                          border: `1px solid ${vb.border}`,
                        }}
                        className="rounded-full px-2 py-0.5 text-[10.5px] font-bold"
                      >
                        {vb.label}
                      </span>
                    </div>
                    <div className="mt-2 text-sm font-bold text-slate-900">{item.title}</div>
                    <div className="mt-1 font-mono text-xs text-slate-500">{item.targetUrl}</div>
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-2 border-t border-slate-100 pt-2.5 text-xs">
                    <div>
                      <div className="text-[10px] text-slate-400">相対リフト</div>
                      <div
                        className={`font-mono font-bold ${
                          res.relativeLiftPct > 0 ? 'text-emerald-600' : 'text-slate-700'
                        }`}
                      >
                        {res.relativeLiftPct > 0 ? '+' : ''}
                        {res.relativeLiftPct}%
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-400">両側 p値</div>
                      <div className="font-mono font-bold text-slate-800">
                        {res.pValue < 0.001 ? '<0.001' : res.pValue.toFixed(3)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-400">検出力 (1-β)</div>
                      <div className="font-mono font-bold text-slate-800">
                        {(res.statisticalPower * 100).toFixed(0)}%
                      </div>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>

          {/* Selected Experiment Deep Hypothesis Detail */}
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs font-bold text-slate-700">
                    {selected.code}
                  </span>
                  <span className="font-mono text-xs text-indigo-600">{selected.targetUrl}</span>
                  <Link
                    href={selected.sourcePrescription.href}
                    className="text-xs font-semibold text-slate-500 underline hover:text-indigo-600"
                  >
                    起点処方箋: {selected.sourcePrescription.module} ({selected.sourcePrescription.issueCode})
                  </Link>
                </div>
                <h2 className="text-lg font-bold text-slate-900">{selected.title}</h2>
                <p className="text-xs font-medium text-slate-700">{selected.hypothesisH1}</p>
                <p className="text-[11px] text-slate-500">{selected.nullHypothesisH0}</p>
              </div>
              <div
                style={{
                  background: VERDICT_BADGE[selectedTest.verdict].bg,
                  color: VERDICT_BADGE[selectedTest.verdict].fg,
                  border: `1px solid ${VERDICT_BADGE[selectedTest.verdict].border}`,
                }}
                className="rounded-xl px-4 py-2.5 text-right"
              >
                <div className="text-xs font-bold">{VERDICT_BADGE[selectedTest.verdict].label}</div>
                <div className="mt-0.5 font-mono text-xs">
                  Z = {selectedTest.zScore.toFixed(2)} / p ={' '}
                  {selectedTest.pValue < 0.0001 ? '< 0.0001' : selectedTest.pValue.toFixed(4)}
                </div>
              </div>
            </div>

            {/* Verdict Banner */}
            <div
              style={{
                background: VERDICT_BADGE[selectedTest.verdict].bg,
                borderColor: VERDICT_BADGE[selectedTest.verdict].border,
                color: VERDICT_BADGE[selectedTest.verdict].fg,
              }}
              className="rounded-xl border p-4"
            >
              <div className="text-sm font-bold">{selectedTest.verdictHeadline}</div>
              <div className="mt-1 text-xs leading-relaxed opacity-90">{selectedTest.verdictSummary}</div>
            </div>

            {/* 4 Statistical Pillars */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                <div className="text-xs font-semibold text-slate-500">Control群 (現状 A)</div>
                <div className="mt-1 font-mono text-2xl font-bold text-slate-900">
                  {(selectedTest.control.cvr * 100).toFixed(2)}%
                </div>
                <div className="mt-1 font-mono text-xs text-slate-500">
                  {selectedTest.control.conversions.toLocaleString()} CV /{' '}
                  {selectedTest.control.sessions.toLocaleString()} sessions
                </div>
              </div>

              <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4">
                <div className="text-xs font-semibold text-indigo-700">Variant群 (施策 B)</div>
                <div className="mt-1 font-mono text-2xl font-bold text-indigo-950">
                  {(selectedTest.variant.cvr * 100).toFixed(2)}%
                </div>
                <div className="mt-1 font-mono text-xs text-indigo-700">
                  {selectedTest.variant.conversions.toLocaleString()} CV /{' '}
                  {selectedTest.variant.sessions.toLocaleString()} sessions
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                <div className="text-xs font-semibold text-slate-500">相対リフト & 95%信頼区間</div>
                <div
                  className={`mt-1 font-mono text-2xl font-bold ${
                    selectedTest.relativeLiftPct > 0 ? 'text-emerald-600' : 'text-slate-800'
                  }`}
                >
                  {selectedTest.relativeLiftPct > 0 ? '+' : ''}
                  {selectedTest.relativeLiftPct}%
                </div>
                <div className="mt-1 font-mono text-xs text-slate-600">
                  95% CI: [{selectedTest.relativeCi95LowPct > 0 ? '+' : ''}
                  {selectedTest.relativeCi95LowPct}%, {selectedTest.relativeCi95HighPct > 0 ? '+' : ''}
                  {selectedTest.relativeCi95HighPct}%]
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                <div className="text-xs font-semibold text-slate-500">検出力 (1-β) & サンプル到達率</div>
                <div className="mt-1 font-mono text-2xl font-bold text-slate-900">
                  {(selectedTest.statisticalPower * 100).toFixed(1)}%
                </div>
                <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="h-full rounded-full bg-indigo-600 transition-all"
                    style={{ width: `${selectedTest.sampleProgressPct}%` }}
                  />
                </div>
                <div className="mt-1 font-mono text-[11px] text-slate-500">
                  到達率 {selectedTest.sampleProgressPct}% (目標 {selectedTest.requiredSessionsPerArm.toLocaleString()}
                  /群)
                </div>
              </div>
            </div>

            {selected.segments.length > 0 && (
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600">
                  セグメント別仮説検定
                </h3>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full border-collapse text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                        <th className="py-2 px-3">流入セグメント</th>
                        <th className="py-2 px-3 text-right">Control CVR</th>
                        <th className="py-2 px-3 text-right">Variant CVR</th>
                        <th className="py-2 px-3 text-right">相対リフト</th>
                        <th className="py-2 px-3 text-right">95% 信頼区間</th>
                        <th className="py-2 px-3 text-right">両側 p値</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.segments.map((seg) => {
                        const segRes = runHypothesisTest({
                          controlSessions: seg.controlSessions,
                          controlConversions: seg.controlCv,
                          variantSessions: seg.variantSessions,
                          variantConversions: seg.variantCv,
                        })
                        return (
                          <tr key={seg.segment} className="border-b border-slate-100">
                            <td className="py-2.5 px-3 font-semibold text-slate-800">
                              <span>{seg.segment}</span>
                              <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">
                                {seg.badge}
                              </span>
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono">
                              {(segRes.control.cvr * 100).toFixed(2)}% ({seg.controlCv}/{seg.controlSessions})
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono font-semibold text-indigo-900">
                              {(segRes.variant.cvr * 100).toFixed(2)}% ({seg.variantCv}/{seg.variantSessions})
                            </td>
                            <td
                              className={`py-2.5 px-3 text-right font-mono font-bold ${
                                segRes.relativeLiftPct >= 0 ? 'text-emerald-600' : 'text-rose-600'
                              }`}
                            >
                              {segRes.relativeLiftPct >= 0 ? '+' : ''}
                              {segRes.relativeLiftPct}%
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono text-slate-600">
                              [{segRes.relativeCi95LowPct}%, +{segRes.relativeCi95HighPct}%]
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono">
                              {segRes.pValue < 0.001 ? '< 0.001' : segRes.pValue.toFixed(3)}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* Interactive Statistical Power & Hypothesis Test Simulator */}
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-slate-900">
              🔬 仮説検定・必要サンプルサイズ試算ツール（シミュレーション計算機 — 実測値ではありません）
            </h3>
            <p className="text-xs text-slate-600">
              任意の想定セッション数・CV数を入力して、p値・95%信頼区間・検出力ゲート（偽陽性ガード）を試算できます。
            </p>
          </div>
          <span
            style={{
              background: VERDICT_BADGE[simResult.verdict].bg,
              color: VERDICT_BADGE[simResult.verdict].fg,
              border: `1px solid ${VERDICT_BADGE[simResult.verdict].border}`,
            }}
            className="rounded-full px-3 py-1 text-xs font-bold"
          >
            試算判定: {VERDICT_BADGE[simResult.verdict].label}
          </span>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-5">
          <label className="block text-xs">
            <span className="font-semibold text-slate-700">想定 Control セッション (n_c)</span>
            <input
              type="number"
              min={1}
              value={simControlN}
              onChange={(e) => setSimControlN(Number(e.target.value) || 0)}
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs"
            />
          </label>
          <label className="block text-xs">
            <span className="font-semibold text-slate-700">想定 Control CV数 (cv_c)</span>
            <input
              type="number"
              min={0}
              value={simControlCv}
              onChange={(e) => setSimControlCv(Number(e.target.value) || 0)}
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs"
            />
          </label>
          <label className="block text-xs">
            <span className="font-semibold text-slate-700">想定 Variant セッション (n_v)</span>
            <input
              type="number"
              min={1}
              value={simVariantN}
              onChange={(e) => setSimVariantN(Number(e.target.value) || 0)}
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs"
            />
          </label>
          <label className="block text-xs">
            <span className="font-semibold text-slate-700">想定 Variant CV数 (cv_v)</span>
            <input
              type="number"
              min={0}
              value={simVariantCv}
              onChange={(e) => setSimVariantCv(Number(e.target.value) || 0)}
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs"
            />
          </label>
          <label className="block text-xs">
            <span className="font-semibold text-slate-700">目標MDE (相対改善%)</span>
            <input
              type="number"
              min={5}
              max={200}
              value={simMdePct}
              onChange={(e) => setSimMdePct(Number(e.target.value) || 20)}
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs"
            />
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white p-3 text-xs border border-slate-200">
          <div>
            <b>試算結果:</b> {simResult.verdictHeadline}
          </div>
          <div className="font-mono text-slate-700">
            Lift: <b>{simResult.relativeLiftPct >= 0 ? '+' : ''}{simResult.relativeLiftPct}%</b> · p ={' '}
            <b>{simResult.pValue.toFixed(4)}</b> · Power ={' '}
            <b>{(simResult.statisticalPower * 100).toFixed(1)}%</b> · 必要サンプル/群:{' '}
            <b>{simResult.requiredSessionsPerArm.toLocaleString()}</b>
          </div>
        </div>
      </div>
    </div>
  )
}
