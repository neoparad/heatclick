/**
 * ChatModelMeta — assistant メッセージヘッダの Token / Latency 表示 (続 66 §3 F-3)
 *
 * 親 SSOT §3.6 / Part V P-AI / 続 66 §3 F-3
 * 配備: 続 69 (Frontend W2-A)
 *
 * 責務:
 *   - 通常モード: `{latencyMs}ms · {tokens} tok` の最小表示 (続 63 既存挙動を踏襲)
 *   - Debug モード (localStorage `chat-debug-meta=1`): TTFB / Latency / In/Out tokens
 *     / cost / model_id を全展開 (Owner / Reviewer / Engineer 観測用)
 *
 * Debug toggle:
 *   - `localStorage.chat-debug-meta` が `'1'` なら full 表示、それ以外は minimal
 *   - SSR 時は minimal (mount 後に localStorage 読み込んで切替、hydration mismatch 回避)
 *   - Toggle UI は明示ボタン (右クリック / Alt+Click 等の隠し操作にせず、tooltip + aria-label)
 *
 * Cost / TTFB が undefined (W1 stub / 既存 4-tier 経路) の場合は graceful fallback:
 *   - cost → "—"
 *   - ttftMs → 非表示
 *   - inputTokens / outputTokens → undefined なら従来通り合算のみ
 */

'use client'

import { useEffect, useState, useCallback } from 'react'
import { Eye, EyeOff } from 'lucide-react'

import type { ChatReply } from '@/types/evidence'
import { cn } from '@/lib/utils'

interface ChatModelMetaProps {
  meta: ChatReply['modelMeta']
  className?: string
}

const STORAGE_KEY = 'chat-debug-meta'

function readDebugFlag(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function writeDebugFlag(value: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0')
  } catch {
    /* private mode / quota — silently ignore */
  }
}

function formatCost(usd: number | undefined): string {
  if (typeof usd !== 'number' || Number.isNaN(usd)) return '—'
  if (usd < 0.001) return `$${(usd * 1000).toFixed(2)}m`
  return `$${usd.toFixed(4)}`
}

export function ChatModelMeta({ meta, className }: ChatModelMetaProps) {
  // SSR hydration mismatch 回避: 初期は false (minimal)、mount 後に localStorage 反映
  const [debug, setDebug] = useState<boolean>(false)
  const [mounted, setMounted] = useState<boolean>(false)

  useEffect(() => {
    setMounted(true)
    setDebug(readDebugFlag())
  }, [])

  const toggleDebug = useCallback(() => {
    setDebug((prev) => {
      const next = !prev
      writeDebugFlag(next)
      return next
    })
  }, [])

  const totalTokens = meta.tokens
  const inputTokens = meta.inputTokens
  const outputTokens = meta.outputTokens
  const ttftMs = meta.ttftMs
  const latencyMs = meta.latencyMs
  const costUsd = meta.costUsd
  const modelId = meta.model

  // mount 前 or debug off → minimal
  if (!mounted || !debug) {
    return (
      <button
        type="button"
        onClick={toggleDebug}
        className={cn(
          'inline-flex items-center gap-1 font-mono text-[10px] text-text-3 hover:text-foreground',
          className,
        )}
        title="Click to show full token / latency breakdown"
        aria-label="Toggle chat debug meta"
        data-testid="chat-model-meta"
        data-debug={mounted && debug ? '1' : '0'}
      >
        <span>
          {latencyMs}ms · {totalTokens.toLocaleString()} tok
        </span>
        <Eye className="h-3 w-3 opacity-60" aria-hidden />
      </button>
    )
  }

  // debug ON → full breakdown
  return (
    <span
      className={cn(
        'inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] text-text-3',
        className,
      )}
      data-testid="chat-model-meta"
      data-debug="1"
    >
      {typeof ttftMs === 'number' ? <span title="Time to first token">TTFB {ttftMs}ms</span> : null}
      <span title="End-to-end latency">Latency {latencyMs}ms</span>
      {typeof inputTokens === 'number' ? <span title="Input tokens">In {inputTokens}t</span> : null}
      {typeof outputTokens === 'number' ? (
        <span title="Output tokens">Out {outputTokens}t</span>
      ) : null}
      {typeof inputTokens !== 'number' && typeof outputTokens !== 'number' ? (
        <span title="Total tokens (in + out)">Tot {totalTokens}t</span>
      ) : null}
      <span title="Inference cost USD">{formatCost(costUsd)}</span>
      <span className="truncate" title={`Model: ${modelId}`}>
        {modelId}
      </span>
      <button
        type="button"
        onClick={toggleDebug}
        className="inline-flex h-3.5 w-3.5 items-center justify-center text-text-3 hover:text-foreground"
        title="Hide debug breakdown"
        aria-label="Hide chat debug meta"
      >
        <EyeOff className="h-3 w-3" aria-hidden />
      </button>
    </span>
  )
}
