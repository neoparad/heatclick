/**
 * Worker のリクエスト body の検証。worker.ts (puppeteer に依存) から切り出して単体テスト可能にしてある。
 */

export interface ScreenshotRequestBody {
  url: string;
  width: number;
  /** 基準の倍率。ロード / autoScroll / 最初の撮影はこの倍率で行う。旧アプリはこれだけを送る。 */
  deviceScaleFactor: number;
  /**
   * 2026-09-29: 「軽いページだけこの倍率で撮り直してほしい」という希望 (SP=2)。省略可。
   * 別フィールドにしてあるのは後方互換のため: このフィールドを知らない旧 Worker は無視して
   * deviceScaleFactor (=1) で撮るので、アプリと Worker のどちらを先にデプロイしても安全。
   */
  preferredDeviceScaleFactor?: number;
}

function isValidDsf(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 4;
}

export function parseRequestBody(raw: unknown): ScreenshotRequestBody | string {
  if (typeof raw !== 'object' || raw === null) {
    return 'request body must be a JSON object';
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.url !== 'string' || obj.url.trim().length === 0) {
    return 'url must be a non-empty string';
  }
  const width = obj.width;
  if (typeof width !== 'number' || !Number.isFinite(width) || width < 320 || width > 3840) {
    return 'width must be a number in [320, 3840]';
  }
  const dsf = obj.deviceScaleFactor;
  if (!isValidDsf(dsf)) {
    return 'deviceScaleFactor must be a positive number ≤ 4';
  }

  // 任意の「希望」。不正な値で撮影自体を失敗させるより、希望を捨てて従来どおり 1x で撮る方が安全。
  const preferred = isValidDsf(obj.preferredDeviceScaleFactor)
    ? obj.preferredDeviceScaleFactor
    : undefined;

  return {
    url: obj.url.trim(),
    width: Math.round(width),
    deviceScaleFactor: dsf,
    ...(preferred !== undefined ? { preferredDeviceScaleFactor: preferred } : {}),
  };
}
