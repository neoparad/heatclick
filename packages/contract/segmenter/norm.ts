/**
 * UGOKI LINK v2 — Table-Driven Text Normalizer `norm/1`
 *
 * join-final.md A1:
 * - ASCII lower-case
 * - Full-width ASCII (U+FF01..U+FF5E) to half-width ASCII
 * - Half-width katakana (U+FF61..U+FF9F) to full-width katakana with voiced/semi-voiced composition
 * - Combining voiced/semi-voiced marks (U+3099, U+309A) composed with base kana via table
 * - Every Unicode space collapsed to one ASCII space and trimmed
 * - Zero-width characters and soft hyphens removed
 * - NEVER calls `String.prototype.normalize` or `Intl` (engine-version independent)
 */

import { hash64 } from './hash'

export const NORM_RULE_REV = 'norm/1' as const

// Half-width katakana table U+FF61..U+FF9F (63 entries)
const HALFWIDTH_KANA_BASE: readonly string[] = [
  '。', '「', '」', '、', '・', 'ヲ', 'ァ', 'ィ', 'ゥ', 'ェ', 'ォ', 'ャ', 'ュ', 'ョ', 'ッ', 'ー',
  'ア', 'イ', 'ウ', 'エ', 'オ', 'カ', 'キ', 'ク', 'ケ', 'コ', 'サ', 'シ', 'ス', 'セ', 'ソ', 'タ',
  'チ', 'ツ', 'テ', 'ト', 'ナ', 'ニ', 'ヌ', 'ネ', 'ノ', 'ハ', 'ヒ', 'フ', 'ヘ', 'ホ', 'マ', 'ミ',
  'ム', 'メ', 'モ', 'ヤ', 'ユ', 'ヨ', 'ラ', 'リ', 'ル', 'レ', 'ロ', 'ワ', 'ン', '゛', '゜',
]

// Base full-width kana -> voiced (dakuten) precomposed form
const VOICED_COMPOSE_MAP: Readonly<Record<string, string>> = {
  // Katakana
  'ウ': 'ヴ',
  'カ': 'ガ', 'キ': 'ギ', 'ク': 'グ', 'ケ': 'ゲ', 'コ': 'ゴ',
  'サ': 'ザ', 'シ': 'ジ', 'ス': 'ズ', 'セ': 'ゼ', 'ソ': 'ゾ',
  'タ': 'ダ', 'チ': 'ヂ', 'ツ': 'ヅ', 'テ': 'デ', 'ト': 'ド',
  'ハ': 'バ', 'ヒ': 'ビ', 'フ': 'ブ', 'ヘ': 'ベ', 'ホ': 'ボ',
  'ワ': 'ヷ', 'ヰ': 'ヸ', 'ヱ': 'ヹ', 'ヲ': 'ヺ',
  // Hiragana
  'う': 'ゔ',
  'か': 'が', 'き': 'ぎ', 'く': 'ぐ', 'け': 'げ', 'こ': 'ご',
  'さ': 'ざ', 'し': 'じ', 'す': 'ず', 'せ': 'ぜ', 'そ': 'ぞ',
  'た': 'だ', 'ち': 'ぢ', 'つ': 'づ', 'て': 'で', 'と': 'ど',
  'は': 'ば', 'ひ': 'び', 'ふ': 'ぶ', 'へ': 'べ', 'ほ': 'ぼ',
}

// Base full-width kana -> semi-voiced (handakuten) precomposed form
const SEMIVOICED_COMPOSE_MAP: Readonly<Record<string, string>> = {
  'ハ': 'パ', 'ヒ': 'ピ', 'フ': 'プ', 'ヘ': 'ペ', 'ホ': 'ポ',
  'は': 'ぱ', 'ひ': 'ぴ', 'ふ': 'ぷ', 'へ': 'ぺ', 'ほ': 'ぽ',
}

function isZeroWidthOrSoftHyphen(code: number): boolean {
  return (
    code === 0x00ad || // soft hyphen
    (code >= 0x200b && code <= 0x200f) || // ZWSP, ZWNJ, ZWJ, LRM, RLM
    (code >= 0x202a && code <= 0x202e) || // bidi control
    (code >= 0x2060 && code <= 0x206f) || // word joiner & invisibles
    code === 0xfeff // BOM / ZWNBSP
  )
}

function isUnicodeSpace(code: number): boolean {
  return (
    (code >= 0x0009 && code <= 0x000d) || // TAB, LF, VT, FF, CR
    code === 0x0020 || // SPACE
    code === 0x0085 || // NEL
    code === 0x00a0 || // NBSP
    code === 0x1680 || // OGHAM SPACE MARK
    (code >= 0x2000 && code <= 0x200a) || // EN QUAD .. HAIR SPACE
    code === 0x2028 || // LINE SEPARATOR
    code === 0x2029 || // PARAGRAPH SEPARATOR
    code === 0x202f || // NARROW NO-BREAK SPACE
    code === 0x205f || // MEDIUM MATHEMATICAL SPACE
    code === 0x3000 // IDEOGRAPHIC SPACE
  )
}

export function normText(input: string): string {
  if (!input) return ''

  // Pass 1: strip zero-width, convert full-width ASCII & half-width kana, compose voiced marks
  const chars: string[] = []
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)
    if (isZeroWidthOrSoftHyphen(code)) {
      continue
    }

    if (isUnicodeSpace(code)) {
      chars.push(' ')
      continue
    }

    // Full-width ASCII (U+FF01..U+FF5E -> U+0021..U+007E)
    if (code >= 0xff01 && code <= 0xff5e) {
      let half = code - 0xfee0
      if (half >= 0x41 && half <= 0x5a) half += 0x20
      chars.push(String.fromCharCode(half))
      continue
    }

    // ASCII uppercase -> lowercase
    if (code >= 0x41 && code <= 0x5a) {
      chars.push(String.fromCharCode(code + 0x20))
      continue
    }

    // Half-width katakana (U+FF61..U+FF9F)
    if (code >= 0xff61 && code <= 0xff9f) {
      // Voiced mark U+FF9E (ﾞ) or semi-voiced mark U+FF9F (ﾟ)
      if (code === 0xff9e && chars.length > 0) {
        const prev = chars[chars.length - 1]
        const composed = VOICED_COMPOSE_MAP[prev]
        if (composed) {
          chars[chars.length - 1] = composed
          continue
        }
      } else if (code === 0xff9f && chars.length > 0) {
        const prev = chars[chars.length - 1]
        const composed = SEMIVOICED_COMPOSE_MAP[prev]
        if (composed) {
          chars[chars.length - 1] = composed
          continue
        }
      }
      chars.push(HALFWIDTH_KANA_BASE[code - 0xff61])
      continue
    }

    // Combining voiced/semi-voiced marks (U+3099, U+309A) -> table-based NFC composition
    if (code === 0x3099 && chars.length > 0) {
      const prev = chars[chars.length - 1]
      const composed = VOICED_COMPOSE_MAP[prev]
      if (composed) {
        chars[chars.length - 1] = composed
        continue
      }
    } else if (code === 0x309a && chars.length > 0) {
      const prev = chars[chars.length - 1]
      const composed = SEMIVOICED_COMPOSE_MAP[prev]
      if (composed) {
        chars[chars.length - 1] = composed
        continue
      }
    }

    chars.push(input[i])
  }

  // Pass 2: collapse consecutive spaces & trim
  let out = ''
  let prevSpace = true // skips leading spaces
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (ch === ' ') {
      if (!prevSpace) {
        out += ' '
        prevSpace = true
      }
    } else {
      out += ch
      prevSpace = false
    }
  }
  if (out.endsWith(' ')) {
    out = out.slice(0, -1)
  }
  return out
}

/**
 * 起動時自己診断用プローブ文字列 (join-final.md A1)。
 */
export const NORM_PROBE_STRING =
  '  ＡＢＣ\u3000ｶﾞｷﾞｸﾞｹﾞｺﾞ ﾊﾟﾋﾟﾌﾟﾍﾟﾎﾟ か\u3099は\u309A\u200B\u00AD\tHello\u00A0WORLD!  '

export const NORM_PROBE_EXPECTED_NORM = 'abc ガギグゲゴ パピプペポ がぱ hello world!'

export const NORM_PROBE_EXPECTED_HASH = hash64(NORM_RULE_REV, NORM_PROBE_EXPECTED_NORM)

export function verifyNormProbe(): boolean {
  const actual = normText(NORM_PROBE_STRING)
  if (actual !== NORM_PROBE_EXPECTED_NORM) return false
  return hash64(NORM_RULE_REV, actual) === NORM_PROBE_EXPECTED_HASH
}
