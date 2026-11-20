/**
 * Unknowables Ledger (`limits[]`, Master Architecture v2 §4.9 / §12.2 / §16.4)
 *
 * Machine-readable register of everything that cannot be known in principle from the
 * browser, site logs, or observational data alone (TEL Appendix A6 U1–U16 + ACT U1–U4 + EV U1).
 *
 * Includes `auditDescriptionAgainstUnknowables()` (TEL M9 lint) which rejects any API / MCP
 * description that touches an unknowable topic without declaring its upper bound, or makes a
 * prohibited absolute claim.
 */

export type UnknowableDomain = 'tel' | 'act' | 'ev'

export interface UnknowableEntry {
  readonly id: string
  readonly domain: UnknowableDomain
  readonly topic: string
  readonly limitation: string
  readonly specBasis: string
  readonly strongestProxy: string
  readonly proxyUpperBound: string
  readonly unlockRequirement: string
  /** Keywords indicating that an API / MCP description touches this unknowable topic */
  readonly triggerKeywords: ReadonlyArray<string>
  /** At least one of these qualification terms (or explicit limitId reference) must appear when triggered */
  readonly requiredQualificationKeywords: ReadonlyArray<string>
  /** Hard-banned overclaims that always fail audit even when qualifications are present */
  readonly forbiddenClaims: ReadonlyArray<string>
}

export interface UnknowableAuditViolation {
  readonly limitId: string
  readonly topic: string
  readonly kind: 'forbidden_claim' | 'missing_upper_bound'
  readonly matchedKeyword: string
  readonly message: string
}

export interface UnknowableAuditResult {
  readonly passed: boolean
  readonly operationId?: string
  readonly matchedLimitIds: ReadonlyArray<string>
  readonly violations: ReadonlyArray<UnknowableAuditViolation>
}

const COMMON_LIMIT_QUALIFIERS: ReadonlyArray<string> = [
  '上限',
  '限界',
  '観測不可',
  '知りえない',
  '取得不可',
  '推定',
  '代用',
  '幅',
  '区間',
  '上下限',
  'inferred',
  'observed',
  'not_collected',
  'proxy',
  'bound',
  'upper bound',
  'interval',
  'unobservable',
  'limit',
  'caveat',
]

export const UNKNOWABLES_LEDGER: ReadonlyArray<UnknowableEntry> = [
  // ===== Telemetry U1–U16 (TEL Appendix A6) =====
  {
    id: 'tel.U1',
    domain: 'tel',
    topic: '注意・理解・読了（実際に読んだかどうか）',
    limitation: 'ブラウザからは訪問者が実際に文章へ注意を向け理解・読了したかを観測できない。「読了」「注目」「視線」は断定不可。',
    specBasis: 'Web プラットフォームに視線・認知 API が存在しない (TEL A6 U1 / §11.12)',
    strongestProxy: '中央 40% 注視帯での滞在時間 (engaged dwell under def_ver)',
    proxyUpperBound: 'observed として言えるのは「区画の表示・滞在時間」まで。理解・読了は inferred 止まり。',
    unlockRequirement: '同意済み人間パネルでの較正 (act.M5, それでも上限は inferred)',
    triggerKeywords: ['読了', '熟読', '注目', '視線', 'comprehension', 'attention', 'actually read'],
    requiredQualificationKeywords: [...COMMON_LIMIT_QUALIFIERS, '滞在', '注視帯', 'dwell', 'def_ver'],
    forbiddenClaims: ['完全に読んだ', '読了を正確に計測', '視線を計測', 'guaranteed comprehension'],
  },
  {
    id: 'tel.U2',
    domain: 'tel',
    topic: '走らなかった PV（スクリプト非実行・遮断・非 JS クライアント）',
    limitation: '広告ブロッカー・JS 無効・HTML のみ取得するクローラー等でスクリプトが走らなかった PV はブラウザ側からは原理的に観測できない。',
    specBasis: 'クライアント実行前提の物理限界 (TEL A6 U2 / §4.4 / §4.9)',
    strongestProxy: 'load_vs_frame（設定取得数と初回フレーム数の差）、noscript 画像',
    proxyUpperBound: 'タグ単独導入では未実行 PV の割合は inferred 止まり、ページ内行動は一切観測不可 (not_collected)。',
    unlockRequirement: 'サーバー側観測経路（ゾーン Worker / CDN ログ / Server-Timing 受け渡し）で件数のみ observed 化（行動中身は依然観測不可）',
    triggerKeywords: ['走らなかった', '非実行', 'スクリプト遮断', '欠損', 'non-javascript', 'script blocked', 'zero loss', '欠落'],
    requiredQualificationKeywords: [...COMMON_LIMIT_QUALIFIERS, '損失台帳', 'load_vs_frame', 'script_vs_server', 'loss ledger', '0.01%'],
    forbiddenClaims: ['欠損ゼロ', '欠落ゼロ', '情報欠落ゼロ', 'zero data loss', '100% of page views captured'],
  },
  {
    id: 'tel.U3',
    domain: 'tel',
    topic: '最終フレーム後の状態と真の離脱時刻',
    limitation: '最後に到達確認されたフレーム以降の行動と正確な離脱時刻は、モバイル終了や回線切断により取得できない場合がある。',
    specBasis: 'ブラウザ終了イベント (beforeunload/pagehide) の非保証性 (TEL A6 U3 / [br 3])',
    strongestProxy: '[最終到達状態, 最終状態 + 心拍間隔 h] の区間と 2 秒監査群バイアス推定',
    proxyUpperBound: '単一 PV の正確な末尾状態は不明。集計末尾指標は心拍幅 h による区間付き (inferred/observed) が上限。',
    unlockRequirement: '単一 PV に対しては原理的に不可（集団バイアスは監査群と fetchLater で狭める）',
    triggerKeywords: ['離脱時刻', '真の離脱', '最終状態', 'exit time', 'terminal state', 'session end'],
    requiredQualificationKeywords: [...COMMON_LIMIT_QUALIFIERS, '心拍', 'terminal_unconfirmed', 'audit', '区間', 'h'],
    forbiddenClaims: ['正確な離脱時刻を100%取得', 'モバイル離脱を完全捕捉', 'exact exit time guaranteed'],
  },
  {
    id: 'tel.U4',
    domain: 'tel',
    topic: '訪問ごとの自然検索クエリ・ナビゲーションヘッダ・IP・HttpOnly Cookie',
    limitation: 'ブラウザ内スクリプトは自然検索の個別クエリ、ナビゲーションリクエストヘッダ、IP、HttpOnly Cookie を読み取れない。',
    specBasis: 'ブラウザ参照元制限 (Referer に検索語を含まない)・Same-Origin/HttpOnly 仕様 (TEL A6 U4 / §4.9 / §16.4)',
    strongestProxy: 'Search Console の着地ページ × 日 × 端末 × 国の分布 (q_prior) と仮定を置かないクエリ別到達率の上下限、およびオリジン/エッジによるエコー',
    proxyUpperBound: '訪問ごとの検索クエリは取得不可。クエリ別行動は分布・上下限 (inferred、幅 ≤ 0.3 のみ提示) が上限。',
    unlockRequirement: 'ヘッダ・Cookie はオリジンキット/ゾーン Worker で取得可。自然検索の訪問別クエリは検索エンジン仕様上開かない。',
    triggerKeywords: ['検索クエリ', '自然検索クエリ', 'search query', 'organic query', 'per-session query', 'gsc query'],
    requiredQualificationKeywords: [...COMMON_LIMIT_QUALIFIERS, '分布', 'distribution', 'q_prior', '着地ページ', 'search console'],
    forbiddenClaims: ['訪問ごとの検索クエリを取得', 'ユーザーごとの検索語を特定', 'per-visit organic query observed'],
  },
  {
    id: 'tel.U5',
    domain: 'tel',
    topic: '別オリジン枠 (iframe) の中身とマーチャント側の成果発生',
    limitation: '別オリジン iframe 内の行動や、外部マーチャントサイト上で完了した成約・購入は自サイトのブラウザからは見えない。',
    specBasis: 'Same-Origin Policy (TEL A6 U5)',
    strongestProxy: '枠の露出とフォーカス遷移 (blur proxy, inferred)、およびアフィリエイトネットワーク成果報告との突合',
    proxyUpperBound: '枠内操作は位置・露出まで (inferred)。マーチャント側成果はネットワーク報告の結合粒度まで。',
    unlockRequirement: 'ネットワーク成果報告コネクタ結合 (join M5) および A-15R 発行者サブパラメータ',
    triggerKeywords: ['iframe', '別オリジン', 'クロスオリジン', 'マーチャント', 'cross-origin', 'merchant conversion'],
    requiredQualificationKeywords: [...COMMON_LIMIT_QUALIFIERS, '露出', 'ネットワーク報告', '粒度', 'blur'],
    forbiddenClaims: ['別オリジンiframe内の操作を完全追跡', 'cross-origin iframe fully recorded'],
  },
  {
    id: 'tel.U6',
    domain: 'tel',
    topic: 'ブラウザ・端末・識別子リセット・Safari 7日制限を跨ぐ同一人物判定',
    limitation: 'Cookie 削除・ITP 7 日/24 時間制限・別端末や別ブラウザを跨いだ同一人物の紐付けは標準計測だけでは知りえない。',
    specBasis: 'Safari ITP / Storage Partitioning 仕様 (TEL A6 U6 / [br 7])',
    strongestProxy: '同一ブラウザ内の Stratum A (HttpOnly 13 か月 Cookie)、および同意済み会員の identify(hex)',
    proxyUpperBound: '未ログイン訪問者の識別は同一ブラウザ・Cookie 寿命内（Safari JS 書込は最大 7 日）が上限。',
    unlockRequirement: 'オリジンキット (Stratum A) および同意目的 member_link による会員 ID 連携',
    triggerKeywords: ['クロスデバイス', '同一人物', '再訪', 'cross-device', 'cross-browser', 'returning user', 'same person'],
    requiredQualificationKeywords: [...COMMON_LIMIT_QUALIFIERS, 'stratum', 'safari', '7日', 'member_link', 'identify', 'ブラウザ単位'],
    forbiddenClaims: ['端末を跨いで匿名ユーザーを完全特定', 'cross-device anonymous identity guaranteed'],
  },
  {
    id: 'tel.U7',
    domain: 'tel',
    topic: 'クリック時のイベントハンドラ実行有無・実視認画素・Chromium 外の遮蔽判定',
    limitation: 'ページ側 JS ハンドラが実際に動いたか、ユーザーが実際に視認した画素、および Chromium 以外での厳密な要素遮蔽はブラウザから確定できない。',
    specBasis: 'DOM イベント仕様・IntersectionObserver v2 の非普及 (TEL A6 U7 / [br 10])',
    strongestProxy: 'no_effect_click 統計＋CRAWL クリック探針での再現、Chromium での上位 ≤20 CTA 遮蔽観測',
    proxyUpperBound: '要素の不具合断定には検査環境での再現が必須。実訪問のみでは無反応統計の提示まで。',
    unlockRequirement: 'CRAWL クリック探針による同一 el_fp 上での再現 (tel.G6)',
    triggerKeywords: ['デッドクリック', '壊れた要素', '無反応クリック', '遮蔽', 'dead click', 'occlusion', 'broken element'],
    requiredQualificationKeywords: [...COMMON_LIMIT_QUALIFIERS, '探針', '再現', 'no_effect_click', '統計', 'probe', 'reproduction'],
    forbiddenClaims: ['デッドクリックを100%正確に判定', 'broken button proved from browser alone'],
  },
  {
    id: 'tel.U8',
    domain: 'tel',
    topic: 'タグ単独導入におけるクライアントの真正性（PV 数の偽造耐性）',
    limitation: '公開キーしか持たないタグ単独導入では、自動化された偽造ブラウザからの PV 数水増しをクライアント側だけで完全に防げない。',
    specBasis: 'ブラウザは秘密鍵を保持できない (TEL A6 U8 / §4.4)',
    strongestProxy: '信頼度階層 (trust tiers)・動的境界・ネットワーク単位日次上限・急増遮断器',
    proxyUpperBound: 'タグ単独では連続性 (continuity) 信頼度まで。PV 総数の偽造耐性は主張できない。',
    unlockRequirement: 'オリジンキット (origin_attested) またはゾーン Worker 受け渡し (edge_attested)',
    triggerKeywords: ['偽造', '真正性', 'タグ単独', 'tag-only', 'authenticity', 'forged pv', 'click fraud'],
    requiredQualificationKeywords: [...COMMON_LIMIT_QUALIFIERS, '信頼度', 'trust', 'origin_attested', 'edge_attested', 'サーバー経路'],
    forbiddenClaims: ['タグのみで偽造PVを完全排除', 'tag-only install prevents all forged traffic'],
  },
  {
    id: 'tel.U9',
    domain: 'tel',
    topic: 'コンテキストメニューや長押しで背景タブに開いたリンク',
    limitation: '右クリックメニューやモバイル長押しで背景タブに開かれた外部リンクは click イベントが発火せず、ブラウザから直接観測できない。',
    specBasis: 'ブラウザはコンテキストメニュー選択結果のイベントを発行しない (TEL A6 U9 / §4.9)',
    strongestProxy: 'new_tab_inferred ヒューリスティック (inferred) およびアフィリエイトネットワーク報告との突合',
    proxyUpperBound: '個別クリックの捕捉漏れは避けられず、比率較正 (join.G13: [0.85, 1.15]) での網羅確認が上限。',
    unlockRequirement: 'ネットワーク報告クリック数との突合較正 (join.G13)',
    triggerKeywords: ['背景タブ', 'バックグラウンドタブ', '長押し', '右クリック', 'background tab', 'context menu', 'long press', '外部リンククリック'],
    requiredQualificationKeywords: [...COMMON_LIMIT_QUALIFIERS, 'new_tab_inferred', 'ネットワーク', '較正', 'join.G13', '取りこぼし'],
    forbiddenClaims: ['すべての外部クリックを漏れなく捕捉', 'background tab opens fully tracked'],
  },
  {
    id: 'tel.U10',
    domain: 'tel',
    topic: 'スクリプトは動いたがコレクターへ到達不能だった PV',
    limitation: 'CSP connect-src 制限・ネットワーク遮断・通信断によりコレクターへ届かなかった PV は受付側からは直接観測できない。',
    specBasis: 'クライアント送信到達の非保証 (TEL A6 U10 / L1)',
    strongestProxy: 'load_vs_frame 比率および導入確認探針 (install_probe)',
    proxyUpperBound: '原因の内訳切り分けにはサーバー経路または探針が必要。',
    unlockRequirement: 'サーバー側観測経路および install_probe (Q-9)',
    triggerKeywords: ['到達不能', 'connect-src', 'コレクター遮断', 'collector unreachable'],
    requiredQualificationKeywords: [...COMMON_LIMIT_QUALIFIERS, 'load_vs_frame', 'install_probe', 'L1'],
    forbiddenClaims: ['すべての送信到達を保証', 'collector delivery 100% guaranteed'],
  },
  {
    id: 'tel.U11',
    domain: 'tel',
    topic: 'SDK 起動・初回送信より前に終了した極短 PV',
    limitation: 'スニペット読込〜SDK 初期化・初回送信完了より前に閉じられた PV はフレームを生成しない。',
    specBasis: 'スクリプト初期化レイテンシ (TEL A6 U11 / L2)',
    strongestProxy: 'start_ms 分布と L1/L2 比率',
    proxyUpperBound: '個別 PV の観測不可。集計上の下限推定まで。',
    unlockRequirement: 'サーバー側文書リクエスト観測 (script_vs_server)',
    triggerKeywords: ['起動前終了', '直帰', '即時離脱', 'before sdk start', 'instant bounce'],
    requiredQualificationKeywords: [...COMMON_LIMIT_QUALIFIERS, 'start_ms', 'L2', 'サーバー経路', 'script_vs_server'],
    forbiddenClaims: ['0ミリ秒離脱をブラウザタグだけで完全計測', 'pre-init bounces fully captured by sdk'],
  },
  {
    id: 'tel.U12',
    domain: 'tel',
    topic: 'GA4 のキーイベント設定および dataLayer 外のタグマネージャ発火',
    limitation: 'どの GA4 イベントが主要成果かはプロパティ側設定であり、dataLayer を経由しないイベントはブラウザから自動判別できない。',
    specBasis: 'GA4 プロパティ設定の非公開性 (TEL A6 U12)',
    strongestProxy: 'サイト別の成果定義設定と網羅性チェック、GA4 接続同期',
    proxyUpperBound: 'サイト設定・GA4 接続なしでは自動キーイベント判別不可。',
    unlockRequirement: 'オーナーによる成果ルール設定および GA4 接続許可 (Q-15)',
    triggerKeywords: ['ga4', 'キーイベント', 'datalayer', 'tag manager', 'key event'],
    requiredQualificationKeywords: [...COMMON_LIMIT_QUALIFIERS, '設定', '外部', 'observed', '同期', 'configuration'],
    forbiddenClaims: ['GA4のキーイベントをタグのみで自動完全同期', 'all gtm events automatically observed'],
  },
  {
    id: 'tel.U13',
    domain: 'tel',
    topic: 'Cookie なし環境でのタブ跨ぎセッション',
    limitation: 'cookieless モード（端末保存禁止）では複数タブにまたがる同一セッションを結合できない。',
    specBasis: 'cookieless 同意制約および sessionStorage のタブ隔離仕様 (TEL A6 U13)',
    strongestProxy: 'タブ単位または PV 単位と明示した指標',
    proxyUpperBound: 'cookieless では PV / タブ単位が上限（セッション単位は not_collected）。',
    unlockRequirement: '同意モード session 以上および法域行の法務署名 (tel.G10 / D-01)',
    triggerKeywords: ['タブ跨ぎ', 'cookieless セッション', 'cross-tab session', 'cookieless session'],
    requiredQualificationKeywords: [...COMMON_LIMIT_QUALIFIERS, 'タブ単位', 'PV単位', 'session', 'tel.G10', 'cookieless'],
    forbiddenClaims: ['cookielessでタブを跨ぐセッションを正確に統合', 'cookieless cross-tab sessions supported'],
  },
  {
    id: 'tel.U14',
    domain: 'tel',
    topic: '手入力とツール自動入力の完全判別・訪問者の年齢・支援技術 (スクリーンリーダー等) の使用有無',
    limitation: 'ブラウザからは訪問者の実年齢、支援技術の使用、および手入力と自動補完の完全な区別は知りえない。',
    specBasis: 'プライバシー保護上のブラウザ仕様 (TEL A6 U14)',
    strongestProxy: 'fill_class (inferred)、サイト設定の minors フラグ、支援技術コホート含むパネル評価',
    proxyUpperBound: '入力種別は inferred、年齢・支援技術は直接検知不可（支援技術利用者をボット誤判定しない設計で保護）。',
    unlockRequirement: '原理的に不可（支援技術誤検知防止は有償パネル act.G15 で上限証明）',
    triggerKeywords: ['支援技術', 'スクリーンリーダー', '年齢', '自動入力', 'assistive technology', 'visitor age', 'autofill detection'],
    requiredQualificationKeywords: [...COMMON_LIMIT_QUALIFIERS, 'fill_class', 'minors', 'パネル', '判別不可'],
    forbiddenClaims: ['訪問者の年齢を自動判定', '支援技術利用者を自動識別', 'exact visitor age detected'],
  },
  {
    id: 'tel.U15',
    domain: 'tel',
    topic: '別ウィンドウに覆われた表示中タブと端末スリープ',
    limitation: 'タブ自体は visible 状態でも他アプリウィンドウに覆われている状態や OS スリープ中の実視認は正確には分からない。',
    specBasis: 'Page Visibility API は別ウィンドウによる遮蔽を返さない (TEL A6 U15 / [br 10])',
    strongestProxy: 'suspend_ms 検出と入力間隔ヒストグラム (無操作しきい値で上限処理)',
    proxyUpperBound: '入力停止ギャップによる上限付き滞在時間推定まで。',
    unlockRequirement: '原理的に不可',
    triggerKeywords: ['ウィンドウ遮蔽', '端末スリープ', 'window covered', 'device sleep', 'background window'],
    requiredQualificationKeywords: [...COMMON_LIMIT_QUALIFIERS, 'suspend_ms', '入力間隔', '無操作', 'input gap'],
    forbiddenClaims: ['別ウィンドウに隠れた状態を完全検知', 'detects occluded browser window accurately'],
  },
  {
    id: 'tel.U16',
    domain: 'tel',
    topic: 'アプリ内ブラウザ (LINE / Yahoo! JAPAN / Google App 等) の固有ライフサイクル仕様',
    limitation: '各アプリ内 WebView の終了イベント・キャッシュ・ストレージ挙動は非公開かつ更新で変化するため一律保証できない。',
    specBasis: 'ベンダー固有 WebView 実装の非標準性 (TEL A6 U16 / [br 3])',
    strongestProxy: 'アプリ内ブラウザを独立系統として分類した損失台帳とリリース毎の実機終了マトリクス (tel.G3)',
    proxyUpperBound: '最新実機マトリクスで検証済みの系統・版に対する区間保証まで。',
    unlockRequirement: 'リリース毎の実機終了マトリクス試験 (tel.G3)',
    triggerKeywords: ['アプリ内ブラウザ', 'in-app browser', 'webview', 'line browser'],
    requiredQualificationKeywords: [...COMMON_LIMIT_QUALIFIERS, '実機', '系統', 'exit matrix', 'tel.G3', '損失台帳'],
    forbiddenClaims: ['全アプリ内ブラウザに完全対応', 'all in-app browsers fully guaranteed'],
  },

  // ===== Actors U1–U4 (§4.9 / §12.2 / §16.4 / ACT §3) =====
  {
    id: 'act.U1',
    domain: 'act',
    topic: 'AI 検索・回答エンジンでの引用事実そのもの（探針した構成を除く）',
    limitation: '実際の利用者が入力したプロンプトと、その回答に自サイトが引用された事実自体は、サイト側の観測からは原理的に知りえない。',
    specBasis: 'AI 回答エンジン側の非公開推論と個別プロンプトの不可視性 (§4.9 / §16.4 / ACT §3)',
    strongestProxy: 'Search Console 標本に基づく公式 API 探針 (ai_citation) とベンダー集計との順位相関検証 (act.G24)',
    proxyUpperBound: '探針した固定構成に対する標本推定値（inferred / 3 週以上）が上限。全実ユーザーの引用実数は不可知。',
    unlockRequirement: 'ベンダーが公式ページ別引用ログを提供しない限り不可（消費者面主張は act.G24 Spearman ≥ 0.6 が条件）',
    triggerKeywords: ['引用', 'ai引用', 'citation', 'cited', 'ai overview citation', 'ai検索引用'],
    requiredQualificationKeywords: [...COMMON_LIMIT_QUALIFIERS, '探針', '標本', 'probe', 'panel', 'act.G24', '構成'],
    forbiddenClaims: ['実際のAI引用件数を完全把握', '全ユーザーのAI引用を直接計測', 'exact wild ai citations observed'],
  },
  {
    id: 'act.U2',
    domain: 'act',
    topic: 'AI 引用からクリックへの遷移・単一の AI 検索フルファネル ROI',
    limitation: 'AI 回答内で引用を見た利用者がクリックしたかどうか（引用→クリック率）はサイト側から観測できず、単一の確定 ROI 数値は算出できない。',
    specBasis: 'AI プラットフォーム上のインプレッション・非参照流入の不可視性 (ACT §3 / ledger #48)',
    strongestProxy: 'ファネル台帳 S0–S7 と roi_band（低=実測参照、中/高=差の差推定・探針結合）',
    proxyUpperBound: '単一点 ROI ではなく幅 (roi_band: low observed / mid・high inferred) と各段階の未達ゲート提示が上限。',
    unlockRequirement: 'アフィリエイト売上結合 (join.M5) で金額換算可、因果効果はディレクトリ単位の無作為化 (act.G28) で検証',
    triggerKeywords: ['ai roi', 'ai検索roi', 'ai-search roi', 'フルファネルroi', '引用クリック', 'citation-to-click', 'citation ctr'],
    requiredQualificationKeywords: [...COMMON_LIMIT_QUALIFIERS, 'roi_band', '低・中・高', '台帳', 'band', 'S0', 'S7'],
    forbiddenClaims: ['AI検索のROIを1本の確定値で算出', 'exact ai-search full-funnel roi', 'citation-to-click rate directly measured'],
  },
  {
    id: 'act.U3',
    domain: 'act',
    topic: 'ローカル AI（利用者自身のブラウザ内で動く AI）の身元と単一セッションの AI 確率',
    limitation: '利用者自身のブラウザ拡張やローカル操作で動く AI エージェントはベンダー署名を出さず、真の有病率 π が不明なため「このセッションが AI である確率」は識別できない。',
    specBasis: 'flagged share = π·TPR + (1-π)·FPR の非識別性およびベンダー署名不在 (§4.9 / §7.5 / §16.4 / ACT §3)',
    strongestProxy: '尤度比スコア＋有償人間パネルで証明した 1 人あたり誤検知率上限 (fpr_upper_panel: 1% / 0.3% / 0.1%)',
    proxyUpperBound: '確率ではなく「人間より何倍それらしいか（尤度比）」と誤検知上限証明書＋採点可能範囲の提示が上限。',
    unlockRequirement: '1,300 人以上の有償人間パネル (act.G15 / D-18) により証明書を付与（点確率は原理的に開かない）',
    triggerKeywords: ['ローカルai', 'ブラウザai', 'ブラウザ操作型ai', 'local ai', 'local agent', 'browser agent', 'ai probability', 'aiである確率'],
    requiredQualificationKeywords: [...COMMON_LIMIT_QUALIFIERS, '尤度比', '誤検知', 'fpr', 'likelihood ratio', '証明書', 'scoreable'],
    forbiddenClaims: ['ブラウザAIを完全検知', 'セッションがAIである確率', 'probability that this session is an ai', '100% browser agent detection'],
  },
  {
    id: 'act.U4',
    domain: 'act',
    topic: '野生の AI エージェントの目的・タスク意図（「詰まり」の真因）',
    limitation: '外部から来訪した未知（野生）の AI エージェントが何の目的・タスクを達成しようとしていたかは観測できず、目標不在のまま「詰まった」とは断定できない。',
    specBasis: '外部エージェントのプロンプト・達成目標の不可視性 (§4.9 / §16.4 / ACT §3)',
    strongestProxy: '4 分離計器（ゼロ通信操作可能性監査・目標固定の検査走行・HTTP 取得摩擦・検証済みホスト型 AI の操作軌跡）',
    proxyUpperBound: '「詰まり」は目標定義済みの検査走行 (lab_agent_run) に限定。野生 AI については取得事実・観測行動の要約まで。',
    unlockRequirement: '検査走行 (act.G20) による目標固定評価（野生 AI の意図自体は原理的に開かない）',
    triggerKeywords: ['野生ai', '野生のai', 'エージェントの目的', 'aiの詰まり', 'wild agent', 'wild ai', 'agent goal', 'agent stuck', '摩擦ヒートマップ'],
    requiredQualificationKeywords: [...COMMON_LIMIT_QUALIFIERS, '4つ', '検査走行', '操作可能性監査', '目標', 'instrument', 'lab'],
    forbiddenClaims: ['全AI共通の摩擦ヒートマップで野生AIの詰まりを特定', 'wild agent goal identified', 'unified friction heatmap for all agents'],
  },

  // ===== Evidence U1 (§9.9 / §16.4) =====
  {
    id: 'ev.U1',
    domain: 'ev',
    topic: '前後比較・観測データ・SHAP 寄与度だけからの因果「原因」',
    limitation: '変更前後比較（対照群付き準実験を含む）や予測モデルの TreeSHAP 寄与度からは因果的な「原因」を証明できない。',
    specBasis: '時系列自己相関・未観測交絡・予測寄与≠介入効果の統計限界 (§8.4 / §9.9 / §16.4)',
    strongestProxy: '変更効果台帳 (observed, 偽介入較正付き) および TreeSHAP「モデルが何を使ったか」→ 事前登録した無作為実験 (proven) の候補生成',
    proxyUpperBound: '前後比較・観測台帳は最大 observed、SHAP/超過離脱検出は最大 inferred。因果・原因は事前登録した無作為介入 (proven) のみ。',
    unlockRequirement: 'アロケータによる訪問者無作為化またはページ単位無作為展開 (ev.G-14 / ev.G-15)',
    triggerKeywords: ['前後比較', '因果', '原因', 'shap', 'treeshap', '寄与度', 'before/after', 'causal', 'root cause'],
    requiredQualificationKeywords: [...COMMON_LIMIT_QUALIFIERS, '無作為', '実験', 'proven', 'モデルが何を使ったか', '準実験', 'randomised', 'randomized'],
    forbiddenClaims: ['前後比較から原因を断定', 'TreeSHAPで低CVRの原因を正確に特定', 'proves causality from before/after', 'shap identifies true causal root cause'],
  },
] as const

const UNKNOWABLE_MAP = new Map<string, UnknowableEntry>(
  UNKNOWABLES_LEDGER.map((entry) => [entry.id, entry]),
)

export function getUnknowable(id: string): UnknowableEntry | undefined {
  return UNKNOWABLE_MAP.get(id)
}

export interface AuditDescriptionOptions {
  readonly operationId?: string
  /** Limit IDs explicitly declared in the operation's structured metadata (`limits[]`) */
  readonly declaredLimitIds?: ReadonlyArray<string>
}

/**
 * Audit an API or MCP tool description against the Unknowables Ledger (§4.9 / TEL M9 lint).
 *
 * Rules:
 *   1. Any match against `forbiddenClaims` is an immediate failure (`forbidden_claim`).
 *   2. If the text touches a topic (`triggerKeywords`), it MUST either declare the
 *      corresponding `limitId` in `declaredLimitIds` AND/OR state the limitation / upper bound
 *      using one of `requiredQualificationKeywords`. Otherwise it fails (`missing_upper_bound`).
 */
export function auditDescriptionAgainstUnknowables(
  description: string,
  options: AuditDescriptionOptions = {},
): UnknowableAuditResult {
  const normalized = description.toLowerCase()
  const declaredSet = new Set(options.declaredLimitIds ?? [])
  const matchedLimitIds: string[] = []
  const violations: UnknowableAuditViolation[] = []

  for (const entry of UNKNOWABLES_LEDGER) {
    // 1. Check hard-banned claims first
    const forbiddenMatch = entry.forbiddenClaims.find((claim) =>
      normalized.includes(claim.toLowerCase()),
    )
    if (forbiddenMatch) {
      matchedLimitIds.push(entry.id)
      violations.push({
        limitId: entry.id,
        topic: entry.topic,
        kind: 'forbidden_claim',
        matchedKeyword: forbiddenMatch,
        message: `[${entry.id}] Description contains forbidden absolute claim "${forbiddenMatch}" violating unknowable limit: ${entry.limitation}`,
      })
      continue
    }

    // 2. Check whether description mentions this unknowable topic
    const triggerMatch = entry.triggerKeywords.find((kw) =>
      normalized.includes(kw.toLowerCase()),
    )
    if (!triggerMatch) {
      continue
    }

    matchedLimitIds.push(entry.id)

    const hasInlineQualification = entry.requiredQualificationKeywords.some((q) =>
      normalized.includes(q.toLowerCase()),
    )
    const hasDeclaredId = declaredSet.has(entry.id)

    if (!hasInlineQualification && !hasDeclaredId) {
      violations.push({
        limitId: entry.id,
        topic: entry.topic,
        kind: 'missing_upper_bound',
        matchedKeyword: triggerMatch,
        message: `[${entry.id}] Description touches "${entry.topic}" (matched "${triggerMatch}") without stating its upper bound or declaring limit id "${entry.id}". Upper bound: ${entry.proxyUpperBound}`,
      })
    }
  }

  return {
    passed: violations.length === 0,
    ...(options.operationId ? { operationId: options.operationId } : {}),
    matchedLimitIds,
    violations,
  }
}

export interface CatalogDescriptionItem {
  readonly operationId: string
  readonly description: string
  readonly declaredLimitIds?: ReadonlyArray<string>
}

/**
 * Batch-audit a full REST / MCP catalogue of operation descriptions for CI release gating.
 */
export function auditCatalogDescriptions(
  items: ReadonlyArray<CatalogDescriptionItem>,
): {
  readonly passed: boolean
  readonly totalChecked: number
  readonly failedCount: number
  readonly results: ReadonlyArray<UnknowableAuditResult>
} {
  const results = items.map((item) =>
    auditDescriptionAgainstUnknowables(item.description, {
      operationId: item.operationId,
      declaredLimitIds: item.declaredLimitIds,
    }),
  )
  const failedCount = results.filter((r) => !r.passed).length
  return {
    passed: failedCount === 0,
    totalChecked: results.length,
    failedCount,
    results,
  }
}
