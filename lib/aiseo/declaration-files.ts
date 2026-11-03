/**
 * 宣言ファイル到達確認（純粋ロジック・UI非依存）。
 * 「AIが llms.txt / aimap.json 等の宣言ファイルを実際に取得しに来たか」を、
 * collector が既に持っている URL別アクセスデータから判定する。
 */

export interface DeclarationPathDef {
  path: string
  label: string
  kind: 'target' | 'control'
}

export interface CheckedDeclarationFile extends DeclarationPathDef {
  hit: boolean
  hits: number
  topAgents: Array<{ agent: string; count: number }>
}

export const DECLARATION_PATHS: ReadonlyArray<DeclarationPathDef> = [
  { path: '/llms.txt', label: 'llms.txt', kind: 'target' },
  { path: '/aimap.json', label: 'aimap.json', kind: 'target' },
  { path: '/.well-known/aimap.json', label: '.well-known/aimap.json', kind: 'target' },
  { path: '/aimap.md', label: 'aimap.md', kind: 'target' },
  { path: '/robots.txt', label: 'robots.txt（陽性対照）', kind: 'control' },
  { path: '/sitemap.xml', label: 'sitemap.xml（陽性対照）', kind: 'control' },
]

function normalizedPathname(url: string | undefined): string {
  let p: string
  try {
    p = new URL(url || '').pathname
  } catch {
    p = String(url || '')
  }
  if (p.length > 1) p = p.replace(/\/$/, '')
  return p || '/'
}

export function checkDeclarationFiles(
  urls: ReadonlyArray<{ url: string; hits: number; top_agents?: Array<{ agent: string; count: number }> }> = [],
): CheckedDeclarationFile[] {
  const byPath = new Map<
    string,
    { url: string; hits: number; top_agents?: Array<{ agent: string; count: number }> }
  >()
  for (const u of urls) {
    byPath.set(normalizedPathname(u.url), u)
  }
  return DECLARATION_PATHS.map((d) => {
    const match = byPath.get(d.path.replace(/\/$/, '') || '/')
    return {
      ...d,
      hit: Boolean(match),
      hits: match?.hits || 0,
      topAgents: match?.top_agents || [],
    }
  })
}

export function looksLikeCoverageGap(checked: ReadonlyArray<CheckedDeclarationFile>): boolean {
  const controls = checked.filter((c) => c.kind === 'control')
  return controls.length > 0 && controls.every((c) => !c.hit)
}
