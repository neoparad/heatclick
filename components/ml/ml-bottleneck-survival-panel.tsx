'use client'

import React from 'react'
import type {
  BottleneckAttributionResult,
  KaplanMeierScrollSurvivalResult,
} from '@/lib/ml/pragmatic-ml-engine'

const CATEGORY_BADGE: Record<
  string,
  { label: string; bg: string; fg: string }
> = {
  speed: { label: '表示速度 (Speed)', bg: '#e0f2fe', fg: '#0369a1' },
  ux_friction: { label: 'UI摩擦 (Friction)', bg: '#fef2f2', fg: '#991b1b' },
  cta_layout: { label: 'CTA導線 (CTA)', bg: '#ede9fe', fg: '#5b21b6' },
  form: { label: 'フォーム摩擦 (Form)', bg: '#ffedd5', fg: '#9a3412' },
  structure: { label: '文書構造 (Structure)', bg: '#f1f5f9', fg: '#334155' },
  aiseo: { label: 'AI抽出適性 (AISEO)', bg: '#dcfce7', fg: '#166534' },
}

export interface MlBottleneckSurvivalPanelProps {
  bottleneckAttribution: BottleneckAttributionResult
  scrollSurvival: KaplanMeierScrollSurvivalResult
  methodologyNote?: string
}

export function MlBottleneckSurvivalPanel({
  bottleneckAttribution,
  scrollSurvival,
  methodologyNote,
}: MlBottleneckSurvivalPanelProps) {
  const topFactors = bottleneckAttribution.factors.slice(0, 6)
  const maxImportance = Math.max(
    1,
    ...topFactors.map((f) => f.relativeImportancePct),
  )
  const steepestCliff = scrollSurvival.steepestCliff

  return (
    <div
      className="card"
      style={{
        marginBottom: 22,
        border: '1.5px solid #93c5fd',
        background: 'linear-gradient(180deg, #f8fafc 0%, #ffffff 100%)',
      }}
    >
      <div
        className="card-head"
        style={{ borderBottom: '1px solid #e2e8f0', paddingBottom: 12 }}
      >
        <div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <span
              style={{
                padding: '3px 10px',
                borderRadius: 999,
                background: '#0f172a',
                color: '#fff',
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              Explainable Pragmatic ML Engine · 統計的因果帰属
            </span>
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 999,
                background:
                  bottleneckAttribution.modelConfidence === 'high'
                    ? '#dcfce7'
                    : '#fef3c7',
                color:
                  bottleneckAttribution.modelConfidence === 'high'
                    ? '#166534'
                    : '#92400e',
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              Model Confidence: {bottleneckAttribution.modelConfidence.toUpperCase()}
            </span>
          </div>
          <div className="card-title" style={{ fontSize: 17, marginTop: 6 }}>
            SHAP 構造×行動ボトルネック寄与度ランキング ＆ Kaplan-Meier スクロール生存分析
          </div>
          {methodologyNote && (
            <div className="card-sub" style={{ marginTop: 2 }}>
              {methodologyNote}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div
            style={{
              padding: '8px 14px',
              borderRadius: 10,
              background: '#eff6ff',
              border: '1px solid #bfdbfe',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: 10, fontWeight: 700, color: '#1e40af' }}>
              SHAP 最適改修時 CVR予測
            </div>
            <div
              className="mono"
              style={{ fontSize: 17, fontWeight: 800, color: '#1e3a8a' }}
            >
              {(bottleneckAttribution.baselineCvr * 100).toFixed(2)}% →{' '}
              {(bottleneckAttribution.predictedOptimalCvr * 100).toFixed(2)}%
            </div>
          </div>

          <div
            style={{
              padding: '8px 14px',
              borderRadius: 10,
              background: scrollSurvival.isSignificant ? '#ecfdf5' : '#f8fafc',
              border: `1px solid ${scrollSurvival.isSignificant ? '#6ee7b7' : '#cbd5e1'}`,
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: 10, fontWeight: 700, color: '#065f46' }}>
              Log-Rank 生存曲線差検定
            </div>
            <div
              className="mono"
              style={{ fontSize: 15, fontWeight: 800, color: '#064e3b' }}
            >
              χ²={scrollSurvival.logRankStat.toFixed(1)} · p=
              {scrollSurvival.pValue < 0.001
                ? '< 0.001'
                : scrollSurvival.pValue.toFixed(4)}{' '}
              {scrollSurvival.isSignificant ? '(有意 p<0.05)' : '(非有意)'}
            </div>
          </div>
        </div>
      </div>

      <div className="grid-2" style={{ marginTop: 14, gap: 16 }}>
        {/* Left: SHAP Bottleneck Attribution Ranking */}
        <div
          style={{
            background: '#fff',
            borderRadius: 10,
            padding: 16,
            border: '1px solid var(--border)',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 14 }}>
              ① SHAP 構造×行動ボトルネック寄与度ランキング
            </div>
            <span className="mono" style={{ fontSize: 11, color: '#64748b' }}>
              80+特徴量キャリブレーション
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {topFactors.map((factor, idx) => {
              const cat =
                CATEGORY_BADGE[factor.category] || CATEGORY_BADGE.structure
              const widthPct = Math.min(
                100,
                Math.max(8, (factor.relativeImportancePct / maxImportance) * 100),
              )
              return (
                <div
                  key={factor.featureKey}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 8,
                    background: idx === 0 ? '#fffbeb' : '#f8fafc',
                    border:
                      idx === 0 ? '1px solid #fde68a' : '1px solid #e2e8f0',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                      <span
                        className="mono"
                        style={{
                          fontSize: 11,
                          fontWeight: 800,
                          color: idx === 0 ? '#b45309' : '#334155',
                        }}
                      >
                        #{idx + 1}
                      </span>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '1px 6px',
                          borderRadius: 4,
                          background: cat.bg,
                          color: cat.fg,
                        }}
                      >
                        {cat.label}
                      </span>
                      <span style={{ fontWeight: 700, fontSize: 12.5 }}>
                        {factor.label}
                      </span>
                    </div>

                    <div
                      className="mono"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 11.5,
                      }}
                    >
                      <span style={{ color: '#dc2626', fontWeight: 700 }}>
                        SHAP影響度 ({factor.shapImpactCvrPct.toFixed(2)}% pt)
                      </span>
                      <span
                        style={{
                          padding: '1px 6px',
                          borderRadius: 4,
                          background: '#dcfce7',
                          color: '#166534',
                          fontWeight: 700,
                        }}
                      >
                        改善時の期待CVリフト (+{factor.expectedRelativeLiftPct}%)
                      </span>
                    </div>
                  </div>

                  {/* Horizontal SHAP bar */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      marginTop: 6,
                    }}
                  >
                    <div
                      className="bar"
                      style={{ flex: 1, height: 8, background: '#e2e8f0' }}
                    >
                      <span
                        style={{
                          width: `${widthPct}%`,
                          background:
                            idx === 0
                              ? 'linear-gradient(90deg, #dc2626, #f59e0b)'
                              : '#3b82f6',
                        }}
                      />
                    </div>
                    <span
                      className="mono"
                      style={{
                        fontSize: 11,
                        color: '#475569',
                        minWidth: 165,
                        textAlign: 'right',
                      }}
                    >
                      実測: <b>{factor.observedValue}</b> / 基準: {factor.benchmarkValue}
                    </span>
                  </div>

                  <div
                    style={{
                      fontSize: 11.5,
                      color: '#334155',
                      marginTop: 6,
                      lineHeight: 1.5,
                    }}
                  >
                    <b style={{ color: '#2563eb' }}>処方箋:</b>{' '}
                    {factor.prescription}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Right: Kaplan-Meier Scroll Survival Analysis & Hazard Cliff */}
        <div
          style={{
            background: '#fff',
            borderRadius: 10,
            padding: 16,
            border: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 8,
            }}
          >
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>
                ② Kaplan-Meier スクロール生存分析 ＆ 離脱の崖 (Hazard Cliff)
              </div>
              <div style={{ fontSize: 11.5, color: '#64748b', marginTop: 2 }}>
                非CV群50%離脱Y座標:{' '}
                <b className="mono" style={{ color: '#dc2626' }}>
                  Y={scrollSurvival.medianNonConverterDropoffYpx.toLocaleString()}px
                </b>{' '}
                · S(y) = ∏(1 - dᵢ/nᵢ)
              </div>
            </div>
            <span
              className="mono"
              style={{
                padding: '3px 8px',
                borderRadius: 6,
                background: scrollSurvival.isSignificant ? '#dcfce7' : '#f1f5f9',
                color: scrollSurvival.isSignificant ? '#166534' : '#475569',
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              Log-Rank p ={' '}
              {scrollSurvival.pValue < 0.001
                ? '< 0.001'
                : scrollSurvival.pValue.toFixed(4)}
            </span>
          </div>

          {steepestCliff && (
            <div
              style={{
                padding: '10px 12px',
                borderRadius: 8,
                background: '#fef2f2',
                border: '1px solid #fecaca',
                fontSize: 12,
              }}
            >
              <div style={{ fontWeight: 700, color: '#991b1b' }}>
                ⚠ 最大の離脱の崖 (Steepest Hazard Cliff): {steepestCliff.sectionLabel}
              </div>
              <div style={{ color: '#7f1d1d', marginTop: 3, fontSize: 11.5 }}>
                {steepestCliff.diagnosis}（生存率ギャップ ΔS(y) ={' '}
                <b>{(steepestCliff.survivalGap * 100).toFixed(1)}pt</b>）
              </div>
            </div>
          )}

          <table className="tbl" style={{ fontSize: 11.5 }}>
            <thead>
              <tr>
                <th>Y座標 / セクション</th>
                <th style={{ width: 150 }}>CV群 vs 非CV群 S(y)</th>
                <th className="num">CV群 S(y)</th>
                <th className="num">非CV群 S(y)</th>
                <th className="num">非CVハザード</th>
              </tr>
            </thead>
            <tbody>
              {scrollSurvival.convertersCurve.map((cvPt, idx) => {
                const nonCvPt =
                  scrollSurvival.nonConvertersCurve[idx] || cvPt
                const isCliff =
                  steepestCliff && steepestCliff.yPx === nonCvPt.yPx
                const cvPct = Math.round(cvPt.survivalRate * 100)
                const nonCvPct = Math.round(nonCvPt.survivalRate * 100)
                return (
                  <tr
                    key={cvPt.yPx}
                    style={{
                      background: isCliff ? '#fef2f2' : undefined,
                    }}
                  >
                    <td>
                      <div
                        className="mono"
                        style={{
                          fontWeight: isCliff ? 700 : 600,
                          color: isCliff ? '#991b1b' : '#1e293b',
                        }}
                      >
                        {cvPt.sectionLabel}
                      </div>
                      {isCliff && (
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            color: '#dc2626',
                          }}
                        >
                          ★ Hazard Cliff (離脱急増区間)
                        </span>
                      )}
                    </td>
                    <td>
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 3,
                        }}
                      >
                        <div
                          className="bar"
                          style={{ height: 6, background: '#e2e8f0' }}
                          title={`CV群生存率 ${cvPct}%`}
                        >
                          <span
                            style={{
                              width: `${cvPct}%`,
                              background: '#10b981',
                            }}
                          />
                        </div>
                        <div
                          className="bar"
                          style={{ height: 6, background: '#e2e8f0' }}
                          title={`非CV群生存率 ${nonCvPct}%`}
                        >
                          <span
                            style={{
                              width: `${nonCvPct}%`,
                              background: isCliff ? '#dc2626' : '#64748b',
                            }}
                          />
                        </div>
                      </div>
                    </td>
                    <td
                      className="num"
                      style={{ color: '#059669', fontWeight: 700 }}
                    >
                      {cvPct}%
                    </td>
                    <td
                      className="num"
                      style={{
                        color: nonCvPct < 40 ? '#dc2626' : '#334155',
                        fontWeight: 700,
                      }}
                    >
                      {nonCvPct}%
                    </td>
                    <td
                      className="num"
                      style={{
                        color:
                          nonCvPt.hazardRate >= 0.2 ? '#dc2626' : '#64748b',
                        fontWeight: nonCvPt.hazardRate >= 0.2 ? 700 : 400,
                      }}
                    >
                      {(nonCvPt.hazardRate * 100).toFixed(1)}%
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
