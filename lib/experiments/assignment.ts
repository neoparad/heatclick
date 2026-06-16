/**
 * 宝プロジェクト — サーバー権威 arm 割付 (M2, T1, requirement B)
 *
 * Reference:
 *   - handoff/2026-06-10-ugokimap-treasure-ab-pooling-module.md §作る5コンポーネント #3 (サーバー割付)
 *   - decisions.md D-12 / project memory project-treasure-ab-pooling-stream
 *
 * 設計 (フロントから上書き不可):
 *   - arm = HMAC(secret salt → 実験別 key, visitor_id) → 厳密 50/50。**サーバー側のみ**で計算する。
 *   - secret salt (EXPERIMENT_ASSIGN_SALT) を client は知らない → 望む arm を offline 計算できない。
 *   - **計測 (M3) も同じ computeArm で arm を再計算**する。これにより control 割付の visitor が
 *     treatment として計上されることが原理的に起きない (client の申告 arm は参考値で、信頼しない)。
 *   - salt_version で salt ローテーション可。実験ごとに固定、running 後は不変 (registry の locked field)。
 *   - 純関数 (computeArm) は割付・計測の唯一の真実 (single source of assignment truth)。
 *
 * ⚠️ SECURITY — visitor_id の信頼境界 (Codex T1 review CRITICAL):
 *   computeArm は visitor_id を安定した principal として扱う。visitor_id が **生のクライアント
 *   cookie (__ugk_vid)** の場合、悪意ある visitor は cookie を回し直して望む arm に入れる
 *   (arm-stuffing、平均 ~2 回)。これは「同一 visitor_id を別 arm に偽装」はできない (計測も同関数で
 *   再計算するため) が、**新規 ID を量産して片 arm へ寄せる Sybil** は可能。
 *   → 完全防御は本純関数ではなく **層** で行う (本モジュールは前提を明示するに留める):
 *     - M2b endpoint: visitor_id を検証 (isValidVisitorId)、可能なら server-minted/署名 vid へ移行。
 *     - M3 計測: bot / 自動化を is_agent で除外。
 *     - M5 pooling: プールの単位は **visitor ではなく SITE** (K≥24 独立サイト) + τ²/I² 異質性 +
 *       outlier サイト除外。単一サイト / 単一 visitor では cross-customer corpus を汚染できない
 *       (鉄則「単一サイトで因果断定しない」)。
 */

import { createHmac } from 'node:crypto'

export const ARMS = ['control', 'treatment'] as const
export type Arm = (typeof ARMS)[number]

// 32-bit hash < HALF → control。2^32 は偶数なので **厳密 50/50** (modulo bias なし)。
const HALF = 0x8000_0000 // 2^31
// 観測用 bucket の粒度 (0.01%)。arm 判定には使わない (arm は HALF 比較で厳密 50/50)。
const BUCKET_MODULUS = 10_000

export interface ComputeArmParams {
  experimentId: string
  visitorId: string
  /** server secret (EXPERIMENT_ASSIGN_SALT)。client には決して出さない。 */
  salt: string
  /** 割付 salt のローテーション世代 (experiments.salt_version)。 */
  saltVersion: number
}

/**
 * 実験別 key を secret salt から派生 (KDF 風)。salt が secret かつ高エントロピーである限り、
 * 非秘密の experimentId / saltVersion を混ぜても安全 (HMAC は PRF)。
 */
function deriveExperimentKey(salt: string, experimentId: string, saltVersion: number): Buffer {
  return createHmac('sha256', salt).update(`exp:${experimentId}:v${saltVersion}`).digest()
}

/** visitor の 32-bit ハッシュ (派生 key で HMAC)。arm / bucket の共通の素。 */
function rawHash(params: ComputeArmParams): number {
  const key = deriveExperimentKey(params.salt, params.experimentId, params.saltVersion)
  return createHmac('sha256', key).update(params.visitorId).digest().readUInt32BE(0)
}

/** 観測用 bucket [0, BUCKET_MODULUS)。診断 / 将来の非 50/50 split 用 (arm 判定には未使用)。 */
export function assignmentBucket(params: ComputeArmParams): number {
  return rawHash(params) % BUCKET_MODULUS
}

/** visitor の arm をサーバー側で決定論的に計算 (厳密 50/50)。割付と計測の唯一の真実。 */
export function computeArm(params: ComputeArmParams): Arm {
  return rawHash(params) < HALF ? 'control' : 'treatment'
}

/** arm → variant ラベル (control=A / treatment=B)。events / scenario_match へ emit する際に使用。 */
export function armToVariantId(arm: Arm): 'A' | 'B' {
  return arm === 'control' ? 'A' : 'B'
}

// ── visitor_id hygiene (M2b endpoint 用、grinding は防げない = identity-binding が別途必要) ──
const VISITOR_ID_RE = /^[A-Za-z0-9_.:-]{8,128}$/

/** 空 / 過長 / 制御文字 / 異常 ID を弾く最低限の境界 (arm-stuffing への完全防御ではない)。 */
export function isValidVisitorId(visitorId: unknown): visitorId is string {
  return typeof visitorId === 'string' && VISITOR_ID_RE.test(visitorId)
}

// ── env salt accessor (fail-closed) ──────────────────────────────────────────

export class AssignSaltMissingError extends Error {
  constructor() {
    super(
      'EXPERIMENT_ASSIGN_SALT is missing or weak (need >= 32 chars, >= 8 distinct, no surrounding whitespace; ' +
        'generate via `openssl rand -hex 32`)',
    )
    this.name = 'AssignSaltMissingError'
  }
}

const MIN_SALT_LENGTH = 32 // ~>= 128-bit entropy 相当を最低限 (Codex HIGH)
const MIN_SALT_DISTINCT = 8 // '0000…' のような低エントロピー既定値を拒否

/** EXPERIMENT_ASSIGN_SALT を env から取得。未設定 / 弱い salt は fail-closed (silent な弱割付を許さない)。 */
export function getAssignSalt(): string {
  const salt = process.env.EXPERIMENT_ASSIGN_SALT
  if (
    typeof salt !== 'string' ||
    salt.length < MIN_SALT_LENGTH ||
    salt.trim() !== salt ||
    new Set(salt).size < MIN_SALT_DISTINCT
  ) {
    throw new AssignSaltMissingError()
  }
  return salt
}

/** env salt を使って arm を計算 (endpoint / 計測の実呼び出し口)。 */
export function assignArm(experimentId: string, visitorId: string, saltVersion: number): Arm {
  return computeArm({ experimentId, visitorId, salt: getAssignSalt(), saltVersion })
}
