# ボタン計測機能の提案

**作成日**: 2025年1月26日  
**目的**: ページに設置されているボタンの計測を実現する方法を提案

---

## 🎯 目標

ページに設置されているボタンの以下を計測できるようにする：
- クリック数
- クリック率（CTR）
- クリック位置（座標）
- ボタンの種類・識別子
- デバイス別のクリック分布
- 時間帯別のクリック傾向

---

## 📊 現状の分析

### 現在のクリック計測機能

現在のシステムでは、以下のクリックデータを取得しています：
- ✅ クリック座標（`click_x`, `click_y`）
- ✅ 要素情報（`element_tag_name`, `element_id`, `element_class_name`）
- ✅ 要素テキスト（`element_text`）
- ✅ セッション情報
- ✅ デバイス情報

### 課題

1. **ボタンの識別が困難**: 同じクラス名のボタンが複数ある場合、区別できない
2. **ボタンの種類が不明**: 通常のボタン、リンクボタン、フォーム送信ボタンなどの区別ができない
3. **ボタンの意味が不明**: 「購入」「登録」「問い合わせ」などのボタンの目的が分からない

---

## 💡 提案1: データ属性によるボタン識別（推奨）

### 概要

HTMLの`data-*`属性を使用して、ボタンに識別子や意味を付与する方法。

### 実装方法

#### フロントエンド（トラッキングスクリプト側）

```javascript
// クリックイベントの拡張
trackers.click = (e) => {
  const element = e.target;
  const rect = element.getBoundingClientRect();
  const scrollY = window.scrollY || window.pageYOffset;

  // データ属性からボタン情報を取得
  const buttonId = element.getAttribute('data-button-id');
  const buttonType = element.getAttribute('data-button-type'); // 'cta', 'form', 'link', 'custom'
  const buttonPurpose = element.getAttribute('data-button-purpose'); // 'purchase', 'register', 'contact', etc.
  const buttonLabel = element.getAttribute('data-button-label'); // 表示ラベル

  queueEvent({
    event_type: 'click',
    // 既存のフィールド
    click_x: Math.round(e.clientX),
    click_y: Math.round(e.clientY + scrollY),
    element_tag_name: element.tagName.toLowerCase(),
    element_id: element.id || '',
    element_class_name: element.className || '',
    // 新規フィールド
    button_id: buttonId || null,
    button_type: buttonType || null,
    button_purpose: buttonPurpose || null,
    button_label: buttonLabel || null,
    is_button: element.tagName === 'BUTTON' || 
               element.tagName === 'A' || 
               element.getAttribute('role') === 'button' ||
               element.classList.contains('btn') ||
               element.classList.contains('button'),
  });
};
```

#### HTML側（ユーザーが設置）

```html
<!-- 例1: CTAボタン -->
<button 
  data-button-id="hero-cta"
  data-button-type="cta"
  data-button-purpose="register"
  data-button-label="無料で始める"
  class="btn btn-primary">
  無料で始める
</button>

<!-- 例2: フォーム送信ボタン -->
<button 
  data-button-id="contact-submit"
  data-button-type="form"
  data-button-purpose="contact"
  data-button-label="送信"
  type="submit">
  送信
</button>

<!-- 例3: リンクボタン -->
<a 
  href="/pricing"
  data-button-id="pricing-link"
  data-button-type="link"
  data-button-purpose="pricing"
  data-button-label="料金を見る"
  class="btn btn-outline">
  料金を見る
</a>
```

### メリット

- ✅ **実装が簡単**: HTMLに属性を追加するだけ
- ✅ **柔軟性が高い**: 任意のボタンに識別子を付与できる
- ✅ **既存コードへの影響が少ない**: 既存のHTMLを変更するだけ
- ✅ **自動検出も可能**: `is_button`フラグでボタンかどうかを自動判定

### デメリット

- ⚠️ **手動設定が必要**: すべてのボタンに属性を追加する必要がある
- ⚠️ **一貫性の維持**: 属性の命名規則を統一する必要がある

---

## 💡 提案2: 自動ボタン検出と分類

### 概要

トラッキングスクリプトが自動的にボタンを検出し、要素の特徴から分類する方法。

### 実装方法

```javascript
// ボタンの自動検出と分類
function detectButtonType(element) {
  // 1. タグ名による判定
  if (element.tagName === 'BUTTON') {
    return {
      type: 'button',
      purpose: detectButtonPurpose(element)
    };
  }
  
  // 2. リンク要素の判定
  if (element.tagName === 'A' && element.href) {
    const href = element.href;
    if (href.includes('mailto:')) return { type: 'link', purpose: 'email' };
    if (href.includes('tel:')) return { type: 'link', purpose: 'phone' };
    if (href.includes('#') && !href.includes('http')) return { type: 'link', purpose: 'anchor' };
    return { type: 'link', purpose: 'navigation' };
  }
  
  // 3. フォーム要素の判定
  if (element.tagName === 'INPUT' && element.type === 'submit') {
    return { type: 'form', purpose: 'submit' };
  }
  
  // 4. クラス名による判定
  const classList = element.className.toLowerCase();
  if (classList.includes('btn') || classList.includes('button')) {
    return {
      type: 'custom',
      purpose: detectButtonPurpose(element)
    };
  }
  
  // 5. role属性による判定
  if (element.getAttribute('role') === 'button') {
    return { type: 'custom', purpose: 'interactive' };
  }
  
  return null;
}

// ボタンの目的を検出（テキスト内容から推測）
function detectButtonPurpose(element) {
  const text = (element.textContent || element.innerText || '').toLowerCase().trim();
  const id = (element.id || '').toLowerCase();
  const className = (element.className || '').toLowerCase();
  
  // キーワードマッチング
  const keywords = {
    purchase: ['購入', 'buy', 'purchase', 'カート', 'cart', '注文', 'order'],
    register: ['登録', 'register', 'signup', 'sign up', '会員登録', '新規登録'],
    contact: ['問い合わせ', 'contact', 'お問い合わせ', 'inquiry', '連絡'],
    download: ['ダウンロード', 'download', 'dl'],
    subscribe: ['購読', 'subscribe', '登録', 'register'],
    login: ['ログイン', 'login', 'sign in', 'サインイン'],
    logout: ['ログアウト', 'logout', 'sign out', 'サインアウト'],
    share: ['シェア', 'share', '共有'],
    like: ['いいね', 'like', 'お気に入り', 'favorite'],
  };
  
  for (const [purpose, words] of Object.entries(keywords)) {
    if (words.some(word => text.includes(word) || id.includes(word) || className.includes(word))) {
      return purpose;
    }
  }
  
  return 'unknown';
}
```

### メリット

- ✅ **自動検出**: 手動設定が不要
- ✅ **既存サイトに対応**: 既存のHTMLを変更する必要がない
- ✅ **包括的**: すべてのボタンを自動的に検出

### デメリット

- ⚠️ **精度の問題**: テキスト内容からの推測は100%正確ではない
- ⚠️ **多言語対応**: 日本語と英語の両方に対応する必要がある
- ⚠️ **カスタマイズ性が低い**: ユーザーが意図した分類と異なる可能性がある

---

## 💡 提案3: ハイブリッド方式（推奨）

### 概要

データ属性による明示的な識別と、自動検出を組み合わせた方式。

### 実装方法

```javascript
// 優先順位: データ属性 > 自動検出
function getButtonInfo(element) {
  // 1. データ属性を優先的に使用
  const buttonId = element.getAttribute('data-button-id');
  const buttonType = element.getAttribute('data-button-type');
  const buttonPurpose = element.getAttribute('data-button-purpose');
  const buttonLabel = element.getAttribute('data-button-label');
  
  // 2. データ属性がない場合は自動検出
  if (!buttonType || !buttonPurpose) {
    const detected = detectButtonType(element);
    return {
      button_id: buttonId || generateButtonId(element),
      button_type: buttonType || detected?.type || 'unknown',
      button_purpose: buttonPurpose || detected?.purpose || 'unknown',
      button_label: buttonLabel || (element.textContent || '').trim().substring(0, 50),
      is_auto_detected: !buttonType || !buttonPurpose
    };
  }
  
  return {
    button_id: buttonId || generateButtonId(element),
    button_type: buttonType,
    button_purpose: buttonPurpose,
    button_label: buttonLabel || (element.textContent || '').trim().substring(0, 50),
    is_auto_detected: false
  };
}

// ボタンIDの自動生成（データ属性がない場合）
function generateButtonId(element) {
  if (element.id) return element.id;
  
  const text = (element.textContent || '').trim().substring(0, 20);
  const className = element.className.split(' ')[0] || '';
  const tagName = element.tagName.toLowerCase();
  
  return `${tagName}-${className || 'no-class'}-${text.replace(/\s+/g, '-')}`.toLowerCase();
}
```

### メリット

- ✅ **柔軟性**: 重要なボタンには明示的に識別子を付与、その他は自動検出
- ✅ **精度**: 重要なボタンは確実に識別できる
- ✅ **実用性**: 既存サイトにも対応しつつ、新規サイトでは詳細な設定が可能

---

## 📊 データベーススキーマの拡張

### 既存の`events`テーブルに追加するフィールド

```sql
ALTER TABLE clickinsight.events
ADD COLUMN IF NOT EXISTS button_id Nullable(String),
ADD COLUMN IF NOT EXISTS button_type Nullable(String), -- 'button', 'link', 'form', 'custom'
ADD COLUMN IF NOT EXISTS button_purpose Nullable(String), -- 'purchase', 'register', 'contact', etc.
ADD COLUMN IF NOT EXISTS button_label Nullable(String),
ADD COLUMN IF NOT EXISTS is_button UInt8 DEFAULT 0,
ADD COLUMN IF NOT EXISTS is_auto_detected UInt8 DEFAULT 0;
```

### 新しい`button_analytics`テーブル（集約用）

```sql
CREATE TABLE IF NOT EXISTS clickinsight.button_analytics (
  id String,
  site_id String,
  button_id String,
  button_type String,
  button_purpose String,
  button_label String,
  page_url String,
  clicks UInt32,
  unique_sessions UInt32,
  ctr Float32, -- クリック率
  avg_click_x UInt16,
  avg_click_y UInt16,
  device_type String,
  first_click DateTime,
  last_click DateTime,
  created_at DateTime DEFAULT now()
) ENGINE = SummingMergeTree(clicks, unique_sessions)
ORDER BY (site_id, button_id, page_url, device_type)
PARTITION BY toYYYYMM(created_at);
```

---

## 🎨 UI/UXの改善提案

### ダッシュボードへの追加

1. **ボタン分析セクション**
   - ボタン別のクリック数ランキング
   - ボタン別のCTR
   - ボタンの種類別の分布
   - ボタンの目的別の分布

2. **ボタンヒートマップ**
   - ボタンの位置を可視化
   - クリック数の多いボタンを強調表示

3. **ボタン最適化の提案**
   - CTRが低いボタンの特定
   - ボタンの位置やデザインの改善提案

---

## 📝 実装ステップ

### Phase 1: データ収集の拡張
1. トラッキングスクリプトにボタン検出機能を追加
2. データベーススキーマを拡張
3. APIエンドポイントを更新

### Phase 2: データ分析機能
1. ボタン分析用のAPIエンドポイントを作成
2. ボタン別の統計を計算
3. ボタン分析ページを作成

### Phase 3: UI/UXの改善
1. ダッシュボードにボタン分析セクションを追加
2. ボタンヒートマップを実装
3. ボタン最適化の提案機能を追加

---

## 🔍 考慮事項

### プライバシー
- ボタンのラベルに個人情報が含まれる可能性があるため、適切に処理する必要がある

### パフォーマンス
- ボタン検出の処理が重くならないよう、最適化が必要

### 互換性
- 既存のクリック計測機能との互換性を保つ必要がある

---

## 📚 参考資料

- [HTML data-* 属性](https://developer.mozilla.org/ja/docs/Web/HTML/Global_attributes/data-*)
- [ARIA role="button"](https://developer.mozilla.org/ja/docs/Web/Accessibility/ARIA/Roles/button_role)
- [Web Analytics Best Practices](https://www.analyticsvidhya.com/blog/2021/06/web-analytics-best-practices/)

---

**最終更新**: 2025年1月26日

