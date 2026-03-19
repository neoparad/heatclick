/**
 * サイトデータのメモリ内ストア（ClickHouseフォールバック用）
 * ClickHouseが未接続の場合、メモリ内にデータを保持する
 * サーバー再起動でデータは消失する
 */

export interface SiteData {
  id: string
  name: string
  url: string
  tracking_id: string
  status: string
  user_id: string | null
  org_id: string | null
  created_at: string
  updated_at: string
  last_activity: string
  page_views: number
}

// メモリ内サイトストア
const memorySites: Map<string, SiteData> = new Map()

export function getMemorySites(): SiteData[] {
  return Array.from(memorySites.values()).sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  )
}

export function getMemorySiteById(id: string): SiteData | undefined {
  return memorySites.get(id)
}

export function addMemorySite(site: SiteData): void {
  memorySites.set(site.id, site)
}

export function updateMemorySite(id: string, updates: Partial<SiteData>): SiteData | null {
  const existing = memorySites.get(id)
  if (!existing) return null
  const updated = { ...existing, ...updates, updated_at: formatDateTime(new Date()) }
  memorySites.set(id, updated)
  return updated
}

export function deleteMemorySite(id: string): boolean {
  return memorySites.delete(id)
}

export function findMemorySiteByUrl(url: string): SiteData | undefined {
  const sites = Array.from(memorySites.values())
  return sites.find(site => site.url === url)
}

export function isMemoryStoreActive(): boolean {
  return true // 常にフォールバックとして利用可能
}

// ヘルパー: DateTimeフォーマット
export function formatDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').substring(0, 19)
}
