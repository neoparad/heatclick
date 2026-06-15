/**
 * Unit tests: chunk-recovery — 白画面 (ChunkLoadError) 自己修復ロジックの regression guard
 * 続 117 white-screen root-fix
 */

import {
  isChunkLoadError,
  recoverFromStaleChunk,
  CHUNK_RELOAD_KEY,
  CHUNK_RELOAD_COOLDOWN_MS,
} from './chunk-recovery'

describe('isChunkLoadError', () => {
  it('name === "ChunkLoadError" を検知', () => {
    const e = new Error('boom')
    e.name = 'ChunkLoadError'
    expect(isChunkLoadError(e)).toBe(true)
  })
  it('"Loading chunk 123 failed" message を検知', () => {
    expect(isChunkLoadError(new Error('Loading chunk 4827 failed.'))).toBe(true)
  })
  it('"Loading CSS chunk failed" message を検知', () => {
    expect(isChunkLoadError(new Error('Loading CSS chunk 12 failed'))).toBe(true)
  })
  it('dynamic import 失敗 message を検知 (modern bundlers)', () => {
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module: /x.js'))).toBe(
      true,
    )
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(false)
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true)
  })
  it('通常の Error は false', () => {
    expect(isChunkLoadError(new Error('TypeError: cannot read x of undefined'))).toBe(false)
  })
  it('Error 以外 (object / null / string) も安全に判定', () => {
    expect(isChunkLoadError({ name: 'ChunkLoadError' })).toBe(true)
    expect(isChunkLoadError({ message: 'Loading chunk a1b2 failed' })).toBe(true)
    expect(isChunkLoadError(null)).toBe(false)
    expect(isChunkLoadError('ChunkLoadError')).toBe(false)
    expect(isChunkLoadError(undefined)).toBe(false)
  })
})

describe('recoverFromStaleChunk', () => {
  function makeStorage(initial: Record<string, string> = {}) {
    const map = new Map<string, string>(Object.entries(initial))
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v)
      },
      _map: map,
    }
  }

  it('ChunkLoadError なら reload して true、reload 時刻を記録', () => {
    const storage = makeStorage()
    let reloaded = 0
    const e = new Error('Loading chunk 9 failed')
    const result = recoverFromStaleChunk(e, {
      now: () => 1_000_000,
      reload: () => {
        reloaded += 1
      },
      storage,
    })
    expect(result).toBe(true)
    expect(reloaded).toBe(1)
    expect(storage._map.get(CHUNK_RELOAD_KEY)).toBe('1000000')
  })

  it('非 ChunkLoadError は何もせず false', () => {
    const storage = makeStorage()
    let reloaded = 0
    const result = recoverFromStaleChunk(new Error('normal render crash'), {
      now: () => 1_000_000,
      reload: () => {
        reloaded += 1
      },
      storage,
    })
    expect(result).toBe(false)
    expect(reloaded).toBe(0)
    expect(storage._map.has(CHUNK_RELOAD_KEY)).toBe(false)
  })

  it('クールダウン中 (60秒以内) の再発は reload しない (無限ループ防止)', () => {
    const storage = makeStorage({ [CHUNK_RELOAD_KEY]: '1000000' })
    let reloaded = 0
    const e = new Error('Loading chunk 9 failed')
    const result = recoverFromStaleChunk(e, {
      now: () => 1_000_000 + CHUNK_RELOAD_COOLDOWN_MS - 1,
      reload: () => {
        reloaded += 1
      },
      storage,
    })
    expect(result).toBe(false)
    expect(reloaded).toBe(0)
  })

  it('クールダウン経過後は再び reload する', () => {
    const storage = makeStorage({ [CHUNK_RELOAD_KEY]: '1000000' })
    let reloaded = 0
    const e = new Error('Loading chunk 9 failed')
    const result = recoverFromStaleChunk(e, {
      now: () => 1_000_000 + CHUNK_RELOAD_COOLDOWN_MS + 1,
      reload: () => {
        reloaded += 1
      },
      storage,
    })
    expect(result).toBe(true)
    expect(reloaded).toBe(1)
  })

  it('reload / storage が無い環境 (SSR) では false', () => {
    expect(recoverFromStaleChunk(new Error('Loading chunk 9 failed'), { reload: undefined, storage: undefined })).toBe(
      false,
    )
  })
})
