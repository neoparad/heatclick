/**
 * UGOKI LINK v2 — 束 3-D (手順 10): アドレスプライバシー 3 分類 (E/T/P類) & 用途別ネットワーク仮名
 *
 * 設計書 §7.9 / §14.2 判断 12 (`D-12`) / ゲート `act.G31`, `act.G32`:
 * - **E 類** (リクエスト時点で自動操作証拠あり行):
 *   サイト × UTC 日ごとの公開鍵 (X25519 + HKDF-SHA256 + AES-256-GCM) でフルアドレスを封印。
 *   取得点は復号秘密を持たない。秘密鍵は 30 日後に完全破棄（鍵 1 本の破棄で全複製が読解不能）。
 * - **T 類** (既定 — 人と推定される行):
 *   IPv4 `/24`・IPv6 `/48` 上位プレフィックス＋ASN のみ保持しフルアドレスは即時廃棄。
 *   人推定行は 35 日で日次集計へ畳み消去 (`rollup_collapse_at`)。
 * - **P 類** (任意 opt-in `sealed_pending`):
 *   全文書行を 72 時間鍵で封印しバッチ証拠で E 類昇格可能。別法務署名ゲート (`act.G32`) が閉じるまで `not_entitled`。
 * - **用途別ネットワーク仮名 (4 種完全非リンク)**:
 *   `daily_cap` (1日上限) / `experiment` (実験ごと) / `quorum` (定足数) / `cohort_k_anon` (集団人数判定)
 *   ごとに独立鍵＋用途ドメイン分離 HMAC で導出し、用途横断リンクを暗号学的に不能にする。
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto'

import {
  formatIpv4,
  formatIpv6,
  parseIp,
} from '@/lib/link/clocks/actor-evidence-snapshot'
import {
  NotEntitledError,
  requireDecisionEntitled,
  type DecisionEntitlementResult,
} from '@/packages/contract/ledgers'

// ---------------------------------------------------------------------------
// Constants & Types
// ---------------------------------------------------------------------------

export type IpPrivacyClass = 'E' | 'T' | 'P'

export const CLASS_E_KEY_TTL_DAYS = 30
export const CLASS_T_HUMAN_ROLLUP_COLLAPSE_DAYS = 35
export const CLASS_P_KEY_TTL_HOURS = 72

export type NetworkPseudonymPurpose =
  | 'daily_cap'
  | 'experiment'
  | 'quorum'
  | 'cohort_k_anon'

export interface SealedIpEnvelope {
  readonly alg: 'X25519-HKDF-SHA256-AES-256-GCM'
  readonly key_id: string
  readonly address_class: 'E' | 'P'
  readonly ephemeral_public_key_der_b64: string
  readonly iv_b64: string
  readonly auth_tag_b64: string
  readonly ciphertext_b64: string
  readonly expires_at: string
}

export interface MinimizedIpEvidence {
  readonly address_class: IpPrivacyClass
  readonly prefix: string | null
  readonly asn: number | null
  /** Present ONLY for Class E (30d) or Class P (72h); NEVER raw plaintext IP */
  readonly sealed_ip: SealedIpEnvelope | null
  /** Present for Class T human-presumed rows: 35 days from observation (§7.9) */
  readonly human_rollup_collapse_at: string | null
  readonly recompute_scope: 'evidence_rows_30d' | 'pending_72h' | 'prefix_only'
}

export interface KeyDestructionAuditRecord {
  readonly key_id: string
  readonly tenant_id: string
  readonly site_id: string
  readonly address_class: 'E' | 'P'
  readonly bucket_key: string
  readonly destroyed_at: string
  readonly reason: 'ttl_expired' | 'manual_erasure' | 'restore_drill'
}

export class KeyDestroyedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeyDestroyedError'
  }
}

export interface IpPrivacyEntitlementOptions {
  /** Overrides `requireDecisionEntitled('D-12')` only in controlled tests; defaults to live ledger */
  readonly decisionCheckOverride?: () => DecisionEntitlementResult
  /** Class P requires separate legal sign-off (`act.G32`, §14.2 #12) */
  readonly classPSignedOff?: boolean
}

// ---------------------------------------------------------------------------
// IP Truncation (/24 for IPv4, /48 for IPv6)
// ---------------------------------------------------------------------------

export function truncateIpPrefix(rawIp: string): string | null {
  const parsed = parseIp(rawIp)
  if (!parsed) return null
  if (parsed.family === 4) {
    const masked = parsed.value & 0xffffff00n
    return `${formatIpv4(masked)}/24`
  }
  const mask48 = ((1n << 48n) - 1n) << 80n
  const masked = parsed.value & mask48
  return `${formatIpv6(masked)}/48`
}

// ---------------------------------------------------------------------------
// Daily Public-Key Sealing Vault (No Recoverable History — `act.G31`)
// ---------------------------------------------------------------------------

interface StoredSealingKeyPair {
  readonly key_id: string
  readonly tenant_id: string
  readonly site_id: string
  readonly address_class: 'E' | 'P'
  readonly bucket_key: string
  readonly publicKey: KeyObject
  privateKey: KeyObject | null
  readonly created_at: string
  readonly destroy_after: string
  destroyed_at: string | null
}

/**
 * サイト × UTC 日（Class E: 30日 / Class P: 72時間）ごとの X25519 公開鍵封印保管庫。
 * 取得点へは公開鍵 (`getPublicKey`) のみ配布し、秘密鍵の破棄後は同一暗号文が完全復号不能となる。
 */
export class DailySealingKeyVault {
  private readonly keys = new Map<string, StoredSealingKeyPair>()
  private readonly byKeyId = new Map<string, StoredSealingKeyPair>()
  private readonly destructionAuditLog: KeyDestructionAuditRecord[] = []

  private lookupSlotKey(
    tenantId: string,
    siteId: string,
    addressClass: 'E' | 'P',
    bucketKey: string,
  ): string {
    return `${tenantId}|${siteId}|${addressClass}|${bucketKey}`
  }

  getOrCreateDailyPublicKey(params: {
    readonly tenant_id: string
    readonly site_id: string
    readonly address_class: 'E' | 'P'
    readonly observed_at: string
  }): { readonly key_id: string; readonly publicKey: KeyObject; readonly destroy_after: string } {
    const obsDate = new Date(params.observed_at)
    if (Number.isNaN(obsDate.getTime())) {
      throw new Error(`Invalid observed_at timestamp: ${params.observed_at}`)
    }
    const bucketKey = obsDate.toISOString().slice(0, 10) // UTC YYYY-MM-DD
    const slotKey = this.lookupSlotKey(
      params.tenant_id,
      params.site_id,
      params.address_class,
      bucketKey,
    )
    const existing = this.keys.get(slotKey)
    if (existing) {
      if (existing.destroyed_at !== null) {
        throw new KeyDestroyedError(`Key ${existing.key_id} for ${bucketKey} has already been destroyed`)
      }
      return {
        key_id: existing.key_id,
        publicKey: existing.publicKey,
        destroy_after: existing.destroy_after,
      }
    }

    const { publicKey, privateKey } = generateKeyPairSync('x25519')
    const ttlMs =
      params.address_class === 'E'
        ? CLASS_E_KEY_TTL_DAYS * 24 * 60 * 60 * 1000
        : CLASS_P_KEY_TTL_HOURS * 60 * 60 * 1000
    const destroyAfter = new Date(obsDate.getTime() + ttlMs).toISOString()
    const keyId = `seal_${params.address_class}_${params.tenant_id}_${params.site_id}_${bucketKey}`

    const record: StoredSealingKeyPair = {
      key_id: keyId,
      tenant_id: params.tenant_id,
      site_id: params.site_id,
      address_class: params.address_class,
      bucket_key: bucketKey,
      publicKey,
      privateKey,
      created_at: obsDate.toISOString(),
      destroy_after: destroyAfter,
      destroyed_at: null,
    }
    this.keys.set(slotKey, record)
    this.byKeyId.set(keyId, record)
    return { key_id: keyId, publicKey, destroy_after: destroyAfter }
  }

  /**
   * 取得点（エッジ Worker / ログシッパー等）で公開鍵のみを使ってフル IP を封印する。
   */
  sealIpAddress(params: {
    readonly tenant_id: string
    readonly site_id: string
    readonly address_class: 'E' | 'P'
    readonly raw_ip: string
    readonly observed_at: string
  }): SealedIpEnvelope {
    const { key_id, publicKey, destroy_after } = this.getOrCreateDailyPublicKey(params)
    const eph = generateKeyPairSync('x25519')
    const sharedSecret = diffieHellman({
      privateKey: eph.privateKey,
      publicKey,
    })

    const aesKey = Buffer.from(
      hkdfSync(
        'sha256',
        sharedSecret,
        Buffer.from(key_id, 'utf8'),
        Buffer.from(`ugk-seal-ip-${params.address_class}`, 'utf8'),
        32,
      ),
    )

    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', aesKey, iv)
    cipher.setAAD(Buffer.from(`${params.tenant_id}|${params.site_id}|${key_id}`, 'utf8'))
    const encrypted = Buffer.concat([cipher.update(params.raw_ip, 'utf8'), cipher.final()])
    const authTag = cipher.getAuthTag()
    const ephPubDer = eph.publicKey.export({ type: 'spki', format: 'der' })

    return Object.freeze({
      alg: 'X25519-HKDF-SHA256-AES-256-GCM',
      key_id,
      address_class: params.address_class,
      ephemeral_public_key_der_b64: Buffer.from(ephPubDer).toString('base64'),
      iv_b64: iv.toString('base64'),
      auth_tag_b64: authTag.toString('base64'),
      ciphertext_b64: encrypted.toString('base64'),
      expires_at: destroy_after,
    })
  }

  /**
   * 復号（サーバー側再計算・検証用）。秘密鍵破棄後は `KeyDestroyedError` で必ず失敗する。
   */
  unsealIpAddress(params: {
    readonly tenant_id: string
    readonly site_id: string
    readonly envelope: SealedIpEnvelope
  }): string {
    const rec = this.byKeyId.get(params.envelope.key_id)
    if (!rec) {
      throw new KeyDestroyedError(`Sealing key "${params.envelope.key_id}" does not exist`)
    }
    if (rec.tenant_id !== params.tenant_id || rec.site_id !== params.site_id) {
      throw new KeyDestroyedError(`Sealing key "${params.envelope.key_id}" does not belong to tenant/site`)
    }
    if (rec.privateKey === null || rec.destroyed_at !== null) {
      throw new KeyDestroyedError(
        `Sealing private key "${params.envelope.key_id}" was permanently destroyed at ${rec.destroyed_at ?? 'unknown'}`,
      )
    }

    const ephPubDer = Buffer.from(params.envelope.ephemeral_public_key_der_b64, 'base64')
    const ephPub = createPublicKey({ key: ephPubDer, format: 'der', type: 'spki' })
    const sharedSecret = diffieHellman({
      privateKey: rec.privateKey,
      publicKey: ephPub,
    })

    const aesKey = Buffer.from(
      hkdfSync(
        'sha256',
        sharedSecret,
        Buffer.from(params.envelope.key_id, 'utf8'),
        Buffer.from(`ugk-seal-ip-${params.envelope.address_class}`, 'utf8'),
        32,
      ),
    )

    const iv = Buffer.from(params.envelope.iv_b64, 'base64')
    const authTag = Buffer.from(params.envelope.auth_tag_b64, 'base64')
    const ciphertext = Buffer.from(params.envelope.ciphertext_b64, 'base64')

    const decipher = createDecipheriv('aes-256-gcm', aesKey, iv)
    decipher.setAAD(Buffer.from(`${params.tenant_id}|${params.site_id}|${params.envelope.key_id}`, 'utf8'))
    decipher.setAuthTag(authTag)
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return decrypted.toString('utf8')
  }

  /**
   * 秘密鍵を永久破棄し監査ログを残す（復元不能ドリル `act.G31` 対象）。
   */
  destroyPrivateKey(
    keyId: string,
    destroyedAt: string,
    reason: KeyDestructionAuditRecord['reason'] = 'ttl_expired',
  ): KeyDestructionAuditRecord | null {
    const rec = this.byKeyId.get(keyId)
    if (!rec || rec.destroyed_at !== null) return null
    rec.privateKey = null
    rec.destroyed_at = destroyedAt
    const audit: KeyDestructionAuditRecord = Object.freeze({
      key_id: rec.key_id,
      tenant_id: rec.tenant_id,
      site_id: rec.site_id,
      address_class: rec.address_class,
      bucket_key: rec.bucket_key,
      destroyed_at: destroyedAt,
      reason,
    })
    this.destructionAuditLog.push(audit)
    return audit
  }

  /**
   * `nowIso` を過ぎて期限切れとなった Class E (30日) / Class P (72時間) の秘密鍵を一括破棄する。
   */
  purgeExpiredPrivateKeys(nowIso: string): readonly KeyDestructionAuditRecord[] {
    const nowMs = Date.parse(nowIso)
    const purged: KeyDestructionAuditRecord[] = []
    for (const rec of this.byKeyId.values()) {
      if (rec.destroyed_at === null && Date.parse(rec.destroy_after) <= nowMs) {
        const audit = this.destroyPrivateKey(rec.key_id, nowIso, 'ttl_expired')
        if (audit) purged.push(audit)
      }
    }
    return Object.freeze(purged)
  }

  getDestructionAuditLog(): readonly KeyDestructionAuditRecord[] {
    return Object.freeze([...this.destructionAuditLog])
  }
}

// ---------------------------------------------------------------------------
// Request-Time Address Classification & Minimization (E / T / P + D-12 Gate)
// ---------------------------------------------------------------------------

export interface ClassifyAddressInput {
  readonly tenant_id: string
  readonly site_id: string
  readonly raw_ip: string
  readonly asn: number | null
  readonly observed_at: string
  /** Request-time automation evidence: declared bot token, signature header, feed/SAIL hit, decoy hit */
  readonly has_request_time_automation_evidence: boolean
  /** Optional opt-in request for Class P (72h sealed_pending) */
  readonly request_class_p?: boolean
}

export function classifyAndMinimizeIpAddress(
  input: ClassifyAddressInput,
  vault: DailySealingKeyVault,
  options?: IpPrivacyEntitlementOptions,
): MinimizedIpEvidence {
  // Decision D-12 gate (§14.2 #12): server-side IP evidence storage requires D-12 + legal sign-off
  const d12 = options?.decisionCheckOverride
    ? options.decisionCheckOverride()
    : requireDecisionEntitled('D-12', { enforceLegalSignOff: true })

  if (!d12.entitled) {
    throw new NotEntitledError(d12)
  }

  const prefix = truncateIpPrefix(input.raw_ip)

  // Class E: request-time automation evidence -> seal full IP with 30-day daily public key
  if (input.has_request_time_automation_evidence) {
    const sealed = vault.sealIpAddress({
      tenant_id: input.tenant_id,
      site_id: input.site_id,
      address_class: 'E',
      raw_ip: input.raw_ip,
      observed_at: input.observed_at,
    })
    return Object.freeze({
      address_class: 'E',
      prefix,
      asn: input.asn,
      sealed_ip: sealed,
      human_rollup_collapse_at: null,
      recompute_scope: 'evidence_rows_30d',
    })
  }

  // Class P (opt-in): requires separate legal sign-off (`act.G32`)
  if (input.request_class_p) {
    if (!options?.classPSignedOff) {
      throw new NotEntitledError({
        entitled: false,
        status: 'not_entitled',
        decisionId: 'D-12',
        reason: 'legal_signoff_pending',
        message: 'Address Class P (72h sealed_pending) requires separate legal sign-off (gate act.G32)',
        unlockRequirement: 'Record H-8 Class P legal sign-off (act.G32) before enabling Class P',
      })
    }
    const sealed = vault.sealIpAddress({
      tenant_id: input.tenant_id,
      site_id: input.site_id,
      address_class: 'P',
      raw_ip: input.raw_ip,
      observed_at: input.observed_at,
    })
    return Object.freeze({
      address_class: 'P',
      prefix,
      asn: input.asn,
      sealed_ip: sealed,
      human_rollup_collapse_at: null,
      recompute_scope: 'pending_72h',
    })
  }

  // Class T (default): prefix (/24 or /48) + ASN only; human-presumed row collapses to daily rollup in 35 days
  const collapseAt = new Date(
    Date.parse(input.observed_at) + CLASS_T_HUMAN_ROLLUP_COLLAPSE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()

  return Object.freeze({
    address_class: 'T',
    prefix,
    asn: input.asn,
    sealed_ip: null,
    human_rollup_collapse_at: collapseAt,
    recompute_scope: 'prefix_only',
  })
}

// ---------------------------------------------------------------------------
// Daily Zero-Unsealed-IP Scanner (Gate `act.G31`)
// ---------------------------------------------------------------------------

const FULL_IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b(?!\/(?:24|16|8)\b)/

export function scanForUnsealedFullIps(records: readonly unknown[]): readonly {
  readonly record_index: number
  readonly path: string
  readonly sample_redacted: string
}[] {
  const leaks: Array<{ record_index: number; path: string; sample_redacted: string }> = []

  const walk = (node: unknown, idx: number, p: string, key: string | null): void => {
    if (node === null || node === undefined) return
    if (typeof node === 'string') {
      if (key === 'ciphertext_b64' || key === 'prefix' || key === 'ephemeral_public_key_der_b64') {
        return
      }
      if (FULL_IPV4_RE.test(node)) {
        leaks.push({ record_index: idx, path: p, sample_redacted: '<full_ipv4_detected>' })
        return
      }
      const trimmed = node.trim()
      if (trimmed.includes(':') && !trimmed.includes('/') && parseIp(trimmed)?.family === 6) {
        leaks.push({ record_index: idx, path: p, sample_redacted: '<full_ipv6_detected>' })
      }
      return
    }
    if (typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], idx, `${p}[${i}]`, key)
      return
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      walk(v, idx, `${p}.${k}`, k)
    }
  }

  for (let i = 0; i < records.length; i++) {
    walk(records[i], i, '$', null)
  }
  return Object.freeze(leaks)
}

// ---------------------------------------------------------------------------
// 4 Purpose-Scoped Unlinkable Network Pseudonyms (§7.9)
// ---------------------------------------------------------------------------

export interface PurposePseudonymKeyRing {
  readonly daily_cap_secret: string | Buffer
  readonly experiment_secret: string | Buffer
  readonly quorum_secret: string | Buffer
  readonly cohort_k_anon_secret: string | Buffer
}

export interface DerivePseudonymParams {
  readonly purpose: NetworkPseudonymPurpose
  readonly tenant_id: string
  readonly site_id: string
  readonly network_prefix: string
  readonly asn: number | null
  /** Purpose-specific scope salt (UTC day for daily_cap, experiment_id for experiment, window_id for quorum, query_id for cohort) */
  readonly scope_id: string
}

/**
 * 4 用途（1日上限 / 実験ごと / 定足数 / 集団人数判定）ごとに独立鍵＋ドメイン分離 HMAC-SHA256 で
 * ネットワーク単位仮名を導出する (§7.9)。用途をまたいだ名寄せは不可能。
 */
export function derivePurposeNetworkPseudonym(
  params: DerivePseudonymParams,
  keyRing: PurposePseudonymKeyRing,
): string {
  if (!params.tenant_id.trim() || !params.site_id.trim() || !params.scope_id.trim()) {
    throw new Error('tenant_id, site_id, and scope_id are required to derive network pseudonym')
  }

  let secret: string | Buffer
  switch (params.purpose) {
    case 'daily_cap':
      secret = keyRing.daily_cap_secret
      break
    case 'experiment':
      secret = keyRing.experiment_secret
      break
    case 'quorum':
      secret = keyRing.quorum_secret
      break
    case 'cohort_k_anon':
      secret = keyRing.cohort_k_anon_secret
      break
  }

  const normalizedPrefix = params.network_prefix.includes('/')
    ? params.network_prefix.trim().toLowerCase()
    : (truncateIpPrefix(params.network_prefix) ?? params.network_prefix.trim().toLowerCase())

  const payload = [
    'ugk-net-pseudo/1',
    params.purpose,
    params.tenant_id,
    params.site_id,
    params.scope_id,
    normalizedPrefix,
    String(params.asn ?? 0),
  ].join('|')

  const mac = createHmac('sha256', secret).update(payload, 'utf8').digest('hex').slice(0, 32)
  return `np_${params.purpose}_${mac}`
}
