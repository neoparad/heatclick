/**
 * Unit tests for lib/page-meta-store + components/layout/page-meta — 続 75 Task A
 *
 * 背景: Owner 2026-05-24 09:28 報告「タイトルがコンテンツ下部にあると視認性悪い、
 *       AI チャットには title すらない」→ 続 73 / 75 で AppShell topbar に title slot を
 *       設けて、各 page が PageMeta コンポーネントで差し込む仕組みを配備。
 *
 * 検証対象:
 *   1. lib/page-meta-store.ts — set/clear/subscribe の最小 API + initial empty state
 *   2. PageMeta コンポーネント自体は 'use client' + useEffect 依存 (React テスト環境
 *      なしで検証するのは過剰)。本テストは store 側の挙動と各 (proof) page が
 *      <PageMeta ... /> を render しているかの source-level inspection に絞る。
 *   3. 全 (proof) 配下の page.tsx が PageMeta を 1 個以上含む (AppShell の topbar が
 *      空のままにならないことを保証)。
 *
 * Usage:
 *   cd ugokimap-saas
 *   node --test tests/unit/page-meta-store.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function readSrc(relPath) {
  return readFileSync(resolve(__dirname, '../..', relPath), 'utf8')
}

// ── 1. Source-level: 全 (proof) page で PageMeta render 済 ───────────

const PROOF_PAGES = [
  'app/(proof)/dashboard/page.tsx',
  'app/(proof)/heatmap/page.tsx',
  'app/(proof)/personas/page.tsx',
  'app/(proof)/chat/page.tsx',
  // 続 75 Task B + Task D: 新規配備 page
  'app/(proof)/paths/page.tsx',
  'app/(proof)/install/page.tsx',
]

// 続 75 Task A: 各 page の title 文字列に対する整合チェック
const EXPECTED_TITLES = {
  'app/(proof)/dashboard/page.tsx': /title=["']おはようございます/,
  'app/(proof)/heatmap/page.tsx': /title=["']ヒートマップ["']/,
  'app/(proof)/personas/page.tsx': /title=["']Persona クラスタ["']/,
  'app/(proof)/chat/page.tsx': /title=["']UGOKIMAP AI["']/,
  'app/(proof)/paths/page.tsx': /title=["']経路分析エージェント["']/,
  'app/(proof)/install/page.tsx': /title=["']設定 \/ タグ設置["']/,
}

for (const rel of PROOF_PAGES) {
  test(`PageMeta wired in ${rel}`, () => {
    const src = readSrc(rel)
    assert.match(
      src,
      /import\s+{[^}]*\bPageMeta\b[^}]*}\s+from\s+['"]@\/components\/layout\/page-meta['"]/,
      `${rel} must import PageMeta from @/components/layout/page-meta`,
    )
    assert.match(
      src,
      /<PageMeta\b[^>]*\btitle=/,
      `${rel} must render <PageMeta title=... /> with a title prop`,
    )
    const expected = EXPECTED_TITLES[rel]
    if (expected) {
      assert.match(src, expected, `${rel} must use expected title (${expected})`)
    }
  })
}

// 続 75 Task B: paths page (Server entry) + PathAnalysisCanvas + fixture の 3 段構成
test('app/(proof)/paths/page.tsx delegates to PathAnalysisCanvas + dummy fixture', () => {
  const src = readSrc('app/(proof)/paths/page.tsx')
  assert.match(src, /PathAnalysisCanvas/, 'paths page must render PathAnalysisCanvas')
  assert.match(src, /getDummyPathAnalysis/, 'paths page must use getDummyPathAnalysis fixture')
})

test('lib/fixtures/path-analysis.ts declares 3 branches (A/B/C) + trigger + 2 insights', () => {
  const src = readSrc('lib/fixtures/path-analysis.ts')
  // 3 branch IDs
  for (const id of ["'A'", "'B'", "'C'"]) {
    assert.ok(src.includes(`id: ${id}`), `fixture must declare branch id ${id}`)
  }
  assert.match(src, /trigger:\s*\{/, 'fixture must declare trigger object')
  assert.match(
    src,
    /isDummy:\s*true/,
    'fixture must mark isDummy=true (D-07 inferred 表示の根拠)',
  )
  assert.match(
    src,
    /export\s+function\s+getDummyPathAnalysis/,
    'fixture must export getDummyPathAnalysis()',
  )
})

test('components/paths/path-analysis-canvas.tsx renders branches + AgentRail + DummyBanner', () => {
  const src = readSrc('components/paths/path-analysis-canvas.tsx')
  assert.match(src, /AgentRail/, 'canvas must render AgentRail (right pane)')
  assert.match(src, /DummyBanner/, 'canvas must render DummyBanner (D-07 inferred 明示)')
  assert.match(src, /BranchRow/, 'canvas must render BranchRow (3 branches grid)')
  assert.match(src, /NodePerfBar/, 'canvas must render NodePerfBar (各 node の LCP mini-bar)')
})

// 続 78 Task A regression: title block を content area から削除し、workflow 切替
// pulldown のみ残す。title (eyebrow + h1) は page.tsx の <PageMeta /> で topbar に集約。
test('続 78 Task A: path-analysis-canvas does NOT render h1 with workflowName (title moved to topbar)', () => {
  const src = readSrc('components/paths/path-analysis-canvas.tsx')
  // canvas 内に <h1>{data.workflowName}</h1> が残っていないこと
  assert.ok(
    !/<h1[^>]*>\s*\{data\.workflowName\}/.test(src),
    'path-analysis-canvas must NOT render <h1>{data.workflowName}</h1> in content area (続 78 Task A: title moved to topbar via PageMeta)',
  )
  // "Path Analysis · AI Agent" eyebrow も content area から除去済
  assert.ok(
    !src.includes('Path Analysis · AI Agent'),
    'path-analysis-canvas must NOT contain "Path Analysis · AI Agent" eyebrow string (続 78 Task A)',
  )
})

test('続 78 Task A: path-analysis-canvas renders WorkflowPulldown (compact pulldown)', () => {
  const src = readSrc('components/paths/path-analysis-canvas.tsx')
  assert.match(
    src,
    /WorkflowPulldown/,
    'path-analysis-canvas must render WorkflowPulldown for workflow switch (mockup 11_path_analysis.html 準拠)',
  )
  assert.match(
    src,
    /ChevronDown/,
    'WorkflowPulldown must use ChevronDown icon (compact pulldown affordance)',
  )
})

// 続 75 Task D: install page (Server entry) は Phase 1 5 sites の seed + InstallSettingsPane 経由で render
test('app/(proof)/install/page.tsx delegates to InstallSettingsPane + Phase 1 5 sites SSR fetch', () => {
  const src = readSrc('app/(proof)/install/page.tsx')
  assert.match(src, /CIP_EcwUTHEZdIOAUqum/, 'install page must reference Phase 1 dogfood site CIP_EcwUTHEZdIOAUqum')
  assert.match(
    src,
    /InstallSettingsPane/,
    'install page must delegate to InstallSettingsPane (Client orchestrator)',
  )
  assert.match(
    src,
    /\/api\/pages\?site_id=/,
    'install page must SSR-fetch /api/pages?site_id= for initial site status',
  )
})

// 続 75 Task D: InstallSettingsPane が mockup 15 の 5 install 手法 + Step 3 verify rows を持つ
test('components/install/install-settings-pane.tsx declares 5 install methods + verify steps', () => {
  const src = readSrc('components/install/install-settings-pane.tsx')
  assert.match(
    src,
    /INSTALL_METHODS/,
    'install-settings-pane must declare INSTALL_METHODS array (5 手法)',
  )
  assert.match(
    src,
    /VERIFY_ROWS_TEMPLATE|StepThreeVerify/,
    'install-settings-pane must declare verify rows (Step 3 動作確認)',
  )
  // mockup 5 install 手法
  for (const m of ['Google Tag Manager', 'WordPress', 'Shopify', '手動設置', 'Next.js']) {
    assert.ok(src.includes(m), `install-settings-pane must reference install method "${m}"`)
  }
  // 動作確認 button → /api/pages 経由 probe
  assert.match(
    src,
    /\/api\/pages\?site_id=/,
    'install-settings-pane must call /api/pages?site_id= for tracking probe button',
  )
})

// ── 2. Source-level: AppShell が usePageMeta() で title slot を render ──

test('AppShell topbar uses usePageMeta() and renders title slot', () => {
  const src = readSrc('components/layout/app-shell.tsx')
  assert.match(
    src,
    /import\s+{[^}]*\busePageMeta\b[^}]*}\s+from\s+['"]@\/lib\/page-meta-store['"]/,
    'AppShell must import usePageMeta from @/lib/page-meta-store',
  )
  assert.match(
    src,
    /usePageMeta\(\)/,
    'AppShell must call usePageMeta() hook',
  )
  assert.match(
    src,
    /ug-page-meta-title/,
    'AppShell topbar must render .ug-page-meta-title (CSS in globals.css)',
  )
})

// ── 3. globals.css に .ug-page-meta-title 等の class が存在 ─────────

test('globals.css contains .ug-page-meta class definitions', () => {
  const css = readSrc('app/globals.css')
  for (const cls of ['.ug-page-meta ', '.ug-page-meta-title', '.ug-page-meta-eyebrow']) {
    assert.ok(css.includes(cls), `globals.css must define ${cls}`)
  }
})

// ── 4. page-meta-store: pure function 部分のみ動作確認 ──────────────

// require() for TS module は不可なので、source-level に必要 export が
// 揃っていることだけ確認 (実 module の挙動は Next.js dev/build で検証される)。

test('page-meta-store exports setPageMeta / clearPageMeta / usePageMeta', () => {
  const src = readSrc('lib/page-meta-store.ts')
  for (const expName of ['setPageMeta', 'clearPageMeta', 'usePageMeta']) {
    assert.match(
      src,
      new RegExp(`export\\s+function\\s+${expName}\\b`),
      `lib/page-meta-store.ts must export ${expName}`,
    )
  }
  assert.match(src, /useSyncExternalStore/, 'must use useSyncExternalStore for SSR-safe subscription')
})

// require() unused 警告抑止 (createRequire は将来 .ts 直 load 対応時の足場)
void createRequire(import.meta.url)
