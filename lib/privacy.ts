// プライバシー・GDPR対応機能

// IPアドレスの匿名化（最後のオクテットを0に置き換え）
export function anonymizeIp(ip: string): string {
  if (!ip) return ''
  
  // IPv4の場合
  if (ip.includes('.')) {
    const parts = ip.split('.')
    if (parts.length === 4) {
      parts[3] = '0'
      return parts.join('.')
    }
  }
  
  // IPv6の場合（最後の64ビットを0に）
  if (ip.includes(':')) {
    const parts = ip.split(':')
    if (parts.length >= 4) {
      // 最後の4つのセグメントを0に
      for (let i = Math.max(0, parts.length - 4); i < parts.length; i++) {
        parts[i] = '0'
      }
      return parts.join(':')
    }
  }
  
  return ip
}

// ユーザーエージェントの簡略化（プライバシー保護）
export function simplifyUserAgent(userAgent: string): string {
  if (!userAgent) return ''
  
  // ブラウザとOSの情報のみを保持
  const browser = getBrowser(userAgent)
  const os = getOS(userAgent)
  
  return `${browser} on ${os}`
}

function getBrowser(userAgent: string): string {
  if (userAgent.includes('Chrome')) return 'Chrome'
  if (userAgent.includes('Firefox')) return 'Firefox'
  if (userAgent.includes('Safari')) return 'Safari'
  if (userAgent.includes('Edge')) return 'Edge'
  if (userAgent.includes('Opera')) return 'Opera'
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

// オプトアウトチェック（Cookieから）
export function checkOptOut(): boolean {
  if (typeof window === 'undefined') return false
  
  const optOut = localStorage.getItem('clickinsight_optout')
  return optOut === 'true'
}

// オプトアウト設定
export function setOptOut(optOut: boolean): void {
  if (typeof window === 'undefined') return
  
  if (optOut) {
    localStorage.setItem('clickinsight_optout', 'true')
  } else {
    localStorage.removeItem('clickinsight_optout')
  }
}

// Cookie同意チェック
export function checkCookieConsent(): boolean {
  if (typeof window === 'undefined') return false
  
  const consent = localStorage.getItem('clickinsight_cookie_consent')
  return consent === 'true'
}

// Cookie同意設定
export function setCookieConsent(consent: boolean): void {
  if (typeof window === 'undefined') return
  
  if (consent) {
    localStorage.setItem('clickinsight_cookie_consent', 'true')
  } else {
    localStorage.removeItem('clickinsight_cookie_consent')
  }
}



