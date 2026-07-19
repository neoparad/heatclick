/**
 * サーバ側計測ヘルパ (P0: ヒートマップ表示速度の区間計測)。
 *
 * 背景: `docs/heatmap/SONNET_PROMPT_P0_instrumentation_2026-07-19.md` §2。
 *
 * 絶対条件 (spec §0 — このファイルはそれを満たすことが存在意義):
 *   - 計測コードが失敗してもレスポンス内容・ステータスは不変。`span`/`mark`/
 *     `headerValue`/`logLine`/`coldStartInfo`/`region` は全て内部で try/catch
 *     して自壊しない (計測処理そのものの失敗は握りつぶし、フォールバック値を返す)。
 *     ただし `span()` に渡された `fn` 自体が投げたエラーは握りつぶさず、span を
 *     記録した上で必ず rethrow する (呼び出し元のエラーハンドリングを変えない)。
 *   - Server-Timing の desc に URL・エラーメッセージ・接続情報を入れない
 *     (数値・列挙ラベルのみ。ブラウザに露出するため — これは呼び出し側の責務)。
 *     加えてここでも `"` / `,` / `;` / 改行など Server-Timing の構文を壊す文字・
 *     ヘッダ分割に使われうる制御文字は機械的に除去する (縦深防御)。
 *   - 新規 npm 依存なし。Web Performance API (`performance.now()`) と
 *     Web Crypto (`crypto.randomUUID()`, Node 18+ グローバル) のみ。
 *
 * 時間は必ず `performance.now()` (単調増加) を使う。`Date.now()` とは混ぜない。
 */

/** 1 span (計測区間) の記録。Server-Timing の dur 付き metric に対応。 */
export interface PerfSpan {
  name: string
  durMs: number
  desc?: string
}

/** dur を持たないラベル (tier など列挙値)。Server-Timing の desc-only metric に対応。 */
interface PerfMark {
  name: string
  desc: string
}

export interface RouteTimer {
  /**
   * fn を計測して結果をそのまま返す。fn が throw しても span は記録した上で
   * rethrow する (レスポンス内容・エラー経路は一切変えない)。
   */
  span<T>(name: string, fn: () => Promise<T>): Promise<T>
  /** dur なしのラベルを記録する (tier 等)。 */
  mark(name: string, desc: string): void
  /** `Server-Timing` ヘッダの値。cold/region/init を自動で追加する。 */
  headerValue(): string
  /** 構造化 1 行 JSON (route, spans, marks, total, cold, region, reqId)。呼び出し側が `console.info` へ渡す想定。 */
  logLine(): string
  /** この route 呼び出し用に生成された相関 ID。CH `log_comment` 等、他の計測箇所へ同じ値を渡すのに使う。 */
  reqId(): string
}

// --- module スコープ: cold start 判定 ---------------------------------------
// route ファイルでなくこの module 内で保持する。全 route が同一 function bundle に
// 入る場合も、別 bundle の場合も、それぞれの bundle の cold を正しく表す。
const MODULE_LOAD_AT = safeNow()
let invoked = false

/**
 * この module インスタンスで初めて呼ばれたかどうか (= cold start か) を返す。
 * 2 回目以降の呼び出しは常に `cold: false` になる (module 全体で 1 回だけ true)。
 */
export function coldStartInfo(): { cold: boolean; initToHandlerMs: number } {
  try {
    const cold = !invoked
    invoked = true
    return { cold, initToHandlerMs: round1(safeNow() - MODULE_LOAD_AT) }
  } catch {
    return { cold: false, initToHandlerMs: 0 }
  }
}

/** 実行 region ラベル。取得できなければ `'local'`。 */
export function region(): string {
  try {
    const value = process.env.VERCEL_REGION
    return value && value.length > 0 ? value : 'local'
  } catch {
    return 'local'
  }
}

/** route 冒頭で 1 回だけ生成するタイマーを作る。 */
export function createRouteTimer(route: string): RouteTimer {
  const timerStart = safeNow()
  const { cold, initToHandlerMs } = coldStartInfo()
  const routeRegion = region()
  const reqId = safeReqId()
  const spans: PerfSpan[] = []
  const marks: PerfMark[] = []

  function recordSpan(name: string, durMs: number, desc?: string): void {
    try {
      const entry: PerfSpan =
        desc !== undefined
          ? { name, durMs: round1(durMs), desc: sanitizeDesc(desc) }
          : { name, durMs: round1(durMs) }
      spans.push(entry)
    } catch {
      // 計測失敗はレスポンスに影響させない (絶対条件 1)
    }
  }

  async function span<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = safeNow()
    try {
      const result = await fn()
      recordSpan(name, safeNow() - start)
      return result
    } catch (error) {
      recordSpan(name, safeNow() - start)
      throw error
    }
  }

  function mark(name: string, desc: string): void {
    try {
      marks.push({ name, desc: sanitizeDesc(desc) })
    } catch {
      // 計測失敗はレスポンスに影響させない
    }
  }

  function totalDurMs(): number {
    try {
      return round1(safeNow() - timerStart)
    } catch {
      return 0
    }
  }

  function buildEntries(): string[] {
    const entries: string[] = []
    for (const s of spans) {
      entries.push(formatSpanEntry(s.name, s.durMs, s.desc))
    }
    entries.push(formatSpanEntry('total', totalDurMs()))
    for (const m of marks) {
      entries.push(formatMarkEntry(m.name, m.desc))
    }
    entries.push(formatMarkEntry('cold', cold ? '1' : '0'))
    entries.push(formatMarkEntry('region', sanitizeDesc(routeRegion)))
    if (cold) {
      entries.push(formatSpanEntry('init', round1(initToHandlerMs)))
    }
    return entries
  }

  function headerValue(): string {
    try {
      return buildEntries().join(', ')
    } catch {
      return ''
    }
  }

  function logLine(): string {
    try {
      return JSON.stringify({
        route,
        reqId,
        cold,
        region: routeRegion,
        spans: [...spans, { name: 'total', durMs: totalDurMs() }],
        marks,
      })
    } catch {
      return '{}'
    }
  }

  return { span, mark, headerValue, logLine, reqId: () => reqId }
}

// --- internal helpers --------------------------------------------------------

function safeNow(): number {
  try {
    return performance.now()
  } catch {
    return 0
  }
}

function round1(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 10) / 10
}

/** Server-Timing の構文を壊す文字・ヘッダ分割に使われうる制御文字を除去する。 */
function sanitizeDesc(desc: string): string {
  try {
    return desc.replace(/["\r\n;,]/g, '')
  } catch {
    return ''
  }
}

function formatSpanEntry(name: string, durMs: number, desc?: string): string {
  const dur = Number.isFinite(durMs) ? durMs : 0
  if (desc !== undefined && desc.length > 0) {
    return `${name};desc="${desc}";dur=${dur.toFixed(1)}`
  }
  return `${name};dur=${dur.toFixed(1)}`
}

function formatMarkEntry(name: string, desc: string): string {
  return `${name};desc="${desc}"`
}

function safeReqId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }
}
