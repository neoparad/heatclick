/**
 * heatmap.js v2.x には公式 TypeScript 型がないため、最低限の型宣言を提供する。
 *
 * 親 SSOT Part V §5.5.1 P-04 / Infra heatmap-pagination.md §6
 */

declare module 'heatmap.js' {
  export interface HeatmapDataPoint {
    x: number
    y: number
    value: number
    radius?: number
  }

  export interface HeatmapData {
    max: number
    min?: number
    data: HeatmapDataPoint[]
  }

  export interface HeatmapConfiguration {
    container: HTMLElement
    radius?: number
    maxOpacity?: number
    minOpacity?: number
    blur?: number
    gradient?: Record<string, string>
    backgroundColor?: string
  }

  export interface HeatmapInstance {
    setData(data: HeatmapData): HeatmapInstance
    setDataMax(max: number): HeatmapInstance
    setDataMin(min: number): HeatmapInstance
    addData(point: HeatmapDataPoint | HeatmapDataPoint[]): HeatmapInstance
    getData(): HeatmapData
    getValueAt(point: { x: number; y: number }): number
    repaint(): HeatmapInstance
    getDataURL(): string
  }

  const h337: {
    create(config: HeatmapConfiguration): HeatmapInstance
  }

  export default h337
}
