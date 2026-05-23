/**
 * Privacy / GDPR utilities
 *
 * 親 SSOT §1.6 原則 5 / §3.8.2 (PII REDACT)
 * Sprint 0 S0-03 完成版。
 *
 * ugokimap/lib/privacy.ts そのまま流用 + storage key を ugokimap_saas_* に変更。
 */

const STORAGE_KEY_OPTOUT = 'ugokimap_saas_optout'
const STORAGE_KEY_COOKIE_CONSENT = 'ugokimap_saas_cookie_consent'

/**
 * IPv4 / IPv6 の匿名化 (§3.8.2 PII REDACT)
 * - IPv4: 最後のオクテットを 0
 * - IPv6: 最後の 64bit を 0
 */
export function anonymizeIp(ip: string): string {
  if (!ip) return ''

  // IPv4
  if (ip.includes('.')) {
    const parts = ip.split('.')
    if (parts.length === 4) {
      parts[3] = '0'
      return parts.join('.')
    }
  }

  // IPv6
  if (ip.includes(':')) {
    const parts = ip.split(':')
    if (parts.length >= 4) {
      for (let i = Math.max(0, parts.length - 4); i < parts.length; i++) {
        parts[i] = '0'
      }
      return parts.join(':')
    }
  }

  return ip
}

export function simplifyUserAgent(userAgent: string): string {
  if (!userAgent) return ''
  return `${getBrowser(userAgent)} on ${getOS(userAgent)}`
}

function getBrowser(userAgent: string): string {
  // 判定順序が重要: Edge/Opera は Chrome を含むため先に判定
  if (userAgent.includes('Edg/') || userAgent.includes('Edge/')) return 'Edge'
  if (userAgent.includes('OPR/') || userAgent.includes('Opera')) return 'Opera'
  if (userAgent.includes('Chrome')) return 'Chrome'
  if (userAgent.includes('Firefox')) return 'Firefox'
  if (userAgent.includes('Safari')) return 'Safari'
  return 'Unknown'
}

function getOS(userAgent: string): string {
  if (userAgent.includes('Windows')) return 'Windows'
  if (userAgent.includes('Mac')) return 'macOS'
  if (userAgent.includes('Linux')) return 'Linux'
  if (userAgent.includes('Android')) return 'Android'
  if (userAgent.includes('iOS')) return 'iOS'
  return 'Unknown'
}

export function checkOptOut(): boolean {
  if (typeof window === 'undefined') return false
  return localStorage.getItem(STORAGE_KEY_OPTOUT) === 'true'
}

export function setOptOut(optOut: boolean): void {
  if (typeof window === 'undefined') return
  if (optOut) {
    localStorage.setItem(STORAGE_KEY_OPTOUT, 'true')
  } else {
    localStorage.removeItem(STORAGE_KEY_OPTOUT)
  }
}

export function checkCookieConsent(): boolean {
  if (typeof window === 'undefined') return false
  return localStorage.getItem(STORAGE_KEY_COOKIE_CONSENT) === 'true'
}

export function setCookieConsent(consent: boolean): void {
  if (typeof window === 'undefined') return
  if (consent) {
    localStorage.setItem(STORAGE_KEY_COOKIE_CONSENT, 'true')
  } else {
    localStorage.removeItem(STORAGE_KEY_COOKIE_CONSENT)
  }
}

/**
 * PII REDACT パターン (§3.8.2 + Codex Round 2 OQ-16)
 * Sprint 0 で実装、Workers 側 + サンプリング検査ジョブで使用。
 */
export const PII_PATTERNS = {
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  phone_jp: /(0\d{1,4}-?\d{1,4}-?\d{4}|\+81-?\d{1,4}-?\d{1,4}-?\d{4})/g,
  credit_card: /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,
  mynumber: /\b\d{12}\b/g,
  zip_jp: /\b\d{3}-?\d{4}\b/g,
  jwt: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  api_key_openai: /sk-[a-zA-Z0-9]{20,}/g,
  api_key_anthropic: /sk-ant-[a-zA-Z0-9-]+/g,
  url_token: /[?&]token=[^&\s]+/g,
}

export function redactPII(text: string): string {
  if (!text) return text
  let redacted = text
  for (const pattern of Object.values(PII_PATTERNS)) {
    redacted = redacted.replace(pattern, '[REDACTED]')
  }
  return redacted
}
