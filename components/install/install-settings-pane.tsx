/**
 * InstallSettingsPane — 設定 / タグ設置 page の Client orchestrator (続 75 Task D)
 *
 * mockup `linkscrawl/docs/fusion/mockups/15_install_settings.html`
 * 親 SSOT §3.6.5 / §6.4 Sprint 1 S1-02
 *
 * 構成 (mockup 準拠):
 *   - Status banner (実 site の events 件数で green / warn 判定)
 *   - 5 tabs (タグ設置 active、他 4 つは Sprint 3 W2 で本接続 = disabled)
 *   - 2 column:
 *     Left  : Step 1 snippet + Step 2 install methods accordion + Step 3 verification
 *     Right : 計測サマリー (tracking_id + 7d page 件数等) + Phase 1 sites status
 *
 * Sprint 3 W2-A (続 75 範囲):
 *   - tracking script は実 tracking_id (server props 経由で渡される) で生成
 *   - 動作確認 button → /api/pages?site_id=<id> を fetch して 1 件以上返ればイベント流入 OK と判定
 *   - 各 site の status (last_event 推定 / 7d events) は `initialSiteStats` (server で /api/pages 経由で取得) を表示
 *   - site status row は `/install?site_id=` への Link (続128: サイト切替が無かったため追加)
 *
 * Sprint 3 W2 (続 76+ 想定):
 *   - 個人情報マスク / CV・目標設定 / アラート tab の本接続 (Infra schema 待ち)
 *   - Phase 1 site 一覧は `app/(proof)/install/page.tsx` の `PHASE1_SITES` 固定配列のまま
 *     (Sprint 3 W2-B で `clickinsight.sites` からの動的取得に切替予定)
 */

'use client'

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ChevronRight,
  Code2,
  Copy,
  Globe,
  Loader2,
  PlayCircle,
  Settings,
  ShoppingBag,
} from 'lucide-react'

export interface SiteStatus {
  siteId: string
  siteName: string
  /** 過去 7d で events が 1 件以上あったか */
  hasEvents: boolean
  /** 直近 7d で集計対象になっている page 数 (api/pages の返却件数) */
  pagesCount: number
  /** 取得時のエラー (null なら成功) */
  errorMessage?: string | null
}

interface InstallSettingsPaneProps {
  /** 現在の operator が選択中の site (Phase 1 = bihadashop.jp 固定)。 */
  activeSiteId: string
  activeSiteName: string
  /** P0-2 fix: tracking snippet に必須 (public/v2/tracking.js の tenant_id 必須化、未指定時は
   *  sendBeacon が無言で抑止される)。session (getServerSession) 由来、server から渡される。 */
  tenantId: string
  /** tracking.js script の host (env から server 経由で渡される) */
  trackingOrigin: string
  /** Phase 1 5 sites の初期 status (server で /api/pages を叩いた結果) */
  initialSiteStats: ReadonlyArray<SiteStatus>
}

const TABS = [
  { id: 'install' as const, label: 'タグ設置', enabled: true },
  { id: 'mask' as const, label: '個人情報マスク', enabled: false, hint: 'W2 配備予定' },
  { id: 'cv' as const, label: 'CV / 目標設定', enabled: false, hint: 'W2 配備予定' },
  { id: 'alerts' as const, label: 'アラート / 通知', enabled: false, hint: 'W2 配備予定' },
  { id: 'advanced' as const, label: '高度な設定', enabled: false, hint: 'W2 配備予定' },
]

type TabId = (typeof TABS)[number]['id']

// 続 75 Task D: mockup 15_install_settings.html の 5 install 手法 (Step 2)。
// 1 ロールの「方法」と一致する文字列を含むため、unit test は INSTALL_METHODS を
// 直接 grep して 'Google Tag Manager' / 'WordPress' / 'Shopify' / '手動設置' / 'Next.js' 等の
// 存在で配備完了を判定する。
export interface InstallMethodDef {
  id: string
  icon: React.ReactNode
  name: string
  sub: string
  recommended?: boolean
  detail: React.ReactNode
}

export const INSTALL_METHODS: InstallMethodDef[] = [
  {
    id: 'gtm',
    icon: <Settings className="h-3.5 w-3.5" aria-hidden />,
    name: 'Google Tag Manager',
    sub: '推奨・GTM 経由',
    recommended: true,
    detail: (
      <ol>
        <li>GTM 管理画面 → タグ → 新規 → 「カスタム HTML」</li>
        <li>上記のコードを貼り付け</li>
        <li>
          トリガー: <span className="mini-code">All Pages</span>
        </li>
        <li>保存 → 公開</li>
      </ol>
    ),
  },
  {
    id: 'wp',
    icon: <Code2 className="h-3.5 w-3.5" aria-hidden />,
    name: 'WordPress プラグイン',
    sub: 'Insert Headers and Footers 等',
    detail: (
      <ol>
        <li>WordPress 管理画面 → プラグイン → 新規追加</li>
        <li>「Insert Headers and Footers」をインストール → 有効化</li>
        <li>設定 → Insert Headers and Footers</li>
        <li>
          <span className="mini-code">Scripts in Header</span> に上記コード貼り付け → 保存
        </li>
      </ol>
    ),
  },
  {
    id: 'shopify',
    icon: <ShoppingBag className="h-3.5 w-3.5" aria-hidden />,
    name: 'Shopify',
    sub: 'テーマファイル theme.liquid',
    detail: (
      <ol>
        <li>Shopify 管理画面 → オンラインストア → テーマ → アクション → コードを編集</li>
        <li>
          <span className="mini-code">layout/theme.liquid</span> を開く
        </li>
        <li>{`<head>`} 直前に上記コードを貼り付け → 保存</li>
      </ol>
    ),
  },
  {
    id: 'manual',
    icon: <Globe className="h-3.5 w-3.5" aria-hidden />,
    name: '手動設置',
    sub: 'HTML の <head> に直接貼り付け',
    detail: (
      <ol>
        <li>サイトの HTML テンプレートを開く</li>
        <li>
          {`<head>`}{' '}...{' '}{`</head>`} の中 (なるべく上部) に上記コード貼り付け
        </li>
        <li>デプロイ → 動作確認</li>
      </ol>
    ),
  },
  {
    id: 'nextjs',
    icon: <Boxes className="h-3.5 w-3.5" aria-hidden />,
    name: 'Next.js / React',
    sub: 'next/script の Script コンポーネント',
    detail: (
      <ol>
        <li>
          <span className="mini-code">app/layout.tsx</span> または{' '}
          <span className="mini-code">pages/_app.tsx</span> を開く
        </li>
        <li>
          <span className="mini-code">
            {`<Script src="<origin>/v2/tracking.js" data-site-id="<site_id>" data-tenant-id="<tenant_id>" strategy="afterInteractive" />`}
          </span>{' '}
          を追加 (site_id / tenant_id は上部 Step 1 のタグと同じ値)
        </li>
        <li>
          data-tenant-id が無いと計測は無言で停止します。site_id / tenant_id は環境変数
          (例 <span className="mini-code">NEXT_PUBLIC_UGOKIMAP_SITE_ID</span> /{' '}
          <span className="mini-code">NEXT_PUBLIC_UGOKIMAP_TENANT_ID</span>) 経由で注入しても構いません
        </li>
      </ol>
    ),
  },
]

// 続 75 Task D: Step 3 の動作確認 verify rows (テンプレ、page-level state で動的化)
export interface VerifyRowDef {
  /** ok = 緑、warn = 黄、todo = 灰 */
  state: 'ok' | 'warn' | 'todo'
  title: string
  detail: React.ReactNode
}

// Issue ③ (2026-08): link-th.co.jp 本番で実際に発生した設置ミスの再発防止用定数。
// tracking.js の script タグは trackingOrigin (SaaS 側ホスト) から読み込まれるが、
// 実際のイベント計測ビーコン (sendBeacon/fetch) は別オリジンの Cloudflare Worker である
// この URL に直接送信される (public/v2/tracking.js:124 apiEndpoint 既定値)。
// 顧客が <script src> のホストだけを CSP script-src に許可し、この Worker origin を
// connect-src に追加し忘れる、というのが実際に起きた事故パターン。
const EVENT_INGEST_ORIGIN = 'https://ugokimap-event-ingest.linkth.workers.dev'

export const VERIFY_ROWS_TEMPLATE: VerifyRowDef[] = [
  {
    state: 'ok',
    title: 'tracking.js のロード確認',
    detail: '実 deploy 上では DevTools Network タブで `tracking.js` を確認します',
  },
  {
    state: 'ok',
    title: 'tracking_id の認識',
    detail: '受信側 ClickHouse events.site_id に CIP_* が記録されているか',
  },
  {
    state: 'ok',
    title: 'イベント受信',
    detail: '過去 7 日間で `/api/pages` が 1 件以上の URL を返すこと',
  },
  {
    state: 'warn',
    title: 'CSP (Content Security Policy)',
    detail:
      'script-src には tracking.js を読み込んでいるホストを、connect-src には同ホストに加えて ' +
      `${EVENT_INGEST_ORIGIN} (実際のイベント送信先 Worker) を追加してください。` +
      'script タグの src だけを見て connect-src への追加を忘れると、タグは読み込まれるのに ' +
      '計測イベントだけ CSP でブロックされます (link-th.co.jp で実際に発生した設置ミス)。',
  },
]

export function InstallSettingsPane({
  activeSiteId,
  activeSiteName,
  tenantId,
  trackingOrigin,
  initialSiteStats,
}: InstallSettingsPaneProps) {
  const [tab, setTab] = useState<TabId>('install')
  const [siteStats, setSiteStats] = useState<ReadonlyArray<SiteStatus>>(initialSiteStats)
  const [isProbing, setIsProbing] = useState(false)
  const [lastProbeAt, setLastProbeAt] = useState<Date | null>(null)

  const activeStat = useMemo(
    () => siteStats.find((s) => s.siteId === activeSiteId) ?? null,
    [siteStats, activeSiteId],
  )

  const probeEvents = useCallback(async () => {
    if (isProbing) return
    setIsProbing(true)
    try {
      const fresh: SiteStatus[] = []
      for (const s of siteStats) {
        try {
          const res = await fetch(`/api/pages?site_id=${encodeURIComponent(s.siteId)}`, {
            cache: 'no-store',
          })
          if (!res.ok) {
            fresh.push({
              ...s,
              hasEvents: false,
              pagesCount: 0,
              errorMessage: `HTTP_${res.status}`,
            })
            continue
          }
          const json = (await res.json()) as {
            success: boolean
            data?: Array<{ url: string; label: string }>
          }
          if (!json.success || !Array.isArray(json.data)) {
            fresh.push({
              ...s,
              hasEvents: false,
              pagesCount: 0,
              errorMessage: 'invalid_response',
            })
            continue
          }
          fresh.push({
            ...s,
            hasEvents: json.data.length > 0,
            pagesCount: json.data.length,
            errorMessage: null,
          })
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'network'
          fresh.push({
            ...s,
            hasEvents: false,
            pagesCount: 0,
            errorMessage: msg,
          })
        }
      }
      setSiteStats(fresh)
      setLastProbeAt(new Date())
    } finally {
      setIsProbing(false)
    }
  }, [isProbing, siteStats])

  const bannerVariant = activeStat?.hasEvents ? 'ok' : 'warn'
  const banner7dEvents = activeStat?.pagesCount ?? 0

  return (
    <div className="ug-page-scroll">
      <div className="ug-page-inner space-y-4">
        <header className="ug-page-head">
          <div className="sub">
            <span>
              <strong className="font-semibold text-[color:var(--ug-text)]">
                {activeSiteName}
              </strong>{' '}
              <span className="mono">{activeSiteId}</span>
            </span>
            <span className="mono">tracking script host: {trackingOrigin}</span>
          </div>
        </header>

        <StatusBanner
          variant={bannerVariant}
          activeSiteName={activeSiteName}
          pagesCount={banner7dEvents}
          lastProbeAt={lastProbeAt}
          isProbing={isProbing}
          onProbe={probeEvents}
          errorMessage={activeStat?.errorMessage ?? null}
        />

        <div className="ug-st-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`ug-st-tab${tab === t.id ? ' active' : ''}`}
              disabled={!t.enabled}
              title={t.hint}
              onClick={() => t.enabled && setTab(t.id)}
            >
              {t.label}
              {!t.enabled ? <span className="pill">W2</span> : null}
            </button>
          ))}
        </div>

        <div className="ug-st-grid">
          <div>
            <StepOneSnippet
              siteId={activeSiteId}
              tenantId={tenantId}
              trackingOrigin={trackingOrigin}
            />
            <StepTwoInstallMethods />
            <StepThreeVerify activeStat={activeStat} trackingOrigin={trackingOrigin} />
          </div>
          <div>
            <TrackingSummaryCard activeStat={activeStat} />
            <SitesStatusCard
              siteStats={siteStats}
              activeSiteId={activeSiteId}
              isProbing={isProbing}
              onProbe={probeEvents}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function formatRelative(d: Date | null): string {
  if (!d) return '未実行'
  const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000))
  if (diffSec < 60) return `${diffSec} 秒前`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分前`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 時間前`
  return `${Math.floor(diffSec / 86400)} 日前`
}

function StatusBanner({
  variant,
  activeSiteName,
  pagesCount,
  lastProbeAt,
  isProbing,
  onProbe,
  errorMessage,
}: {
  variant: 'ok' | 'warn'
  activeSiteName: string
  pagesCount: number
  lastProbeAt: Date | null
  isProbing: boolean
  onProbe: () => void
  errorMessage: string | null
}) {
  return (
    <div className={`ug-st-banner${variant === 'warn' ? ' warn' : ''}`} role="status">
      <div className="ic">
        {variant === 'ok' ? (
          <CheckCircle2 className="h-5 w-5" aria-hidden />
        ) : (
          <AlertTriangle className="h-5 w-5" aria-hidden />
        )}
      </div>
      <div>
        {variant === 'ok' ? (
          <>
            <h3>計測タグは正常に動作中</h3>
            <div className="body">
              <span className="pulse">最終確認: {formatRelative(lastProbeAt)}</span>
              {' · '}
              <b>{activeSiteName}</b> で過去 7 日間 <b>{pagesCount}</b> URL のイベント受信を確認
              {errorMessage ? (
                <>
                  {' '}·{' '}
                  <span style={{ color: 'var(--ug-yellow)' }}>注: {errorMessage}</span>
                </>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <h3>計測イベントが確認できません</h3>
            <div className="body">
              <b>{activeSiteName}</b> から過去 7 日間のイベントが流入していません。
              {errorMessage ? (
                <>
                  {' '}エラー:{' '}
                  <span className="mono" style={{ color: 'var(--ug-red)' }}>{errorMessage}</span>
                </>
              ) : (
                ' タグが正しく設置されているか、または tracking.js が読み込まれているか確認してください。'
              )}
            </div>
          </>
        )}
      </div>
      <div>
        <button
          type="button"
          className="ug-st-action-btn"
          onClick={onProbe}
          disabled={isProbing}
          aria-label="動作確認を実行"
        >
          {isProbing ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> 確認中...
            </>
          ) : (
            <>
              <PlayCircle className="h-3.5 w-3.5" aria-hidden /> 動作確認を実行
            </>
          )}
        </button>
      </div>
    </div>
  )
}

function StepOneSnippet({
  siteId,
  tenantId,
  trackingOrigin,
}: {
  siteId: string
  tenantId: string
  trackingOrigin: string
}) {
  const [copied, setCopied] = useState(false)
  // P0-2 fix (independent review 2026-07-11): tenant_id 欠落で tracking.js が全 event を
  // 無言で抑止していた (public/v2/tracking.js:136)。window.CLICKINSIGHT_TENANT_ID を追加。
  const snippet = useMemo(
    () =>
      `<!-- UGOKI MAP Tracking -->\n` +
      `<script>\n` +
      `  window.CLICKINSIGHT_SITE_ID = '${siteId}';\n` +
      `  window.CLICKINSIGHT_TENANT_ID = '${tenantId}';\n` +
      `  window.CLICKINSIGHT_DEBUG = false;\n` +
      `</script>\n` +
      `<script src="${trackingOrigin}/v2/tracking.js" async></script>`,
    [siteId, tenantId, trackingOrigin],
  )

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(snippet)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      // ignore — user can select manually
    }
  }, [snippet])

  // P0-2 fix: tenantId 欠落 (session 取得失敗等) で壊れたタグを無警告でコピーさせない。
  // tracking.js は tenant_id 空だと sendBeacon を無言で抑止するため (:136)、
  // コピー自体をブロックし再読込を促す。
  const tenantMissing = tenantId === ''

  const handleCopyId = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(siteId)
    } catch {
      // ignore
    }
  }, [siteId])

  return (
    <div className="ug-st-card">
      <div className="ug-st-card-h done">
        <div className="num">1</div>
        <h3>JS タグを取得</h3>
        <span className="status done">準備完了</span>
      </div>
      <div className="ug-st-tracking-id-box">
        <span className="lbl">tracking_id</span>
        <span className="id">{siteId}</span>
        <button type="button" className="copy" onClick={handleCopyId}>
          <Copy className="h-3 w-3" aria-hidden /> ID コピー
        </button>
      </div>
      {tenantMissing ? (
        <div className="ug-st-banner warn" role="status">
          <div className="ic">
            <AlertTriangle className="h-5 w-5" aria-hidden />
          </div>
          <div>
            セッション情報の取得に失敗したため、タグを生成できません。ページを再読み込みしてから再度お試しください
            (このまま設置すると計測が行われません)。
          </div>
        </div>
      ) : null}
      <div style={{ position: 'relative' }}>
        <pre className="ug-st-code-block">
          <code>{snippet}</code>
        </pre>
        <button
          type="button"
          className="ug-st-code-copy"
          onClick={handleCopy}
          disabled={tenantMissing}
        >
          <Copy className="h-2.5 w-2.5" aria-hidden /> {copied ? 'コピー済' : 'コードコピー'}
        </button>
      </div>
    </div>
  )
}

function StepTwoInstallMethods() {
  const [openId, setOpenId] = useState<string>('gtm')

  return (
    <div className="ug-st-card">
      <div className="ug-st-card-h done">
        <div className="num">2</div>
        <h3>サイトに設置</h3>
        <span className="status doing">ガイド</span>
      </div>
      <div className="ug-st-im-list">
        {INSTALL_METHODS.map((m) => {
          const isOpen = openId === m.id
          return (
            <button
              key={m.id}
              type="button"
              className={`ug-st-im-row${isOpen ? ' open' : ''}`}
              onClick={() => setOpenId(isOpen ? '' : m.id)}
              aria-expanded={isOpen}
            >
              <div className="ug-st-im-head">
                <div className="icon">{m.icon}</div>
                <div className="name">
                  {m.name} <span className="sub">{m.sub}</span>
                </div>
                {m.recommended ? <span className="rec">RECOMMENDED</span> : null}
                <ChevronRight
                  className="h-3 w-3"
                  aria-hidden
                  style={{
                    color: 'var(--ug-text-3)',
                    transition: 'transform .15s',
                    transform: isOpen ? 'rotate(90deg)' : 'rotate(0)',
                  }}
                />
              </div>
              {isOpen ? <div className="ug-st-im-detail">{m.detail}</div> : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function StepThreeVerify({
  activeStat,
  trackingOrigin,
}: {
  activeStat: SiteStatus | null
  trackingOrigin: string
}) {
  const hasEvents = activeStat?.hasEvents === true
  // Template に動的 active site 情報を merge
  const rows: VerifyRowDef[] = [
    {
      state: hasEvents ? 'ok' : 'todo',
      title: 'tracking.js のロード確認',
      detail:
        '実 deploy 上では DevTools Network タブで `tracking.js` を確認します。' +
        '(本ローカル UI からは確認不可、Owner 環境で要 manual verify)',
    },
    {
      state: hasEvents ? 'ok' : 'todo',
      title: 'tracking_id の認識',
      detail: (
        <>
          受信側 ClickHouse <span className="mono">events.site_id</span> に
          <span className="mono"> {activeStat?.siteId ?? '...'} </span>
          が記録されているか
        </>
      ),
    },
    {
      state: hasEvents ? 'ok' : 'todo',
      title: 'イベント受信',
      detail: hasEvents
        ? `過去 7 日間で ${activeStat?.pagesCount ?? 0} URL のイベント受信を確認`
        : '過去 7 日間で `/api/pages` が 1 件以上の URL を返すこと',
    },
    {
      state: 'warn',
      title: 'CSP (Content Security Policy)',
      detail: (
        <>
          script タグの読み込み元と、実際のイベント送信先は別ホストです。両方を CSP に追加してください:{' '}
          <span className="mono">script-src {trackingOrigin}</span>
          {' / '}
          <span className="mono">
            connect-src {trackingOrigin} {EVENT_INGEST_ORIGIN}
          </span>
          。タグの src は {trackingOrigin} を指していますが、sendBeacon / fetch で送信される計測
          イベントは別オリジンの Cloudflare Worker ({EVENT_INGEST_ORIGIN}) へ直接届きます。
          connect-src にこの Worker のオリジンを追加し忘れると、タグ自体は正常に読み込まれるのに
          送信だけ CSP にブロックされ、計測が止まっていることに気づきにくくなります
          (link-th.co.jp の本番環境で実際に発生した設置ミスです)。
        </>
      ),
    },
  ]

  return (
    <div className="ug-st-card">
      <div className="ug-st-card-h done">
        <div className="num">3</div>
        <h3>動作確認</h3>
        <span className={`status ${hasEvents ? 'done' : 'todo'}`}>
          {hasEvents ? '受信確認済' : '要確認'}
        </span>
      </div>
      <div>
        {rows.map((r, idx) => {
          return (
            <div key={idx} className="ug-st-verify-row">
              <div className={`ic ${r.state}`}>
                {r.state === 'ok' ? (
                  <CheckCircle2 className="h-3 w-3" aria-hidden />
                ) : r.state === 'warn' ? (
                  <AlertTriangle className="h-3 w-3" aria-hidden />
                ) : (
                  <span style={{ fontSize: 12, fontWeight: 700 }}>?</span>
                )}
              </div>
              <div>
                <div className="t">{r.title}</div>
                <div className="d">{r.detail}</div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TrackingSummaryCard({ activeStat }: { activeStat: SiteStatus | null }) {
  return (
    <div className="ug-st-side-panel">
      <h4>計測サマリー (現在の選択 site)</h4>
      <div className="kv">
        <span className="k">tracking_id</span>
        <span className="v">{activeStat?.siteId ?? '—'}</span>
      </div>
      <div className="kv">
        <span className="k">過去 7d で計測中の URL 数</span>
        <span className={`v ${activeStat?.hasEvents ? 'ok' : 'warn'}`}>
          {activeStat?.pagesCount ?? 0}
        </span>
      </div>
      <div className="kv">
        <span className="k">最終受信</span>
        <span className={`v ${activeStat?.hasEvents ? 'ok' : 'warn'}`}>
          {activeStat?.hasEvents ? '7d 以内' : '未受信'}
        </span>
      </div>
      <div className="kv">
        <span className="k">PII マスク (CSS selector)</span>
        <span className="v warn">W2 配備予定</span>
      </div>
      <div className="kv">
        <span className="k">CSP 設定</span>
        <span className="v warn">推奨適用</span>
      </div>
    </div>
  )
}

function SitesStatusCard({
  siteStats,
  activeSiteId,
  isProbing,
  onProbe,
}: {
  siteStats: ReadonlyArray<SiteStatus>
  activeSiteId: string
  isProbing: boolean
  onProbe: () => void
}) {
  return (
    <div className="ug-st-side-panel">
      <h4>Phase 1 {siteStats.length} sites tracking 状況</h4>
      <div>
        {siteStats.map((s) => {
          const dotClass = s.errorMessage ? 'crit' : s.hasEvents ? '' : 'warn'
          return (
            <Link
              href={`/install?site_id=${encodeURIComponent(s.siteId)}`}
              className="ug-st-site-row"
              style={{ textDecoration: 'none', color: 'inherit', cursor: 'pointer' }}
              key={s.siteId}
            >
              <span className={`dot ${dotClass}`} />
              <div className="meta">
                <div className="name">
                  {s.siteName}
                  {s.siteId === activeSiteId ? (
                    <span
                      style={{
                        marginLeft: 6,
                        fontFamily: 'var(--font-mono, monospace)',
                        fontSize: 9.5,
                        color: 'var(--ug-brand-1)',
                        fontWeight: 600,
                      }}
                    >
                      active
                    </span>
                  ) : null}
                </div>
                <div className="id">{s.siteId}</div>
              </div>
              <div className="stat">
                {s.errorMessage ? (
                  <span style={{ color: 'var(--ug-red)' }}>{s.errorMessage}</span>
                ) : (
                  <>
                    <b>{s.pagesCount}</b> URL / 7d
                  </>
                )}
              </div>
              {s.siteId === activeSiteId ? null : (
                <ChevronRight className="switch-hint h-3.5 w-3.5" aria-hidden />
              )}
            </Link>
          )
        })}
      </div>
      <button
        type="button"
        className="ug-st-action-btn"
        style={{ marginTop: 10, width: '100%', justifyContent: 'center' }}
        onClick={onProbe}
        disabled={isProbing}
      >
        {isProbing ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> 確認中...
          </>
        ) : (
          <>
            <PlayCircle className="h-3.5 w-3.5" aria-hidden /> 全 site の動作確認を実行
          </>
        )}
      </button>
    </div>
  )
}
