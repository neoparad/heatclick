/**
 * 撮影プラン: 縦方向の切り詰め高さと、「2x で撮り直してよいか」を決める純関数群。
 *
 * 背景 (2026-09-29): ヒートマップ背景画像が粗い問題への対処として、SP は軽いページだけ 2x でも撮る。
 * 2x の画像は重く、Chrome のスクリーンショットには 16K px 級の寸法制限 (compositor の最大テクスチャ)
 * もあるため、2x を試すのは「予算内に収まる軽いページ」だけにする。2x の撮影が例外・時間切れ・
 * 予算外・整合性チェック不合格のどれになっても、先に確保してある 1x の画像を返す (withSharpUpgrade)。
 * 撮り直しの結果が「エラーページ / 別バリアント」で正常な 1x を置き換えないよう、
 * HTTP ステータスと全高の整合性 (isSharpRecaptureConsistent) も確認する。
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

/**
 * 2x の撮り直しの全高が、先に撮った 1x の全高と大きく食い違っていたら採用しない (比率の許容範囲)。
 * 2 回目の読み込みが WAF のチャレンジ / エラーページ / 別の A/B バリアントになった場合に、
 * 正常な 1x を置き換えないための安全弁。
 */
export const SHARP_MIN_HEIGHT_RATIO = 0.8;
export const SHARP_MAX_HEIGHT_RATIO = 1.25;

/** 希望倍率が基準倍率よりこれ以上大きいときだけ 2x を試す (1.0000001 のような無意味な差で読み込み直さない)。 */
export const MIN_DSF_UPLIFT = 0.5;

/** 1 回の撮影結果。レスポンスヘッダに載せる値を一緒に持つ。 */
export interface Shot {
  bytes: Uint8Array;
  capped: boolean;
  /** 撮影した CSS 高さ (px) */
  capHeight: number;
  /** ページ全高 (CSS px) */
  fullHeight: number;
  /** 撮影で使った倍率 */
  dsf: number;
}

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
 * 注意: dsf>1 では上限が dsf² 倍縮む。アプリは基準の deviceScaleFactor を常に 1 で送るので影響しないが、
 * 直接 Worker を呼ぶ別の呼び出し元が dsf>1 を送ると、従来より短く clip される。
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

export interface SharpEligibilityInput {
  /** アプリが希望した倍率 (無ければ undefined) */
  preferredDsf: number | undefined;
  /** 基準の倍率 (1x の撮影に使った倍率) */
  baseDsf: number;
  /** viewport の CSS 幅 (px) */
  width: number;
  /** document の scrollWidth (CSS px)。横にはみ出すページでは width より大きい */
  scrollWidth: number;
  /** 1x の撮影時に測った全高 (CSS px) */
  fullHeight: number;
}

/**
 * 2x の撮り直しを試してよいか。希望があり、基準より十分大きく、予算 (面積・寸法) 内のときだけ true。
 * fullPage の画像幅は scrollWidth に従うため、予算判定には max(viewport 幅, scrollWidth) を使う。
 */
export function isSharpEligible(input: SharpEligibilityInput): boolean {
  const { preferredDsf } = input;
  if (preferredDsf === undefined) return false;
  if (!(preferredDsf >= input.baseDsf + MIN_DSF_UPLIFT)) return false;
  return canCaptureSharp({
    width: Math.max(input.width, input.scrollWidth),
    dsf: preferredDsf,
    fullHeight: input.fullHeight,
  });
}

/** 2x の撮り直しに使える時間 (ms)。全体の締切 - 余裕 と、1 回の撮り直しの上限のうち小さい方。 */
export function sharpBudgetMs(input: {
  startedAt: number;
  now: number;
  totalTimeoutMs: number;
  safetyMs: number;
  maxAttemptMs: number;
}): number {
  return Math.min(
    input.startedAt + input.totalTimeoutMs - input.safetyMs - input.now,
    input.maxAttemptMs,
  );
}

/** 撮り直した全高が 1x の全高と整合しているか (0.8 倍〜1.25 倍)。 */
export function isSharpRecaptureConsistent(baseFullHeight: number, sharpFullHeight: number): boolean {
  if (!(baseFullHeight > 0) || !(sharpFullHeight > 0)) return false;
  const ratio = sharpFullHeight / baseFullHeight;
  return ratio >= SHARP_MIN_HEIGHT_RATIO && ratio <= SHARP_MAX_HEIGHT_RATIO;
}

/** レスポンスのヘッダ。x-capture-* は観測用で、アプリ側 truncation guard の入力にもなる。 */
export function buildCaptureHeaders(shot: Omit<Shot, 'bytes'>): Record<string, string> {
  return {
    'content-type': 'image/jpeg',
    'x-capture-capped': shot.capped ? '1' : '0',
    'x-capture-full-height': String(shot.fullHeight),
    'x-capture-height': String(shot.capHeight),
    'x-capture-dsf': String(shot.dsf),
  };
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
 * 2x の撮影が例外・null・時間切れのどれになっても base を返す。
 * (撮影は成功したが中身が食い違う場合は trySharp 側で null を返すこと: isSharpRecaptureConsistent)
 */
export async function withSharpUpgrade<T>(opts: SharpUpgradeOptions<T>): Promise<T> {
  if (!opts.eligible) return opts.base;
  const remaining = opts.remainingMs();
  if (!(remaining >= opts.minBudgetMs)) return opts.base;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve('timeout');
    }, remaining);
  });
  // 時間切れ後に遅れて失敗しても未処理の reject にならないよう、必ずここで受ける。
  const attempt = Promise.resolve()
    .then(() => opts.trySharp())
    .then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => {
        // 時間切れで既に通知済みなら、遅れて届く失敗 (ブラウザを閉じた後の Target closed など) は重ねて通知しない。
        if (!timedOut) opts.onError?.(err);
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
