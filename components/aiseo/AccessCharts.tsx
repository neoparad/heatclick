'use client'

import { useId } from 'react'

const AX = 'var(--chart-axis)'
const GRID = 'var(--chart-grid)'
const MUT = 'var(--linkth-muted)'

export interface LinePoint {
  date: string
  value: number
}

interface LineChartProps {
  series?: ReadonlyArray<LinePoint>
  color?: string
  height?: number
  valueFmt?: (v: number) => string | number
}

export function LineChart({
  series = [],
  color = 'var(--chart-1)',
  height = 220,
  valueFmt = (v) => v,
}: LineChartProps) {
  const gid = useId().replace(/:/g, '')
  const w = 720
  const h = height
  const padL = 48
  const padR = 16
  const padT = 16
  const padB = 28
  const innerW = w - padL - padR
  const innerH = h - padT - padB

  if (!series.length) {
    return (
      <div style={{ color: MUT, fontSize: 12, padding: 24, textAlign: 'center' }}>
        データなし
      </div>
    )
  }
  const vals = series.map((d) => d.value)
  const maxV = Math.max(1, ...vals)
  const minV = Math.min(0, ...vals)
  const span = maxV - minV || 1
  const x = (i: number) =>
    padL + (series.length === 1 ? innerW / 2 : (i / (series.length - 1)) * innerW)
  const y = (v: number) => padT + innerH - ((v - minV) / span) * innerH

  const line = series
    .map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`)
    .join(' ')
  const area = `${line} L${x(series.length - 1).toFixed(1)},${(padT + innerH).toFixed(1)} L${x(0).toFixed(1)},${(padT + innerH).toFixed(1)} Z`

  const ticks = 4
  const gridLines = Array.from({ length: ticks + 1 }, (_, i) => {
    const v = minV + (span * i) / ticks
    return { v, yy: y(v) }
  })

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width="100%"
      style={{ display: 'block' }}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <linearGradient id={`laGrad${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {gridLines.map((g, i) => (
        <g key={i}>
          <line x1={padL} y1={g.yy} x2={w - padR} y2={g.yy} stroke={GRID} strokeWidth="1" />
          <text x={padL - 8} y={g.yy + 3} textAnchor="end" fontSize="9" fill={MUT}>
            {valueFmt(Math.round(g.v))}
          </text>
        </g>
      ))}
      <path d={area} fill={`url(#laGrad${gid})`} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <text x={padL} y={h - 8} fontSize="9" fill={MUT}>
        {series[0].date}
      </text>
      <text x={w - padR} y={h - 8} textAnchor="end" fontSize="9" fill={MUT}>
        {series[series.length - 1].date}
      </text>
    </svg>
  )
}

export interface ScatterPoint {
  x: number
  y: number
}

export interface ScatterMetricDef {
  posLabel: string
  negLabel: string
  xTitle: string
  yTitle: string
  xFmt: (v: number) => string | number
}

interface ScatterChangeProps {
  data?: ReadonlyArray<ScatterPoint>
  metric: ScatterMetricDef
  height?: number
}

export function ScatterChange({ data = [], metric, height = 300 }: ScatterChangeProps) {
  const w = 720
  const h = height
  const padL = 56
  const padR = 16
  const padT = 14
  const padB = 34
  const innerW = w - padL - padR
  const innerH = h - padT - padB
  const POS = 'var(--chart-pos)'
  const NEG = 'var(--chart-neg)'

  if (!data.length) {
    return (
      <div style={{ color: MUT, fontSize: 12, padding: 24, textAlign: 'center' }}>
        比較できるデータがありません（両期間に存在する項目が必要）
      </div>
    )
  }
  const maxX = Math.max(1, ...data.map((d) => d.x))
  const maxAbsY = Math.max(1, ...data.map((d) => Math.abs(d.y)))
  const x = (v: number) => padL + (v / maxX) * innerW
  const y = (v: number) => padT + innerH / 2 - (v / maxAbsY) * (innerH / 2)
  const zeroY = y(0)

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width="100%"
      style={{ display: 'block' }}
      preserveAspectRatio="xMidYMid meet"
    >
      <rect x={padL} y={padT} width={innerW} height={zeroY - padT} fill={POS} opacity="0.04" />
      <rect
        x={padL}
        y={zeroY}
        width={innerW}
        height={padT + innerH - zeroY}
        fill={NEG}
        opacity="0.04"
      />
      <line x1={padL} y1={padT} x2={padL} y2={padT + innerH} stroke={AX} strokeWidth="1" />
      <line
        x1={padL}
        y1={zeroY}
        x2={w - padR}
        y2={zeroY}
        stroke={AX}
        strokeWidth="1"
        strokeDasharray="3 3"
      />
      {data.map((d, i) => (
        <circle
          key={i}
          cx={x(d.x)}
          cy={y(d.y)}
          r="3.5"
          fill={d.y >= 0 ? POS : NEG}
          opacity="0.7"
        />
      ))}
      <text x={padL + 6} y={padT + 12} fontSize="10" fill={POS} fontWeight="600">
        ▲ {metric.posLabel}
      </text>
      <text x={padL + 6} y={padT + innerH - 4} fontSize="10" fill={NEG} fontWeight="600">
        ▼ {metric.negLabel}
      </text>
      <text x={(padL + w - padR) / 2} y={h - 8} textAnchor="middle" fontSize="10" fill={MUT}>
        {metric.xTitle} →
      </text>
      <text
        x={14}
        y={padT + innerH / 2}
        textAnchor="middle"
        fontSize="10"
        fill={MUT}
        transform={`rotate(-90 14 ${padT + innerH / 2})`}
      >
        {metric.yTitle}
      </text>
      {[0, 0.5, 1].map((t, i) => (
        <text
          key={i}
          x={x(maxX * t)}
          y={padT + innerH + 16}
          textAnchor="middle"
          fontSize="9"
          fill={MUT}
        >
          {metric.xFmt(maxX * t)}
        </text>
      ))}
    </svg>
  )
}
