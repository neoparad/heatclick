/**
 * App base URL resolver — メールに焼き込まれてクライアントがクリックする絶対 URL
 * (magic-link verify URL 等) を組み立てるための単一ソース。
 *
 * 続 117 root-fix (本番 magic-link login bug):
 *   旧 `app/api/auth/magic-link/route.ts` は固定の
 *     `process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'`
 *   でリンクを生成していた。アプリは複数 host (ugokimap.com / *.vercel.app) で開けるが、
 *   セッション Cookie は host 単位 (domain 未指定)。ユーザーが vercel.app を見ていても
 *   リンクは ugokimap.com を指すため、別 host でログイン成立 → 閲覧中の host には Cookie が
 *   付かず、ページ遷移のたびに sign-in へ蹴られる無限ループになっていた。
 *
 * 解決方針:
 *   - resolveRequestOrigin(request): 「今アクセス中の host」を allowlist 厳格検証し、
 *     ログイン host と閲覧 host を一致させる。allowlist 外なら canonical へフォールバック。
 *   - resolveAppUrl(): host が取れない / 信頼できない場合の canonical 解決 (env ベース)。
 *
 * セキュリティ (Codex T1 review fix):
 *   - host は WHATWG URL parser で厳格 parse。userinfo / path / query / fragment を持つ値は
 *     拒否 (例: "attacker.com#.ugokimap.com" は fragment 注入なので reject → token 流出防止)。
 *   - Vercel host は Vercel が当デプロイに設定する env (VERCEL_URL / VERCEL_PROJECT_PRODUCTION_URL)
 *     と exact match した場合のみ信用。prefix glob は project 名乗っ取りで破れるため使わない。
 *   - 信頼 host への明示 port (例 ugokimap.com:8443) は別 origin 扱いで reject (localhost dev 除く)。
 *   - scheme は https/http allowlist のみ。本番は常に https を強制 (x-forwarded-proto 注入を無効化)。
 */

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

/** `http://localhost`, `http://127.0.0.1`, `http://[::1]` 系を localhost とみなす (full URL 判定) */
function isLocalhostUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch {
    return /(^|\/\/)(localhost|127\.0\.0\.1|\[?::1\]?)(:|\/|$)/i.test(rawUrl)
  }
}

/**
 * 現在の実行環境に対する正規 base URL (末尾スラッシュ無し) を返す。
 * 環境変数を呼び出し時に読むため、cold start のタイミング差やテストの差し替えに強い。
 *
 * 解決順位:
 *   1. NEXT_PUBLIC_APP_URL          — 明示設定 (最優先 override)
 *                                     ただし Vercel 上 or 本番で localhost を指す設定ミスは無視
 *   2. VERCEL_PROJECT_PRODUCTION_URL — Vercel 本番の正規ドメイン
 *   3. VERCEL_URL                   — Vercel preview デプロイの一意 URL
 *   4. https://ugokimap.com          — 本番 fallback
 *   5. http://localhost:3000         — ローカル開発
 */
export function resolveAppUrl(): string {
  const onVercel = Boolean(process.env.VERCEL)
  const isProd = process.env.NODE_ENV === 'production'
  // Vercel 上 or 本番では localhost を指す明示設定は設定ミスとして無視する
  // (Codex T1 review fix: 非 Vercel 本番でも localhost link を出さない)。
  const distrustLocalhost = onVercel || isProd
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim()

  if (explicit && !(distrustLocalhost && isLocalhostUrl(explicit))) {
    return stripTrailingSlash(explicit)
  }

  const prodDomain = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim()
  if (prodDomain) return `https://${stripTrailingSlash(prodDomain)}`

  const vercelUrl = process.env.VERCEL_URL?.trim()
  if (vercelUrl) return `https://${stripTrailingSlash(vercelUrl)}`

  if (isProd) return 'https://ugokimap.com'

  return 'http://localhost:3000'
}

/**
 * Vercel が設定する env (VERCEL_URL / VERCEL_PROJECT_PRODUCTION_URL) を hostname に正規化する。
 * Codex LOW nit fix: env が誤って `https://host` / `host/` / `host:443` / 大文字 / 末尾ドット等で
 * 設定された場合でも allowlist と exact 一致できるよう、同じ URL parser で hostname を取り出す
 * (一致失敗による preview デプロイの正規 flow 退行を防ぐ。security bypass ではなく堅牢性向上)。
 */
function normalizeEnvHost(value: string | undefined): string | null {
  const raw = value?.trim().toLowerCase()
  if (!raw) return null
  const candidate = raw.includes('://') ? raw : `https://${raw}`
  try {
    let h = new URL(candidate).hostname // port / path / query / fragment は除去される
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
    if (h.endsWith('.')) h = h.slice(0, -1)
    return h || null
  } catch {
    return null
  }
}

/**
 * host header 候補を WHATWG URL parser で厳格 parse し、自社所有の信頼 host なら
 * 正規化済 `host[:port]` を、そうでなければ null を返す内部関数。
 *
 * 厳格化のポイント (Codex T1 CRITICAL fix):
 *   - `http://<raw>` として parse し、userinfo / path / query / fragment が付いていたら reject。
 *     これにより "attacker.com#.ugokimap.com" 等の fragment/path 注入で endsWith() を
 *     すり抜ける攻撃を防ぐ (new URL は host を attacker.com、残りを fragment として解釈するため)。
 *   - allowlist 判定は parser が返した正規化 hostname に対してのみ行う。
 */
function trustedHostValue(host: string | null | undefined): string | null {
  if (!host) return null
  const raw = host.trim().toLowerCase()
  if (!raw) return null

  let u: URL
  try {
    u = new URL(`http://${raw}`)
  } catch {
    return null
  }
  // 注入の兆候 (userinfo / path / query / fragment) を持つ値は信用しない
  if (u.username || u.password) return null
  if (u.pathname !== '/') return null
  if (u.search !== '' || u.hash !== '') return null

  const rawHostname = u.hostname // IPv6 は "[::1]" 形式、port は含まない
  let bareHostname = rawHostname
  if (bareHostname.startsWith('[') && bareHostname.endsWith(']')) {
    bareHostname = bareHostname.slice(1, -1)
  }
  if (bareHostname.endsWith('.')) bareHostname = bareHostname.slice(0, -1)

  const isProd = process.env.NODE_ENV === 'production'

  // localhost (dev のみ) は開発サーバの明示 port (:3000 等) を許可する。
  // それ以外の信頼 host (本番ドメイン / Vercel host) は明示 port を持たないため、
  // port 付きは origin すり替え (例 "ugokimap.com:8443") として reject する
  // (Codex MEDIUM fix: 同一 hostname でも別 origin にトークンが飛ぶのを防ぐ)。
  const isLocalDev =
    !isProd && (bareHostname === 'localhost' || bareHostname === '127.0.0.1' || bareHostname === '::1')
  if (u.port && !isLocalDev) return null

  // Vercel 上の信頼 host は「prefix glob 推測」ではなく Vercel が当デプロイに対して
  // 権威的に設定する env (VERCEL_URL / VERCEL_PROJECT_PRODUCTION_URL) から導出する。
  // Codex CRITICAL fix:
  //   旧実装の `startsWith('ugokimap-saas-') && endsWith('.vercel.app')` は、攻撃者が
  //   `ugokimap-saas-attacker` という Vercel project を作れば
  //   `ugokimap-saas-attacker.vercel.app` を所有でき、magic-link トークンが攻撃者 origin に
  //   飛ぶ穴だった。env 由来の値は header で偽装しても一致しないため安全。
  const trustedExact = new Set<string>(['ugokimap.com', 'ugokimap-saas.vercel.app'])
  const prodUrl = normalizeEnvHost(process.env.VERCEL_PROJECT_PRODUCTION_URL)
  if (prodUrl) trustedExact.add(prodUrl)
  const vercelUrl = normalizeEnvHost(process.env.VERCEL_URL)
  if (vercelUrl) trustedExact.add(vercelUrl)

  const ok = trustedExact.has(bareHostname) || bareHostname.endsWith('.ugokimap.com') || isLocalDev
  if (!ok) return null

  // 正規化した hostname (trailing dot 除去後) + port を再構成して返す。
  // raw header をそのまま使うと前後空白等で後続の new URL が throw する恐れがあるため、
  // parser 正規化済の値のみを使う。port は上の検証を通過した localhost dev のみ残る。
  const normHostname = rawHostname.endsWith('.') ? rawHostname.slice(0, -1) : rawHostname
  return u.port ? `${normHostname}:${u.port}` : normHostname
}

/**
 * 自社が所有する信頼できる host か判定する (公開 API、テスト用)。
 * 詳細仕様は trustedHostValue を参照。
 */
export function isTrustedHost(host: string | null | undefined): boolean {
  return trustedHostValue(host) !== null
}

/**
 * 続 117 root-fix (本番 login bug の本丸):
 *   magic-link 確認 URL を「ユーザーが今アクセスしている host」で組み立てる解決関数。
 *   ログイン host と閲覧 host を自動一致させることで、host またぎの Cookie ズレ
 *   (= ページ遷移で sign-in へ蹴られる無限ループ) を解消する。
 *
 *   host (Vercel が権威的に設定) を優先し、無ければ x-forwarded-host。いずれも
 *   trustedHostValue で厳格検証し、allowlist 外 (Host injection 等) なら resolveAppUrl()
 *   の canonical にフォールバックして token 流出を防ぐ。
 */
export function resolveRequestOrigin(request: { headers: Headers }): string {
  const h = request.headers
  const chosen = trustedHostValue(h.get('host')) ?? trustedHostValue(h.get('x-forwarded-host'))
  if (!chosen) return resolveAppUrl()

  // scheme は https/http allowlist のみ (Codex T1 HIGH fix: x-forwarded-proto 注入無効化)。
  // 本番は信頼 host が全て https-only のため常に https を強制する。
  let proto: 'https' | 'http'
  if (process.env.NODE_ENV === 'production') {
    proto = 'https'
  } else {
    const rawProto = (h.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? '').toLowerCase()
    proto = rawProto === 'https' ? 'https' : 'http'
  }

  return `${proto}://${chosen}`
}
