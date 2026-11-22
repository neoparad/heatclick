import {
  COMMON_INPUT_PATH_PATTERNS,
  DEFAULT_NOISE_EXACT_PARAMS,
  LENGTH_BUCKET_TOKENS,
  PII_SCRUB_TOKEN,
  URL_KEY_VERSION,
  UrlKeyError,
  UrlUnknowablesRegistry,
  computeConformanceSuiteHash,
  computeLengthBucket,
  computeUrlKeyV2,
  isPiiShapedValue,
  verifyUrlKeyIdempotency,
  type UrlKeyV2Rules,
} from './index'

interface ValidVector {
  readonly id: string
  readonly category: string
  readonly input: string
  readonly rules?: UrlKeyV2Rules
  readonly expected_url_key_v2: string
  readonly expected_path_key?: string
  readonly expected_coarse_key?: boolean
  readonly expected_unclassified?: readonly string[]
  readonly expected_path_masked?: boolean
  readonly must_not_contain?: readonly string[]
}

interface InvalidVector {
  readonly id: string
  readonly category: string
  readonly input: string
  readonly rules?: UrlKeyV2Rules
}

const CONTENT_SITE_RULES: UrlKeyV2Rules = {
  profileRev: 'site-test/rev-1',
  paramClasses: {
    page: 'content',
    p: 'content',
    category: 'content',
    cat: 'content',
    sort: 'content',
    tag: 'content',
    id: 'content',
    item: 'content',
    lang: 'content',
    filter: 'content',
    color: 'content',
    size: 'content',
    tab: 'content',
    q: 'user_input',
    query: 'user_input',
    keyword: 'user_input',
    s: 'user_input',
    search: 'user_input',
    ref_noise: 'noise',
    preview_token: 'noise',
    ab_debug: 'noise',
  },
  pageParamOverrides: [
    {
      pathPattern: '/special/*',
      paramClasses: {
        mode: 'content',
        sort: 'noise',
      },
    },
    {
      pathPattern: '/exact-override',
      paramClasses: {
        view: 'content',
      },
    },
  ],
  inputPathPatterns: [
    ...COMMON_INPUT_PATH_PATTERNS,
    { id: 'tag_search', pattern: '/find/:keyword/items' },
    { id: 'multi_slot', pattern: '/compare/<first>/<second>' },
  ],
}

function buildValidConformanceVectors(): ValidVector[] {
  const vectors: ValidVector[] = []
  let seq = 1
  const add = (
    category: string,
    input: string,
    expected_url_key_v2: string,
    extra: Partial<Omit<ValidVector, 'id' | 'category' | 'input' | 'expected_url_key_v2'>> = {},
  ): void => {
    vectors.push({
      id: `V${String(seq++).padStart(3, '0')}`,
      category,
      input,
      expected_url_key_v2,
      ...extra,
    })
  }

  // =========================================================================
  // 1. Scheme, Host, Case, www., Trailing Dot, Fragments (35 vectors)
  // =========================================================================
  add('basic', 'https://example.com/', 'example.com/')
  add('basic', 'http://example.com/', 'example.com/')
  add('basic', 'HTTPS://EXAMPLE.COM/', 'example.com/')
  add('basic', 'HTTP://Example.Com', 'example.com/')
  add('basic', 'https://www.example.com/', 'example.com/')
  add('basic', 'http://WWW.Example.COM/', 'example.com/')
  add('basic', 'https://example.com.', 'example.com/')
  add('basic', 'https://www.example.com./', 'example.com/')
  add('basic', 'https://example.com...', 'example.com/')
  add('basic', 'https://www.example.com/about/', 'example.com/about')
  add('basic', 'http://example.com/about', 'example.com/about')
  add('basic', 'https://www.bihadashop.jp/column/skin-care/', 'bihadashop.jp/column/skin-care')
  add('basic', 'http://bihadashop.jp/column/skin-care', 'bihadashop.jp/column/skin-care')
  add('basic', '//www.example.com/proto-relative/', 'example.com/proto-relative')
  add('basic', '//example.com', 'example.com/')
  add('basic', 'example.com/schemeless/', 'example.com/schemeless')
  add('basic', 'www.example.com/schemeless', 'example.com/schemeless')
  add('basic', '  https://example.com/trimmed/  ', 'example.com/trimmed')
  add('basic', 'https://example.com/a\tb\rc\n', 'example.com/abc')
  add('basic', 'https://example.com/page#section-1', 'example.com/page')
  add('basic', 'https://example.com/page/#foo/bar?utm_source=x', 'example.com/page')
  add('basic', 'https://example.com/#top', 'example.com/')
  add('basic', 'https://example.com/?#only-hash', 'example.com/')
  add('basic', 'https://sub.www.example.com/a', 'sub.www.example.com/a')
  add('basic', 'https://www2.example.com/a', 'www2.example.com/a')
  add('basic', 'https://www.com/a', 'www.com/a')
  add('basic', 'https://www.example.com/a', 'www.example.com/a', {
    rules: { stripWww: false },
  })
  add('basic', 'https://user:secret@example.com/private-cred', 'example.com/private-cred', {
    must_not_contain: ['user', 'secret'],
  })
  add('basic', 'https://onlyuser@example.com/path', 'example.com/path', {
    must_not_contain: ['onlyuser'],
  })
  add('basic', 'https://example.com/Case/Sensitive/Path', 'example.com/Case/Sensitive/Path')
  add('basic', 'https://example.com/keep-slash/', 'example.com/keep-slash/', {
    rules: { trailingSlash: 'keep' },
  })
  add('basic', 'https://example.com/keep-no-slash', 'example.com/keep-no-slash', {
    rules: { trailingSlash: 'keep' },
  })
  add('basic', 'https://example.com/ensure-slash', 'example.com/ensure-slash/', {
    rules: { trailingSlash: 'ensure' },
  })
  add('basic', 'https://example.com/dir/index.html', 'example.com/dir', {
    rules: { indexFiles: ['index.html', 'index.php'] },
  })
  add('basic', 'https://example.com/spa#/dashboard/overview', 'example.com/spa#/dashboard/overview', {
    rules: { hashRouting: true },
  })

  // =========================================================================
  // 2. IDN / Punycode / UTS-46 & IP Hosts (30 vectors)
  // =========================================================================
  add('idn', 'https://日本語.jp/', 'xn--wgv71a119e.jp/')
  add('idn', 'http://www.日本語.jp/テスト/', 'xn--wgv71a119e.jp/%E3%83%86%E3%82%B9%E3%83%88')
  add('idn', 'https://xn--wgv71a119e.jp/', 'xn--wgv71a119e.jp/')
  add('idn', 'https://XN--WGV71A119E.JP/', 'xn--wgv71a119e.jp/')
  add('idn', 'https://日本語。jp/記事', 'xn--wgv71a119e.jp/%E8%A8%98%E4%BA%8B')
  add('idn', 'https://日本語．jp/記事/', 'xn--wgv71a119e.jp/%E8%A8%98%E4%BA%8B')
  add('idn', 'https://日本語.jp./記事', 'xn--wgv71a119e.jp/%E8%A8%98%E4%BA%8B')
  add('idn', 'https://美肌.bihadashop.jp/', 'xn--lt0a7t.bihadashop.jp/')
  add('idn', 'https://münchen.de/straße', 'xn--mnchen-3ya.de/stra%C3%9Fe')
  add('idn', 'https://MÜNCHEN.DE/', 'xn--mnchen-3ya.de/')
  add('idn', 'https://bücher.example/b', 'xn--bcher-kva.example/b')
  add('idn', 'https://한국어.kr/페이지', 'xn--3e0bk47br7k.kr/%ED%8E%98%EC%9D%B4%EC%A7%80')
  add('idn', 'https://例子.测试/页', 'xn--fsqu00a.xn--0zwm56d/%E9%A1%B5')
  add('idn', 'https://пример.рф/путь', 'xn--e1afmkfd.xn--p1ai/%D0%BF%D1%83%D1%82%D1%8C')
  add('idn', 'https://café.fr/menu', 'xn--caf-dma.fr/menu')
  add('idn', 'https://www.café.fr/menu/', 'xn--caf-dma.fr/menu')
  add('idn', 'https://東京.co.jp:443/案内/', 'xn--1lqs71d.co.jp/%E6%A1%88%E5%86%85')
  add('idn', 'http://東京.co.jp:8080/案内/', 'xn--1lqs71d.co.jp:8080/%E6%A1%88%E5%86%85')
  add('idn', 'https://127.0.0.1/status', '127.0.0.1/status')
  add('idn', 'http://2130706433/status', '127.0.0.1/status')
  add('idn', 'http://0x7f.0.0.1/status', '127.0.0.1/status')
  add('idn', 'http://127.1/status', '127.0.0.1/status')
  add('idn', 'http://0177.0.0.1/status', '127.0.0.1/status')
  add('idn', 'http://[2001:0db8:0000:0000:0000:0000:0000:0001]/v6', '[2001:db8::1]/v6')
  add('idn', 'https://[2001:DB8::1]:443/v6/', '[2001:db8::1]/v6')
  add('idn', 'http://[::1]:8080/local/', '[::1]:8080/local')
  add('idn', '[::1]:8080/local', '[::1]:8080/local')
  add('idn', 'http://localhost:3000/app/', 'localhost:3000/app')
  add('idn', 'localhost:3000/app/', 'localhost:3000/app')
  add('idn', 'https://xn--eckwd4c7cu47r2wf.jp/a', 'xn--eckwd4c7cu47r2wf.jp/a')

  // =========================================================================
  // 3. Ports (15 vectors)
  // =========================================================================
  add('port', 'http://example.com:80/a', 'example.com/a')
  add('port', 'https://example.com:443/a', 'example.com/a')
  add('port', 'http://example.com:443/a', 'example.com/a')
  add('port', 'https://example.com:80/a', 'example.com/a')
  add('port', 'https://example.com:/a', 'example.com/a')
  add('port', 'http://example.com:8080/a/', 'example.com:8080/a')
  add('port', 'https://example.com:8443/a/', 'example.com:8443/a')
  add('port', 'http://www.example.com:3000/v1', 'example.com:3000/v1')
  add('port', 'example.com:9000/metrics/', 'example.com:9000/metrics')
  add('port', 'http://example.com:080/a', 'example.com/a')
  add('port', 'https://example.com:0443/a', 'example.com/a')
  add('port', 'http://example.com:08080/a', 'example.com:8080/a')
  add('port', 'https://example.com:65535/max', 'example.com:65535/max')
  add('port', 'https://example.com:81/alt', 'example.com:81/alt')
  add('port', 'https://sub.example.com:444/alt', 'sub.example.com:444/alt')

  // =========================================================================
  // 4. Japanese Paths, Percent-Encoding, Broken Escapes, Shift_JIS,
  //    Dot-Segments, Astral Chars, Lone Surrogates, Matrix Params (65 vectors)
  // =========================================================================
  add('path', 'https://bihadashop.jp/美肌/化粧水/', 'bihadashop.jp/%E7%BE%8E%E8%82%8C/%E5%8C%96%E7%B2%A7%E6%B0%B4')
  add('path', 'https://bihadashop.jp/%e7%be%8e%e8%82%8c/%e5%8c%96%e7%b2%a7%e6%b0%b4', 'bihadashop.jp/%E7%BE%8E%E8%82%8C/%E5%8C%96%E7%B2%A7%E6%B0%B4')
  add('path', 'https://bihadashop.jp/%E7%BE%8E%E8%82%8C/化粧水', 'bihadashop.jp/%E7%BE%8E%E8%82%8C/%E5%8C%96%E7%B2%A7%E6%B0%B4')
  add('path', 'https://example.com/%41%42%43%61%62%63%30%39', 'example.com/ABCabc09')
  add('path', 'https://example.com/%2d%2e%5f%7e', 'example.com/-._~')
  add('path', 'https://example.com/%7Euser/%7eprofile', 'example.com/~user/~profile')
  add('path', 'https://example.com/a%2fb/c%2Fd', 'example.com/a%2Fb/c%2Fd')
  add('path', 'https://example.com/a%3fb/c%23d', 'example.com/a%3Fb/c%23d')
  add('path', 'https://example.com/100%25/discount', 'example.com/100%25/discount')
  add('path', 'https://example.com/hello%20world', 'example.com/hello%20world')
  add('path', 'https://example.com/hello world', 'example.com/hello%20world')
  add('path', 'https://example.com/a+b/c%2bd', 'example.com/a+b/c%2Bd')
  // Shift_JIS & EUC-JP non-UTF-8 bytes preserved uppercase without transcoding (join-final.md A3!)
  add('path-nonutf8', 'https://example.com/%82%a0%82%a2', 'example.com/%82%A0%82%A2')
  add('path-nonutf8', 'https://example.com/%93%fa%96%7b%8c%ea', 'example.com/%93%FA%96%7B%8C%EA')
  add('path-nonutf8', 'https://example.com/%a4%a2%a4%a4', 'example.com/%A4%A2%A4%A4')
  add('path-nonutf8', 'https://example.com/%ff%fe/raw', 'example.com/%FF%FE/raw')
  add('path-nonutf8', 'https://example.com/%c0%af/overlong', 'example.com/%C0%AF/overlong')
  add('path-nonutf8', 'https://example.com/%80/single-cont', 'example.com/%80/single-cont')
  // Broken percent-escapes safely escaped to %25 (idempotent!)
  add('path-broken-pct', 'https://example.com/100%/off', 'example.com/100%25/off')
  add('path-broken-pct', 'https://example.com/%ZZ/bad', 'example.com/%25ZZ/bad')
  add('path-broken-pct', 'https://example.com/%2/short', 'example.com/%252/short')
  add('path-broken-pct', 'https://example.com/trailing%', 'example.com/trailing%25')
  add('path-broken-pct', 'https://example.com/trailing%a', 'example.com/trailing%25a')
  add('path-broken-pct', 'https://example.com/%G0/%0G/%g1', 'example.com/%25G0/%250G/%25g1')
  add('path-broken-pct', 'https://example.com/%%20/mix', 'example.com/%25%20/mix')
  add('path-broken-pct', 'https://example.com/%%%/', 'example.com/%25%25%25')
  add('path-broken-pct', 'https://example.com/a%20b%ZZc%7e', 'example.com/a%20b%25ZZc~')
  add('path-broken-pct', 'https://example.com/rate-50%-sale', 'example.com/rate-50%25-sale')
  // Dot segments, slashes, backslashes
  add('path-dots', 'https://example.com/a/b/c/./../../g', 'example.com/a/g')
  add('path-dots', 'https://example.com/mid/content=5/../6', 'example.com/mid/6')
  add('path-dots', 'https://example.com/./a/./b/.', 'example.com/a/b')
  add('path-dots', 'https://example.com/../../above-root', 'example.com/above-root')
  add('path-dots', 'https://example.com/a/b/..', 'example.com/a')
  add('path-dots', 'https://example.com/a/b/../..', 'example.com/')
  add('path-dots', 'https://example.com/a/%2e/b/%2e%2e/c', 'example.com/a/c')
  add('path-dots', 'https://example.com/a/%2E%2E/b', 'example.com/b')
  add('path-dots', 'https://example.com///a////b///c///', 'example.com/a/b/c')
  add('path-dots', 'https://example.com\\a\\b\\c', 'example.com/a/b/c')
  add('path-dots', 'https://example.com/a\\..\\b', 'example.com/b')
  add('path-dots', 'https://example.com/a/b/.', 'example.com/a/b/', {
    rules: { trailingSlash: 'keep' },
  })
  add('path-dots', 'https://example.com/a/b/..', 'example.com/a/', {
    rules: { trailingSlash: 'keep' },
  })
  add('path-dots', 'https://example.com/.../three-dots', 'example.com/.../three-dots')
  // Astral characters (emoji, CJK Extension B) & lone surrogates
  add('path-unicode', 'https://example.com/🚀/launch', 'example.com/%F0%9F%9A%80/launch')
  add('path-unicode', 'https://example.com/𠮷野家/menu', 'example.com/%F0%A0%AE%B7%E9%87%8E%E5%AE%B6/menu')
  add('path-unicode', 'https://example.com/👩‍💻', 'example.com/%F0%9F%91%A9%E2%80%8D%F0%9F%92%BB')
  add('path-unicode', 'https://example.com/a\uD800b', 'example.com/a%EF%BF%BDb')
  add('path-unicode', 'https://example.com/a\uDC00b', 'example.com/a%EF%BF%BDb')
  add('path-unicode', 'https://example.com/\uD800\uD800', 'example.com/%EF%BF%BD%EF%BF%BD')
  add('path-unicode', 'https://example.com/「テスト」', 'example.com/%E3%80%8C%E3%83%86%E3%82%B9%E3%83%88%E3%80%8D')
  add('path-unicode', 'https://example.com/全角　スペース', 'example.com/%E5%85%A8%E8%A7%92%E3%80%80%E3%82%B9%E3%83%9A%E3%83%BC%E3%82%B9')
  add('path-unicode', 'https://example.com/unsafe/<>"`{}|^', 'example.com/unsafe/%3C%3E%22%60%7B%7D%7C%5E')
  add('path-unicode', 'https://example.com/subdelims/!$&\'()*+,;=@:', 'example.com/subdelims/!$&\'()*+,;=@:')
  // Matrix & session path parameters
  add('path-matrix', 'https://example.com/catalog;v=2/item;color=red', 'example.com/catalog;v=2/item;color=red')
  add('path-matrix', 'https://example.com/page;jsessionid=ABC123', 'example.com/page;jsessionid=ABC123')
  add('path-matrix', 'https://example.com/page;jsessionid=ABC123', 'example.com/page', {
    rules: { stripSessionPathParams: ['jsessionid'] },
  })
  add('path-matrix', 'https://example.com/dir;jsessionid=XYZ;v=1/view', 'example.com/dir;v=1/view', {
    rules: { stripSessionPathParams: ['jsessionid'] },
  })
  // Pagination paths & diverse JP slugs
  for (let p = 1; p <= 9; p++) {
    add('path-pagination', `https://bihadashop.jp/column/page/${p}/`, `bihadashop.jp/column/page/${p}`)
  }

  // =========================================================================
  // 5. Built-in Noise Parameters — All 25 Exact + utm_* Variants (40 vectors)
  // =========================================================================
  const allBuiltinNoise = Array.from(DEFAULT_NOISE_EXACT_PARAMS).sort()
  for (const param of allBuiltinNoise) {
    add(
      'noise-builtin',
      `https://example.com/article?${param}=value123`,
      'example.com/article',
      { expected_coarse_key: false, expected_unclassified: [] },
    )
  }
  const utmVariants = [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'utm_id',
    'utm_source_platform',
    'utm_creative_format',
    'utm_marketing_tactic',
    'UTM_SOURCE',
    'Utm_Campaign',
    '%75%74%6d%5f%73%6f%75%72%63%65',
  ]
  for (const utm of utmVariants) {
    add('noise-utm', `https://example.com/lp?${utm}=google`, 'example.com/lp', {
      expected_coarse_key: false,
      expected_unclassified: [],
    })
  }
  add(
    'noise-combo',
    'https://www.example.com/item/?utm_source=google&utm_medium=cpc&gclid=Cj0KCQ&fbclid=IwAR&srsltid=AfmBOo&gad_source=1&_hsenc=abc',
    'example.com/item',
    { expected_coarse_key: false, expected_unclassified: [] },
  )
  add(
    'noise-site-rule',
    'https://example.com/item?ref_noise=xyz&preview_token=123&ab_debug=1',
    'example.com/item',
    { rules: CONTENT_SITE_RULES, expected_coarse_key: false, expected_unclassified: [] },
  )
  add(
    'noise-case-insensitive',
    'https://example.com/item?GCLID=1&FBCLID=2&YCLID=3&MSCLKID=4',
    'example.com/item',
    { expected_coarse_key: false, expected_unclassified: [] },
  )

  // =========================================================================
  // 6. Content Parameters, Stable Key-Only Sorting, Duplicates, PII Scrub (45 vectors)
  // =========================================================================
  add('content', 'https://example.com/list?page=2', 'example.com/list?page=2', {
    rules: CONTENT_SITE_RULES,
    expected_coarse_key: false,
  })
  add('content', 'https://example.com/list?sort=price&page=2&category=skin', 'example.com/list?category=skin&page=2&sort=price', {
    rules: CONTENT_SITE_RULES,
    expected_coarse_key: false,
  })
  // Stable sort by KEY ONLY: repeated keys MUST retain relative order (NOT sorted by value!)
  add('content-dup', 'https://example.com/list?tag=zebra&tag=apple&tag=mango', 'example.com/list?tag=zebra&tag=apple&tag=mango', {
    rules: CONTENT_SITE_RULES,
    expected_coarse_key: false,
  })
  add('content-dup', 'https://example.com/list?size=L&color=red&size=S&color=blue&size=M', 'example.com/list?color=red&color=blue&size=L&size=S&size=M', {
    rules: CONTENT_SITE_RULES,
    expected_coarse_key: false,
  })
  add('content-dup', 'https://example.com/list?filter=3&filter=1&filter=2&utm_source=x', 'example.com/list?filter=3&filter=1&filter=2', {
    rules: CONTENT_SITE_RULES,
    expected_coarse_key: false,
  })
  add('content-dup', 'https://example.com/list?id=b&id=a&cat=2&cat=1', 'example.com/list?cat=2&cat=1&id=b&id=a', {
    rules: CONTENT_SITE_RULES,
    expected_coarse_key: false,
  })
  add('content-empty', 'https://example.com/list?page=&sort=asc', 'example.com/list?page=&sort=asc', {
    rules: CONTENT_SITE_RULES,
  })
  add('content-empty', 'https://example.com/list?page&&&sort=asc&', 'example.com/list?page=&sort=asc', {
    rules: CONTENT_SITE_RULES,
  })
  add('content-encoding', 'https://example.com/list?category=美肌&tag=%e3%82%b1%e3%82%a2', 'example.com/list?category=%E7%BE%8E%E8%82%8C&tag=%E3%82%B1%E3%82%A2', {
    rules: CONTENT_SITE_RULES,
  })
  add('content-encoding', 'https://example.com/list?tag=%82%a0&sort=%7easc', 'example.com/list?sort=~asc&tag=%82%A0', {
    rules: CONTENT_SITE_RULES,
  })
  add('content-encoding', 'https://example.com/list?tag=100%25&filter=50%ZZ', 'example.com/list?filter=50%25ZZ&tag=100%25', {
    rules: CONTENT_SITE_RULES,
  })
  add('content-encoding', 'https://example.com/list?filter=a=b', 'example.com/list?filter=a%3Db', {
    rules: CONTENT_SITE_RULES,
  })
  add('content-encoding', 'https://example.com/list?tag=a+b&sort=c%20d', 'example.com/list?sort=c%20d&tag=a+b', {
    rules: CONTENT_SITE_RULES,
  })
  add('content-encoding', 'https://example.com/list?tag=a b', 'example.com/list?tag=a%20b', {
    rules: CONTENT_SITE_RULES,
  })
  // PII scrubbing inside content params
  add('content-pii', 'https://example.com/list?id=taro.yamada@example.co.jp', `example.com/list?id=${PII_SCRUB_TOKEN}`, {
    rules: CONTENT_SITE_RULES,
    must_not_contain: ['taro.yamada', 'example.co.jp'],
  })
  add('content-pii', 'https://example.com/list?id=user%40domain.com', `example.com/list?id=${PII_SCRUB_TOKEN}`, {
    rules: CONTENT_SITE_RULES,
    must_not_contain: ['user', 'domain.com'],
  })
  add('content-pii', 'https://example.com/list?id=090-1234-5678', `example.com/list?id=${PII_SCRUB_TOKEN}`, {
    rules: CONTENT_SITE_RULES,
    must_not_contain: ['090', '1234', '5678'],
  })
  add('content-pii', 'https://example.com/list?id=+81-90-1234-5678', `example.com/list?id=${PII_SCRUB_TOKEN}`, {
    rules: CONTENT_SITE_RULES,
    must_not_contain: ['1234', '5678'],
  })
  add('content-pii', 'https://example.com/list?id=4111-1111-1111-1111', `example.com/list?id=${PII_SCRUB_TOKEN}`, {
    rules: CONTENT_SITE_RULES,
    must_not_contain: ['4111'],
  })
  add(
    'content-pii',
    'https://example.com/list?id=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3OCJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    `example.com/list?id=${PII_SCRUB_TOKEN}`,
    { rules: CONTENT_SITE_RULES, must_not_contain: ['eyJhbGci'] },
  )
  add('content-pii', `https://example.com/list?id=${PII_SCRUB_TOKEN}`, `example.com/list?id=${PII_SCRUB_TOKEN}`, {
    rules: CONTENT_SITE_RULES,
  })
  // Page-level overrides
  add('page-override', 'https://example.com/special/campaign?mode=dark&sort=price&page=1', 'example.com/special/campaign?mode=dark&page=1', {
    rules: CONTENT_SITE_RULES,
    expected_coarse_key: false,
  })
  add('page-override', 'https://example.com/normal/campaign?mode=dark&sort=price', `example.com/normal/campaign?mode=${LENGTH_BUCKET_TOKENS.LEN_1_4}&sort=price`, {
    rules: CONTENT_SITE_RULES,
    expected_coarse_key: true,
    expected_unclassified: ['mode'],
  })
  add('page-override', 'https://example.com/exact-override?view=grid', 'example.com/exact-override?view=grid', {
    rules: CONTENT_SITE_RULES,
    expected_coarse_key: false,
  })
  add('page-override', 'https://example.com/exact-override/sub?view=grid', `example.com/exact-override/sub?view=${LENGTH_BUCKET_TOKENS.LEN_1_4}`, {
    rules: CONTENT_SITE_RULES,
    expected_coarse_key: true,
    expected_unclassified: ['view'],
  })
  // Additional pagination & content combinations (20 vectors)
  for (let i = 1; i <= 20; i++) {
    add(
      'content-grid',
      `https://bihadashop.jp/products?sort=rank&p=${i}&cat=lotion&utm_source=ig`,
      `bihadashop.jp/products?cat=lotion&p=${i}&sort=rank`,
      { rules: CONTENT_SITE_RULES, expected_coarse_key: false },
    )
  }

  // =========================================================================
  // 7. User Input Parameters -> Length Bucket Only, coarse_key = false (30 vectors)
  // =========================================================================
  add('user-input', 'https://example.com/search?q=', `example.com/search?q=${LENGTH_BUCKET_TOKENS.ZERO}`, {
    rules: CONTENT_SITE_RULES,
    expected_coarse_key: false,
  })
  add('user-input', 'https://example.com/search?q=a', `example.com/search?q=${LENGTH_BUCKET_TOKENS.LEN_1_4}`, {
    rules: CONTENT_SITE_RULES,
    expected_coarse_key: false,
  })
  add('user-input', 'https://example.com/search?q=abcd', `example.com/search?q=${LENGTH_BUCKET_TOKENS.LEN_1_4}`, {
    rules: CONTENT_SITE_RULES,
    expected_coarse_key: false,
    must_not_contain: ['abcd'],
  })
  add('user-input', 'https://example.com/search?q=abcde', `example.com/search?q=${LENGTH_BUCKET_TOKENS.LEN_5_16}`, {
    rules: CONTENT_SITE_RULES,
    expected_coarse_key: false,
    must_not_contain: ['abcde'],
  })
  add('user-input', 'https://example.com/search?q=' + 'a'.repeat(16), `example.com/search?q=${LENGTH_BUCKET_TOKENS.LEN_5_16}`, {
    rules: CONTENT_SITE_RULES,
    expected_coarse_key: false,
  })
  add('user-input', 'https://example.com/search?q=' + 'a'.repeat(17), `example.com/search?q=${LENGTH_BUCKET_TOKENS.LEN_17_64}`, {
    rules: CONTENT_SITE_RULES,
    expected_coarse_key: false,
  })
  add('user-input', 'https://example.com/search?q=' + 'a'.repeat(64), `example.com/search?q=${LENGTH_BUCKET_TOKENS.LEN_17_64}`, {
    rules: CONTENT_SITE_RULES,
    expected_coarse_key: false,
  })
  add('user-input', 'https://example.com/search?q=' + 'a'.repeat(65), `example.com/search?q=${LENGTH_BUCKET_TOKENS.LEN_65_256}`, {
    rules: CONTENT_SITE_RULES,
    expected_coarse_key: false,
  })
  add('user-input', 'https://example.com/search?q=' + 'a'.repeat(256), `example.com/search?q=${LENGTH_BUCKET_TOKENS.LEN_65_256}`, {
    rules: CONTENT_SITE_RULES,
    expected_coarse_key: false,
  })
  add('user-input', 'https://example.com/search?q=' + 'a'.repeat(257), `example.com/search?q=${LENGTH_BUCKET_TOKENS.LEN_257_PLUS}`, {
    rules: CONTENT_SITE_RULES,
    expected_coarse_key: false,
  })
  // Japanese raw vs percent-encoded produces identical length bucket!
  add('user-input', 'https://example.com/search?q=化粧水', `example.com/search?q=${LENGTH_BUCKET_TOKENS.LEN_1_4}`, {
    rules: CONTENT_SITE_RULES,
    expected_coarse_key: false,
    must_not_contain: ['化粧水', '%E5%8C%96'],
  })
  add('user-input', 'https://example.com/search?q=%E5%8C%96%E7%B2%A7%E6%B0%B4', `example.com/search?q=${LENGTH_BUCKET_TOKENS.LEN_1_4}`, {
    rules: CONTENT_SITE_RULES,
    expected_coarse_key: false,
    must_not_contain: ['%E5%8C%96'],
  })
  add('user-input', 'https://example.com/search?keyword=敏感肌+化粧水+おすすめ', `example.com/search?keyword=${LENGTH_BUCKET_TOKENS.LEN_5_16}`, {
    rules: CONTENT_SITE_RULES,
    expected_coarse_key: false,
    must_not_contain: ['敏感肌', 'おすすめ'],
  })
  add('user-input', 'https://example.com/search?s=secret+medical+query&page=2', `example.com/search?page=2&s=${LENGTH_BUCKET_TOKENS.LEN_17_64}`, {
    rules: CONTENT_SITE_RULES,
    expected_coarse_key: false,
    must_not_contain: ['secret', 'medical'],
  })
  // Already-bucketed values are preserved idempotently!
  for (const tok of Object.values(LENGTH_BUCKET_TOKENS)) {
    add('user-input-idempotent', `https://example.com/search?q=${tok}`, `example.com/search?q=${tok}`, {
      rules: CONTENT_SITE_RULES,
      expected_coarse_key: false,
    })
  }
  // Additional user-input param names & combinations (10 vectors)
  const sampleQueries = [
    ['query', 'hi', LENGTH_BUCKET_TOKENS.LEN_1_4],
    ['query', 'vitaminc', LENGTH_BUCKET_TOKENS.LEN_5_16],
    ['search', 'retinol cream for dry skin', LENGTH_BUCKET_TOKENS.LEN_17_64],
    ['s', '🚀✨', LENGTH_BUCKET_TOKENS.LEN_1_4],
    ['keyword', '%82%a0%82%a2', LENGTH_BUCKET_TOKENS.LEN_1_4],
    ['q', '100%ZZ', LENGTH_BUCKET_TOKENS.LEN_5_16],
    ['q', 'x', LENGTH_BUCKET_TOKENS.LEN_1_4],
    ['s', '美肌ケア完全ガイド2026年最新版', LENGTH_BUCKET_TOKENS.LEN_17_64],
    ['query', 'a+b+c+d+e+f+g+h+i+j', LENGTH_BUCKET_TOKENS.LEN_17_64],
    ['search', '', LENGTH_BUCKET_TOKENS.ZERO],
  ] as const
  for (const [k, v, expectedTok] of sampleQueries) {
    add('user-input-matrix', `https://example.com/find?${k}=${v}`, `example.com/find?${k}=${expectedTok}`, {
      rules: CONTENT_SITE_RULES,
      expected_coarse_key: false,
    })
  }

  // =========================================================================
  // 8. Unclassified Parameters -> Name + Length Bucket Only, coarse_key = true (45 vectors)
  //    MUST NOT leak numeric vs alphabetic shape (§6.4)!
  // =========================================================================
  add('unclassified', 'https://example.com/p?foo=12345', `example.com/p?foo=${LENGTH_BUCKET_TOKENS.LEN_5_16}`, {
    expected_coarse_key: true,
    expected_unclassified: ['foo'],
    must_not_contain: ['12345', 'int', 'slug'],
  })
  add('unclassified', 'https://example.com/p?foo=abcde', `example.com/p?foo=${LENGTH_BUCKET_TOKENS.LEN_5_16}`, {
    expected_coarse_key: true,
    expected_unclassified: ['foo'],
    must_not_contain: ['abcde', 'int', 'slug'],
  })
  add('unclassified', 'https://example.com/p?secret_user=yamada@test.jp', `example.com/p?secret_user=${LENGTH_BUCKET_TOKENS.LEN_5_16}`, {
    expected_coarse_key: true,
    expected_unclassified: ['secret_user'],
    must_not_contain: ['yamada', 'test.jp'],
  })
  add('unclassified', 'https://example.com/p?z=1&a=hello&utm_source=google', `example.com/p?a=${LENGTH_BUCKET_TOKENS.LEN_5_16}&z=${LENGTH_BUCKET_TOKENS.LEN_1_4}`, {
    expected_coarse_key: true,
    expected_unclassified: ['a', 'z'],
    must_not_contain: ['hello', 'google'],
  })
  add('unclassified', 'https://example.com/p?page=2&unknown_x=secret', `example.com/p?page=2&unknown_x=${LENGTH_BUCKET_TOKENS.LEN_5_16}`, {
    rules: CONTENT_SITE_RULES,
    expected_coarse_key: true,
    expected_unclassified: ['unknown_x'],
    must_not_contain: ['secret'],
  })
  add('unclassified', 'https://example.com/p?flag', `example.com/p?flag=${LENGTH_BUCKET_TOKENS.ZERO}`, {
    expected_coarse_key: true,
    expected_unclassified: ['flag'],
  })
  add('unclassified', 'https://example.com/p?dup=1&dup=12345678901234567890', `example.com/p?dup=${LENGTH_BUCKET_TOKENS.LEN_1_4}&dup=${LENGTH_BUCKET_TOKENS.LEN_17_64}`, {
    expected_coarse_key: true,
    expected_unclassified: ['dup'],
    must_not_contain: ['12345678901234567890'],
  })
  add('unclassified', 'https://example.com/p?bad%ZZ=secretvalue', `example.com/p?bad%25ZZ=${LENGTH_BUCKET_TOKENS.LEN_5_16}`, {
    expected_coarse_key: true,
    expected_unclassified: ['bad%25ZZ'],
    must_not_contain: ['secretvalue'],
  })
  // All 6 length buckets for unclassified params
  for (const [val, tok] of [
    ['', LENGTH_BUCKET_TOKENS.ZERO],
    ['1', LENGTH_BUCKET_TOKENS.LEN_1_4],
    ['9999', LENGTH_BUCKET_TOKENS.LEN_1_4],
    ['12345', LENGTH_BUCKET_TOKENS.LEN_5_16],
    ['x'.repeat(16), LENGTH_BUCKET_TOKENS.LEN_5_16],
    ['x'.repeat(17), LENGTH_BUCKET_TOKENS.LEN_17_64],
    ['x'.repeat(64), LENGTH_BUCKET_TOKENS.LEN_17_64],
    ['x'.repeat(65), LENGTH_BUCKET_TOKENS.LEN_65_256],
    ['x'.repeat(256), LENGTH_BUCKET_TOKENS.LEN_65_256],
    ['x'.repeat(257), LENGTH_BUCKET_TOKENS.LEN_257_PLUS],
  ] as const) {
    add('unclassified-buckets', `https://example.com/item?u=${val}`, `example.com/item?u=${tok}`, {
      expected_coarse_key: true,
      expected_unclassified: ['u'],
    })
  }
  // 27 diverse unclassified parameter names with mixed content + noise + user_input
  for (let i = 1; i <= 27; i++) {
    const rawVal = i % 2 === 0 ? String(10000 + i) : `token_${i}_abc`
    add(
      'unclassified-mixed',
      `https://example.com/a?page=${i}&x_custom_${i}=${rawVal}&gclid=ignore&q=検索`,
      `example.com/a?page=${i}&q=${LENGTH_BUCKET_TOKENS.LEN_1_4}&x_custom_${i}=${LENGTH_BUCKET_TOKENS.LEN_5_16}`,
      {
        rules: CONTENT_SITE_RULES,
        expected_coarse_key: true,
        expected_unclassified: [`x_custom_${i}`],
        must_not_contain: [rawVal, 'ignore', '検索'],
      },
    )
  }

  // =========================================================================
  // 9. Input Path Pattern Masking (`/search/<term>/` etc.) (35 vectors)
  // =========================================================================
  add('path-mask', 'https://example.com/search/化粧水/', `example.com/search/${LENGTH_BUCKET_TOKENS.LEN_1_4}`, {
    rules: CONTENT_SITE_RULES,
    expected_path_masked: true,
    must_not_contain: ['化粧水', '%E5%8C%96'],
  })
  add('path-mask', 'https://example.com/search/%E5%8C%96%E7%B2%A7%E6%B0%B4/', `example.com/search/${LENGTH_BUCKET_TOKENS.LEN_1_4}`, {
    rules: CONTENT_SITE_RULES,
    expected_path_masked: true,
    must_not_contain: ['%E5%8C%96'],
  })
  add('path-mask', 'https://example.com/search/niacinamide-serum', `example.com/search/${LENGTH_BUCKET_TOKENS.LEN_17_64}`, {
    rules: CONTENT_SITE_RULES,
    expected_path_masked: true,
    must_not_contain: ['niacinamide'],
  })
  add('path-mask', 'https://example.com/search/ビタミンC美容液/page/2', `example.com/search/${LENGTH_BUCKET_TOKENS.LEN_5_16}/page/2`, {
    rules: CONTENT_SITE_RULES,
    expected_path_masked: true,
    must_not_contain: ['ビタミン', '%E3%83%93'],
  })
  add('path-mask', 'https://example.com/s/test/', `example.com/s/${LENGTH_BUCKET_TOKENS.LEN_1_4}`, {
    rules: CONTENT_SITE_RULES,
    expected_path_masked: true,
    must_not_contain: ['test'],
  })
  add('path-mask', 'https://example.com/find/敏感肌コスメ/items?page=3', `example.com/find/${LENGTH_BUCKET_TOKENS.LEN_5_16}/items?page=3`, {
    rules: CONTENT_SITE_RULES,
    expected_path_masked: true,
    expected_coarse_key: false,
    must_not_contain: ['敏感肌'],
  })
  add('path-mask', 'https://example.com/compare/productA/very-long-product-name-here', `example.com/compare/${LENGTH_BUCKET_TOKENS.LEN_5_16}/${LENGTH_BUCKET_TOKENS.LEN_17_64}`, {
    rules: CONTENT_SITE_RULES,
    expected_path_masked: true,
    must_not_contain: ['productA', 'very-long'],
  })
  // Without rules, /search/term is NOT masked (must be explicitly registered per §6.4!)
  add('path-mask-unregistered', 'https://example.com/search/retinol', 'example.com/search/retinol', {
    expected_path_masked: false,
  })
  // Non-matching path stays unmasked even when rules are registered
  add('path-mask-nomatch', 'https://example.com/blog/retinol', 'example.com/blog/retinol', {
    rules: CONTENT_SITE_RULES,
    expected_path_masked: false,
  })
  // Trailing slash keep + path mask idempotency
  add('path-mask-keep-slash', 'https://example.com/search/敏感肌ケア/', `example.com/search/${LENGTH_BUCKET_TOKENS.LEN_5_16}/`, {
    rules: { ...CONTENT_SITE_RULES, trailingSlash: 'keep' },
    expected_path_masked: true,
  })
  // 25 more path-mask vectors across lengths, Japanese, broken %, special chars
  for (let i = 1; i <= 25; i++) {
    const term = i <= 5 ? 'a'.repeat(i) : i <= 15 ? `検索語${'あ'.repeat(i)}` : 'k'.repeat(i * 4)
    const expectedBucket = computeLengthBucket(term, false)
    add(
      'path-mask-matrix',
      `https://example.com/search/${term}/?utm_source=x&page=1`,
      `example.com/search/${expectedBucket}?page=1`,
      {
        rules: CONTENT_SITE_RULES,
        expected_path_masked: true,
        expected_coarse_key: false,
      },
    )
  }

  return vectors
}

const INVALID_VECTORS: readonly InvalidVector[] = [
  { id: 'INV01', category: 'invalid', input: '' },
  { id: 'INV02', category: 'invalid', input: '   \t\n  ' },
  { id: 'INV03', category: 'invalid', input: 'javascript:alert(1)' },
  { id: 'INV04', category: 'invalid', input: 'JAVASCRIPT:void(0)' },
  { id: 'INV05', category: 'invalid', input: 'data:text/html,<script>alert(1)</script>' },
  { id: 'INV06', category: 'invalid', input: 'mailto:user@example.com' },
  { id: 'INV07', category: 'invalid', input: 'ftp://files.example.com/archive.zip' },
  { id: 'INV08', category: 'invalid', input: 'file:///etc/passwd' },
  { id: 'INV09', category: 'invalid', input: 'tel:+81-90-1234-5678' },
  { id: 'INV10', category: 'invalid', input: 'about:blank' },
  { id: 'INV11', category: 'invalid', input: 'blob:https://example.com/550e8400-e29b-41d4' },
  { id: 'INV12', category: 'invalid', input: 'ws://example.com/socket' },
  { id: 'INV13', category: 'invalid', input: 'wss://example.com/socket' },
  { id: 'INV14', category: 'invalid', input: 'https:///' },
  { id: 'INV15', category: 'invalid', input: 'https://[::1/' },
  { id: 'INV16', category: 'invalid', input: 'https://example.com/' + 'a'.repeat(17000) },
  { id: 'INV17', category: 'invalid', input: 'https://example.com/a\x00b' },
  { id: 'INV18', category: 'invalid', input: 'https://example.com/a\x1fb' },
  { id: 'INV19', category: 'invalid', input: 'https://example.com/a\x7fb' },
  {
    id: 'INV20',
    category: 'invalid',
    input: 'https://example.com/?' + Array.from({ length: 1001 }, (_, i) => `k${i}=1`).join('&'),
  },
]

const VALID_VECTORS = buildValidConformanceVectors()

describe('Bundle 1-C: urlkey/2 Single Authority Normalizer (packages/contract/urlkey — Gate join.G10)', () => {
  it('contains at least 300 conformance vectors (gate join.G10)', () => {
    const total = VALID_VECTORS.length + INVALID_VECTORS.length
    expect(total).toBeGreaterThanOrEqual(300)
    expect(VALID_VECTORS.length).toBeGreaterThanOrEqual(300)
  })

  it.each(VALID_VECTORS)('[$id] ($category) normalizes and is strictly idempotent', (v) => {
    const res = computeUrlKeyV2(v.input, v.rules)

    expect(res.key_ver).toBe(URL_KEY_VERSION)
    expect(res.url_key_v2).toBe(v.expected_url_key_v2)
    expect(res.url_key).toBe(v.expected_url_key_v2)
    expect(res.url_id_hex).toMatch(/^[0-9a-f]{16}$/)
    expect(res.url_id).toMatch(/^\d+$/)
    expect(res.key_degraded).toBe(res.coarse_key)

    if (v.expected_path_key !== undefined) {
      expect(res.path_key).toBe(v.expected_path_key)
    } else {
      const expectedPathKey = v.expected_url_key_v2.split(/[?#]/, 1)[0]
      expect(res.path_key).toBe(expectedPathKey)
    }

    if (v.expected_coarse_key !== undefined) {
      expect(res.coarse_key).toBe(v.expected_coarse_key)
    }
    if (v.expected_unclassified !== undefined) {
      expect(res.unclassified_param_names).toEqual(v.expected_unclassified)
    }
    if (v.expected_path_masked !== undefined) {
      expect(res.path_masked).toBe(v.expected_path_masked)
    }
    if (v.must_not_contain) {
      for (const secret of v.must_not_contain) {
        expect(res.url_key_v2).not.toContain(secret)
        expect(res.path_key).not.toContain(secret)
      }
    }

    // Strict collector-side fixed-point idempotency:
    // 1. Canonical output `res.url_key_v2` MUST be a true fixed point (`idempotent === true`)
    const canonicalIdem = verifyUrlKeyIdempotency(res.url_key_v2, v.rules)
    expect(canonicalIdem.idempotent).toBe(true)
    expect(canonicalIdem.first.url_key_v2).toBe(res.url_key_v2)
    expect(canonicalIdem.second.url_key_v2).toBe(res.url_key_v2)
    expect(canonicalIdem.second.url_id).toBe(res.url_id)
    expect(canonicalIdem.second.path_key).toBe(res.path_key)
    expect(canonicalIdem.second.coarse_key).toBe(res.coarse_key)
    expect(canonicalIdem.second.unclassified_param_names).toEqual(res.unclassified_param_names)

    // 2. Raw input is only already-idempotent when `v.input === res.url_key_v2` ([C-08])
    const rawIdem = verifyUrlKeyIdempotency(v.input, v.rules)
    expect(rawIdem.idempotent).toBe(v.input === res.url_key_v2)
    expect(rawIdem.second.url_key_v2).toBe(rawIdem.first.url_key_v2)
  })

  it.each(INVALID_VECTORS)('[$id] ($category) rejects invalid or non-http(s) URL', (v) => {
    expect(() => computeUrlKeyV2(v.input, v.rules)).toThrow(UrlKeyError)
  })

  it('guarantees unclassified parameters do not leak numeric vs alphabetic shape (§6.4)', () => {
    const numericRes = computeUrlKeyV2('https://example.com/item?mystery=123456')
    const alphaRes = computeUrlKeyV2('https://example.com/item?mystery=abcdef')
    const slugRes = computeUrlKeyV2('https://example.com/item?mystery=ab-12c')

    expect(numericRes.url_key_v2).toBe(alphaRes.url_key_v2)
    expect(alphaRes.url_key_v2).toBe(slugRes.url_key_v2)
    expect(numericRes.coarse_key).toBe(true)
    expect(numericRes.unclassified_param_names).toEqual(['mystery'])
  })

  it('extracts campaign attribution (UTM + click-id types without raw click-id values)', () => {
    const res = computeUrlKeyV2(
      'https://www.bihadashop.jp/column/skin/?utm_source=google&utm_medium=cpc&utm_campaign=spring&gclid=EAIaIQobChMI12345&fbclid=IwAR999&page=2',
      CONTENT_SITE_RULES,
    )
    expect(res.url_key_v2).toBe('bihadashop.jp/column/skin?page=2')
    expect(res.campaign_attribution.utm).toEqual({
      source: 'google',
      medium: 'cpc',
      campaign: 'spring',
    })
    expect(res.campaign_attribution.click_id_types).toEqual(['fbclid', 'gclid'])
    // Raw click ID values must NOT appear anywhere in serialized result
    const serialized = JSON.stringify(res)
    expect(serialized).not.toContain('EAIaIQobChMI12345')
    expect(serialized).not.toContain('IwAR999')
  })

  it('detects PII-shaped values accurately and computes deterministic conformance suite hash', () => {
    expect(isPiiShapedValue('user@example.com')).toBe(true)
    expect(isPiiShapedValue('090-1234-5678')).toBe(true)
    expect(isPiiShapedValue('4242-4242-4242-4242')).toBe(true)
    expect(isPiiShapedValue('skin-care-2026')).toBe(false)
    expect(isPiiShapedValue('12345')).toBe(false)

    const manifestInput = [
      ...VALID_VECTORS.map((v) => ({
        id: v.id,
        input: v.input,
        expected_url_key_v2: v.expected_url_key_v2,
      })),
      ...INVALID_VECTORS.map((v) => ({
        id: v.id,
        input: v.input,
        expected_url_key_v2: null,
      })),
    ]
    const hash1 = computeConformanceSuiteHash(manifestInput)
    const hash2 = computeConformanceSuiteHash(manifestInput)
    expect(hash1).toMatch(/^[0-9a-f]{64}$/)
    expect(hash1).toBe(hash2)
  })

  describe('Wave 8 Adversarial Regressions: [C-08] & [H-12]', () => {
    it('[C-08] enforces true fixed-point idempotency (rejects raw credentials/fragments/uppercase as non-idempotent) and supports single-label host:port/path', () => {
      // Raw URLs with credentials, fragments, scheme, uppercase host, or unsorted query are NOT already canonical!
      expect(verifyUrlKeyIdempotency('https://user:secret@EXAMPLE.COM/page#frag').idempotent).toBe(false)
      expect(verifyUrlKeyIdempotency('example.com/page#frag').idempotent).toBe(false)
      expect(verifyUrlKeyIdempotency('EXAMPLE.COM/page').idempotent).toBe(false)
      expect(verifyUrlKeyIdempotency('example.com/list?sort=price&page=2', CONTENT_SITE_RULES).idempotent).toBe(false)
      expect(verifyUrlKeyIdempotency('example.com/list?page=2&sort=price', CONTENT_SITE_RULES).idempotent).toBe(true)

      // Single-label host:port/path (e.g. staging:8080/page, app-dev:3000/a) succeeds on 1st & 2nd pass
      const first = computeUrlKeyV2('http://staging:8080/page/')
      expect(first.url_key_v2).toBe('staging:8080/page')
      const second = computeUrlKeyV2(first.url_key_v2)
      expect(second.url_key_v2).toBe('staging:8080/page')
      expect(verifyUrlKeyIdempotency(first.url_key_v2).idempotent).toBe(true)

      // Known non-HTTP schemes with numeric payload (e.g. tel:110, sms:12345) MUST still throw UrlKeyError!
      expect(() => computeUrlKeyV2('tel:110')).toThrow(UrlKeyError)
      expect(() => computeUrlKeyV2('sms:12345')).toThrow(UrlKeyError)
    })

    it('[H-12] catches malformed-% PII bypass (alice%40example.com%ZZ), matches case-insensitive/wildcard search paths, records unknowables, and rejects https:///path', () => {
      // 1. Malformed %ZZ suffix cannot bypass %40 -> @ PII scrubbing!
      expect(isPiiShapedValue('alice%40example.com%ZZ')).toBe(true)
      expect(isPiiShapedValue('090%2D1234%2D5678%ZZ')).toBe(true)
      expect(isPiiShapedValue('4111%2D1111%2D1111%2D1111%2')).toBe(true)

      const scrubbedContent = computeUrlKeyV2(
        'https://example.com/list?id=alice%40example.com%ZZ&utm_campaign=bob%40secret.jp%ZZ',
        CONTENT_SITE_RULES,
      )
      expect(scrubbedContent.url_key_v2).toBe(`example.com/list?id=${PII_SCRUB_TOKEN}`)
      expect(scrubbedContent.url_key_v2).not.toContain('alice')
      expect(scrubbedContent.campaign_attribution.utm.campaign).toBe(PII_SCRUB_TOKEN)
      expect(JSON.stringify(scrubbedContent)).not.toContain('bob')

      // 2. Case-insensitive & multi-segment wildcard search paths (`/Search/...`, `/search/*/query`)
      const caseInsensitiveSearch = computeUrlKeyV2(
        'https://example.com/Search/secret-medical-term/page/2',
        CONTENT_SITE_RULES,
      )
      expect(caseInsensitiveSearch.path_masked).toBe(true)
      expect(caseInsensitiveSearch.url_key_v2).toBe(
        `example.com/search/${LENGTH_BUCKET_TOKENS.LEN_17_64}/page/2`,
      )
      expect(caseInsensitiveSearch.url_key_v2).not.toContain('secret-medical-term')

      const midWildcardRules: UrlKeyV2Rules = {
        inputPathPatterns: [
          { id: 'mid_wild_placeholder', pattern: '/Search/*/:query' },
          { id: 'mid_wild_implicit', pattern: '/find/*/query' },
          { id: 'multi_dots', pattern: '/lookup/...' },
        ],
      }
      const r1 = computeUrlKeyV2('https://example.com/SEARCH/books/retinol-serum', midWildcardRules)
      expect(r1.path_masked).toBe(true)
      expect(r1.url_key_v2).toBe(`example.com/search/books/${LENGTH_BUCKET_TOKENS.LEN_5_16}`)
      expect(verifyUrlKeyIdempotency(r1.url_key_v2, midWildcardRules).idempotent).toBe(true)

      const r2 = computeUrlKeyV2('https://example.com/Find/retinol-serum/Query', midWildcardRules)
      expect(r2.path_masked).toBe(true)
      expect(r2.url_key_v2).toBe(`example.com/find/${LENGTH_BUCKET_TOKENS.LEN_5_16}/query`)
      expect(verifyUrlKeyIdempotency(r2.url_key_v2, midWildcardRules).idempotent).toBe(true)

      const r3 = computeUrlKeyV2('https://example.com/Lookup/catA/secretTerm', midWildcardRules)
      expect(r3.path_masked).toBe(true)
      expect(r3.url_key_v2).toBe(
        `example.com/lookup/${LENGTH_BUCKET_TOKENS.LEN_1_4}/${LENGTH_BUCKET_TOKENS.LEN_5_16}`,
      )
      expect(verifyUrlKeyIdempotency(r3.url_key_v2, midWildcardRules).idempotent).toBe(true)

      // 3. Unregistered search-like paths recorded in unknowables metadata without raw terms!
      const unreg = computeUrlKeyV2('https://example.com/Search/SensitiveSecretTerm?mystery=123')
      expect(unreg.path_masked).toBe(false)
      expect(unreg.unknowables.unregistered_search_path.suspected).toBe(true)
      expect(unreg.unknowables.unregistered_search_path.suggested_pattern).toBe('/search/<term>')
      expect(JSON.stringify(unreg.unknowables)).not.toContain('SensitiveSecretTerm')

      const tracker = new UrlUnknowablesRegistry()
      tracker.record(unreg)
      expect(tracker.snapshot().suspectedSearchPatterns['/search/<term>']).toBe(1)
      expect(tracker.snapshot().unclassifiedParamCounts['mystery']).toBe(1)

      // 4. Empty-host URLs (`https:///path`, `http:///admin`, `///secret`, `https://:8080/a`, `https://user@/a`) throw UrlKeyError!
      for (const emptyHostUrl of [
        'https:///path',
        'http:///admin/panel',
        '///secret/path',
        'https://\\escaped',
        'https://:8080/path',
        'https://user:pass@/path',
        'https:/single-slash',
      ]) {
        expect(() => computeUrlKeyV2(emptyHostUrl)).toThrow(UrlKeyError)
      }
    })
  })
})
