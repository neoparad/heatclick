'use client'

/**
 * VariantImageUpload — R2 経由で banner 画像をアップロードする UI
 * (M-Director Stage 3、続 M-10、2026-05-28)
 *
 * Flow:
 *   1. ユーザーが <input type="file"> でファイルを選択
 *   2. POST /api/banner-assets/sign-url で R2 presigned PUT URL を発行
 *   3. PUT <upload_url> でファイル本体を R2 へ直送 (Vercel 帯域を消費しない)
 *   4. onUploaded(public_url) コールバックで親に通知 (scenario.variants[N].image_url に反映)
 *
 * 制限 (Phase 2):
 *   - 5 MiB / image
 *   - PNG / JPEG / WebP / GIF
 *   - 並列 upload 1 件まで
 *
 * Reference:
 *   - 続 M-9 §6 #4 (Stage 3 配備計画)
 *   - app/api/banner-assets/sign-url/route.ts (Sign URL API)
 *   - lib/scenarios/r2-signed-url.ts (manual SigV4 signing)
 */

import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'

const MAX_BYTES = 5 * 1024 * 1024
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export interface VariantImageUploadProps {
  scenarioId: string
  tenantId?: string
  /** 現在の画像 URL (アップロード前後の比較用) */
  currentUrl?: string | null
  /** アップロード完了時に親に通知 (image_url + dimensions 等) */
  onUploaded: (info: { publicUrl: string; assetId: string; byteSize: number }) => void
  /** 任意: アップロード前にバリデーション拒否したい場合 */
  disabled?: boolean
}

interface SignUrlResponse {
  asset_id: string
  upload_url: string
  public_url: string
  storage_key: string
  expires_at: string
  content_type: string
}

export function VariantImageUpload({
  scenarioId,
  tenantId,
  currentUrl,
  onUploaded,
  disabled = false,
}: VariantImageUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [progress, setProgress] = useState(0)

  const onPickFile = useCallback(() => {
    if (disabled || isUploading) return
    fileInputRef.current?.click()
  }, [disabled, isUploading])

  const onFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      // reset input so the same file can be re-selected after retry
      e.target.value = ''
      if (!file) return

      // Client-side validation (server also validates, defense in depth)
      if (file.size > MAX_BYTES) {
        toast.error(`サイズオーバー`, {
          description: `${(file.size / 1024 / 1024).toFixed(2)} MB > 5 MB 上限`,
        })
        return
      }
      if (!ALLOWED_MIME.has(file.type)) {
        toast.error(`形式エラー`, {
          description: `${file.type} は未対応。PNG / JPEG / WebP / GIF のみ。`,
        })
        return
      }

      setIsUploading(true)
      setProgress(0)

      try {
        // Step 1: get signed URL
        const signResp = await fetch('/api/banner-assets/sign-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scenario_id: scenarioId,
            tenant_id: tenantId,
            filename: file.name,
            content_type: file.type,
            byte_size: file.size,
          }),
        })

        if (!signResp.ok) {
          const errBody = await signResp.json().catch(() => ({ error: 'unknown' }))
          const issues = Array.isArray(errBody.issues)
            ? ': ' +
              errBody.issues
                .map((i: { path: string; message: string }) => `${i.path}=${i.message}`)
                .join(' / ')
            : ''
          throw new Error(
            errBody.message ?? `signed URL 発行失敗 (HTTP ${signResp.status})${issues}`,
          )
        }

        const signed = (await signResp.json()) as SignUrlResponse
        setProgress(15)

        // Step 2: PUT to R2 with the signed URL
        // Use XMLHttpRequest so we can show upload progress (fetch streaming is
        // not yet supported across all browsers for upload progress).
        const uploadResp = await putWithProgress(signed.upload_url, file, (pct) => {
          // Map browser 0-100 onto our 15-95 progress range so the steps are visible.
          setProgress(15 + Math.round(pct * 0.8))
        })

        if (uploadResp.status < 200 || uploadResp.status >= 300) {
          throw new Error(`R2 PUT 失敗 (HTTP ${uploadResp.status})`)
        }

        setProgress(100)
        toast.success('画像をアップロードしました', {
          description: `${file.name} → ${signed.public_url.split('/').slice(-2).join('/')}`,
        })

        onUploaded({
          publicUrl: signed.public_url,
          assetId: signed.asset_id,
          byteSize: file.size,
        })
      } catch (err) {
        const message = (err as Error).message
        toast.error('アップロード失敗', { description: message })
      } finally {
        setIsUploading(false)
        // give the 100% bar a moment to be visible before fading
        window.setTimeout(() => setProgress(0), 500)
      }
    },
    [onUploaded, scenarioId, tenantId],
  )

  return (
    <div className="space-y-2">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={(e) => void onFileSelected(e)}
        className="hidden"
        aria-hidden
      />
      <button
        type="button"
        onClick={onPickFile}
        disabled={disabled || isUploading}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded-md transition-colors ${
          disabled || isUploading
            ? 'border-slate-200 bg-slate-100 text-slate-400 cursor-not-allowed'
            : 'border-slate-300 bg-white hover:bg-slate-50 text-slate-700'
        }`}
        title={currentUrl ? `現在: ${currentUrl}` : '画像を選択 (PNG / JPEG / WebP / GIF、5MB まで)'}
      >
        {isUploading ? `アップロード中... ${progress}%` : '画像を差し替え'}
      </button>
      {isUploading ? (
        <div
          className="h-1.5 bg-slate-100 rounded overflow-hidden"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <div
            className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
      ) : null}
    </div>
  )
}

interface PutResponse {
  status: number
}

function putWithProgress(
  url: string,
  body: Blob,
  onProgress: (pct: number) => void,
): Promise<PutResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url, true)
    if (body.type) xhr.setRequestHeader('Content-Type', body.type)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = (e.loaded / e.total) * 100
        onProgress(pct)
      }
    }
    xhr.onload = () => resolve({ status: xhr.status })
    xhr.onerror = () => reject(new Error('network error'))
    xhr.ontimeout = () => reject(new Error('timeout'))
    xhr.send(body)
  })
}
