/**
 * 撮影プラン: 縦方向の切り詰め高さと、「2x で撮り直してよいか」を決める純関数群。
 *
 * 背景 (2026-09-29): ヒートマップ背景画像が粗い問題への対処として、SP は軽いページだけ 2x でも撮る。
 * 2x の画像は重く、Chrome のスクリーンショットには 16K px 級の寸法制限 (compositor の最大テクスチャ)
 * もあるため、2x を試すのは「予算内に収まる軽いページ」だけにする。2x の撮影が失敗しても、
 * 先に確保してある 1x の画像を返すので、従来より悪くなることはない (withSharpUpgrade)。
 *
 * 純関数にしてあるのは、Puppeteer / Browser Rendering を使わずに判断と縮退動作をテストするため。
 */

/**
 * 続133: 撮影の最大ピクセル面積 (画像 px)。超過時は上端から clip する。
 * 1x では従来と同じ height = floor(26M / width) になる。
 */
export const MAX_CAPTURE_AREA_PX = 26_000_000;

/**
 * 2x で撮ってよい最大ピクセル面積 (画像 px)。2x の画像は重く、表示速度 (体感 10-12 秒の問題) を
 * 悪化させ得るため、全体の上限より厳しくして「軽いページだけ」にする。
 * SP (390px) の 2x では CSS 高さ約 8,000px まで (次の寸法制限が先に効く)。
 */
export const MAX_SHARP_AREA_PX = 16_000_000;

/**
 * 2x で撮ってよい画像の一辺の最大 px。Chrome のスクリーンショットは 16,384px 付近に寸法制限があり、
 * compositor の設定によっては超えると撮影自体が失敗する (実測で確認済み。Cloudflare 側の設定は不明)。
 * 余裕を見て 16,000。1x の既存経路はこの制限の影響を受けない前提で従来どおり。
 */
export const MAX_SHARP_DIMENSION_PX = 16_000;

export interface CapInput {
  /** 画像の基準となる CSS 幅 (px) */
  width: number;
  /** 実際に撮影で使う倍率 */
  dsf: number;
  /** ページ全高 (CSS px)。測れなかった場合は非有限値 */
  fullHeight: number;
}

export interface CapResult {
  /** 撮影する CSS 高さ (px)。clip の height にそのまま使う */
  capHeight: number;
  /** 面積上限で上端から切り詰めたか */
  capped: boolean;
}

function usableHeight(fullHeight: number): number {
  return Number.isFinite(fullHeight) && fullHeight > 0 ? fullHeight : 0;
}

/**
 * 面積上限 (画像 px 面積) を、実際に使う倍率で計算した CSS 高さの上限。
 * dsf=1 では従来と完全に同じ (floor(26M / width))。
 */
export function capForDsf(input: CapInput): CapResult {
  const h = usableHeight(input.fullHeight);
  const maxHeightByArea = Math.floor(MAX_CAPTURE_AREA_PX / (input.width * input.dsf * input.dsf));
  const capHeight = Math.min(h, maxHeightByArea);
  return { capHeight, capped: h > capHeight };
}

/**
 * 倍率 dsf (>1) で撮り直してよいか。面積・一辺の寸法の両方が予算内のときだけ true。
 * width には「実際に画像の幅になる値」(= max(viewport 幅, document の scrollWidth)) を渡すこと。
 * 横にはみ出すページは fullPage の画像幅がビューポート幅を超えるため。
 */
export function canCaptureSharp(input: CapInput): boolean {
  const h = usableHeight(input.fullHeight);
  const { width, dsf } = input;
  if (!(dsf > 1) || h <= 0 || !(width > 0)) return false;
  return (
    width * dsf <= MAX_SHARP_DIMENSION_PX &&
    h * dsf <= MAX_SHARP_DIMENSION_PX &&
    width * h * dsf * dsf <= MAX_SHARP_AREA_PX
  );
}

export interface SharpUpgradeOptions<T> {
  /** 先に確保済みの 1x の撮影結果 (失敗時の返り値) */
  base: T;
  /** 2x を試してよいか (呼び出し側で canCaptureSharp などから判定済み) */
  eligible: boolean;
  /** 全体の締切までの残り時間 (ms) */
  remainingMs: () => number;
  /** 2x を試すのに最低限必要な残り時間 (ms)。足りなければ試さず base を返す */
  minBudgetMs: number;
  /** 2x の撮影。撮らないと判断したら null を返す */
  trySharp: () => Promise<T | null>;
  /** 2x が失敗 / 時間切れのときの通知 (ログ用) */
  onError?: (err: unknown) => void;
}

/**
 * 「1x を確保済み → 2x を試す → 失敗したら 1x」の縮退制御。
 * 2x の撮影が例外・null・時間切れのどれになっても base を返す。2x が原因で 1x より悪くなることはない。
 */
export async function withSharpUpgrade<T>(opts: SharpUpgradeOptions<T>): Promise<T> {
  if (!opts.eligible) return opts.base;
  const remaining = opts.remainingMs();
  if (!(remaining >= opts.minBudgetMs)) return opts.base;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), remaining);
  });
  // 時間切れ後に遅れて失敗しても未処理の reject にならないよう、必ずここで受ける。
  const attempt = Promise.resolve()
    .then(() => opts.trySharp())
    .then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => {
        opts.onError?.(err);
        return { ok: false as const };
      },
    );

  try {
    const winner = await Promise.race([attempt, timeout]);
    if (winner === 'timeout') {
      opts.onError?.(new Error('sharp capture exceeded the remaining time budget'));
      return opts.base;
    }
    return winner.ok && winner.value !== null ? winner.value : opts.base;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
