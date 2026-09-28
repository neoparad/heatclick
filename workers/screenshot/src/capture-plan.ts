/**
 * 撮影プラン: 倍率 (deviceScaleFactor) と縦方向の切り詰め高さを決める純関数。
 *
 * 背景 (2026-09-29): ヒートマップ背景画像が粗い問題への対処として SP を 2x で撮る。
 * 面積上限 (MAX_CAPTURE_AREA_PX) は「画像ピクセル面積」で効くため、倍率を上げると CSS 高さの上限が
 * 1/倍率² に縮む。縦長ページで上限が縮んで「上部のみ画像」が増えないよう、倍率を上げてよいのは
 * 「倍率込みの面積が MAX_SHARP_AREA_PX 以内」のページだけにし、それ以外は従来どおり 1x に戻す。
 *
 * 純関数にしてあるのは、Puppeteer / Browser Rendering を使わずにこの判断だけをテストするため。
 */

/**
 * 続133: 撮影の最大ピクセル面積 (画像 px)。超過時は上端から clip する。
 * 1x では従来と同じ height = floor(26M / width) になる。
 */
export const MAX_CAPTURE_AREA_PX = 26_000_000;

/**
 * 倍率を上げたまま撮ってよい最大ピクセル面積 (画像 px)。
 * 倍率を上げた画像は重くなり、表示速度 (体感 10-12 秒の問題) を悪化させ得るため、
 * 全体の上限より厳しくして「倍率を上げるのは軽いページだけ」にする。
 * SP (390px) の 2x では CSS 高さ約 10,200px まで、PC (1280px) の 2x では約 3,100px まで。
 * 調整するときはこの値だけを変える。
 */
export const MAX_SHARP_AREA_PX = 16_000_000;

export interface CapturePlan {
  /** 実際に撮影で使う倍率 (要求より小さくなることがある) */
  dsf: number;
  /** 撮影する CSS 高さ (px)。clip の height にそのまま使う */
  capHeight: number;
  /** 面積上限で上端から切り詰めたか */
  capped: boolean;
}

export interface CapturePlanInput {
  /** viewport の CSS 幅 (px) */
  width: number;
  /** アプリが要求した倍率 */
  requestedDsf: number;
  /** ページ全高 (CSS px)。測れなかった場合は非有限値 */
  fullHeight: number;
}

export function planCapture(input: CapturePlanInput): CapturePlan {
  const { width, requestedDsf } = input;
  const fullHeight =
    Number.isFinite(input.fullHeight) && input.fullHeight > 0 ? input.fullHeight : 0;

  // 倍率を上げる要求で、かつ「倍率込みの面積」が予算内のときだけ要求どおりにする。
  const sharpFits =
    requestedDsf > 1 &&
    fullHeight > 0 &&
    width * fullHeight * requestedDsf * requestedDsf <= MAX_SHARP_AREA_PX;
  const dsf = sharpFits ? requestedDsf : 1;

  const maxHeightByArea = Math.floor(MAX_CAPTURE_AREA_PX / (width * dsf * dsf));
  const capHeight = Math.min(fullHeight, maxHeightByArea);
  return { dsf, capHeight, capped: fullHeight > capHeight };
}
