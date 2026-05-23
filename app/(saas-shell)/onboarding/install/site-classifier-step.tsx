/**
 * F-58 顧客自己診断 Step 1 — サイト URL 入力 → LLM 自動分類
 *
 * 親 SSOT v0.7 P-02 拡張 / decisions.md 2026-05-17 PM-B / Part V §5.5.1 P-02
 *
 * Sprint 1 = UI 骨組みのみ、Sprint 3 で ML `site_classifier` 接続。
 * 本コンポーネントは Step 1 (URL 入力 + classify call) + Step 2 (結果プレビュー、read-only)。
 * Step 3 (Operator HITL コメント) は Sprint 3 で追加。
 *
 * a11y:
 *  - IME composition 中の onChange 抑止
 *  - 実行中は role="status" + aria-live="polite"
 *  - confidence < 0.6 で警告バナー (赤、PM 防御 #1)
 *  - permanent inferred (vocabulary 外) は EvidenceBadge `inferred` 固定で警告
 */

'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ExternalLink, Loader2, ShieldAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { EvidenceBadge } from '@/components/dashboard/evidence-badge'

const schema = z.object({
  site_url: z.string().url('URL の形式が正しくありません'),
})

type FormValues = z.infer<typeof schema>

interface ClassifyResult {
  primary_industry: string
  business_model_tags: string[]
  confidence: number
}

interface SiteClassifierStepProps {
  siteId: string
}

export function SiteClassifierStep({ siteId }: SiteClassifierStepProps) {
  const [phase, setPhase] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [result, setResult] = useState<ClassifyResult | null>(null)

  const { register, handleSubmit, formState } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { site_url: '' },
  })

  async function onSubmit(values: FormValues) {
    setPhase('running')
    setResult(null)
    try {
      // Sprint 1 では実 ML 接続なし。Sprint 3 で /api/account/site/[site_id]/classify に切替。
      // 5 秒ダミー delay でユーザー体験を再現。
      await new Promise((r) => window.setTimeout(r, 1500))
      setResult({
        primary_industry: inferFromUrl(values.site_url),
        business_model_tags: ['EC', 'D2C', 'コスメ・ビューティ'],
        confidence: 0.48,
      })
      setPhase('done')
    } catch {
      setPhase('error')
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate aria-busy={phase === 'running'}>
      <div className="space-y-1.5">
        <Label htmlFor="site_url">サイト URL</Label>
        <div className="flex gap-2">
          <Input
            id="site_url"
            type="url"
            autoComplete="url"
            placeholder="https://www.your-site.com"
            aria-invalid={Boolean(formState.errors.site_url)}
            aria-describedby={formState.errors.site_url ? 'site-url-error' : undefined}
            disabled={phase === 'running'}
            {...register('site_url')}
          />
          <Button type="submit" disabled={phase === 'running'} className="gap-2">
            {phase === 'running' ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                分析中…
              </>
            ) : (
              <>
                <ExternalLink className="h-4 w-4" aria-hidden />
                業種を自動診断
              </>
            )}
          </Button>
        </div>
        {formState.errors.site_url ? (
          <p id="site-url-error" role="alert" className="text-xs text-destructive">
            {formState.errors.site_url.message}
          </p>
        ) : null}
        <p className="text-[11px] text-text-3">
          ML がサイトを解析し、業種候補を <strong>5-8 秒</strong> 程度で返します。
        </p>
      </div>

      {phase === 'running' ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-border bg-muted/50 px-4 py-6 text-center text-xs text-text-2"
        >
          <Loader2 className="mx-auto h-5 w-5 animate-spin text-primary" aria-hidden />
          <p className="mt-2">貴サイトを分析中です…(平均 5 秒)</p>
        </div>
      ) : null}

      {phase === 'done' && result ? (
        <ClassificationPreview result={result} siteId={siteId} />
      ) : null}

      {phase === 'error' ? (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
          分析中にエラーが発生しました。時間をおいて再度お試しください。
        </div>
      ) : null}
    </form>
  )
}

function ClassificationPreview({ result, siteId }: { result: ClassifyResult; siteId: string }) {
  const lowConfidence = result.confidence < 0.6

  return (
    <div className="rounded-md border border-border bg-background p-4 text-sm" data-site-id={siteId}>
      <div className="mb-3 flex items-center gap-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-text-3">
          診断結果
        </p>
        <EvidenceBadge
          evidence={{ level: 'inferred', confidence: result.confidence, references: [] }}
          compact
        />
      </div>

      <dl className="grid grid-cols-1 gap-y-3 sm:grid-cols-[160px_1fr]">
        <dt className="text-xs text-text-3">主要業種</dt>
        <dd className="text-sm font-semibold">{result.primary_industry}</dd>

        <dt className="text-xs text-text-3">ビジネスモデルタグ</dt>
        <dd className="flex flex-wrap gap-1.5">
          {result.business_model_tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-foreground"
            >
              {tag}
            </span>
          ))}
        </dd>
      </dl>

      {lowConfidence ? (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
          <p>
            分類自信度が低めです (confidence {Math.round(result.confidence * 100)}%)。
            <br />
            設定 → 業種設定から正しい業種を選び直すと、KPI の比較対象が最適化されます。
          </p>
        </div>
      ) : null}

      <p className="mt-4 text-[11px] text-text-3">
        Sprint 3 で業種編集 UI (Step 2) を有効化し、Operator が初期 100 サイトの分類を確認します。
      </p>
    </div>
  )
}

/** Sprint 1 用ダミー判定 (Sprint 3 で削除、ML 接続に置換) */
function inferFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (host.includes('shop') || host.includes('store')) return 'EC / D2C'
    if (host.includes('blog') || host.includes('media')) return 'メディア / オウンドメディア'
    if (host.includes('hotel') || host.includes('travel')) return '旅行・宿泊'
    return 'EC / D2C'
  } catch {
    return '判別不能 (Sprint 3 で改善)'
  }
}
