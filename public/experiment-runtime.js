/**
 * experiment-runtime.js — 宝プロジェクト M6 (標準実験の mechanical レンダリング)
 *
 * 顧客サイトに 1 行で読み込む単独 runtime (Owner 承認 Option A、2026-06-11):
 *   <script async src="https://<app>/experiment-runtime.js"
 *           data-tenant="TENANT_ID" data-site="SITE_ID" data-api="https://<app>"></script>
 *
 * 設計 (scenario-runtime.js / tracking.js / banner worker には一切触れない = 衝突ゼロ):
 *   - visitor_id は tracking.js v2 が発行する __ugk_vid cookie を読むだけ (無ければ何もしない)。
 *   - GET /api/experiments/assign が返す **server-arm** に従う。クライアントで arm を計算しない
 *     (salt はサーバーのみ。計測 (M3) も同関数で arm を再計算するため、改竄しても計測は歪まない)。
 *   - treatment のみ DOM 操作。**任意 HTML は一切注入しない** — 既存要素の移動 / クローン /
 *     表示切替のみ (banner と異なり XSS 面を構造的に持たない)。
 *       cta_placement       : 対象 CTA (アンカー) をファーストビュー先頭へクローン挿入
 *       sticky_cta_mobile   : モバイル幅のみ、固定ボトムバーに CTA リンクを複製
 *       form_field_reduction: 指定 selector の任意項目を非表示 ([required] を含む要素は安全のため skip)
 *   - 失敗は全て黙って no-op (顧客サイトを壊さない)。冪等 (data-ugk-exp 属性ガード)。
 *
 * テスト: 純関数 (pathMatches / pickApplicable / isSafeSelector) は module.exports 経由で
 * jest から検証 (experiment-runtime.test.js)。DOM 操作部は dogfood 実機で検証。
 */
;(function () {
  'use strict'

  var COOKIE_NAME = '__ugk_vid'
  var APPLIED_ATTR = 'data-ugk-exp'
  var MAX_FIELD_SELECTORS = 20

  // ── 純関数 (jest 対象) ────────────────────────────────────────────────────

  /** サーバー (arm-stats / listActiveForAssignment) と同じ subtree 一致セマンティクス。 */
  function pathMatches(pathname, pattern) {
    if (typeof pathname !== 'string' || typeof pattern !== 'string' || pattern === '') return false
    if (pattern === '/') return true
    return pathname === pattern || pathname.indexOf(pattern + '/') === 0
  }

  /** 現在 path に適用すべき treatment レンダリング指示のみ抽出。 */
  function pickApplicable(assignments, pathname) {
    var out = []
    if (!assignments || typeof assignments.length !== 'number') return out
    for (var i = 0; i < assignments.length; i++) {
      var a = assignments[i]
      if (!a || a.arm !== 'treatment' || !a.render || !a.render.config) continue
      if (!pathMatches(pathname, a.url_pattern)) continue
      out.push(a)
    }
    return out
  }

  /** selector の最低限の hygiene (長さ・型のみ。querySelector は try/catch で包む)。 */
  function isSafeSelector(sel) {
    return typeof sel === 'string' && sel.length > 0 && sel.length <= 256
  }

  /**
   * CTA として複製してよい href か (Codex M6 MEDIUM: javascript:/data: 等の script-bearing
   * リンクを first view / sticky へ「昇格」させない)。相対 URL / http(s) / # アンカーのみ許可。
   */
  function isSafeHref(href) {
    if (typeof href !== 'string' || href.length === 0 || href.length > 2048) return false
    // 空白・制御文字 (0x00-0x20) を除去してから判定 (scheme 分断対策)
    var h = href.replace(/[\x00-\x20]+/g, '').toLowerCase()
    if (h.indexOf('javascript:') === 0 || h.indexOf('data:') === 0 || h.indexOf('vbscript:') === 0) {
      return false
    }
    return (
      h.indexOf('https://') === 0 ||
      h.indexOf('http://') === 0 ||
      h.charAt(0) === '/' ||
      h.charAt(0) === '#' ||
      h.charAt(0) === '?' ||
      h.indexOf(':') === -1 // scheme なし相対 (e.g. 'page.html')
    )
  }

  // ── DOM helpers (注入なし: createElement + textContent / 既存要素操作のみ) ──

  function qs(sel) {
    if (!isSafeSelector(sel)) return null
    try {
      return document.querySelector(sel)
    } catch (e) {
      return null
    }
  }

  function alreadyApplied(experimentId) {
    return !!document.querySelector('[' + APPLIED_ATTR + '="' + experimentId + '"]')
  }

  /**
   * 対象 CTA から安全な複製リンクを作る (Codex M6 MEDIUM: cloneNode(true) は inline on* /
   * script 子孫 / javascript: href を引き継ぐため **使わない**)。createElement + textContent +
   * 検証済み href + className 文字列コピーのみ — active content は一切引き継がない。
   */
  function buildSafeCtaLink(el) {
    if (!el || el.tagName !== 'A') return null
    var href = el.getAttribute('href')
    if (!isSafeHref(href)) return null
    var link = document.createElement('a')
    link.href = href
    link.textContent = (el.textContent || '').trim() || href
    link.className = el.className || '' // class 文字列はマークアップにならない (site の CTA スタイル継承)
    return link
  }

  /** cta_placement: 安全な複製リンクをファーストビュー先頭 (h1 直後 or main/body 先頭) に挿入。 */
  function applyCtaPlacement(experimentId, config) {
    var link = buildSafeCtaLink(qs(config.cta_selector))
    if (!link) return false
    link.setAttribute(APPLIED_ATTR, experimentId)
    link.style.display = 'inline-block'
    link.style.margin = '12px 0'
    var h1 = document.querySelector('h1')
    if (h1 && h1.parentNode) {
      h1.parentNode.insertBefore(link, h1.nextSibling)
      return true
    }
    var host = document.querySelector('main') || document.body
    if (!host) return false
    host.insertBefore(link, host.firstChild)
    return true
  }

  /** sticky_cta_mobile: モバイル幅のみ。固定ボトムバー + 安全な複製リンク。 */
  function applyStickyCtaMobile(experimentId, config) {
    if (window.innerWidth > 768) return false
    var link = buildSafeCtaLink(qs(config.cta_selector))
    if (!link) return false
    var bar = document.createElement('div')
    bar.setAttribute(APPLIED_ATTR, experimentId)
    bar.style.cssText =
      'position:fixed;bottom:0;left:0;right:0;z-index:2147483000;padding:10px 16px;' +
      'background:#ffffff;box-shadow:0 -2px 12px rgba(0,0,0,0.15);text-align:center;'
    link.className = '' // sticky バーは自前スタイルで統一 (site class は持ち込まない)
    link.style.cssText =
      'display:block;padding:12px;background:#111111;color:#ffffff;border-radius:8px;' +
      'font-size:15px;font-weight:600;text-decoration:none;'
    bar.appendChild(link)
    if (!document.body) return false
    document.body.appendChild(bar)
    return true
  }

  /**
   * required を含む要素か (Codex M6 LOW: attribute だけでなく :required 疑似クラスと
   * DOM property も見る — JS で required を立てるフォームライブラリ対策)。
   */
  function containsRequired(el) {
    try {
      if (el.matches && (el.matches('[required]') || el.matches(':required'))) return true
      if (el.querySelector && (el.querySelector('[required]') || el.querySelector(':required'))) {
        return true
      }
      if (el.required === true) return true
      if (el.querySelectorAll) {
        var controls = el.querySelectorAll('input, select, textarea')
        for (var i = 0; i < controls.length; i++) {
          if (controls[i].required === true) return true
        }
      }
      return false
    } catch (e) {
      return true // 判定不能なら安全側 (隠さない)
    }
  }

  /** form_field_reduction: 任意項目を非表示。required を含む要素は安全のため skip。 */
  function applyFormFieldReduction(experimentId, config) {
    var sels = config.field_selectors
    if (!sels || typeof sels.length !== 'number') return false
    var appliedAny = false
    var n = Math.min(sels.length, MAX_FIELD_SELECTORS)
    for (var i = 0; i < n; i++) {
      var el = qs(sels[i])
      if (!el) continue
      // required フィールドを隠すとフォームが壊れる — 構造ガードとして必ず skip。
      if (containsRequired(el)) continue
      el.style.display = 'none'
      el.setAttribute(APPLIED_ATTR, experimentId)
      appliedAny = true
    }
    return appliedAny
  }

  function applyAssignment(a) {
    try {
      if (alreadyApplied(a.experiment_id)) return
      var kind = a.render.config.kind
      var type = a.render.intervention_type
      if (kind === 'cta' && type === 'cta_placement') {
        applyCtaPlacement(a.experiment_id, a.render.config)
      } else if (kind === 'cta' && type === 'sticky_cta_mobile') {
        applyStickyCtaMobile(a.experiment_id, a.render.config)
      } else if (kind === 'form_fields' && type === 'form_field_reduction') {
        applyFormFieldReduction(a.experiment_id, a.render.config)
      }
    } catch (e) {
      // 顧客サイトを絶対に壊さない: 個別適用の失敗は黙って無視
    }
  }

  // ── bootstrap ────────────────────────────────────────────────────────────

  function readCookie(name) {
    var parts = ('; ' + document.cookie).split('; ' + name + '=')
    if (parts.length === 2) return parts.pop().split(';').shift()
    return null
  }

  function currentScript() {
    if (document.currentScript) return document.currentScript
    var scripts = document.getElementsByTagName('script')
    for (var i = scripts.length - 1; i >= 0; i--) {
      var src = scripts[i].getAttribute('src') || ''
      if (src.indexOf('experiment-runtime') !== -1) return scripts[i]
    }
    return null
  }

  function start() {
    var script = currentScript()
    if (!script) return
    var tenant = script.getAttribute('data-tenant')
    var site = script.getAttribute('data-site')
    if (!tenant || !site) return
    var api = script.getAttribute('data-api') || ''
    if (!api) {
      var m = (script.getAttribute('src') || '').match(/^(https?:\/\/[^/]+)/)
      if (!m) return
      api = m[1]
    }
    var vid = readCookie(COOKIE_NAME)
    if (!vid) return // tracking.js 未稼働 / 同意前は何もしない

    var url =
      api +
      '/api/experiments/assign?tenant_id=' +
      encodeURIComponent(tenant) +
      '&site_id=' +
      encodeURIComponent(site) +
      '&visitor_id=' +
      encodeURIComponent(vid)

    fetch(url, { credentials: 'omit', mode: 'cors' })
      .then(function (r) {
        return r.ok ? r.json() : null
      })
      .then(function (j) {
        if (!j || !j.assignments) return
        var applicable = pickApplicable(j.assignments, window.location.pathname)
        for (var i = 0; i < applicable.length; i++) applyAssignment(applicable[i])
      })
      .catch(function () {
        // ネットワーク失敗は no-op
      })
  }

  // jest (node) からは純関数のみ公開。browser では即起動。
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      pathMatches: pathMatches,
      pickApplicable: pickApplicable,
      isSafeSelector: isSafeSelector,
      isSafeHref: isSafeHref,
    }
  } else if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start)
    } else {
      start()
    }
  }
})()
