/**
 * Unit tests for sidebar SSOT compliance — 続 73 (Frontend mockup 再現)
 *
 * 背景: 続 55 で sidebar SSOT 確定 (data-nav 値 + 4 ピラー構成 + 行動分析 active 固定)。
 *       続 73 で React 化、本テストは source-level inspection で SSOT 適合を保証。
 *
 * 検証対象:
 *   1. SidebarPillar.tsx — 4 ピラー (behavior active / m-agent / aiseo / custom-bi coming soon)
 *   2. SidebarNav.tsx — 行動分析 7 items + 分析 3 items + アカウント 2 items の data-nav SSOT
 *   3. AppShell.tsx — sidebar / topbar / main 3 region 構造
 *   4. (proof)/layout.tsx — AppShell wrap で 全 proof page に sidebar 提供
 *
 * Strategy: source-level inspection (regex)。E2E は Playwright sign-in 後の (proof)
 *           page で別途検証。
 *
 * Usage:
 *   cd ugokimap-saas
 *   node --test tests/unit/sidebar-nav-ssot.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function readSrc(relPath) {
  return readFileSync(resolve(__dirname, '../..', relPath), 'utf8')
}

const pillarSrc = readSrc('components/layout/sidebar-pillar.tsx')
const navSrc = readSrc('components/layout/sidebar-nav.tsx')
const shellSrc = readSrc('components/layout/app-shell.tsx')
const layoutSrc = readSrc('app/(proof)/layout.tsx')

// ── SidebarPillar 4 pillar SSOT (続 66 §3) ──────────────────────────

test('SidebarPillar declares all 4 pillars (続 66 §3 IA SSOT)', () => {
  const required = ['behavior', 'm-agent', 'aiseo', 'custom-bi']
  for (const id of required) {
    assert.ok(
      pillarSrc.includes(`'${id}'`) || pillarSrc.includes(`"${id}"`),
      `SidebarPillar must declare pillar '${id}'`,
    )
  }
})

test('SidebarPillar marks behavior as comingSoon=false, others coming soon (続 55 SSOT)', () => {
  // SEED 配列の behavior エントリは comingSoon: false、他は true
  const behaviorBlockRe = /id:\s*['"]behavior['"][\s\S]*?comingSoon:\s*false/
  assert.ok(
    behaviorBlockRe.test(pillarSrc),
    'behavior pillar must be active (comingSoon: false)',
  )
  for (const id of ['m-agent', 'aiseo', 'custom-bi']) {
    const re = new RegExp(`id:\\s*['"]${id}['"][\\s\\S]*?comingSoon:\\s*true`)
    assert.ok(re.test(pillarSrc), `${id} pillar must be coming soon (comingSoon: true)`)
  }
})

test('SidebarPillar uses Coming soon badge on coming-soon pillars', () => {
  assert.ok(
    pillarSrc.includes('Coming soon'),
    'SidebarPillar must render "Coming soon" badge text',
  )
  assert.ok(
    pillarSrc.includes('ug-coming-badge'),
    'SidebarPillar must use ug-coming-badge CSS class',
  )
})

// ── SidebarNav data-nav SSOT (続 55) ─────────────────────────────────

const PRIMARY_NAV_KEYS = [
  'ai-chat',
  'heatmap',
  'session-replay',
  'cv-journey',
  'path-analysis',
  'action-tickets',
  'site-doc',
]

const ANALYSIS_SUB_KEYS = ['performance-behavior', 'personas', 'pages']
const ACCOUNT_KEYS = ['install-settings', 'logout']

test('SidebarNav declares all 7 primary nav data-nav keys (続 55 SSOT)', () => {
  for (const key of PRIMARY_NAV_KEYS) {
    assert.ok(
      navSrc.includes(`navKey: '${key}'`) || navSrc.includes(`navKey: "${key}"`),
      `SidebarNav must include data-nav '${key}' in PRIMARY_NAV`,
    )
  }
})

test('SidebarNav declares 3 analysis sub-nav data-nav keys (続 55 SSOT)', () => {
  for (const key of ANALYSIS_SUB_KEYS) {
    assert.ok(
      navSrc.includes(`navKey: '${key}'`) || navSrc.includes(`navKey: "${key}"`),
      `SidebarNav must include sub-nav '${key}' in ANALYSIS_SUB_NAV`,
    )
  }
})

test('SidebarNav declares account nav (settings + logout)', () => {
  for (const key of ACCOUNT_KEYS) {
    assert.ok(
      navSrc.includes(`navKey: '${key}'`) || navSrc.includes(`navKey: "${key}"`),
      `SidebarNav must include account nav '${key}'`,
    )
  }
})

test('SidebarNav uses Next.js Link for active routes (not <a>)', () => {
  assert.ok(
    navSrc.includes(`from 'next/link'`),
    'SidebarNav must import next/link for client-side navigation',
  )
  assert.ok(
    navSrc.includes('<Link'),
    'SidebarNav must render <Link> for enabled nav items',
  )
})

test('SidebarNav uses usePathname for active state', () => {
  assert.ok(
    navSrc.includes(`from 'next/navigation'`) && navSrc.includes('usePathname'),
    'SidebarNav must use usePathname() to compute active state',
  )
})

test('SidebarNav primary nav: at least ai-chat + heatmap are enabled (not disabled)', () => {
  // 続 71 までで chat + heatmap は配備済、disabled: true がついていないこと
  const aiChatBlockRe = /navKey:\s*['"]ai-chat['"][\s\S]{0,200}/
  const heatmapBlockRe = /navKey:\s*['"]heatmap['"][\s\S]{0,200}/
  const aiChatBlock = navSrc.match(aiChatBlockRe)?.[0] ?? ''
  const heatmapBlock = navSrc.match(heatmapBlockRe)?.[0] ?? ''
  assert.ok(
    !/disabled:\s*true/.test(aiChatBlock),
    'ai-chat must be enabled (not disabled) — was deployed at 続 63',
  )
  assert.ok(
    !/disabled:\s*true/.test(heatmapBlock),
    'heatmap must be enabled (not disabled) — was deployed at 続 56',
  )
})

test('SidebarNav personas sub-link is enabled (deployed at 続 41)', () => {
  const personasBlockRe = /navKey:\s*['"]personas['"][\s\S]{0,200}/
  const personasBlock = navSrc.match(personasBlockRe)?.[0] ?? ''
  assert.ok(
    !/disabled:\s*true/.test(personasBlock),
    'personas sub-nav must be enabled (deployed at 続 41)',
  )
})

// 続 75 Task B / Task D: path-analysis + install-settings の disabled 解除
// regex で navKey block 切り出し、`},` の手前まで局所化 (次 NavItem の disabled
// と取り違えないように非 greedy match + 直近 `}` まで)
function extractNavBlock(src, navKey) {
  const re = new RegExp(`navKey:\\s*['"]${navKey}['"][\\s\\S]*?\\n\\s*\\},`)
  return src.match(re)?.[0] ?? ''
}

test('SidebarNav path-analysis is enabled (続 75 Task B: /paths page 配備)', () => {
  const block = extractNavBlock(navSrc, 'path-analysis')
  assert.ok(block.length > 0, 'path-analysis nav block not found')
  assert.ok(
    !/disabled:\s*true/.test(block),
    'path-analysis must be enabled after 続 75 Task B deployment',
  )
  assert.ok(
    /href:\s*['"]\/paths['"]/.test(block),
    'path-analysis must point to /paths (user-specified in 続 74 dispatch)',
  )
})

test('SidebarNav install-settings is enabled (続 75 Task D: /install page 配備)', () => {
  const block = extractNavBlock(navSrc, 'install-settings')
  assert.ok(block.length > 0, 'install-settings nav block not found')
  assert.ok(
    !/disabled:\s*true/.test(block),
    'install-settings must be enabled after 続 75 Task D deployment',
  )
  assert.ok(
    /href:\s*['"]\/install['"]/.test(block),
    'install-settings must point to /install',
  )
})

// ── AppShell structure (続 73) ────────────────────────────────────────

test('AppShell renders SidebarPillar + SidebarNav (3-pane structure)', () => {
  assert.ok(shellSrc.includes('<SidebarPillar'), 'AppShell must render <SidebarPillar />')
  assert.ok(shellSrc.includes('<SidebarNav'), 'AppShell must render <SidebarNav />')
  assert.ok(
    shellSrc.includes('ug-app') &&
      shellSrc.includes('ug-sidebar') &&
      shellSrc.includes('ug-main') &&
      shellSrc.includes('ug-topbar') &&
      shellSrc.includes('ug-main-body'),
    'AppShell must use ug-app / ug-sidebar / ug-main / ug-topbar / ug-main-body CSS classes',
  )
})

test('AppShell supports mobile hamburger toggle (続 73 mobile responsive)', () => {
  assert.ok(
    shellSrc.includes('mobile-open') || shellSrc.includes('mobileOpen'),
    'AppShell must support mobile-open state (hamburger toggle)',
  )
  assert.ok(
    shellSrc.includes('md:hidden') || shellSrc.includes('md:inline'),
    'AppShell must use md: breakpoint for desktop/mobile divergence',
  )
})

test('AppShell persists sidebar state in localStorage (続 73 UX continuity)', () => {
  assert.ok(
    shellSrc.includes('localStorage') && shellSrc.includes('ugokimap_sidebar_state'),
    'AppShell must persist sidebar state to localStorage under key "ugokimap_sidebar_state"',
  )
})

test('AppShell supports Ctrl/Cmd+B shortcut (mockup 流儀)', () => {
  assert.ok(
    /metaKey|ctrlKey/.test(shellSrc) && /'b'|"b"/.test(shellSrc),
    'AppShell must register Ctrl/Cmd+B keyboard shortcut for sidebar toggle',
  )
})

// ── (proof)/layout integration ────────────────────────────────────────

test('(proof)/layout wraps children with AppShell', () => {
  assert.ok(
    layoutSrc.includes("from '@/components/layout/app-shell'") &&
      layoutSrc.includes('<AppShell'),
    '(proof)/layout.tsx must wrap children with <AppShell />',
  )
})

test('(proof)/layout sets pillar="behavior" (Phase 1)', () => {
  assert.ok(
    layoutSrc.includes(`pillar="behavior"`) || layoutSrc.includes(`pillar='behavior'`),
    '(proof)/layout must set pillar="behavior" for Phase 1',
  )
})

// ── M-Director 続 83 §4 Day 2 (2026-05-25): M Agent pillar 配下 nav 追加 ────

test('SidebarPillar m-agent links to /scenarios (Day 2 React route)', () => {
  // 続 83 §A の暫定 /mockups/ link から /scenarios に切替済を確認
  assert.ok(
    pillarSrc.includes(`'/scenarios'`) || pillarSrc.includes(`"/scenarios"`),
    'SidebarPillar must link m-agent to /scenarios (Day 2 React route, not /mockups/)',
  )
  assert.ok(
    pillarSrc.includes('usePathname'),
    'SidebarPillar must use usePathname() to auto-activate m-agent on /scenarios* paths',
  )
})

test('SidebarNav declares M_AGENT_NAV with ターゲティングバナー (M-Director Day 2)', () => {
  assert.ok(
    navSrc.includes('M_AGENT_NAV'),
    'SidebarNav must declare M_AGENT_NAV array for m-agent pillar',
  )
  assert.ok(
    navSrc.includes(`navKey: 'targeting-banner'`) || navSrc.includes(`navKey: "targeting-banner"`),
    'SidebarNav M_AGENT_NAV must include targeting-banner item',
  )
  assert.ok(
    navSrc.includes(`href: '/scenarios'`) || navSrc.includes(`href: "/scenarios"`),
    'SidebarNav targeting-banner must href=/scenarios',
  )
  assert.ok(
    /isMAgentPath|pathname.*scenarios/.test(navSrc),
    'SidebarNav must branch on pathname /scenarios* to render M_AGENT_NAV',
  )
})
