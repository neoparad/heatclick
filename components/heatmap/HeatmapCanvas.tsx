'use client'

import React, { useEffect, useRef } from 'react'
import h337 from 'heatmap.js'

interface HeatmapPoint {
  x: number
  y: number
  value: number
}

interface HeatmapCanvasProps {
  data: HeatmapPoint[]
  width?: number
  height?: number
  className?: string
}

export default function HeatmapCanvas({
  data,
  width = 800,
  height = 600,
  className = ''
}: HeatmapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const heatmapInstanceRef = useRef<any>(null)

  useEffect(() => {
    if (!containerRef.current || !data.length) return

    // 既存のheatmapインスタンスを破棄
    if (heatmapInstanceRef.current) {
      // heatmap.jsには明示的な破棄メソッドがないため、containerをクリア
      const container = containerRef.current
      while (container.firstChild) {
        container.removeChild(container.firstChild)
      }
    }

    // heatmap.jsインスタンスを作成
    heatmapInstanceRef.current = h337.create({
      container: containerRef.current,
      radius: 40,
      maxOpacity: 0.6,
      minOpacity: 0.1,
      blur: 0.75,
      // 青→緑→黄→オレンジ→赤のグラデーション
      gradient: {
        '0.0': 'blue',
        '0.25': 'cyan',
        '0.5': 'lime',
        '0.75': 'yellow',
        '0.85': 'orange',
        '1.0': 'red'
      }
    })

    // 最大値を計算
    const maxValue = Math.max(...data.map(p => p.value))

    // データを設定
    heatmapInstanceRef.current.setData({
      max: maxValue,
      data: data.map(point => ({
        x: point.x,
        y: point.y,
        value: point.value
      }))
    })

    // クリーンアップ
    return () => {
      if (containerRef.current && heatmapInstanceRef.current) {
        const container = containerRef.current
        while (container.firstChild) {
          container.removeChild(container.firstChild)
        }
        heatmapInstanceRef.current = null
      }
    }
  }, [data])

  return (
    <div
      ref={containerRef}
      className={`relative ${className}`}
      style={{
        width: `${width}px`,
        height: `${height}px`,
        border: '2px solid #e5e7eb',
        borderRadius: '8px',
        overflow: 'hidden'
      }}
    />
  )
}
