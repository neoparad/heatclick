/**
 * 検知器の「確信度」導出（純粋ロジック・UI非依存）。
 *
 * 目的: 単一の弱いシグナル（例: no_plugins / 空UA / UAパターンのみ）だけの判定を
 *       あたかも確定であるかのように見せない。判定を支える"独立した系統"の数で確信度を決める。
 *
 * 設計思想（no_plugins問題への直接のアンチテーゼ）:
 *   同じ系統のシグナルを何本重ねても確信度は上がらない（プラグイン欠落を10個数えても1系統）。
 *   異なる系統（UA/宣言・ネットワーク・署名・アクセス挙動・構造計測・行動計測）が独立に一致して初めて "確認済み"。
 */

export type ConfidenceLevel = 'confirmed' | 'suspected' | 'insufficient'

export type SignalKind =
  | 'identity'
  | 'network'
  | 'crypto'
  | 'behavior_target'
  | 'behavior_tempo'
  | 'structure_dom'
  | 'structure_perf'
  | 'human_behavior'

export interface ConfidenceSignal {
  kind: SignalKind
  label?: string
}

export interface BlankUAProfileContext {
  notFoundRate: number
  burst: { count: number; spanMs: number; perMin: number; start: number; end: number } | null
}

export interface ConfidenceContext {
  blank?: BlankUAProfileContext | null
  hasAsn?: boolean
}

export interface RiskFlagLike {
  type?: string
  severity?: 'high' | 'med' | 'low'
  agent?: string
  category?: string
  hits?: number
  evidence?: string
  status?: string
  [key: string]: unknown
}

export type RiskFlagWithConfidence<T extends RiskFlagLike = RiskFlagLike> = T & {
  signals: ConfidenceSignal[]
  confidence: ConfidenceLevel
  confidence_reason: string
}

export const CONFIDENCE_LABEL: Record<ConfidenceLevel, string> = {
  confirmed: '確認済み',
  suspected: '単一シグナルのみ',
  insufficient: '判定材料不足',
}

export const CONFIDENCE_SHORT: Record<ConfidenceLevel, string> = {
  confirmed: '確認済み',
  suspected: '単一のみ',
  insufficient: '材料不足',
}

export const CONFIDENCE_CLASS: Record<ConfidenceLevel, string> = {
  confirmed: 'cov-ok',
  suspected: 'cov-warn',
  insufficient: 'chip',
}

const KIND_LABEL: Record<SignalKind, string> = {
  identity: 'UA/宣言',
  network: 'ネットワーク(IP/ASN)',
  crypto: '署名(Web Bot Auth)',
  behavior_target: 'アクセス対象',
  behavior_tempo: 'アクセス速度',
  structure_dom: 'DOM・ページ構造',
  structure_perf: '描画・CWV速度',
  human_behavior: '人間行動ログ',
}

/**
 * フラグ1件を支える独立シグナルを列挙する。常に配列を返す（0件でも []）。
 */
export function deriveSignals(
  flag: RiskFlagLike | null | undefined,
  ctx: ConfidenceContext = {},
): ConfidenceSignal[] {
  if (!flag || !flag.type) return []
  const agent = String(flag.agent || '')
  const isEmptyUa = agent === '(空UA)' || agent.trim() === ''
  const signals: ConfidenceSignal[] = []

  switch (flag.type) {
    case 'spoof':
      // UA が既知エージェント名を騙っている、という identity 系統1本のみ。
      // 本来 confirmed にするには network(IPレンジmismatch) か crypto(署名不一致) が要るが
      // S9 未接続のため現状は取得不能 → 必ず suspected 止まりになる（"確定"表示の過信を暴く）。
      signals.push({
        kind: 'identity',
        label: 'UAが既知エージェント名を騙っている（collector分類=spoof）',
      })
      break

    case 'scan_probe':
      // 探索対象（何を叩いたか）＝ behavior_target。
      signals.push({
        kind: 'behavior_target',
        label: '探索的パス(wp-login/.env等)への集中',
      })
      // 空UAコホートに限り、404率/バースト（どう叩いたか）＝ behavior_tempo を独立系統として加算。
      if (isEmptyUa && ctx.blank) {
        if (ctx.blank.notFoundRate >= 0.4) {
          signals.push({
            kind: 'behavior_tempo',
            label: `404率${Math.round(ctx.blank.notFoundRate * 100)}%（存在しないURLを総当り）`,
          })
        } else if (ctx.blank.burst) {
          signals.push({
            kind: 'behavior_tempo',
            label: '短時間バースト（機械的アクセス）',
          })
        }
      }
      break

    case 'unknown_ua':
      // UA が「在るが未分類」なら identity 系統1本。
      // UA が「不在(空)」なら "無いこと" を根拠にしており積極シグナルではない → 0本（材料不足）。
      if (!isEmptyUa) {
        signals.push({
          kind: 'identity',
          label: 'UA文字列が既知分類に未一致',
        })
      }
      break

    case 'known_crawler':
      signals.push({
        kind: 'identity',
        label: '既知クローラUAに一致（classify未登録）',
      })
      break

    case 'overcollection':
      signals.push({
        kind: 'behavior_target',
        label: '特定URLへの集中収集',
      })
      break

    case 'robots':
    default:
      // robots違反は enrichment(日次スナップショット×突合)未接続 → 材料なし。
      break
  }
  return signals
}

/**
 * 独立系統の数で確信度を決める（決定的）。
 *   0系統 → insufficient / 1系統 → suspected / 2系統以上 → confirmed
 * 同一系統の重複はカウントしない（Set で系統を数える）＝ no_plugins 的な水増しを防ぐ。
 */
export function scoreConfidence(
  signals: ReadonlyArray<ConfidenceSignal> | null | undefined,
): ConfidenceLevel {
  const kinds = new Set((signals || []).map((s) => s.kind))
  if (kinds.size === 0) return 'insufficient'
  if (kinds.size === 1) return 'suspected'
  return 'confirmed'
}

/**
 * なぜこの確信度なのかを1文で（ツールチップ/根拠列に出す）。断定を避けた言い回し。
 */
export function confidenceReason(
  flag: RiskFlagLike | null | undefined,
  signals: ReadonlyArray<ConfidenceSignal> | null | undefined,
): string {
  const kinds = Array.from(new Set((signals || []).map((s) => s.kind)))
  if (kinds.length === 0) {
    if (flag && flag.type === 'robots') {
      return 'robots日次スナップショット×アクセス突合が未接続のため判定材料なし。'
    }
    return '観測シグナルが1系統も揃っていない（UA不在など『無いこと』を根拠にした暫定表示）。'
  }
  const names = kinds.map((k) => KIND_LABEL[k] || k)
  if (kinds.length === 1) {
    let base = `${names[0]}の1系統のみに基づく暫定判定（要検証）。`
    if (flag && flag.type === 'spoof') {
      base += ' IPレンジ照合・署名検証(S9)が未接続のため『確定』にはできない。'
    }
    return base
  }
  return `${names.join('＋')}の${kinds.length}系統が独立して一致（相対的に確度が高い）。`
}

/**
 * フラグ配列に confidence / confidence_reason / signals を非破壊で付与。
 */
export function withConfidence<T extends RiskFlagLike>(
  flags: ReadonlyArray<T> | null | undefined,
  ctx: ConfidenceContext = {},
): Array<RiskFlagWithConfidence<T>> {
  return (flags || []).map((f) => {
    const signals = deriveSignals(f, ctx)
    return {
      ...f,
      signals,
      confidence: scoreConfidence(signals),
      confidence_reason: confidenceReason(f, signals),
    }
  })
}

export interface ConfidenceSummary {
  confirmed: number
  suspected: number
  insufficient: number
  total: number
  pct: {
    confirmed: number
    suspected: number
    insufficient: number
  }
}

/**
 * 内訳集計（確信度の横棒＋凡例用）。
 */
export function summarizeConfidence(
  flags: ReadonlyArray<{ confidence?: ConfidenceLevel }> | null | undefined,
): ConfidenceSummary {
  const c = { confirmed: 0, suspected: 0, insufficient: 0 }
  for (const f of flags || []) {
    const lv: ConfidenceLevel = f.confidence || 'insufficient'
    if (c[lv] != null) c[lv]++
  }
  const n = (flags || []).length
  const denom = n || 1
  return {
    ...c,
    total: n,
    pct: {
      confirmed: Math.round((c.confirmed / denom) * 100),
      suspected: Math.round((c.suspected / denom) * 100),
      insufficient: Math.round((c.insufficient / denom) * 100),
    },
  }
}

export interface UnknownUAGroupLike {
  raw_ua: string | null
  hits: number
  probeHits: number
  statuses?: ReadonlyArray<{ code: number; c: number }>
}

/**
 * 深掘りテーブル（正体不明UAグループ）用の軽量確信度。生UA非公開(null)は null を返す。
 */
export function groupConfidence(
  g: UnknownUAGroupLike | null | undefined,
): ConfidenceLevel | null {
  if (!g || g.raw_ua == null) return null
  const empty = String(g.raw_ua).trim() === ''
  const signals: ConfidenceSignal[] = []
  if (!empty) signals.push({ kind: 'identity' })
  if (g.probeHits > 0) signals.push({ kind: 'behavior_target' })
  const nf404 = (g.statuses || []).find((st) => Number(st.code) === 404)?.c || 0
  if (g.hits > 0 && nf404 / g.hits >= 0.4) signals.push({ kind: 'behavior_tempo' })
  return scoreConfidence(signals)
}
