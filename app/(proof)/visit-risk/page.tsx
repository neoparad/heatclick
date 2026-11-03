'use client'

import { useEffect, useMemo, useState } from 'react'
import { generateMockVisitRisk, type VisitRiskPayload } from '@/lib/aiseo/mock'
import {
  RISK_LABEL,
  groupUnknownUA,
  unknownFlags,
  sortFlags,
  profileBlankUA,
} from '@/lib/aiseo/risk'
import {
  withConfidence,
  summarizeConfidence,
  groupConfidence,
} from '@/lib/aiseo/confidence'
import ConfidenceBadge from '@/components/aiseo/ConfidenceBadge'

const nf = (n: number | undefined | null) => Number(n || 0).toLocaleString()

const SEV_CLASS: Record<string, string> = { high: 'cov-bad', med: 'cov-warn', low: 'chip' }
const SEV_LABEL: Record<string, string> = { high: '高', med: '中', low: '低' }

const ASN_NAME: Record<number, string> = {
  14618: 'Amazon AWS',
  16509: 'Amazon AWS',
  396982: 'Google Cloud',
  15169: 'Google',
  13335: 'Cloudflare',
  8075: 'Microsoft/Azure',
  14061: 'DigitalOcean',
  24940: 'Hetzner',
  16276: 'OVH',
  4837: 'China Unicom',
  45102: 'Alibaba',
  132203: 'Tencent',
}
const asnLabel = (asn: number) => `AS${asn}${ASN_NAME[asn] ? ' ' + ASN_NAME[asn] : ''}`
const pathOf = (u: string) => {
  try {
    return new URL(u).pathname || '/'
  } catch {
    return String(u || '/')
  }
}
const fmtTs = (ms: number) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '—')
const statusClass = (c: number) => (c >= 400 ? 'cov-bad' : c >= 300 ? 'cov-warn' : 'cov-ok')

export default function VisitRiskPage() {
  const mock = useMemo(() => generateMockVisitRisk(), [])
  const [data, setData] = useState<VisitRiskPayload>(mock)
  const [source, setSource] = useState<'mock' | 'live'>('mock')

  useEffect(() => {
    let alive = true
    fetch('/api/visit-risk?days=30', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: VisitRiskPayload | null) => {
        if (alive && d && Array.isArray(d.flags)) {
          setData(d)
          setSource(d.source === 'live' ? 'live' : 'mock')
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const unknownGroups = useMemo(
    () => groupUnknownUA(data.unknown_events || []),
    [data.unknown_events],
  )
  const uaHidden = unknownGroups.some((g) => g.raw_ua === null)

  const flags = useMemo(() => {
    const base = data.flags || []
    const hasRawUa = (data.unknown_events || []).some((e) => e.raw_ua != null)
    if (!hasRawUa) return base
    return sortFlags([
      ...base.filter((f) => f.type !== 'unknown_ua'),
      ...unknownFlags(data.unknown_events),
    ])
  }, [data.flags, data.unknown_events])

  const realFlags = flags.filter((f) => f.status === '実測')
  const scanHits = flags.filter((f) => f.type === 'scan_probe').reduce((a, f) => a + f.hits, 0)
  const s = data.summary || {
    total_hits: 0,
    unknown_hits: 0,
    spoof_count: 0,
    overcollection_count: 0,
    robots_count: 0,
  }

  const CLASSIFIED_BENIGN = new Set(['seo_crawler', 'social_unfurl', 'web_search'])
  const totalUnknown = unknownGroups.reduce((a, g) => a + g.hits, 0)
  const classifiedAgents = (data.agents || []).filter((a) =>
    CLASSIFIED_BENIGN.has(a.category || ''),
  )
  const classifiedExcluded = classifiedAgents.reduce((a, x) => a + (x.hits || 0), 0)
  const classifiedNames = classifiedAgents.map((a) => a.agent)
  const ambiguousTotal = classifiedExcluded + totalUnknown
  const classifiedPct = ambiguousTotal ? Math.round((classifiedExcluded / ambiguousTotal) * 100) : 0

  const blank = useMemo(() => profileBlankUA(data.unknown_events || []), [data.unknown_events])
  const fmtClock = (ms: number) => (ms ? new Date(ms).toISOString().slice(11, 19) : '—')

  const hasAsn = useMemo(
    () => (data.unknown_events || []).some((e) => e.asn != null),
    [data.unknown_events],
  )
  const flagsConf = useMemo(() => withConfidence(flags, { blank, hasAsn }), [flags, blank, hasAsn])
  const confSummary = useMemo(() => summarizeConfidence(flagsConf), [flagsConf])

  return (
    <div className="ug-page-scroll">
      <div className="wrap">
        <div className="page-header">
          <div>
            <div className="page-title">AI訪問 &amp; リスク</div>
            <div className="page-subtitle">
              AIアクセスの裏側のリスク：なりすまし（UA詐称）・robots違反・特定ページへの過剰収集を可視化。
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

        <div className="kpi-grid">
          <div className="kpi-card">
            <div className="kpi-label">総AIアクセス</div>
            <div className="kpi-value">{nf(s.total_hits)}</div>
            <div className="kpi-sub neutral">
              期間 {data.range?.from} 〜 {data.range?.to}
            </div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">
              正体不明UA
              <span
                className="conf-hint"
                title="この件数の多くは『UAが不明/未分類』という単一の弱い手がかりだけの暫定分類です。下表「確信度」列で内訳（確認済み/単一シグナルのみ/材料不足）を確認してください。"
              >
                ?
              </span>
            </div>
            <div
              className="kpi-value"
              style={{ color: s.unknown_hits ? 'var(--warn)' : undefined }}
            >
              {nf(s.unknown_hits)}
            </div>
            <div className="kpi-sub neutral">UA不明/未分類のヒット</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">
              なりすまし確定
              <span
                className="conf-hint"
                title="「確定」は collector の UAパターン分類のみに基づく暫定表示です。IPレンジ照合・Web Bot Auth署名検証（S9）が未接続のため、本来の意味での確定ではありません（下表の確信度は「単一シグナルのみ」）。"
              >
                ?
              </span>
            </div>
            <div
              className="kpi-value"
              style={{ color: s.spoof_count ? 'var(--linkth-danger)' : undefined }}
            >
              {nf(s.spoof_count)}
            </div>
            <div className="kpi-sub neutral">collector分類=spoof（UAのみ・暫定）</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">脆弱性スキャン</div>
            <div
              className="kpi-value"
              style={{ color: scanHits ? 'var(--linkth-danger)' : undefined }}
            >
              {nf(scanHits)}
            </div>
            <div className="kpi-sub neutral">wp-login/.env 等の探索ヒット</div>
          </div>
        </div>

        {ambiguousTotal > 0 && !uaHidden && (
          <div className="section verdict">
            <div className="verdict-lead">
              非AI訪問 <b>{nf(ambiguousTotal)}件</b> のうち、
              <b style={{ color: 'var(--ok)' }}>
                分類済み {nf(classifiedExcluded)}件（{classifiedNames.join(' / ') || '—'}）は良性
              </b>
              。残る{' '}
              <b style={{ color: 'var(--linkth-danger)' }}>正体不明 {nf(totalUnknown)}件</b> が要警戒
              （うち{' '}
              <b style={{ color: 'var(--linkth-danger)' }}>脆弱性スキャン探索 {nf(scanHits)}</b>
              、空UA含む）。
            </div>
            <div className="verdict-bar">
              <span
                className="vb-seg ok"
                style={{ width: `${classifiedPct}%` }}
                title={`分類済み(良性) ${classifiedExcluded}`}
              />
              <span
                className="vb-seg bad"
                style={{ width: `${100 - classifiedPct}%` }}
                title={`正体不明 ${totalUnknown}`}
              />
            </div>
            <div className="verdict-legend">
              <span>
                <span className="vb-dot ok" />
                分類済み・SEOクローラー/SNSプレビュー（良性） {nf(classifiedExcluded)}
              </span>
              <span>
                <span className="vb-dot bad" />
                正体不明・無申告UA {nf(totalUnknown)}
              </span>
              <span className="neutral">
                → Ahrefs・facebookexternalhit等は classify r3 で分類済み。下表は残る正体不明の深掘り
              </span>
            </div>
          </div>
        )}

        {confSummary.total > 0 && (
          <div className="section">
            <div className="section-head">
              <div className="section-title">判定の内訳（確信度）</div>
              <div className="section-tools">
                <span className="tool">全 {confSummary.total} 件のフラグ中</span>
              </div>
            </div>
            <div className="conf-bar">
              <span
                className="conf-seg confirmed"
                style={{ width: `${confSummary.pct.confirmed}%` }}
                title={`確認済み ${confSummary.confirmed}件`}
              />
              <span
                className="conf-seg suspected"
                style={{ width: `${confSummary.pct.suspected}%` }}
                title={`単一シグナルのみ ${confSummary.suspected}件`}
              />
              <span
                className="conf-seg insufficient"
                style={{ width: `${confSummary.pct.insufficient}%` }}
                title={`判定材料不足 ${confSummary.insufficient}件`}
              />
            </div>
            <div className="verdict-legend">
              <span>
                <span className="vb-dot ok" />
                確認済み（独立2系統以上が一致） {confSummary.confirmed}件
              </span>
              <span>
                <span className="vb-dot warn" />
                単一シグナルのみ（要検証） {confSummary.suspected}件
              </span>
              <span>
                <span className="vb-dot gray" />
                判定材料不足 {confSummary.insufficient}件
              </span>
            </div>
            <div className="footnote conf-caveat">
              「単一シグナルのみ」は、UAパターンなど1系統の弱い手がかりだけで判定している状態です（例：「なりすまし確定」もUA分類のみ＝ここでは単一シグナル）。断定ではなく暫定的な仮説として扱ってください。
              同じ系統の手がかりを何本重ねても確信度は上がりません。IPレンジ照合・署名検証（S9）の接続後、より多くの判定が「確認済み」に更新される予定です。
            </div>
          </div>
        )}

        <div className="section">
          <div className="section-head">
            <div className="section-title">リスクフラグ（重大度順）</div>
            <div className="section-tools">
              <span className="tool">実測 {realFlags.length} 件</span>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>種別</th>
                <th>重大度</th>
                <th>確信度</th>
                <th>エージェント</th>
                <th className="right">ヒット</th>
                <th>根拠</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody>
              {flagsConf.map((f, i) => (
                <tr key={i}>
                  <td>
                    <span
                      className={
                        'cov ' +
                        (f.type === 'spoof' || f.type === 'scan_probe'
                          ? 'cov-bad'
                          : f.type === 'robots' || f.type === 'known_crawler'
                            ? 'chip'
                            : 'cov-warn')
                      }
                    >
                      {RISK_LABEL[f.type || ''] || f.type}
                    </span>
                  </td>
                  <td>
                    <span className={'cov ' + (SEV_CLASS[f.severity || ''] || 'chip')}>
                      {SEV_LABEL[f.severity || ''] || f.severity}
                    </span>
                  </td>
                  <td>
                    <ConfidenceBadge level={f.confidence} reason={f.confidence_reason} compact />
                  </td>
                  <td className="mono">{f.agent}</td>
                  <td className="right mono">{f.hits ? nf(f.hits) : '—'}</td>
                  <td style={{ fontSize: 11, color: 'var(--linkth-muted)', lineHeight: 1.5 }}>
                    {f.evidence}
                  </td>
                  <td>
                    {f.status === '実測' ? (
                      <span className="pill-ok">実測</span>
                    ) : (
                      <span className="chip">{f.status}</span>
                    )}
                  </td>
                </tr>
              ))}
              {flagsConf.length === 0 && (
                <tr>
                  <td colSpan={7} className="empty">
                    リスクフラグなし
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="footnote">
            {source === 'live' ? 'collector の観測ログから導出（実測）。' : 'mock データ。'}
            なりすまし「確定」は collector 分類のみ（UAだけで断定しない）。robots違反は enrichment（robots日次スナップショット×アクセス突合）配信後に判定。
          </div>
        </div>

        {blank && (
          <div className="section">
            <div className="section-head">
              <div className="section-title">
                空UAの挙動プロファイル（{nf(blank.hits)}件・UAで素性が割れない要警戒コホート）
              </div>
              <div className="section-tools">
                <span className={'cov ' + (blank.verdictSev === 'high' ? 'cov-bad' : 'cov-warn')}>
                  判定: {blank.verdict}
                </span>
              </div>
            </div>
            <div className="prof-grid">
              <div className="prof-cell">
                <div className="prof-k">狙い（アクセス先の内訳）</div>
                <div className="prof-v">
                  <span className="cov cov-bad">脆弱性探索 {blank.buckets.probe}</span>
                  <span className="cov cov-warn">収集(sitemap等) {blank.buckets.collect}</span>
                  <span className="cov cov-ok">本文閲覧 {blank.buckets.content}</span>
                  <span className="chip">その他 {blank.buckets.other}</span>
                </div>
              </div>
              <div className="prof-cell">
                <div className="prof-k">探索 vs 閲覧（404率）</div>
                <div className="prof-v">
                  <b
                    style={{
                      fontSize: 20,
                      color:
                        blank.notFoundRate >= 0.4 ? 'var(--linkth-danger)' : 'var(--linkth-ink)',
                    }}
                  >
                    {Math.round(blank.notFoundRate * 100)}%
                  </b>
                  <span className="neutral">
                    {' '}
                    が404（{blank.status.notfound}/{blank.hits}）→{' '}
                    {blank.notFoundRate >= 0.4
                      ? '存在しないURLを総当り＝探索'
                      : '既存URL中心＝閲覧的'}
                  </span>
                </div>
              </div>
              <div className="prof-cell">
                <div className="prof-k">機械性（時間集中）</div>
                <div className="prof-v">
                  {blank.burst ? (
                    blank.tsSource === 'origin' ? (
                      <>
                        <b style={{ fontSize: 20, color: 'var(--linkth-danger)' }}>
                          {nf(blank.burst.count)}件
                        </b>{' '}
                        <span className="neutral">
                          / {Math.max(1, Math.round(blank.burst.spanMs / 1000))}秒に集中（約
                          {nf(blank.burst.perMin)}件/分, {fmtClock(blank.burst.start)}{' '}
                          UTC〜）＝機械的（申告観測時刻ベース）
                        </span>
                      </>
                    ) : (
                      <>
                        <b style={{ fontSize: 20, color: 'var(--linkth-danger)' }}>
                          {nf(blank.burst.count)}件
                        </b>{' '}
                        <span className="neutral">
                          が同一取込タイムスタンプ（バッチ送出＝機械的。真の到着間隔は origin_ts
                          未提供のため不明）
                        </span>
                      </>
                    )
                  ) : (
                    <span className="neutral">明確な集中なし（散発的アクセス）</span>
                  )}
                </div>
              </div>
            </div>
            {blank.topProbes.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div className="prof-k">探索された主なパス</div>
                <div className="agent-chips" style={{ marginTop: 6 }}>
                  {blank.topProbes.map(([p, c], i) => (
                    <span key={i} className="cov cov-bad mono">
                      {p} ×{c}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="section">
          <div className="section-head">
            <div className="section-title">正体不明UA の深掘り（生UA × ネットワーク）</div>
            <div className="section-tools">
              <span className="tool">
                {nf(unknownGroups.reduce((a, g) => a + g.hits, 0))} 件 / {unknownGroups.length} 種
              </span>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>推定種別</th>
                <th>生 User-Agent</th>
                <th>ネットワーク(ASN)</th>
                <th className="right">ヒット</th>
                <th>主要URL</th>
                <th>ステータス</th>
                <th>期間</th>
              </tr>
            </thead>
            <tbody>
              {unknownGroups.map((g, i) => (
                <tr key={i}>
                  <td>
                    <span
                      className={
                        'cov ' + (g.kind === 'UAなし' || g.raw_ua === '' ? 'cov-bad' : 'cov-warn')
                      }
                    >
                      {g.kind}
                    </span>
                    {g.probeHits > 0 && (
                      <span className="cov cov-bad" style={{ marginLeft: 4 }}>
                        脆弱性スキャン {g.probeHits}
                      </span>
                    )}
                    {groupConfidence(g) && (
                      <span style={{ marginLeft: 4 }}>
                        <ConfidenceBadge level={groupConfidence(g)} compact />
                      </span>
                    )}
                  </td>
                  <td
                    className="url-cell"
                    style={{
                      maxWidth: 240,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={g.label}
                  >
                    {g.label}
                  </td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {g.asns.length ? g.asns.map(asnLabel).join(', ') : '—'}
                  </td>
                  <td className="right mono">{nf(g.hits)}</td>
                  <td style={{ fontSize: 11 }}>
                    {g.topUrls.map((u, j) => (
                      <div key={j} className="mono" style={{ color: 'var(--linkth-muted)' }}>
                        {pathOf(u.url)} <span className="neutral">×{u.c}</span>
                      </div>
                    ))}
                  </td>
                  <td>
                    <div className="agent-chips">
                      {g.statuses.map((st, j) => (
                        <span key={j} className={'cov ' + statusClass(st.code)}>
                          {st.code}×{st.c}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="mono" style={{ fontSize: 10, color: 'var(--linkth-muted)' }}>
                    {fmtTs(g.firstTs)}
                    <br />〜{fmtTs(g.lastTs)}
                  </td>
                </tr>
              ))}
              {unknownGroups.length === 0 && (
                <tr>
                  <td colSpan={7} className="empty">
                    正体不明UAのアクセスはありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
