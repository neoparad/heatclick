/**
 * lib/scenarios/publish-rbac.ts — Scenario publish 権限ガード (Phase 2.1、2026-06-07)
 *
 * 旧来: PUT /api/scenarios/[id] の status を誰でも 'live' に flip 可能だった。
 * Stage 3 全テナント展開前に、status='live' (公開) / 'preview' (内部公開) への昇格を
 * Owner / Admin role でのみ許可するように制限する。
 *
 * 区分:
 *   - owner   : 全 status (publish 含む) に遷移可能
 *   - admin   : 全 status (publish 含む) に遷移可能 (Owner の代理運用)
 *   - member  : draft / measure_only / paused / archived のみ。live / preview は不可。
 *   - viewer  : update 自体禁止 (PUT で 403、本 helper では writable=false で表現)
 *   - undefined: role 未設定 (旧トークン) は member と同じ扱い (fail-safe)
 *
 * REQ-SEC-010 (HIGH): publish RBAC。
 *
 * Browser 側は本 helper の挙動を mirror した同等な制限を UI で適用 (status dropdown の
 * 非表示化)、ただし server 側が authoritative。
 */

import type { JWTPayload } from '@/lib/jwt'
import type { ScenarioStatus } from './types'

export type ScenarioRole = NonNullable<JWTPayload['role']> | 'member'

/**
 * 全 role が選べる「非公開系」status。publish RBAC の影響を受けない。
 */
const NON_PUBLISH_STATUSES: ReadonlySet<ScenarioStatus> = new Set([
  'draft',
  'measure_only',
  'paused',
  'archived',
])

/**
 * publish 系 status (Owner/Admin のみ)。
 */
const PUBLISH_STATUSES: ReadonlySet<ScenarioStatus> = new Set(['live', 'preview'])

/**
 * 書込み権限を持つ role 一覧。viewer は除外。
 */
const WRITABLE_ROLES: ReadonlySet<ScenarioRole> = new Set(['owner', 'admin', 'member'])

/**
 * 配信公開 (live / preview) ができる role 一覧。
 */
const PUBLISH_ROLES: ReadonlySet<ScenarioRole> = new Set(['owner', 'admin'])

/**
 * JWT の role を ScenarioRole に正規化。
 * undefined / 不正値 → 'member' (fail-safe: 既定で publish 不可)。
 */
export function normalizeRole(role: JWTPayload['role'] | undefined): ScenarioRole {
  if (role === 'owner' || role === 'admin' || role === 'member' || role === 'viewer') {
    return role
  }
  return 'member'
}

/**
 * 任意の書込み操作が許可されているか。
 */
export function canWriteScenario(role: ScenarioRole): boolean {
  return WRITABLE_ROLES.has(role)
}

/**
 * 与えられた status へ遷移可能か。
 *
 * - viewer は何にも遷移不可
 * - member は非公開系のみ
 * - owner / admin は全 status
 */
export function canTransitionToStatus(role: ScenarioRole, status: ScenarioStatus): boolean {
  if (!canWriteScenario(role)) return false
  if (NON_PUBLISH_STATUSES.has(status)) return true
  if (PUBLISH_STATUSES.has(status)) return PUBLISH_ROLES.has(role)
  return false
}

/**
 * role が UI で選べる status 一覧 (dropdown 用)。
 */
export function listAllowedStatusesForRole(role: ScenarioRole): ScenarioStatus[] {
  const all: ScenarioStatus[] = ['draft', 'measure_only', 'preview', 'live', 'paused', 'archived']
  return all.filter((s) => canTransitionToStatus(role, s))
}

/**
 * publish 系 status か。UI などで「Owner only」バッジを出すために使う。
 */
export function isPublishStatus(status: ScenarioStatus): boolean {
  return PUBLISH_STATUSES.has(status)
}

/**
 * publish 権限 (owner / admin) を持つ role か。
 * 以下の両方を司る:
 *   - live / preview への昇格 (canTransitionToStatus 経由)
 *   - 配信中 (live / preview) scenario の「配信内容」改変 (REQ-SEC-010 HIGH)
 */
export function canPublish(role: ScenarioRole): boolean {
  return PUBLISH_ROLES.has(role)
}

/**
 * 配信に直接影響するフィールド = runtime payload に乗り visitor の挙動を変えるもの。
 * name / description / evidence_* は admin metadata で配信に影響しないため意図的に除外
 * (配信中 scenario でも member が typo 修正などはできる)。
 *
 * REQ-SEC-010 (HIGH, Codex dual review): status を変えずに live バナーの中身だけ差し替える
 * 「実質 publish」経路を塞ぐためのフィールド集合。
 */
export const DELIVERY_IMPACTING_FIELDS = [
  'variants',
  'condition_ast',
  'frequency_cap',
  'schedule',
] as const

/**
 * 更新 patch が「配信内容」を変えるか。配信中 scenario の改変ガード判定に使う。
 * `undefined` でないキーが 1 つでもあれば true (null = 明示的クリアも配信変更とみなす)。
 */
export function patchMutatesDelivery(patch: Record<string, unknown>): boolean {
  return DELIVERY_IMPACTING_FIELDS.some((f) => patch[f] !== undefined)
}

export const __test__ = {
  NON_PUBLISH_STATUSES,
  PUBLISH_STATUSES,
  WRITABLE_ROLES,
  PUBLISH_ROLES,
}
