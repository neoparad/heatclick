/**
 * GTM 設定ガイド — 動画 + 静止画 9 枚 + 手順テキスト
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-02 / O-OP-2 (動画 a11y)
 *
 * Sprint 1 注記:
 *   - install.mp4 / install.srt / step-NN-*.png/webp は Operator 5/19-21 撮影予定
 *   - 引き渡し前は <video> が 404 になるが poster 表示で UI 崩れない
 *   - poster と同 dir に install-poster.jpg を仮配置するまでは中央プレースホルダ表示
 */

'use client'

import { useRef, useState } from 'react'
import { AlertTriangle, Film } from 'lucide-react'

const STEPS = [
  { n: 1, file: '01-create-account', alt: 'GTM ダッシュボード「アカウント作成」ボタン' },
  { n: 2, file: '02-container-setup', alt: 'コンテナ設定 (ウェブ) 画面' },
  { n: 3, file: '03-install-code', alt: 'GTM コードスニペット表示' },
  { n: 4, file: '04-new-tag-custom-html', alt: '新規タグ → カスタム HTML 選択' },
  { n: 5, file: '05-paste-snippet', alt: 'UGOKI MAP tracking.js snippet 貼付' },
  { n: 6, file: '06-trigger-all-pages', alt: 'トリガー: All Pages 選択' },
  { n: 7, file: '07-preview-debug', alt: 'プレビュー / デバッグモード起動' },
  { n: 8, file: '08-publish', alt: '公開 (Submit) ボタン + バージョン名入力' },
  { n: 9, file: '09-verify-tag-fired', alt: 'プレビューモードで Tag Fired 確認' },
] as const

export function GtmGuide() {
  const [videoError, setVideoError] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)

  return (
    <div className="space-y-6">
      <div className="rounded-md border border-border bg-background">
        <div className="aspect-video w-full overflow-hidden rounded-t-md bg-foreground/95">
          {!videoError ? (
            <video
              ref={videoRef}
              controls
              preload="metadata"
              poster="/onboarding/gtm/install-poster.jpg"
              className="h-full w-full"
              onError={() => setVideoError(true)}
              aria-label="GTM への UGOKI MAP tracking.js 設置ガイド (約 90 秒)"
            >
              <source src="/onboarding/gtm/install.mp4" type="video/mp4" />
              <track
                kind="captions"
                src="/onboarding/gtm/install.srt"
                srcLang="ja"
                label="日本語字幕"
                default
              />
              お使いのブラウザは video 要素に対応していません。
            </video>
          ) : (
            <VideoPlaceholder />
          )}
        </div>
        <p className="px-4 py-3 text-xs text-text-2">
          動画は約 90 秒、音声なしの日本語字幕付きです。動画が再生できない場合は、下のスクリーンショットを参照してください。
        </p>
      </div>

      <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" role="list">
        {STEPS.map((step) => (
          <li
            key={step.n}
            className="overflow-hidden rounded-md border border-border bg-background"
          >
            <div className="relative aspect-[3/2] w-full bg-muted">
              <picture>
                <source srcSet={`/onboarding/gtm/${step.file}.webp`} type="image/webp" />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/onboarding/gtm/${step.file}.png`}
                  alt={step.alt}
                  loading="lazy"
                  className="absolute inset-0 h-full w-full object-cover"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none'
                    const sibling = e.currentTarget.nextElementSibling as HTMLElement | null
                    if (sibling) sibling.style.display = 'flex'
                  }}
                />
              </picture>
              <div
                className="absolute inset-0 hidden items-center justify-center text-xs text-text-3"
                aria-hidden
              >
                Step {step.n} (Operator 撮影待ち)
              </div>
            </div>
            <div className="px-3 py-2">
              <p className="text-[11px] font-mono uppercase tracking-[0.06em] text-text-3">
                Step {step.n}
              </p>
              <p className="text-xs text-foreground">{step.alt}</p>
            </div>
          </li>
        ))}
      </ol>

      <p className="text-[11px] text-text-3">
        画面は Operator 撮影分 (2026-05-19 〜 21 撮影予定) に置き換わります。GTM の UI は予告なく変更されるため、ズレが大きい場合は再撮影します。
      </p>
      {/* M-1 fix (Reviewer T1 dual 続 10): hidden <Image /> placeholder は Operator 撮影前は
          404 → next/image エラー emit → Sentry noise。Sprint 1 では削除。
          ファイル納品後に必要なら次世代 (Sprint 3) で next/image 採用を再評価。 */}
    </div>
  )
}

function VideoPlaceholder() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-foreground/90 px-4 text-center text-background">
      <AlertTriangle className="h-6 w-6" aria-hidden />
      <p className="text-sm font-semibold">動画ファイルが見つかりません</p>
      <p className="max-w-md text-xs opacity-80">
        Operator 撮影 (2026-05-19 〜 21) 完了後に <code className="font-mono">install.mp4</code> が repo に同梱されます。
        スクリーンショット 9 枚で代替手順を確認できます。
      </p>
      <p className="font-mono text-[10px] opacity-60">
        <Film className="inline h-3 w-3" aria-hidden /> public/onboarding/gtm/install.mp4
      </p>
    </div>
  )
}
