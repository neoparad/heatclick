/**
 * UGOKI LINK v2 — 束 4-D (手順 13): 時刻付き有向 URL 別名グラフ
 *
 * 設計書 §6.4 / §6.7:
 * - リダイレクト (`redirect`)・検証済み正規 URL (`verified_canonical`)・雑音パラメータ (`noise_param`)・
 *   端末別ページ (`device_alternate`) を有向・時刻付き辺として保持する。
 * - サイトとテナントは絶対にまたがない。
 * - 辺の有効化は検査環境確認・オーナー確認・CMS 記録のみ（実訪問のみの未確認辺は拒否）。
 * - リダイレクト解除時は辺を削除せず `valid_to` で閉じるため、過去の統合履歴が破壊されない。
 */

export type AliasEdgeKind =
  | 'redirect'
  | 'verified_canonical'
  | 'noise_param'
  | 'device_alternate'

export type AliasEdgeProvenance = 'lab_confirmed' | 'owner_confirmed' | 'cms_confirmed'

export interface UrlAliasEdge {
  readonly edge_id: string
  readonly tenant_id: string
  readonly site_id: string
  readonly from_url_key: string
  readonly to_url_key: string
  readonly kind: AliasEdgeKind
  readonly provenance: AliasEdgeProvenance
  /** UTC ISO-8601 when this edge became active */
  readonly valid_from: string
  /** UTC ISO-8601 when retired (null = still active); retiring NEVER destroys historical resolution */
  readonly valid_to: string | null
  readonly evidence_ref?: string | null
}

export interface AddAliasEdgeInput {
  readonly tenant_id: string
  readonly site_id: string
  readonly from_url_key: string
  readonly to_url_key: string
  readonly to_tenant_id?: string
  readonly to_site_id?: string
  readonly kind: AliasEdgeKind
  readonly provenance: AliasEdgeProvenance
  readonly valid_from: string
  readonly evidence_ref?: string | null
}

export interface AliasResolutionResult {
  readonly tenant_id: string
  readonly site_id: string
  readonly start_url_key: string
  readonly canonical_url_key: string
  readonly as_of: string
  readonly hops: readonly UrlAliasEdge[]
  readonly cycle_detected: boolean
}

export class UrlAliasGraph {
  private readonly edges: UrlAliasEdge[] = []
  private seq = 0

  addEdge(input: AddAliasEdgeInput): UrlAliasEdge {
    if (!input.tenant_id.trim() || !input.site_id.trim()) {
      throw new Error('tenant_id and site_id are required for URL alias edge')
    }
    if (
      (input.to_tenant_id && input.to_tenant_id !== input.tenant_id) ||
      (input.to_site_id && input.to_site_id !== input.site_id)
    ) {
      throw new Error('URL alias edge MUST NOT cross tenant or site boundary (§6.4)')
    }
    if (input.from_url_key === input.to_url_key) {
      throw new Error('Self-referential URL alias edge is prohibited')
    }

    this.seq++
    const edge: UrlAliasEdge = Object.freeze({
      edge_id: `alias_${this.seq}`,
      tenant_id: input.tenant_id,
      site_id: input.site_id,
      from_url_key: input.from_url_key,
      to_url_key: input.to_url_key,
      kind: input.kind,
      provenance: input.provenance,
      valid_from: input.valid_from,
      valid_to: null,
      evidence_ref: input.evidence_ref ?? null,
    })
    this.edges.push(edge)
    return edge
  }

  /**
   * 辺を論理終了する（履歴非破壊: 過去時点の `resolveAtTime` には影響しない）。
   */
  retireEdge(edgeId: string, retiredAtIso: string): UrlAliasEdge | null {
    const idx = this.edges.findIndex((e) => e.edge_id === edgeId)
    if (idx === -1) return null
    const existing = this.edges[idx]
    if (Date.parse(retiredAtIso) < Date.parse(existing.valid_from)) {
      throw new Error('valid_to cannot precede valid_from')
    }
    const updated: UrlAliasEdge = Object.freeze({
      ...existing,
      valid_to: retiredAtIso,
    })
    this.edges[idx] = updated
    return updated
  }

  /**
   * 指定時刻 `asOfIso` 時点で有効だった有向辺を辿って正規 URL キーを解決する。
   */
  resolveAtTime(params: {
    readonly tenant_id: string
    readonly site_id: string
    readonly url_key: string
    readonly as_of: string
    readonly max_hops?: number
  }): AliasResolutionResult {
    const asOfMs = Date.parse(params.as_of)
    const maxHops = params.max_hops ?? 10
    const visited = new Set<string>([params.url_key])
    const hops: UrlAliasEdge[] = []
    let current = params.url_key
    let cycleDetected = false

    for (let step = 0; step < maxHops; step++) {
      // Find latest active edge from `current` in the SAME (tenant_id, site_id)
      const candidates = this.edges
        .filter((e) => {
          if (e.tenant_id !== params.tenant_id || e.site_id !== params.site_id) return false
          if (e.from_url_key !== current) return false
          const fromMs = Date.parse(e.valid_from)
          if (fromMs > asOfMs) return false
          if (e.valid_to !== null && Date.parse(e.valid_to) <= asOfMs) return false
          return true
        })
        .sort((a, b) => Date.parse(b.valid_from) - Date.parse(a.valid_from))

      const nextEdge = candidates[0]
      if (!nextEdge) break

      if (visited.has(nextEdge.to_url_key)) {
        cycleDetected = true
        break
      }

      hops.push(nextEdge)
      visited.add(nextEdge.to_url_key)
      current = nextEdge.to_url_key
    }

    return Object.freeze({
      tenant_id: params.tenant_id,
      site_id: params.site_id,
      start_url_key: params.url_key,
      canonical_url_key: current,
      as_of: params.as_of,
      hops: Object.freeze(hops),
      cycle_detected: cycleDetected,
    })
  }

  listEdges(tenantId: string, siteId: string): readonly UrlAliasEdge[] {
    return Object.freeze(
      this.edges.filter((e) => e.tenant_id === tenantId && e.site_id === siteId),
    )
  }
}
