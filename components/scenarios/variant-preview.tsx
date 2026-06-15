'use client'

/**
 * VariantPreview — エディタ内ビジュアルプレビュー (C / 2026-06-10)
 *
 * 配信前に variant (画像 / HTML) の見た目を確認するモーダル。
 *   - HTML は sanitizePreviewHtml (runtime mirror allowlist) を必ず通す (鉄則)
 *   - 描画は sandbox="" の iframe (allow-scripts なし、null origin) で隔離 = dashboard への
 *     XSS / 親 DOM・cookie アクセス不可 (defense in depth)
 *   - server 往復なし (draft state をそのまま描画)
 */

import { useMemo, useState } from 'react'
import { X } from 'lucide-react'

import { sanitizePreviewHtml } from '@/lib/scenarios/preview-html-sanitize'
import type { Variant } from '@/lib/scenarios/types'

import { buildVariantPreviewSrcDoc } from './variant-preview-srcdoc'

interface VariantPreviewProps {
  variant: Variant
  onClose: () => void
}

export function VariantPreview({ variant, onClose }: VariantPreviewProps) {
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop')
  const srcDoc = useMemo(
    () => buildVariantPreviewSrcDoc(variant, sanitizePreviewHtml, device),
    [variant, device],
  )
  // 表示中デバイスの実効 position (SP で position_mobile があればそれ)。
  const effectivePosition =
    device === 'mobile' && variant.position_mobile ? variant.position_mobile : variant.position

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`variant ${variant.id} プレビュー`}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <div className="text-sm font-semibold flex items-center gap-2">
            variant {variant.id} プレビュー
            <span className="font-mono text-[10px] text-slate-400 uppercase tracking-wider">
              {variant.content_type} · {effectivePosition}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-md border border-slate-200 overflow-hidden text-[11px]">
              <button
                type="button"
                onClick={() => setDevice('desktop')}
                className={`px-2.5 py-1 ${device === 'desktop' ? 'bg-indigo-50 text-indigo-700 font-semibold' : 'text-slate-500 hover:bg-slate-50'}`}
              >
                PC
              </button>
              <button
                type="button"
                onClick={() => setDevice('mobile')}
                className={`px-2.5 py-1 border-l border-slate-200 ${device === 'mobile' ? 'bg-indigo-50 text-indigo-700 font-semibold' : 'text-slate-500 hover:bg-slate-50'}`}
              >
                SP
              </button>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="閉じる"
              className="p-1 rounded hover:bg-slate-100 text-slate-500"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="bg-slate-100 flex justify-center">
          <iframe
            title={`variant ${variant.id} preview`}
            // sandbox="" = 全制限 (script 実行不可・null origin・form/popup/top-nav 不可)。
            sandbox=""
            srcDoc={srcDoc}
            className={`h-[440px] border-0 bg-white ${
              device === 'mobile' ? 'w-[390px] my-3 rounded-xl shadow-sm' : 'w-full'
            }`}
          />
        </div>

        <div className="px-4 py-2.5 text-[11px] text-slate-500 border-t border-slate-100 bg-slate-50 leading-relaxed">
          概算プレビューです。実配信は <code className="font-mono">scenario-runtime.js</code> が描画し、
          公開時に server が HTML を sanitize（script / iframe / on*= / 非 https URL を除去）します。
          CTA はプレビューでは遷移しません。
        </div>
      </div>
    </div>
  )
}
