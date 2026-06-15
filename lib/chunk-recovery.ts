/**
 * Stale-chunk recovery — 「自分のブラウザだけ画面が真っ白／シークレットは平気」問題の自己修復。
 *
 * 続 117 white-screen root-fix:
 *   新デプロイ後、ブラウザがキャッシュした古い HTML / client navigation が、もう存在しない
 *   旧デプロイの JS (または CSS) チャンクを読みに行くと `ChunkLoadError` が throw される。
 *   App Router でエラー境界が無いと、これがそのまま画面真っ白になる
 *   (シークレットウィンドウはキャッシュが無いので最新チャンクを取得でき、再現しない)。
 *
 *   本モジュールは error.tsx / global-error.tsx から呼ばれ、ChunkLoadError と判定できた場合のみ
 *   「60 秒クールダウン付きで 1 回だけ hard reload」して最新チャンクを取り直す。
 *   クールダウンは reload ループ (落ち続けるデプロイ等) の暴走を防ぐためのガード。
 *
 * テスト容易性のため副作用 (now / reload / storage) は注入可能にしてある。
 */

/** ChunkLoadError 系か判定する純粋関数 (error 境界に渡る Error / 任意値を許容)。 */
export function isChunkLoadError(error: unknown): boolean {
  let name = ''
  let message = ''
  if (error instanceof Error) {
    name = error.name
    message = error.message
  } else if (typeof error === 'object' && error !== null) {
    const maybe = error as { name?: unknown; message?: unknown }
    name = typeof maybe.name === 'string' ? maybe.name : ''
    message = typeof maybe.message === 'string' ? maybe.message : ''
  } else {
    return false
  }

  if (name === 'ChunkLoadError') return true
  return (
    /loading chunk [\w-]+ failed/i.test(message) ||
    /loading css chunk [\w-]+ failed/i.test(message) ||
    /failed to fetch dynamically imported module/i.test(message) ||
    /importing a module script failed/i.test(message)
  )
}

export const CHUNK_RELOAD_KEY = 'ug_chunk_reload_at'
export const CHUNK_RELOAD_COOLDOWN_MS = 60_000

export interface RecoverDeps {
  now?: () => number
  reload?: () => void
  storage?: Pick<Storage, 'getItem' | 'setItem'>
}

/**
 * error が ChunkLoadError 系なら、クールダウン外に限り 1 回だけ reload して最新チャンクを
 * 取り直す。reload を実行したら true、しなかった (=非該当 / クールダウン中 / 環境不可) なら false。
 */
export function recoverFromStaleChunk(error: unknown, deps: RecoverDeps = {}): boolean {
  if (!isChunkLoadError(error)) return false

  const now = deps.now ?? Date.now
  const reload =
    deps.reload ??
    (typeof window !== 'undefined' ? () => window.location.reload() : undefined)
  const storage =
    deps.storage ?? (typeof window !== 'undefined' ? window.sessionStorage : undefined)

  if (!reload || !storage) return false

  try {
    const last = Number(storage.getItem(CHUNK_RELOAD_KEY) ?? '0')
    const t = now()
    // 直近 60 秒以内に reload 済みなら、無限ループ防止のため再読込しない
    if (Number.isFinite(last) && last > 0 && t - last < CHUNK_RELOAD_COOLDOWN_MS) {
      return false
    }
    storage.setItem(CHUNK_RELOAD_KEY, String(t))
    reload()
    return true
  } catch {
    return false
  }
}
