declare module 'heatmap.js' {
  interface HeatmapPoint {
    x: number
    y: number
    value: number
  }

  interface HeatmapData {
    max?: number
    min?: number
    data: HeatmapPoint[]
  }

  interface HeatmapConfig {
    container: HTMLElement
    radius?: number
    maxOpacity?: number
    minOpacity?: number
    blur?: number
    gradient?: Record<string, string>
  }

  interface Heatmap {
    setData(data: HeatmapData): void
    addData(data: HeatmapPoint | HeatmapPoint[]): void
    setDataMax(max: number): void
    setDataMin(min: number): void
    configure(config: Partial<HeatmapConfig>): void
    getValueAt(point: { x: number; y: number }): number
    getData(): HeatmapData
    repaint(): void
  }

  function create(config: HeatmapConfig): Heatmap

  export = { create }
}
