# トラッキングスクリプト設定ガイド

## 基本的な実装

### デフォルト（Cookie同意不要）

最もシンプルな実装。日本や多くの国で使用可能です。

```html
<script
  src="https://your-domain.com/tracking.js"
  data-site-id="your-site-id"
></script>
```

または

```html
<script
  src="https://your-domain.com/track.js"
  data-site-id="your-site-id"
  data-api-url="https://your-domain.com/api/track"
></script>
```

## Cookie同意が必要な場合（EU/GDPR対応）

EUやGDPR対応が必要な地域では、以下のように実装してください。

### ステップ1: Cookie同意バナーを実装

```html
<!-- Cookie同意バナー -->
<div id="cookie-banner" style="display: none; position: fixed; bottom: 0; left: 0; right: 0; background: #333; color: white; padding: 20px; z-index: 9999;">
  <div style="max-width: 1200px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center;">
    <p>このサイトはCookieを使用してサイトの使いやすさを向上させています。</p>
    <div>
      <button onclick="acceptTracking()" style="background: #4CAF50; color: white; border: none; padding: 10px 20px; margin-left: 10px; cursor: pointer;">
        同意する
      </button>
      <button onclick="declineTracking()" style="background: #f44336; color: white; border: none; padding: 10px 20px; margin-left: 10px; cursor: pointer;">
        拒否する
      </button>
    </div>
  </div>
</div>

<script>
  // Cookie同意の確認
  function checkConsentStatus() {
    const consent = localStorage.getItem('clickinsight_cookie_consent');
    if (consent === null) {
      // 未設定の場合はバナーを表示
      document.getElementById('cookie-banner').style.display = 'block';
    }
  }

  // 同意する
  function acceptTracking() {
    localStorage.setItem('clickinsight_cookie_consent', 'true');
    document.getElementById('cookie-banner').style.display = 'none';
    location.reload(); // トラッキング開始のためページをリロード
  }

  // 拒否する
  function declineTracking() {
    localStorage.setItem('clickinsight_cookie_consent', 'false');
    localStorage.setItem('clickinsight_optout', 'true');
    document.getElementById('cookie-banner').style.display = 'none';
  }

  // ページ読み込み時にチェック
  checkConsentStatus();
</script>
```

### ステップ2: トラッキングスクリプトを読み込む（同意必須モード）

```html
<script
  src="https://your-domain.com/tracking.js"
  data-site-id="your-site-id"
  data-require-consent="true"
></script>
```

## 設定オプション

### data-site-id（必須）
サイトを識別するID。ClickInsight Proの管理画面で発行されます。

```html
data-site-id="your-site-id"
```

### data-require-consent（オプション）
Cookie同意を必須にするかどうか。

- `true`: Cookie同意が必要（GDPR対応）
- デフォルト: `false`（同意不要）

```html
data-require-consent="true"
```

### data-api-url（オプション）
トラッキングデータの送信先API。

- デフォルト: `/api/track`
- カスタムドメインを使用する場合に設定

```html
data-api-url="https://analytics.your-domain.com/api/track"
```

### CLICKINSIGHT_DEBUG（オプション）
デバッグモードを有効にする。コンソールにログが出力されます。

```html
<script>
  window.CLICKINSIGHT_DEBUG = true;
</script>
<script src="https://your-domain.com/tracking.js" data-site-id="your-site-id"></script>
```

## WordPress実装例

### functions.phpに追加

```php
<?php
function add_clickinsight_tracking() {
  $site_id = 'your-site-id'; // ここに実際のサイトIDを入力
  $require_consent = false; // EU向けの場合はtrueに設定

  ?>
  <script
    src="<?php echo esc_url('https://your-domain.com/tracking.js'); ?>"
    data-site-id="<?php echo esc_attr($site_id); ?>"
    <?php if ($require_consent): ?>
    data-require-consent="true"
    <?php endif; ?>
  ></script>
  <?php
}
add_action('wp_footer', 'add_clickinsight_tracking');
```

## プライバシー機能

### ユーザーがオプトアウトする方法

ユーザーがトラッキングを無効にできる設定ページを提供することを推奨します。

```html
<h2>プライバシー設定</h2>
<button onclick="optOutTracking()">トラッキングを無効にする</button>
<button onclick="optInTracking()">トラッキングを有効にする</button>

<script>
  function optOutTracking() {
    localStorage.setItem('clickinsight_optout', 'true');
    alert('トラッキングを無効にしました。');
    location.reload();
  }

  function optInTracking() {
    localStorage.removeItem('clickinsight_optout');
    localStorage.setItem('clickinsight_cookie_consent', 'true');
    alert('トラッキングを有効にしました。');
    location.reload();
  }
</script>
```

## Cookie同意が必要かどうかの判断基準

### 同意が不要なケース
- 日本国内向けサイト
- 匿名化されたヒートマップ分析のみ
- サイトの機能として必須なトラッキング
- 個人を特定しない統計データのみ

### 同意が必要なケース
- EU圏内のユーザーを対象とするサイト
- 個人を特定できる長期的なトラッキング
- マーケティング目的の行動追跡
- サードパーティとデータを共有する場合

## よくある質問

### Q: デフォルトで同意が不要な理由は？
A: ClickInsight Proは匿名化されたヒートマップとクリック分析を提供します。個人を特定せず、サイトの改善に必要な「必須Cookie」として扱えるため、多くの場合で同意は不要です。

### Q: EUユーザー向けにどう設定すべき？
A: `data-require-consent="true"`を設定し、Cookie同意バナーを実装してください。

### Q: Cookie同意とオプトアウトの違いは？
A:
- **Cookie同意**: トラッキング開始前にユーザーの許可を得る（GDPR要件）
- **オプトアウト**: トラッキング開始後、ユーザーが自主的に無効にできる機能

### Q: 開発環境でテストするには？
A: デバッグモードを有効にして、ブラウザのコンソールでログを確認してください。

```html
<script>window.CLICKINSIGHT_DEBUG = true;</script>
<script src="/tracking.js" data-site-id="test-site-001"></script>
```

## トラブルシューティング

### トラッキングが動作しない場合

1. **ブラウザのコンソールを確認**
   - デバッグモードを有効にして、エラーメッセージを確認

2. **Cookie同意を確認**
   - コンソールで実行: `localStorage.getItem('clickinsight_cookie_consent')`
   - オプトアウトを確認: `localStorage.getItem('clickinsight_optout')`

3. **サイトIDを確認**
   - スクリプトタグの`data-site-id`が正しく設定されているか確認

4. **APIエンドポイントを確認**
   - ネットワークタブで`/api/track`へのリクエストが成功しているか確認

### データが表示されない場合

1. **データベース接続を確認**
   - ClickHouseとRedisが起動しているか確認

2. **環境変数を確認**
   - `.env.local`で`CLICKHOUSE_URL`と`REDIS_URL`が設定されているか確認

3. **API実装を確認**
   - `/api/track`エンドポイントが正常に動作しているか確認
