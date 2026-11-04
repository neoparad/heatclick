/**
 * CV定義 — 述語ビルダー (ルール → SQL述語のリポジトリ唯一の変換点)
 *
 * docs/cv/CV_DEFINITIONS_DESIGN.md §3
 *
 * 継承する実データ契約 (paths Sprint 4-B / cv-journey で確定した罠の集約点):
 *   1. conversion_type は event_type='click' 行に載る (event_type='conversion' は本番0件)。
 *      conversion 照合は event_type を固定せず ifNull(conversion_type,'') 単独一致。
 *   2. click トリガーは event_type IN ('click','rage_click','dead_click') の3種。
 *      _isDead は祖先5要素しか遡らないため、深いネストのアンカー内クリックは dead_click に
 *      再分類される (element_href は closest('a') で正しく載る)。'click' 単独だと
 *      「href に値があるのに CV 0件」の静かな失敗を再生産する (設計書 §3 レビューHIGH)。
 *   3. events の文字列列は Nullable。条件式は全て ifNull(...,'') で NULL-safe にする。
 *   4. ユーザー由来の値は全て {key:String} で query_params 束縛。式に直接埋め込まない。
 *      識別子 (列名) はこのファイル内の固定リテラルのみで、ユーザー入力から組み立てない。
 */

import { pathnameMatchSql, toPathnameForMatch } from '@/lib/paths/url-match'

import { normalizeCvHost } from './types'
import type { ClickConditions, CvScope, CvTrigger, UrlMatch } from './types'

/** 1定義の SQL 展開結果 (funnel-config.ts StepCondition と同形の契約) */
export interface CvPredicate {
  /** countIf / uniqExactIf に渡す条件式 (query_params 参照のみ。リテラル値を含めない) */
  expr: string
  /** expr が参照する query_params */
  params: Record<string, string>
  /** false = 未対応/不正条件 (数値を捏造せず降格。呼び出し側は集計から除外し warning 表示) */
  supported: boolean
  reason?: string
}

const PARAM_PREFIX_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

function unsupported(reason: string): CvPredicate {
  return { expr: '', params: {}, supported: false, reason }
}

/** 内部ビルダーの中間形 (式断片と params の積み上げ) */
interface Fragment {
  expr: string
  params: Record<string, string>
}

/**
 * UrlMatch → SQL 断片。
 * - exact:  正規化 pathname (paths 契約 = path(col) + 末尾スラッシュ除去) の完全一致
 * - prefix: 「そのパス自身 OR 配下」— `(<path> = {p} OR startsWith(<path>, {p_slash}))`。
 *           境界 '/' 付き prefix で '/products' が '/products-other' を誤一致しない
 * - contains: 生カラムの部分一致 (cv-journey position() 互換)
 * 正規化不能 (非http(s)スキーム等) は null を返し、呼び出し側が unsupported に降格する。
 */
function buildUrlMatchFragment(match: UrlMatch, column: 'url' | 'element_href', key: string): Fragment | null {
  if (match.mode === 'contains') {
    return {
      expr: `position(ifNull(${column}, ''), {${key}:String}) > 0`,
      params: { [key]: match.value },
    }
  }

  const pathname = toPathnameForMatch(match.path)
  if (pathname === null) return null
  const pathExpr = pathnameMatchSql(column)

  if (match.mode === 'exact') {
    return {
      expr: `${pathExpr} = {${key}:String}`,
      params: { [key]: pathname },
    }
  }

  // prefix: そのパス自身 OR '/' 境界付き配下
  const prefixWithSlash = pathname === '/' ? '/' : `${pathname}/`
  return {
    expr: `(${pathExpr} = {${key}:String} OR startsWith(${pathExpr}, {${key}_p:String}))`,
    params: { [key]: pathname, [`${key}_p`]: prefixWithSlash },
  }
}

function buildClickConditionFragments(
  conditions: ClickConditions,
  prefix: string,
): Fragment[] | { error: string } {
  const fragments: Fragment[] = []

  if (conditions.hrefHosts) {
    const hostParts: string[] = []
    const params: Record<string, string> = {}
    for (let i = 0; i < conditions.hrefHosts.length; i++) {
      const normalized = normalizeCvHost(conditions.hrefHosts[i])
      if (normalized === null) {
        return { error: `hrefHosts[${i}] がホスト名として不正です` }
      }
      const key = `${prefix}_h${i}`
      // suffix一致 (サブドメイン許容)。domain() の結果は小文字化して比較する
      hostParts.push(
        `(lower(domain(ifNull(element_href, ''))) = {${key}:String} OR endsWith(lower(domain(ifNull(element_href, ''))), concat('.', {${key}:String})))`,
      )
      params[key] = normalized
    }
    fragments.push({
      expr: hostParts.length === 1 ? hostParts[0] : `(${hostParts.join(' OR ')})`,
      params,
    })
  }

  if (conditions.hrefContains) {
    const key = `${prefix}_hc`
    fragments.push({
      expr: `position(ifNull(element_href, ''), {${key}:String}) > 0`,
      params: { [key]: conditions.hrefContains },
    })
  }

  if (conditions.hrefPath) {
    const fragment = buildUrlMatchFragment(conditions.hrefPath, 'element_href', `${prefix}_hp`)
    if (fragment === null) return { error: 'hrefPath のパスを正規化できません' }
    fragments.push(fragment)
  }

  if (conditions.elementId) {
    const key = `${prefix}_id`
    fragments.push({
      expr: `ifNull(element_id, '') = {${key}:String}`,
      params: { [key]: conditions.elementId },
    })
  }

  if (conditions.elementClassContains) {
    const key = `${prefix}_cls`
    fragments.push({
      expr: `position(ifNull(element_class_name, ''), {${key}:String}) > 0`,
      params: { [key]: conditions.elementClassContains },
    })
  }

  if (conditions.selector) {
    const key = `${prefix}_sel`
    fragments.push({
      expr: `ifNull(element_selector, '') = {${key}:String}`,
      params: { [key]: conditions.selector },
    })
  }

  if (conditions.textContains) {
    const key = `${prefix}_txt`
    fragments.push({
      expr: `position(ifNull(element_text, ''), {${key}:String}) > 0`,
      params: { [key]: conditions.textContains },
    })
  }

  if (conditions.pageUrl) {
    const fragment = buildUrlMatchFragment(conditions.pageUrl, 'url', `${prefix}_pg`)
    if (fragment === null) return { error: 'pageUrl のパスを正規化できません' }
    fragments.push(fragment)
  }

  return fragments
}

function buildScopeFragments(scope: CvScope, prefix: string): Fragment[] {
  const fragments: Fragment[] = []
  const mappings: Array<[value: string | undefined, column: string, suffix: string]> = [
    [scope.utmSource, 'utm_source', 'us'],
    [scope.utmMedium, 'utm_medium', 'um'],
    [scope.utmCampaign, 'utm_campaign', 'uc'],
    [scope.deviceType, 'device_type', 'dev'],
  ]
  for (const [value, column, suffix] of mappings) {
    if (!value) continue
    const key = `${prefix}_${suffix}`
    fragments.push({
      expr: `ifNull(${column}, '') = {${key}:String}`,
      params: { [key]: value },
    })
  }
  return fragments
}

function combineAnd(fragments: Fragment[]): Fragment {
  const params: Record<string, string> = {}
  for (const f of fragments) Object.assign(params, f.params)
  return { expr: fragments.map((f) => f.expr).join(' AND '), params }
}

/**
 * CV定義のトリガー + スコープを SQL 述語へ展開する (allowlist)。
 * paramPrefix は呼び出し側が定義ごとに一意に振る (例 'cv0', 'cv1', 'prev')。
 */
export function buildCvPredicate(
  input: { trigger: CvTrigger; scope?: CvScope },
  paramPrefix: string,
): CvPredicate {
  if (!PARAM_PREFIX_PATTERN.test(paramPrefix)) {
    throw new Error('buildCvPredicate: paramPrefix must be a simple identifier')
  }

  const { trigger, scope } = input
  const fragments: Fragment[] = []

  if (trigger.kind === 'page_reach') {
    const urlFragment = buildUrlMatchFragment(trigger.url, 'url', `${paramPrefix}_url`)
    if (urlFragment === null) return unsupported('page_reach: url のパスを正規化できません')
    fragments.push({ expr: `ifNull(event_type, '') IN ('pageview', 'virtual_pageview')`, params: {} })
    fragments.push(urlFragment)
  } else if (trigger.kind === 'click') {
    const conditionFragments = buildClickConditionFragments(trigger.conditions, paramPrefix)
    if ('error' in conditionFragments) return unsupported(`click: ${conditionFragments.error}`)
    if (conditionFragments.length === 0) {
      return unsupported('click: 条件が1つも指定されていません')
    }
    fragments.push({
      expr: `ifNull(event_type, '') IN ('click', 'rage_click', 'dead_click')`,
      params: {},
    })
    fragments.push(...conditionFragments)
  } else {
    // custom_event: conversion_type 単独一致 (event_type を固定しない — 罠1)
    const key = `${paramPrefix}_cv`
    fragments.push({
      expr: `ifNull(conversion_type, '') = {${key}:String}`,
      params: { [key]: trigger.conversionType },
    })
  }

  if (scope) fragments.push(...buildScopeFragments(scope, paramPrefix))

  const combined = combineAnd(fragments)
  return { expr: combined.expr, params: combined.params, supported: true }
}

/**
 * 消費側 (cv-journey / paths) 向けの cvKey 解決述語 — 和集合 (§2 設計判断)。
 * 「(定義の述語) OR (生 conversion_type = cvKey)」。
 * 定義が生イベントの上位互換になり、過去の生ビーコン計測分 (element_href の形が違う旧行) と
 * 時系列が不連続にならない。セッションユニーク集計なので二重計上もされない。
 * 定義の述語が unsupported の場合は生 conversion_type 一致のみに降格する (完全後方互換)。
 */
export function buildCvKeyResolutionPredicate(
  definition: { trigger: CvTrigger; scope?: CvScope; cvKey: string },
  paramPrefix: string,
): CvPredicate {
  if (!PARAM_PREFIX_PATTERN.test(paramPrefix)) {
    throw new Error('buildCvKeyResolutionPredicate: paramPrefix must be a simple identifier')
  }

  const rawKey = `${paramPrefix}_raw`
  const rawExpr = `ifNull(conversion_type, '') = {${rawKey}:String}`
  const rawParams = { [rawKey]: definition.cvKey }

  const predicate = buildCvPredicate(definition, paramPrefix)
  if (!predicate.supported) {
    return { expr: rawExpr, params: rawParams, supported: true, reason: predicate.reason }
  }

  return {
    expr: `((${predicate.expr}) OR ${rawExpr})`,
    params: { ...predicate.params, ...rawParams },
    supported: true,
  }
}
