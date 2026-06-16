/**
 * HeatmapToolbar source-level assertion (node env、jsdom 不要)
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04
 * Dispatch: 2026-05-29 続 116 (D 改修) heatmap-toolbar URL bar 撤去 + stats 拡大
 *
 * jsdom コンポーネント test 環境がないため、ソース文字列に対する regression test で
 * 「URL bar が誤って復活していない」「canvas-stat-* testid が残っている」を担保する。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

const TOOLBAR_SOURCE = readFileSync(
  path.join(__dirname, 'heatmap-toolbar.tsx'),
  'utf-8',
)

describe('HeatmapToolbar source-level regression (続 116 D 改修)', () => {
  it('does NOT contain heatmap-url-bar testid (URL bar 撤去)', () => {
    expect(TOOLBAR_SOURCE).not.toContain('heatmap-url-bar')
  })

  it('does NOT render the lock-icon SVG that was inside the old URL bar', () => {
    // 旧 URL bar 内に lock icon (path d="M7 11V7a5 5 0 0 1 10 0v4") があったので残骸 catch
    expect(TOOLBAR_SOURCE).not.toContain('M7 11V7a5 5 0 0 1 10 0v4')
  })

  it('still exposes canvas-stat-* testids (集約された stats が canvas-top に存在)', () => {
    expect(TOOLBAR_SOURCE).toContain('canvas-stat-pv')
    expect(TOOLBAR_SOURCE).toContain('canvas-stat-ctr')
    expect(TOOLBAR_SOURCE).toContain('canvas-stat-scroll')
    expect(TOOLBAR_SOURCE).toContain('canvas-stat-dwell')
  })

  it('exposes new canvas-stats-group container testid', () => {
    expect(TOOLBAR_SOURCE).toContain('canvas-stats-group')
  })

  it('retains existing device tab + action button testids', () => {
    expect(TOOLBAR_SOURCE).toContain('device-tab-')
    expect(TOOLBAR_SOURCE).toContain('toggle-controls-btn')
    expect(TOOLBAR_SOURCE).toContain('toggle-side-btn')
    expect(TOOLBAR_SOURCE).toContain('enter-fullscreen-btn')
  })

  it('does NOT receive pageUrl prop (撤去された)', () => {
    // インターフェース定義から pageUrl が消えていること
    expect(TOOLBAR_SOURCE).not.toMatch(/pageUrl:\s*string/)
  })
})
