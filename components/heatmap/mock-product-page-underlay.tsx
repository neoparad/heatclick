/**
 * MockProductPageUnderlay — 720px 幅の商品ページ underlay (mockup `01_heatmap_canvas.html` `.hm-page`)
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04
 * Dispatch: 2026-05-29 frontend mockup parity rebuild §4 Step 3 / §6 Phase 1
 *
 * mockup の `.mp-header / .mp-hero / .mp-tabs / .mp-reviews / .mp-related` 構造を
 * 完全再現。クリック不可 (overlay 用の見せ物) のため、リンクは全て div / span。
 * iframe 不採用 (X-Frame-Options で多くサイトが拒否)、Phase 2 で実 screenshot 化予定。
 */

import { MOCK_PRODUCT } from '@/lib/heatmap/mockup-spec'

interface MockProductPageUnderlayProps {
  /** 設定で URL や商品名を差替したい場合 (Phase 2 で site 別 mock を切替) */
  productTitle?: string
  productUrl?: string
}

export function MockProductPageUnderlay({
  productTitle,
  productUrl,
}: MockProductPageUnderlayProps) {
  const title = productTitle ?? MOCK_PRODUCT.title
  const url = productUrl ?? MOCK_PRODUCT.url
  void url

  return (
    <div className="mp" data-testid="mock-product-page-underlay" aria-hidden="true">
      {/* mp-header */}
      <div className="mp-header flex items-center gap-3 px-[18px] py-3">
        <div
          className="h-[22px] w-[22px] rounded"
          style={{ background: 'linear-gradient(135deg, #4F6BFF 0%, #A855F7 100%)' }}
        />
        <div className="flex gap-[14px] text-[11px] text-[#5a5e68]">
          <span className="rounded px-2 py-1">商品</span>
          <span className="rounded px-2 py-1">レビュー</span>
          <span className="rounded px-2 py-1">マイページ</span>
          <span className="rounded px-2 py-1">カート</span>
        </div>
      </div>

      {/* mp-hero */}
      <div
        className="mp-hero grid items-center gap-[18px] px-[18px] py-6"
        style={{
          gridTemplateColumns: '220px 1fr',
          background: 'linear-gradient(180deg, #fbfcfd 0%, #ffffff 100%)',
        }}
      >
        <div
          className="flex aspect-square items-center justify-center rounded-lg font-mono text-[11px] text-[#b6b8bf]"
          style={{ background: '#e9ecf2' }}
        >
          image_1 / 4
        </div>
        <div>
          <h2
            className="mb-1 text-[16px] font-bold leading-tight tracking-tight text-[#1c1d22]"
            style={{ letterSpacing: '-0.015em' }}
          >
            {title}
          </h2>
          <div className="mb-2 font-mono text-[11px] text-[#85888f]">
            {MOCK_PRODUCT.rating} ({MOCK_PRODUCT.reviewCount})
          </div>
          <div className="my-1.5 font-mono text-[18px] font-bold text-[#1c1d22]">
            {MOCK_PRODUCT.price}
            <span className="ml-2 text-[11px] font-normal text-[#b6b8bf] line-through">
              {MOCK_PRODUCT.oldPrice}
            </span>
          </div>
          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              tabIndex={-1}
              disabled
              className="rounded px-[14px] py-2 text-[12px] font-semibold text-white"
              style={{ background: 'linear-gradient(135deg, #4F6BFF 0%, #A855F7 100%)' }}
            >
              カートに追加
            </button>
            <button
              type="button"
              tabIndex={-1}
              disabled
              className="rounded border border-[#d7d9de] bg-white px-[14px] py-2 text-[12px] font-semibold text-[#1c1d22]"
            >
              お気に入り
            </button>
          </div>
        </div>
      </div>

      {/* mp-tabs */}
      <div className="mp-tabs flex border-b border-[#eef0f3] px-[18px]">
        <div
          className="border-b-2 px-[14px] py-2.5 text-[12px] font-semibold text-[#1c1d22]"
          style={{ borderBottomColor: '#4F6BFF' }}
        >
          商品詳細
        </div>
        <div className="px-[14px] py-2.5 text-[12px] text-[#545661]">
          レビュー ({MOCK_PRODUCT.reviewCount})
        </div>
        <div className="px-[14px] py-2.5 text-[12px] text-[#545661]">配送・返品</div>
      </div>

      {/* mp-reviews */}
      <div className="mp-reviews px-[18px] py-4">
        {MOCK_PRODUCT.reviews.map((r, i) => (
          <div
            key={i}
            className={
              'grid grid-cols-[28px_1fr] gap-2.5 py-2.5 text-[11.5px] leading-snug text-[#545661]' +
              (i < MOCK_PRODUCT.reviews.length - 1 ? ' border-b border-dashed border-[#eef0f3]' : '')
            }
          >
            <div className="h-[26px] w-[26px] rounded-full bg-[#e3e6ec]" />
            <div>
              <div className="mb-0.5 font-mono text-[10px] text-[#85888f]">{r.meta}</div>
              {r.body}
            </div>
          </div>
        ))}
      </div>

      {/* mp-related */}
      <div className="mp-related-section px-[18px] py-4" style={{ background: '#fbfcfd' }}>
        <div className="mb-2 text-[12px] font-semibold text-[#1c1d22]">関連商品</div>
        <div className="mp-related grid grid-cols-3 gap-2.5">
          <div className="h-[78px] rounded bg-[#f7f8fa]" />
          <div className="h-[78px] rounded bg-[#f7f8fa]" />
          <div className="h-[78px] rounded bg-[#f7f8fa]" />
        </div>
      </div>
    </div>
  )
}
