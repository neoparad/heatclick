'use client'

/**
 * NlConditionInput — 自然言語 → 条件 AST 入力 (M-Director Phase 2、2026-06-07)
 *
 * 「初回訪問で 1 分以上いてカートに行ってないユーザー」のような日本語要件を
 * POST /api/scenarios/nl-to-ast に送り、生成された AST を親 component に渡す。
 *
 * Evidence Level バッジ表示 (D-07 整合): 結果は常に 'inferred' (LLM 推定)。
 * confidence / reasoning / warnings も並べて、誤解釈に気付けるようにする。
 */

import { useState } from 'react'
import { Loader2, Sparkles, AlertTriangle } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ConditionNode } from '@/lib/scenarios/types'

interface NlConditionInputProps {
  onAstGenerated: (ast: ConditionNode, meta: NlGenerationMeta) => void
  disabled?: boolean
}

export interface NlGenerationMeta {
  confidence: 'high' | 'medium' | 'low'
  evidence_level: 'inferred'
  reasoning: string
  warnings: ReadonlyArray<string>
  source: 'ai-gateway' | 'stub' | 'fallback'
}

interface ApiSuccess {
  success: true
  data: {
    ast: ConditionNode
    confidence: 'high' | 'medium' | 'low'
    evidence_level: 'inferred'
    reasoning: string
    warnings: string[]
    source: 'ai-gateway' | 'stub' | 'fallback'
    validation: { errors: Array<{ code: string; message: string; field?: string }> }
  }
}

interface ApiError {
  success: false
  error: { code: string; message: string }
}

export function NlConditionInput({ onAstGenerated, disabled = false }: NlConditionInputProps) {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [meta, setMeta] = useState<NlGenerationMeta | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(): Promise<void> {
    if (disabled || loading || text.trim().length === 0) return
    setLoading(true)
    setError(null)
    setMeta(null)
    try {
      const res = await fetch('/api/scenarios/nl-to-ast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim() }),
      })
      const json = (await res.json()) as ApiSuccess | ApiError
      if (!res.ok || !json.success) {
        const msg = !json.success ? json.error.message : `HTTP ${res.status}`
        setError(msg)
        return
      }
      const { ast, confidence, evidence_level, reasoning, warnings, source } = json.data
      const newMeta: NlGenerationMeta = { confidence, evidence_level, reasoning, warnings, source }
      setMeta(newMeta)
      onAstGenerated(ast, newMeta)
    } catch (err) {
      setError(err instanceof Error ? err.message : '通信エラー')
    } finally {
      setLoading(false)
    }
  }

  const confidenceColor =
    meta?.confidence === 'high'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
      : meta?.confidence === 'medium'
      ? 'bg-amber-50 text-amber-700 border-amber-300'
      : 'bg-rose-50 text-rose-700 border-rose-300'

  return (
    <div className="bg-slate-50 border border-slate-200 rounded-md p-3 space-y-2">
      <div className="text-[11px] text-slate-500 font-mono uppercase tracking-wider font-semibold flex items-center gap-2">
        <span>自然言語入力</span>
        <Badge variant="outline" className="bg-indigo-50 text-indigo-700 border-indigo-200 text-[9.5px]">
          Claude Haiku 4.5
        </Badge>
        <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 text-[9.5px]">
          Evidence: inferred
        </Badge>
      </div>

      <div className="flex gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSubmit()
          }}
          placeholder="例: 初回訪問で 1 分以上いてカートに行ってないユーザー"
          disabled={disabled || loading}
          maxLength={500}
          className="h-9 text-xs bg-white"
          aria-label="自然言語による条件指定"
        />
        <Button
          size="sm"
          disabled={disabled || loading || text.trim().length === 0}
          onClick={handleSubmit}
          className="shrink-0"
        >
          {loading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Sparkles className="mr-1 h-3 w-3" />}
          {loading ? '生成中...' : 'AI で条件式に変換'}
        </Button>
      </div>

      {error ? (
        <div className="flex items-start gap-1.5 text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1.5">
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {meta ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={`text-[10px] ${confidenceColor}`}>
              confidence: {meta.confidence}
            </Badge>
            <Badge variant="outline" className="text-[10px] bg-slate-100 text-slate-600 border-slate-300 font-mono">
              source: {meta.source}
            </Badge>
            <span className="text-[10.5px] text-slate-500">下の Visual Builder で確認・編集してください</span>
          </div>
          {meta.reasoning ? (
            <div className="text-[11px] text-slate-600 leading-relaxed bg-white border border-slate-200 rounded px-2.5 py-1.5">
              <span className="font-semibold text-slate-700">解釈: </span>
              {meta.reasoning}
            </div>
          ) : null}
          {meta.warnings.length > 0 ? (
            <ul className="text-[10.5px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5 space-y-0.5">
              {meta.warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <span className="text-amber-600">⚠</span>
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="text-[10px] text-slate-400 font-mono">
        ヒント: Ctrl/Cmd + Enter で送信 / 最大 500 文字 / 結果は自動入力されません — 下で確認後に「保存」してください
      </div>
    </div>
  )
}
