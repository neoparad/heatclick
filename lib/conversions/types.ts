/**
 * CV定義 (Conversion Definitions) — データモデル層 (Zod allowlist)
 *
 * docs/cv/CV_DEFINITIONS_DESIGN.md §2
 *
 * 「どのユーザー行動をCVと数えるか」を顧客が管理画面で定義するルール。
 * トリガー型 (ページ到達 / クリック / カスタムイベント) + 複合マッチ条件 + スコープ + ラベル。
 * 値は全て query_params で束縛して SQL 展開する (predicate.ts が唯一の変換点)。
 *
 * 設計判断 (§2):
 *   - cvKey = 仮想 conversion_type。消費側 (cv-journey / paths) は
 *     「(定義の述語) OR ifNull(conversion_type,'') = cvKey」の和集合で解決し、
 *     過去の生ビーコン計測分と時系列が不連続にならないことを保証する。
 *   - ClickConditions は最低1・最大6条件 (AND)。hrefHosts のみフィールド内 OR (最大8ホスト)。
 *   - 上限ガード: 1サイト最大50定義 (repository 層で enforce)。
 */

import { z } from 'zod'

import { toPathnameForMatch } from '@/lib/paths/url-match'

export const CV_KEY_PATTERN = /^[a-z0-9_]{1,64}$/
export const TENANT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
export const SITE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** 1サイトあたりの定義数上限 (DoS/コスト有界化、repository で enforce) */
export const MAX_CV_DEFINITIONS_PER_SITE = 50

/**
 * ホスト名を suffix 一致用に正規化する。
 * 小文字化 + 先頭ドット除去。ホスト名として不正なら null (schema/predicate 両方で使う)。
 */
export function normalizeCvHost(host: string): string | null {
  const trimmed = host.trim().toLowerCase().replace(/^\.+/, '')
  if (!trimmed || trimmed.length > 253) return null
  // ラベル1-63文字・英数字とハイフン・ドット区切り2ラベル以上 (example.com)
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(trimmed)) {
    return null
  }
  return trimmed
}

/**
 * URL照合。pathname は paths の正規化契約 (path(url) + 末尾スラッシュ除去) を共有する。
 * - exact:  正規化 pathname の完全一致
 * - prefix: 「そのパス自身 OR 配下」(例 '/thanks' は '/thanks' と '/thanks/xyz' の両方に一致。
 *           '/products' が '/products-other' を誤一致しないよう境界は '/' 付き prefix で束縛)
 * - contains: 生カラムの部分一致 (cv-journey の position() 互換)
 */
export const urlMatchSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('exact'), path: z.string().min(1).max(300) }),
  z.object({ mode: z.literal('prefix'), path: z.string().min(1).max(300) }),
  z.object({ mode: z.literal('contains'), value: z.string().min(1).max(300) }),
])

function assertPathNormalizable(
  match: z.infer<typeof urlMatchSchema>,
  ctx: z.RefinementCtx,
  label: string,
): void {
  if (match.mode === 'contains') return
  if (toPathnameForMatch(match.path) === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${label}: '/' 始まりのパスまたは http(s) 絶対URLを指定してください`,
    })
  }
}

/**
 * クリック条件 (指定したものが AND、最低1・最大6条件)。
 *
 * ⚠計測契約 (§2 / UIヘルプ文言に必須):
 *   - element_href は最寄りアンカー遡及あり (el.closest('a')) — 子要素クリックでも拾う。堅牢。
 *   - elementId / selector / elementClassContains / textContains は e.target (実クリック要素)
 *     自身の値 — 子要素クリックは不一致になり得る。href 系を主条件に推奨。
 *   - element_text の PII サニタイズは utils 拡張ロード時のみ (サイト構成依存)。
 */
export const clickConditionsSchema = z
  .object({
    /** リンク先ホスト群 (フィールド内OR・suffix一致: 'rakuten.co.jp' は 'a.rakuten.co.jp' も拾う) */
    hrefHosts: z.array(z.string().min(1).max(253)).min(1).max(8).optional(),
    /** element_href の生部分一致 (tel:/mailto:/クエリ内アフィリID用) */
    hrefContains: z.string().min(1).max(256).optional(),
    /** リンク先パス (内部遷移CVはこれ) */
    hrefPath: urlMatchSchema.optional(),
    /** ボタン/要素の id 完全一致 */
    elementId: z.string().min(1).max(256).optional(),
    elementClassContains: z.string().min(1).max(256).optional(),
    /** element_selector 完全一致 */
    selector: z.string().min(1).max(300).optional(),
    /** 要素テキスト部分一致 */
    textContains: z.string().min(1).max(200).optional(),
    /** どのページ上のクリックか */
    pageUrl: urlMatchSchema.optional(),
  })
  .superRefine((conditions, ctx) => {
    const present = Object.values(conditions).filter((v) => v !== undefined)
    if (present.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'クリック条件は最低1つ指定してください',
      })
    }
    if (present.length > 6) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'クリック条件は最大6つまでです',
      })
    }
    if (conditions.hrefHosts) {
      for (const host of conditions.hrefHosts) {
        if (normalizeCvHost(host) === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `hrefHosts: '${host.slice(0, 80)}' はホスト名として不正です`,
          })
        }
      }
    }
    if (conditions.hrefPath) assertPathNormalizable(conditions.hrefPath, ctx, 'hrefPath')
    if (conditions.pageUrl) assertPathNormalizable(conditions.pageUrl, ctx, 'pageUrl')
  })

/**
 * トリガー: 「何が起きたらCVか」
 * ⚠ discriminatedUnion のオプションは ZodObject 必須のため、page_reach のパス検証は
 *   union 全体の superRefine で行う (オプション個別に .superRefine すると zod が throw する)。
 */
export const cvTriggerSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('page_reach'), url: urlMatchSchema }),
    z.object({ kind: z.literal('click'), conditions: clickConditionsSchema }),
    /** 既存 trackConversion / GA4 hook が送る conversion_type の参照 */
    z.object({ kind: z.literal('custom_event'), conversionType: z.string().min(1).max(100) }),
    // Phase 2: form_submit (form_interactions テーブル対応が必要 — §1.2)
  ])
  .superRefine((trigger, ctx) => {
    if (trigger.kind === 'page_reach') assertPathNormalizable(trigger.url, ctx, 'url')
  })

/**
 * スコープ (追加AND条件)。
 * ⚠UTM は「イベント行に載ったUTM」への一致 = 実質ランディングページ上のイベントに限る。
 * セッションレベル帰属 (UTM流入セッションの後続CV) は Phase 2 (§2 計測契約)。
 */
export const cvScopeSchema = z.object({
  utmSource: z.string().min(1).max(200).optional(),
  utmMedium: z.string().min(1).max(200).optional(),
  utmCampaign: z.string().min(1).max(200).optional(),
  deviceType: z.enum(['desktop', 'mobile', 'tablet']).optional(),
})

export const cvValueSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('fixed'), amount: z.number().finite().min(0).max(99_999_999) }),
])

export const cvDefinitionSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().regex(TENANT_ID_PATTERN),
  site_id: z.string().regex(SITE_ID_PATTERN),
  /** 表示名 例: '楽天アフィリ送客' */
  name: z.string().min(1).max(80),
  /**
   * 集計キー (conversion_type と同じ名前空間)。消費側は
   * 「定義の述語 OR 生 conversion_type 一致」の和集合で解決する (§2)。
   */
  cvKey: z.string().regex(CV_KEY_PATTERN, 'cvKey は ^[a-z0-9_]{1,64}$'),
  description: z.string().max(500).optional(),
  /** 無効化しても定義は残る (集計から除外) */
  enabled: z.boolean(),
  trigger: cvTriggerSchema,
  scope: cvScopeSchema.optional(),
  value: cvValueSchema.default({ mode: 'none' }),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  /**
   * best-effort 楽観ロック。Cloudflare KV に CAS が無いため read 時 version 不一致→409 の
   * best-effort であり、書込競合窓は許容 (§2 設計判断)。
   */
  version: z.number().int().min(1),
})

/** 作成/更新入力 (数値・集計結果は受け取らない。id/tenant/site/日時/version はサーバが管理) */
export const createCvDefinitionBodySchema = z.object({
  name: z.string().min(1).max(80),
  cvKey: z.string().regex(CV_KEY_PATTERN, 'cvKey は ^[a-z0-9_]{1,64}$'),
  description: z.string().max(500).optional(),
  enabled: z.boolean().default(true),
  trigger: cvTriggerSchema,
  scope: cvScopeSchema.optional(),
  value: cvValueSchema.default({ mode: 'none' }),
})

export type UrlMatch = z.infer<typeof urlMatchSchema>
export type ClickConditions = z.infer<typeof clickConditionsSchema>
export type CvTrigger = z.infer<typeof cvTriggerSchema>
export type CvScope = z.infer<typeof cvScopeSchema>
export type CvValue = z.infer<typeof cvValueSchema>
export type CvDefinition = z.infer<typeof cvDefinitionSchema>
export type CreateCvDefinitionBody = z.infer<typeof createCvDefinitionBodySchema>
