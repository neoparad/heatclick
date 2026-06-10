/**
 * variant-preview-srcdoc.ts — エディタ内ビジュアルプレビュー用の iframe srcdoc 組み立て (C)
 *
 * 純粋関数。variant (画像 / HTML) を「配信時の見た目」に近い banner カードとして 1 枚の
 * HTML ドキュメント文字列にする。VariantPreview が <iframe sandbox srcDoc=...> に渡す。
 *
 * セキュリティ:
 *   - HTML variant は呼び出し側が渡す sanitizeHtml() を必ず通す (鉄則「HTML は必ず
 *     sanitize を通す」)。本関数はその結果を埋め込むだけ。
 *   - image_url / cta_url は isSafeHttpsUrl で https 絶対 URL のみ許可。
 *   - さらに VariantPreview 側で sandbox iframe (allow-scripts なし) に描画するため、
 *     万一 sanitize を漏れても script は実行されない (defense in depth)。
 */

import { isHttpsAbsoluteUrl } from '@/lib/scenarios/preview-html-sanitize'
import type { Variant } from '@/lib/scenarios/types'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// public/scenario-runtime.js の banner スタイルを縮約 (center=overlay / corner / inline)。
const PREVIEW_STYLES = `
*{box-sizing:border-box}
html,body{margin:0;height:100%;font-family:-apple-system,'Segoe UI',Roboto,'Hiragino Kaku Gothic ProN',sans-serif}
body{display:flex;align-items:center;justify-content:center;padding:18px;background:#f1f5f9}
body.overlay{background:rgba(15,17,23,.55)}
.card{background:#fff;border-radius:14px;padding:18px;max-width:92%;max-height:92%;overflow:auto;box-shadow:0 24px 60px rgba(15,17,23,.30),0 4px 14px rgba(15,17,23,.10)}
.corner{background:#fff;border-radius:12px;padding:14px;max-width:360px;max-height:88%;overflow:auto;box-shadow:0 16px 40px rgba(15,17,23,.25),0 2px 8px rgba(15,17,23,.10)}
.inline{background:#fff;border:1px solid #e6e8ef;border-radius:10px;padding:14px;width:100%}
.ugk-img{display:block;max-width:100%;height:auto;border-radius:8px}
.ugk-cta{display:inline-block;margin-top:12px;padding:10px 20px;background:linear-gradient(135deg,#4f6bff 0%,#a855f7 100%);color:#fff;text-decoration:none;border-radius:6px;font-size:13.5px;font-weight:600}
.ugk-warn{padding:22px;color:#b91c1c;font-size:13px;line-height:1.5}
`.trim()

/**
 * variant の preview ドキュメント文字列を組み立てる。
 *
 * @param variant      プレビュー対象 variant (draft state でよい)
 * @param sanitizeHtml HTML variant に適用する sanitizer (必須。鉄則: HTML は必ず通す)
 */
export function buildVariantPreviewSrcDoc(
  variant: Variant,
  sanitizeHtml: (raw: string) => string,
): string {
  const position = variant.position || 'center'
  const isCenter = position === 'center'
  const isInline = position === 'inline'
  const containerClass = isCenter ? 'card' : isInline ? 'inline' : 'corner'
  const bodyClass = isCenter ? 'overlay' : ''

  let inner: string
  if (variant.content_type === 'image') {
    if (isHttpsAbsoluteUrl(variant.image_url)) {
      inner = `<img class="ugk-img" src="${escapeHtml(variant.image_url)}" alt="${escapeHtml(
        variant.image_alt || '',
      )}">`
    } else {
      inner = `<div class="ugk-warn">⚠ image_url が https:// の絶対 URL ではないためプレビューできません。</div>`
    }
  } else {
    // 鉄則: HTML は必ず sanitize を通す。空 sanitize 結果は何も描画しない。
    inner = sanitizeHtml(variant.html || '')
  }

  const safeCta = variant.cta_url && isHttpsAbsoluteUrl(variant.cta_url) ? variant.cta_url : ''
  // sandbox(allow-popups なし) のため実際には遷移しない = プレビュー専用の見た目。
  const cta = safeCta
    ? `<a class="ugk-cta" href="${escapeHtml(safeCta)}" target="_blank" rel="noopener noreferrer">${
        variant.content_type === 'image' ? '詳しく見る' : 'クーポンを使う'
      }</a>`
    : ''

  return (
    `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>${PREVIEW_STYLES}</style></head>` +
    `<body class="${bodyClass}"><div class="${containerClass}">${inner}${cta}</div></body></html>`
  )
}
