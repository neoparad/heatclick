/**
 * tracking.js snippet 表示 + clipboard copy
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-02
 * B-1 (decisions.md L275 続 14 / L162 続 15 §4.4 BR1):
 *   multi-tenant 化に伴い `data-tenant-id` 属性必須化。tracking.js は不在時に
 *   sendBeacon を抑止する (silent drop)。本コンポーネントは tenantId prop を
 *   受け取り snippet に注入する。
 */

'use client'

import { useMemo, useState } from 'react'
import { Check, Copy, ShieldAlert } from 'lucide-react'
import { z } from 'zod'

import { Button } from '@/components/ui/button'

interface TrackingSnippetProps {
  siteId: string
  tenantId: string
  installToken: string
  origin: string
}

// M-3 fix (Reviewer T1 dual 続 10):
// snippet にコピーされる HTML 文字列は React JSX text の auto-escape を経由しないため、
// `data-site-id="${siteId}"` で attribute injection の余地がある。Sprint 1 dummy では
// impact なしだが、Sprint 3 で実 token 切替時に `"` / `<` / `>` 含むケースを想定し、
// 入力段階で strict alphanumeric + `-` `_` のみ許可。形式違反は snippet を出力しない。
const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, '識別子は英数字 / `_` / `-` のみ使用できます')

export function TrackingSnippet({ siteId, tenantId, installToken, origin }: TrackingSnippetProps) {
  const [copied, setCopied] = useState(false)

  const validation = useMemo(() => {
    const r1 = identifierSchema.safeParse(siteId)
    const r2 = identifierSchema.safeParse(tenantId)
    const r3 = identifierSchema.safeParse(installToken)
    if (!r1.success) return { ok: false, field: 'site_id' as const, message: r1.error.issues[0]?.message }
    if (!r2.success) return { ok: false, field: 'tenant_id' as const, message: r2.error.issues[0]?.message }
    if (!r3.success) return { ok: false, field: 'install_token' as const, message: r3.error.issues[0]?.message }
    return { ok: true } as const
  }, [siteId, tenantId, installToken])

  const snippet = validation.ok
    ? buildSnippet({ siteId, tenantId, installToken, origin })
    : null

  async function handleCopy() {
    if (!snippet) return
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(snippet)
      } else {
        // Fallback (Safari 旧 / iOS WKWebView)
        const ta = document.createElement('textarea')
        ta.value = snippet
        ta.style.position = 'fixed'
        ta.style.top = '-1000px'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // do nothing; user can manually select code
    }
  }

  if (!validation.ok || !snippet) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-xs text-destructive"
      >
        <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
        <p>
          {!validation.ok ? validation.field : 'snippet'} の形式が安全でないためコードを表示できません
          {!validation.ok && validation.message ? ` (${validation.message})` : ''}。
          サポートにご連絡ください。
        </p>
      </div>
    )
  }

  return (
    <div className="relative">
      <pre
        className="overflow-x-auto rounded-md border border-border bg-foreground/95 p-4 pr-14 font-mono text-xs leading-relaxed text-background"
        aria-label="UGOKI MAP tracking.js snippet"
      >
        <code>{snippet}</code>
      </pre>

      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="absolute right-3 top-3 gap-1.5"
        onClick={handleCopy}
        aria-label={copied ? 'コピーしました' : 'コードをコピー'}
      >
        {copied ? (
          <>
            <Check className="h-3.5 w-3.5" aria-hidden /> コピー済
          </>
        ) : (
          <>
            <Copy className="h-3.5 w-3.5" aria-hidden /> コピー
          </>
        )}
      </Button>

      <p
        role="status"
        aria-live="polite"
        className="mt-2 min-h-[1rem] text-xs text-text-3"
      >
        {copied ? 'クリップボードにコピーしました。' : ' '}
      </p>
    </div>
  )
}

function buildSnippet({
  origin,
  siteId,
  tenantId,
  installToken,
}: {
  origin: string
  siteId: string
  tenantId: string
  installToken: string
}): string {
  return `<!-- UGOKI MAP tracking.js -->
<script src="${origin}/v2/tracking.js"
        data-site-id="${siteId}"
        data-tenant-id="${tenantId}"
        data-install-token="${installToken}"
        defer></script>`
}
