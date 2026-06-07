'use client'

/**
 * VariantSetEditor — A/B/C variant 編集 UI (M-Director Phase 2.1、2026-06-07)
 *
 * 新規シナリオ作成画面で使う、reusable な variant 集合エディタ。
 * Phase 2.1 では「先に scenario を draft で保存 → /scenarios/[id] で画像 upload」フローを採用し、
 * 本コンポーネントでは image_url の **直接入力** (タイプ / 既存 URL ペースト) + HTML 編集に集中する。
 *
 * 画像の R2 upload は VariantImageUpload (scenarioId 必須) で別途行う。
 *
 * Responsibilities:
 *   - A/B/C tab 切替 + 追加/削除 (1〜3 件)
 *   - content_type 切替 (image / html)
 *   - content_type 別の値編集 (image_url + alt / html)
 *   - traffic_split slider (integer、合計 100 必須、SplitBar 表示)
 *   - cta_url + position
 *
 * Validation surface: Zod (VariantsSchema) を server 側に任せ、本 UI は緩い hint だけ出す。
 */

import { useMemo } from 'react'
import { Code2, ImageIcon, Plus, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { VARIANT_POSITIONS, type Variant } from '@/lib/scenarios/types'

export interface VariantSetEditorProps {
  variants: Variant[]
  onChange: (next: Variant[]) => void
  disabled?: boolean
}

const NEXT_ID: Record<string, 'A' | 'B' | 'C'> = { A: 'B', B: 'C' }

export function VariantSetEditor({ variants, onChange, disabled = false }: VariantSetEditorProps) {
  const activeIdx = 0 // フォーカス vc は parent で管理しないシンプル版 (Phase 2.2 で tab focus state 化)
  const activeId = variants[activeIdx]?.id ?? 'A'
  const trafficSum = useMemo(() => variants.reduce((s, v) => s + v.traffic_split, 0), [variants])

  function patchVariant(id: string, patch: Partial<Variant>): void {
    if (disabled) return
    onChange(
      variants.map((v) => (v.id === id ? ({ ...v, ...patch } as Variant) : v)),
    )
  }

  function addVariant(): void {
    if (disabled || variants.length >= 3) return
    const lastId = variants[variants.length - 1]?.id ?? 'A'
    const nextId = NEXT_ID[lastId] ?? 'C'
    // rebalance: equal split across all variants
    const newCount = variants.length + 1
    const baseSplit = Math.floor(100 / newCount)
    const remainder = 100 - baseSplit * newCount
    const rebalanced = variants.map((v, i) => ({
      ...v,
      traffic_split: baseSplit + (i === 0 ? remainder : 0),
    }))
    const newVariant = makeDefaultVariant(nextId, baseSplit)
    onChange([...rebalanced, newVariant])
  }

  function removeVariant(id: string): void {
    if (disabled || variants.length <= 1) return
    const remaining = variants.filter((v) => v.id !== id)
    // rebalance equally
    const baseSplit = Math.floor(100 / remaining.length)
    const remainder = 100 - baseSplit * remaining.length
    const rebalanced = remaining.map((v, i) => ({
      ...v,
      traffic_split: baseSplit + (i === 0 ? remainder : 0),
    }))
    onChange(rebalanced)
  }

  return (
    <div>
      {/* Tab row */}
      <div className="flex gap-1.5 mb-3 items-end">
        {variants.map((v) => (
          <div
            key={v.id}
            className={`px-3 py-1.5 text-xs font-semibold rounded-t-md border-2 ${
              v.id === activeId
                ? 'bg-white border-indigo-300 text-indigo-700'
                : 'bg-slate-100 border-slate-200 text-slate-500'
            } flex items-center gap-1.5`}
          >
            <span className={`w-4 h-4 rounded-full flex items-center justify-center font-mono text-[10px] font-bold ${variantBadgeColor(v.id)} text-white`}>
              {v.id}
            </span>
            variant {v.id}
            {variants.length > 1 ? (
              <button
                type="button"
                onClick={() => removeVariant(v.id)}
                disabled={disabled}
                className="text-slate-400 hover:text-rose-500 disabled:opacity-30"
                title={`variant ${v.id} を削除`}
                aria-label={`variant ${v.id} を削除`}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            ) : null}
          </div>
        ))}
        {variants.length < 3 ? (
          <button
            type="button"
            onClick={addVariant}
            disabled={disabled}
            className="px-3 py-1.5 text-xs font-semibold border-2 border-dashed border-slate-300 rounded-t-md text-slate-500 hover:bg-slate-50 disabled:opacity-30 inline-flex items-center gap-1"
          >
            <Plus className="h-3 w-3" /> 追加
          </button>
        ) : null}
        <div className="ml-auto font-mono text-[10.5px] text-slate-400">
          {variants.length} / 3 variants
        </div>
      </div>

      {/* Active variant editor */}
      {variants.map((v) =>
        v.id === activeId ? (
          <SingleVariantEditor
            key={v.id}
            variant={v}
            disabled={disabled}
            onChange={(patch) => patchVariant(v.id, patch)}
          />
        ) : null,
      )}

      {/* Traffic split */}
      <div className="mt-4 bg-slate-50 border border-slate-200 rounded-md p-3">
        <div className="text-[10.5px] font-mono uppercase tracking-wider font-semibold text-slate-500 mb-1.5">
          traffic split (A/B/C 配信比率、合計 100 必須)
        </div>
        <SplitBar variants={variants} />
        <div className="grid grid-cols-3 gap-2 mt-2">
          {variants.map((v) => (
            <div key={v.id} className="px-2 py-1 border border-slate-200 rounded bg-white flex items-center gap-1.5">
              <span className={`font-mono text-[10.5px] font-bold ${variantTextColor(v.id)}`}>{v.id}</span>
              <Input
                type="number"
                min={0}
                max={100}
                value={String(v.traffic_split)}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10)
                  if (!Number.isFinite(n)) return
                  patchVariant(v.id, { traffic_split: Math.max(0, Math.min(100, n)) })
                }}
                disabled={disabled}
                className="w-14 h-7 text-right text-[11.5px] font-mono p-1"
                aria-label={`variant ${v.id} traffic_split`}
              />
              <span className="text-[10px] text-slate-400">%</span>
            </div>
          ))}
        </div>
        {trafficSum !== 100 ? (
          <div className="text-[11px] text-amber-700 mt-1.5 font-medium">
            ⚠️ 合計 {trafficSum}% (100% にしないと保存できません)
          </div>
        ) : (
          <div className="text-[11px] text-emerald-700 mt-1.5">合計 100% ✓</div>
        )}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// SingleVariantEditor — 1 variant の編集 (内部コンポーネント)
// ────────────────────────────────────────────────────────────────────────────

interface SingleVariantEditorProps {
  variant: Variant
  disabled: boolean
  onChange: (patch: Partial<Variant>) => void
}

function SingleVariantEditor({ variant, disabled, onChange }: SingleVariantEditorProps) {
  function switchType(nextType: 'image' | 'html'): void {
    if (disabled || nextType === variant.content_type) return
    // 切替時にデフォルト値を埋める (Zod 必須 field の維持)
    if (nextType === 'image') {
      onChange({
        content_type: 'image',
        image_url: 'https://',
        image_alt: '',
      } as Partial<Variant>)
    } else {
      onChange({
        content_type: 'html',
        html: '<div>サンプル HTML</div>',
      } as Partial<Variant>)
    }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-md p-3 space-y-3">
      {/* Content type toggle */}
      <div className="grid grid-cols-2 gap-2 p-1 bg-slate-100 rounded-md">
        <label
          className={`flex items-center gap-2 px-3 py-2 rounded cursor-pointer ${
            variant.content_type === 'image' ? 'bg-white border border-indigo-300 shadow-sm' : ''
          }`}
        >
          <input
            type="radio"
            name={`vtype-${variant.id}`}
            checked={variant.content_type === 'image'}
            onChange={() => switchType('image')}
            disabled={disabled}
          />
          <div
            className={`w-7 h-7 rounded-md flex items-center justify-center ${
              variant.content_type === 'image'
                ? 'bg-gradient-to-br from-indigo-500 to-purple-500 text-white'
                : 'bg-slate-50 text-slate-400'
            }`}
          >
            <ImageIcon className="h-3.5 w-3.5" />
          </div>
          <div className="text-xs">
            <div className="font-semibold">画像</div>
            <div className="text-[10.5px] text-slate-400">URL を入力 (R2 upload は保存後)</div>
          </div>
        </label>
        <label
          className={`flex items-center gap-2 px-3 py-2 rounded cursor-pointer ${
            variant.content_type === 'html' ? 'bg-white border border-indigo-300 shadow-sm' : ''
          }`}
        >
          <input
            type="radio"
            name={`vtype-${variant.id}`}
            checked={variant.content_type === 'html'}
            onChange={() => switchType('html')}
            disabled={disabled}
          />
          <div
            className={`w-7 h-7 rounded-md flex items-center justify-center ${
              variant.content_type === 'html'
                ? 'bg-gradient-to-br from-indigo-500 to-purple-500 text-white'
                : 'bg-slate-50 text-slate-400'
            }`}
          >
            <Code2 className="h-3.5 w-3.5" />
          </div>
          <div className="text-xs">
            <div className="font-semibold">HTML</div>
            <div className="text-[10.5px] text-slate-400">サニタイズ後 DOM 挿入</div>
          </div>
        </label>
      </div>

      {/* Type-specific editor */}
      {variant.content_type === 'image' ? (
        <ImageVariantFields variant={variant} disabled={disabled} onChange={onChange} />
      ) : (
        <HtmlVariantFields variant={variant} disabled={disabled} onChange={onChange} />
      )}

      {/* Common fields */}
      <div className="grid grid-cols-[110px_1fr] gap-2.5 items-center">
        <span className="text-[11.5px] text-slate-500 font-medium">CTA URL</span>
        <Input
          type="url"
          value={variant.cta_url ?? ''}
          onChange={(e) => onChange({ cta_url: e.target.value || undefined } as Partial<Variant>)}
          placeholder="https://example.com/promo (省略可)"
          disabled={disabled}
          className="h-9 text-xs"
        />

        <span className="text-[11.5px] text-slate-500 font-medium">表示位置</span>
        <select
          value={variant.position}
          onChange={(e) => onChange({ position: e.target.value as Variant['position'] } as Partial<Variant>)}
          disabled={disabled}
          className="h-9 text-xs px-3 border border-slate-200 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-400"
        >
          {VARIANT_POSITIONS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// ImageVariantFields / HtmlVariantFields
// ────────────────────────────────────────────────────────────────────────────

interface VariantFieldsProps {
  variant: Variant
  disabled: boolean
  onChange: (patch: Partial<Variant>) => void
}

function ImageVariantFields({ variant, disabled, onChange }: VariantFieldsProps) {
  if (variant.content_type !== 'image') return null
  const isHttps = variant.image_url.startsWith('https://')
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[110px_1fr] gap-2.5 items-center">
        <span className="text-[11.5px] text-slate-500 font-medium">画像 URL</span>
        <div>
          <Input
            type="url"
            value={variant.image_url}
            onChange={(e) => onChange({ image_url: e.target.value } as Partial<Variant>)}
            placeholder="https://cdn.example.com/banner.png"
            disabled={disabled}
            className="h-9 text-xs"
          />
          {!isHttps ? (
            <div className="text-[10.5px] text-amber-700 mt-0.5">
              ⚠️ https:// 必須 (REQ-SEC-003)。保存後の編集画面で R2 にアップロードできます。
            </div>
          ) : null}
        </div>

        <span className="text-[11.5px] text-slate-500 font-medium">alt</span>
        <Input
          type="text"
          value={variant.image_alt}
          onChange={(e) => onChange({ image_alt: e.target.value } as Partial<Variant>)}
          placeholder="バナー画像の代替テキスト (a11y)"
          maxLength={255}
          disabled={disabled}
          className="h-9 text-xs"
        />

        <span className="text-[11.5px] text-slate-500 font-medium">サイズ</span>
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            min={1}
            max={4096}
            value={String(variant.image_width ?? '')}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10)
              onChange({ image_width: Number.isFinite(n) ? n : undefined } as Partial<Variant>)
            }}
            placeholder="幅 px"
            disabled={disabled}
            className="h-9 text-xs w-20"
          />
          <span className="text-slate-400 text-xs">×</span>
          <Input
            type="number"
            min={1}
            max={4096}
            value={String(variant.image_height ?? '')}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10)
              onChange({ image_height: Number.isFinite(n) ? n : undefined } as Partial<Variant>)
            }}
            placeholder="高 px"
            disabled={disabled}
            className="h-9 text-xs w-20"
          />
          <span className="text-[10.5px] text-slate-400 ml-1.5">省略可</span>
        </div>
      </div>

      {/* Preview */}
      {isHttps ? (
        <div className="border border-slate-200 rounded overflow-hidden">
          <div className="bg-slate-100 px-2 py-1 text-[10px] text-slate-500 font-mono">プレビュー</div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={variant.image_url}
            alt={variant.image_alt}
            className="block max-w-full max-h-44 mx-auto"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none'
            }}
          />
        </div>
      ) : null}
    </div>
  )
}

function HtmlVariantFields({ variant, disabled, onChange }: VariantFieldsProps) {
  if (variant.content_type !== 'html') return null
  const len = variant.html.length
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[11.5px] text-slate-500 font-medium">HTML</span>
        <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200">
          サーバで sanitize-html 通過後に DOM 挿入
        </Badge>
        <span className={`ml-auto text-[10px] font-mono ${len > 8000 ? 'text-rose-600' : 'text-slate-400'}`}>
          {len} / 8192 chars
        </span>
      </div>
      <textarea
        value={variant.html}
        onChange={(e) => onChange({ html: e.target.value } as Partial<Variant>)}
        placeholder={'<div style="padding:8px;background:orange;color:white">期間限定 10% OFF</div>'}
        disabled={disabled}
        rows={6}
        maxLength={8192}
        className="w-full text-xs font-mono px-2.5 py-2 bg-slate-900 text-slate-100 border border-slate-700 rounded resize-y focus:outline-none focus:ring-2 focus:ring-indigo-500"
        aria-label="HTML variant body"
      />
      <div className="text-[10.5px] text-slate-500">
        許可タグ: <code className="font-mono">div, span, p, a, strong, em, br, img, h1-h6, ul, ol, li</code> 等 (server で sanitize-html 適用)。
        <code className="font-mono">script</code> / <code className="font-mono">on*</code> 属性 / <code className="font-mono">javascript:</code> URL は弾かれます。
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// SplitBar (再利用)
// ────────────────────────────────────────────────────────────────────────────

function SplitBar({ variants }: { variants: ReadonlyArray<Variant> }) {
  const total = variants.reduce((s, v) => s + v.traffic_split, 0)
  return (
    <div className="flex h-5 rounded overflow-hidden border border-slate-200">
      {variants.map((v) => (
        <div
          key={v.id}
          className={`${variantBgColor(v.id)} flex items-center justify-center font-mono text-[10.5px] text-white font-bold`}
          style={{ width: `${total > 0 ? (v.traffic_split / total) * 100 : 0}%` }}
          title={`variant ${v.id}: ${v.traffic_split}%`}
        >
          {v.traffic_split}%
        </div>
      ))}
    </div>
  )
}

function variantBadgeColor(id: string): string {
  if (id === 'A') return 'bg-indigo-500'
  if (id === 'B') return 'bg-purple-500'
  return 'bg-emerald-500'
}

function variantBgColor(id: string): string {
  return variantBadgeColor(id)
}

function variantTextColor(id: string): string {
  if (id === 'A') return 'text-indigo-600'
  if (id === 'B') return 'text-purple-600'
  return 'text-emerald-600'
}

// ────────────────────────────────────────────────────────────────────────────
// helpers (exported)
// ────────────────────────────────────────────────────────────────────────────

export function makeDefaultVariant(id: 'A' | 'B' | 'C', traffic_split: number): Variant {
  return {
    id,
    content_type: 'image',
    image_url: 'https://',
    image_alt: '',
    position: 'center',
    traffic_split,
  } as Variant
}

/** 新規 scenario 用の初期 variants (A のみ、100%)。 */
export function makeInitialVariants(): Variant[] {
  return [makeDefaultVariant('A', 100)]
}

/** バリアント側のローカル validation (server-side Zod の前段、UI hint 用)。 */
export function validateVariantsForSubmit(variants: Variant[]): string[] {
  const errors: string[] = []
  if (variants.length < 1 || variants.length > 3) errors.push('variants は 1〜3 件')
  const sum = variants.reduce((s, v) => s + v.traffic_split, 0)
  if (sum !== 100) errors.push(`traffic_split の合計が ${sum} (100 必須)`)
  for (const v of variants) {
    if (v.content_type === 'image') {
      if (!v.image_url || !v.image_url.startsWith('https://') || v.image_url === 'https://') {
        errors.push(`variant ${v.id}: 画像 URL は https:// から始める必要があります`)
      }
    } else if (v.content_type === 'html') {
      if (!v.html || v.html.trim().length === 0) {
        errors.push(`variant ${v.id}: HTML が空です`)
      }
      if (v.html.length > 8192) errors.push(`variant ${v.id}: HTML は 8192 文字以内`)
    }
  }
  const ids = variants.map((v) => v.id)
  if (new Set(ids).size !== ids.length) errors.push('variant ID が重複しています')
  return errors
}
