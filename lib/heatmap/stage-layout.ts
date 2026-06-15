/**
 * Stage layout helpers — outer `.hm-page` (SSOT 720) と inner `.hm-page-stage`
 * (capture px space) の sizing 計算を pure 関数として抽出。
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04
 * Dispatch: 2026-05-29 続 116 frontend heatmap screenshot stage-fix
 *
 * Codex H-3 副作用根本治療:
 *   - 続 115 では capture native px で hm-page を render → 1080+ で SSOT 720 破壊
 *   - 続 116 では outer を 720 (or pageMaxWidth) 固定し、inner stage を
 *     `transform: scale(displayWidth / naturalWidth)` で縮小
 *   - blob / tag は capture px 空間に配置されたまま stage と一緒に scale 縮小される
 */

export interface StageLayoutInput {
  /** 表示幅 (mockup SSOT で 720、fullscreen 時は device 別 fsMaxWidth) */
  displayWidth: number
  /** screenshot 実 width (Microlink から返却された naturalWidth) */
  captureNaturalWidth: number
  /** screenshot 実 height (Microlink から返却された naturalHeight) */
  captureNaturalHeight: number
}

export interface StageLayout {
  /** inner stage の transform: scale(s) に渡す数値 (CSS scale 比) */
  scale: number
  /** outer `.hm-page` height (= naturalHeight * scale)、px */
  outerHeight: number
  /** outer `.hm-page` width (= displayWidth)、px */
  outerWidth: number
  /** inner stage width (= naturalWidth)、capture px */
  stageWidth: number
  /** inner stage height (= naturalHeight)、capture px */
  stageHeight: number
}

/**
 * 与えられた display 幅と capture サイズから stage layout を計算する。
 *
 * 入力 validation:
 *   - displayWidth <= 0 / capture サイズ <= 0 の場合は scale=1, outer=display で安全側に
 *     倒す (CSS で `width:0`/負値を生まないため)。
 */
export function computeStageLayout(input: StageLayoutInput): StageLayout {
  const safeDisplay = input.displayWidth > 0 ? input.displayWidth : 0
  const safeNW = input.captureNaturalWidth > 0 ? input.captureNaturalWidth : 0
  const safeNH = input.captureNaturalHeight > 0 ? input.captureNaturalHeight : 0
  if (safeDisplay === 0 || safeNW === 0 || safeNH === 0) {
    return {
      scale: 1,
      outerHeight: safeDisplay,
      outerWidth: safeDisplay,
      stageWidth: safeNW,
      stageHeight: safeNH,
    }
  }
  const scale = safeDisplay / safeNW
  return {
    scale,
    outerHeight: Math.round(safeNH * scale),
    outerWidth: safeDisplay,
    stageWidth: safeNW,
    stageHeight: safeNH,
  }
}

/**
 * 続 117 v2 root-fix: `transform: scale` の巨大 GPU layer を廃止し、native `<img width:100%>`
 * + overlay 個別 scale に置換するための pure helper 群。
 *
 * `computeStageLayout` (上) は単体 test 維持のため残すが、HeatmapCanvas は以下を使う:
 *   - referenceWidth (= capture.viewportWidth, CSS px, DPR 非依存) を基準に
 *   - displayScale = actualOuterWidth / referenceWidth を overlay 各要素に掛けて縮小
 *   - `<img width:100%>` は actualOuterWidth で自然縮小されるため両者が一致する
 */

/**
 * 実 outer 幅と基準幅 (referenceWidth) から overlay の表示 scale を求める。
 *   - <img width:100%> は actualOuterWidth で表示されるので、capture CSS px 空間の
 *     blob/tag に同じ scale を掛ければ画像とピクセル一致する。
 *   - いずれかが 0 以下なら安全側に 1 を返す (overflow / 負値を防ぐ)。
 */
export function computeDisplayScale(actualOuterWidth: number, referenceWidth: number): number {
  // 続 117 v2 Codex T2 review fix (LOW): client は JSON cast を信用するため NaN/Infinity も弾く。
  if (!Number.isFinite(actualOuterWidth) || !Number.isFinite(referenceWidth)) return 1
  if (actualOuterWidth <= 0 || referenceWidth <= 0) return 1
  return actualOuterWidth / referenceWidth
}

/**
 * screenshot の CSS px 全高を求める (DPR 水増しを除去)。
 *   pageCssHeight = naturalHeight * referenceWidth / naturalWidth
 *
 * 例: DPR=2 の pc capture は naturalWidth=2560, naturalHeight=2*realHeight。
 *     referenceWidth=1280 を掛けると realHeight (CSS px) に戻る。click_y (CSS px) と同空間。
 *   いずれかが 0 以下なら 0 を返す (呼び出し側で fallback 高を使う)。
 */
export function computePageCssHeight(
  naturalWidth: number,
  naturalHeight: number,
  referenceWidth: number,
): number {
  // 続 117 v2 Codex T2 review fix (LOW): NaN/Infinity も弾く (client は JSON cast を信用するため)。
  if (
    !Number.isFinite(naturalWidth) ||
    !Number.isFinite(naturalHeight) ||
    !Number.isFinite(referenceWidth)
  ) {
    return 0
  }
  if (naturalWidth <= 0 || naturalHeight <= 0 || referenceWidth <= 0) return 0
  return Math.round((naturalHeight * referenceWidth) / naturalWidth)
}
