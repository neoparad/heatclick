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
 * publish中 (live / preview) scenario への non-publish role による「status 単独降格 patch」か。
 *
 * 中庸ポリシー (Codex T1 dual review 指摘 HIGH 1 反映、2026-06-07):
 *   member 等 publish 権限を持たない role でも、公開中 scenario を「停止する」運用は
 *   できるべき。よって patch が `{ status: <非publish系> }` 1 key のみのとき *だけ* 許す。
 *   他 field を同時に変える patch は拒否 (内容書き換えを伴う公開停止は owner/admin に依頼)。
 */
export function isStatusOnlyDemotePatch(patch: Record<string, unknown>): boolean {
  const keys = Object.keys(patch)
  if (keys.length !== 1 || keys[0] !== 'status') return false
  const next = patch.status as ScenarioStatus
  return NON_PUBLISH_STATUSES.has(next)
}

export type RbacVerdict = { allowed: true } | { allowed: false; reason: string }

/**
 * 既存 scenario への PUT patch が role 的に許可されるか。
 *
 *   1. viewer        → 不可 (canWriteScenario が落とす)
 *   2. owner / admin → 可 (status 遷移先は別途 canTransitionToStatus でチェック)
 *   3. member / role 不明:
 *      - 既存 status が非 publish (draft/measure_only/paused/archived) → 可
 *      - 既存 status が publish (live/preview) → status 単独降格 patch のみ可
 *
 * REQ-SEC-010 (HIGH): 既存 status を見ずに body だけで認可していた boundary 漏れを塞ぐ
 * (Codex T1 dual review HIGH 1 反映)。
 */
export function canPatchExistingScenario(
  role: ScenarioRole,
  currentStatus: ScenarioStatus,
  patch: Record<string, unknown>,
): RbacVerdict {
  if (!canWriteScenario(role)) {
    return { allowed: false, reason: 'viewer は scenario を更新できません' }
  }
  if (PUBLISH_ROLES.has(role)) {
    return { allowed: true }
  }
  if (!isPublishStatus(currentStatus)) {
    return { allowed: true }
  }
  if (isStatusOnlyDemotePatch(patch)) {
    return { allowed: true }
  }
  return {
    allowed: false,
    reason: `role=${role} は公開中 scenario (status='${currentStatus}') の内容編集ができません。Owner / Admin に依頼するか、status を非公開系に下げる単独 patch を送ってください。`,
  }
}

/**
 * 既存 scenario の DELETE が role 的に許可されるか。
 *
 *   1. viewer        → 不可
 *   2. owner / admin → 可
 *   3. member / role 不明:
 *      - 既存 status が非 publish → 可
 *      - 既存 status が publish → 不可 (削除は実質公開停止 = publish RBAC 迂回になるため)
 *
 * REQ-SEC-010 (HIGH): Codex T1 dual review 指摘 HIGH 2 反映。
 */
export function canDeleteExistingScenario(
  role: ScenarioRole,
  currentStatus: ScenarioStatus,
): RbacVerdict {
  if (!canWriteScenario(role)) {
    return { allowed: false, reason: 'viewer は scenario を削除できません' }
  }
  if (PUBLISH_ROLES.has(role)) {
    return { allowed: true }
  }
  if (isPublishStatus(currentStatus)) {
    return {
      allowed: false,
      reason: `role=${role} は公開中 scenario (status='${currentStatus}') を削除できません。先に status を非公開系に降格するか、Owner / Admin に依頼してください。`,
    }
  }
  return { allowed: true }
}

export const __test__ = {
  NON_PUBLISH_STATUSES,
  PUBLISH_STATUSES,
  WRITABLE_ROLES,
  PUBLISH_ROLES,
}
