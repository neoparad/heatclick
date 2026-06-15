# ESLint custom rule 段階適用 + CI cutover plan

**起票**: Infrastructure Engineer (2026-05-16 夜)
**親 SSOT**: `linkscrawl/docs/fusion/strategy/19_grand_v1.md` §5.2 / §5.3.3 (1 アクセント原則の機械化)
**対応裁定**: decisions.md 2026-05-16 夕 — Infra タスク 2 (FE-Q3 採用 + Reviewer C-3 IconChip variant 制限の 2 層防御連動)
**期限**: warning 段階 = Sprint 0 着工と同時 / hard fail カットオーバー = **Sprint 5 開始日**

---

## 1. 目的 (FE-Q3 + Reviewer C-3 統合)

| 層 | 目的 | 実装 |
|---|---|---|
| 層1 | グラデ class 名の手書き禁止 (ヒーロー / primary CTA / 主要 KPI 1 枚 / 主要 4 機能アイコン以外) | ESLint `no-restricted-syntax` で `bg-brand-grad*` literal を検出 |
| 層2 | アイコンチップ変色防止 (Reviewer C-3 #2) | カスタム rule `enforce-iconchip-variant` で `<IconChip>` の variant prop を `'brand' \| 'neutral'` に enum 制限 + variant 未指定エラー |

§17 アンチパターン #1 (5 色グラデの並置) と #2 (カードごとに違う色アイコン) を **コミット時に自動阻止**することで、Designer review なしでも 1 アクセント原則が破られない状態を作る。

---

## 2. 段階適用スケジュール

| 期間 | severity | CI 動作 | 備考 |
|---|---|---|---|
| Sprint 0 着工日 〜 Sprint 5 開始 1 日前 | `warn` | CI green、PR レビューで visual 確認 | Frontend が `bg-brand-grad*` 許可リスト 5 箇所 (§5.3.3 列挙) を順次 IconChip / 共通コンポネントに集約 |
| **Sprint 5 開始日 (Day 1) 0:00 JST** | **`error`** | **CI red、PR ブロック** | カットオーバー以降、新規違反は merge 不可。warning 残骸は事前に Frontend が消化 |

**カットオーバー条件** (Sprint 5 開始 3 日前までに Director 確認):

- 全リポジトリ `npm run lint` で `bg-brand-grad*` warning ゼロ
- 全 IconChip 利用箇所が `variant="brand" | "neutral"` のいずれかを明示
- Visual regression (Ladle、Sprint 5 内導入予定) で v17 §12 完成チェックリスト 17 項目 pass

---

## 3. .eslintrc.js 実装案

```javascript
// .eslintrc.js (新規作成、Sprint 0 S0-02 完了後即時 commit)
module.exports = {
  root: true,
  extends: ['next/core-web-vitals', 'next/typescript', 'plugin:@typescript-eslint/recommended'],
  parser: '@typescript-eslint/parser',
  parserOptions: { project: './tsconfig.json' },
  plugins: ['@typescript-eslint', 'ugokimap'],
  ignorePatterns: [
    'node_modules/**', '.next/**', 'public/**',
    // mockup HTML は除外 (Frontend Programmer が v17 移植中、ESLint 対象は app/ + components/ のみ)
    'mockups/**', 'docs/**',
  ],
  rules: {
    // ===== 層1: bg-brand-grad* literal 制限 =====
    // Sprint 0-5: severity 'warn' / Sprint 5 cutover: severity 'error'
    // 検出: JSX className 内の "bg-brand-grad*" literal
    'no-restricted-syntax': [
      // SEVERITY_PLACEHOLDER は Sprint 5 cutover 時に scripts/eslint-cutover.mjs で 'warn' → 'error' に書換
      process.env.UGOKIMAP_LINT_LEVEL === 'error' ? 'error' : 'warn',
      {
        selector: "JSXAttribute[name.name='className'] Literal[value=/bg-brand-grad/]",
        message:
          "bg-brand-grad* class は §5.3.3 で <IconChip variant='brand'> / <BrandHeading> / <PrimaryCTA> / <KpiCardHero> 経由のみ許可。直接書きせず共通コンポネントを使用してください (1 アクセント原則 / docs/infra/eslint-ci-cutover.md §1)。",
      },
      {
        selector:
          "JSXAttribute[name.name='className'] TemplateLiteral TemplateElement[value.raw=/bg-brand-grad/]",
        message: 'bg-brand-grad* class はテンプレート文字列内でも禁止 (上記同理由)',
      },
      {
        // clsx() / cn() 引数内も検出
        selector:
          "CallExpression[callee.name=/^(clsx|cn|classNames)$/] Literal[value=/bg-brand-grad/]",
        message: 'bg-brand-grad* は clsx/cn/classNames 引数内でも禁止 (上記同理由)',
      },
    ],

    // ===== 層2: IconChip variant 制限 =====
    // カスタム rule (eslint-plugin-ugokimap、§4 参照)
    'ugokimap/enforce-iconchip-variant': process.env.UGOKIMAP_LINT_LEVEL === 'error' ? 'error' : 'warn',

    // 既存ルール
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'error',
    'react/no-unescaped-entities': 'off',
    '@next/next/no-html-link-for-pages': 'off',
  },
  overrides: [
    {
      // テストファイルは緩める
      files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx', 'tests/**'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        'no-restricted-syntax': 'off',
      },
    },
  ],
}
```

**環境変数 driven の理由**: ローカルで warning を見ながら直し、CI で hard fail に切替えるための機構。`UGOKIMAP_LINT_LEVEL` 未設定 = warn (default)、`UGOKIMAP_LINT_LEVEL=error` = hard fail。

---

## 4. カスタム rule (ローカルプラグイン) 実装

### 4.1 plugin 配置

`tools/eslint-plugin-ugokimap/` (monorepo 化せず、リポ内ローカルプラグイン):

```
tools/eslint-plugin-ugokimap/
├── index.js              # plugin export
├── package.json          # name: "eslint-plugin-ugokimap", main: "index.js"
└── rules/
    ├── enforce-iconchip-variant.js
    └── README.md
```

`package.json` (root) に dev dependency 追加:

```json
{
  "devDependencies": {
    "eslint-plugin-ugokimap": "file:./tools/eslint-plugin-ugokimap"
  }
}
```

### 4.2 enforce-iconchip-variant.js (実装スケルトン — Frontend Programmer が起草、本 doc は仕様)

```javascript
// tools/eslint-plugin-ugokimap/rules/enforce-iconchip-variant.js
'use strict'

const ALLOWED_VARIANTS = ['brand', 'neutral']

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'IconChip variant prop must be "brand" or "neutral" (1 アクセント原則 §5.3.3 / Reviewer C-3 #2)',
    },
    schema: [],
    messages: {
      missing:
        "IconChip コンポネントには variant='brand' または variant='neutral' を必ず指定してください。色 token を直接 className 渡しは禁止 (§5.3.3 / Reviewer C-3 #2)。",
      invalid:
        "IconChip variant='{{value}}' は許可されていません。'brand' または 'neutral' のみ使用可。新規 variant の追加は Designer + Director レビュー必須 (§17 §12 完成チェックリスト)。",
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'IconChip') return

        const variantAttr = node.attributes.find(
          (a) => a.type === 'JSXAttribute' && a.name?.name === 'variant'
        )

        if (!variantAttr) {
          context.report({ node, messageId: 'missing' })
          return
        }

        // variant="..." literal のみ許可 (動的代入は禁止 = 検出不能のため)
        if (variantAttr.value?.type !== 'Literal') {
          context.report({
            node: variantAttr,
            messageId: 'invalid',
            data: { value: '<dynamic>' },
          })
          return
        }

        if (!ALLOWED_VARIANTS.includes(variantAttr.value.value)) {
          context.report({
            node: variantAttr,
            messageId: 'invalid',
            data: { value: String(variantAttr.value.value) },
          })
        }
      },
    }
  },
}
```

```javascript
// tools/eslint-plugin-ugokimap/index.js
module.exports = {
  rules: {
    'enforce-iconchip-variant': require('./rules/enforce-iconchip-variant'),
  },
}
```

---

## 5. CI 組込

### 5.1 GitHub Actions workflow (新規)

```yaml
# .github/workflows/lint.yml
name: Lint
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: ESLint (warning mode)
        if: ${{ vars.UGOKIMAP_LINT_LEVEL != 'error' }}
        run: pnpm lint -- --max-warnings 9999

      - name: ESLint (hard fail mode — Sprint 5 cutover 以降)
        if: ${{ vars.UGOKIMAP_LINT_LEVEL == 'error' }}
        env:
          UGOKIMAP_LINT_LEVEL: error
        run: pnpm lint -- --max-warnings 0

      - name: Type check
        run: pnpm type-check
```

**カットオーバー手順**: Sprint 5 開始日 0:00 JST に Operator が GitHub repo `Settings → Actions → Variables` で `UGOKIMAP_LINT_LEVEL=error` をセット。設定後の最初の PR から hard fail 発動。詳細は §6 cutover runbook 参照。

### 5.2 Vercel (preview / production) ビルド連携

Vercel は `pnpm build` 内で `next build` が ESLint を実行する (next.config.js `eslint.ignoreDuringBuilds=false` がデフォルト)。

カットオーバー後は Vercel 環境変数でも `UGOKIMAP_LINT_LEVEL=error` を Production / Preview 両方にセット (Vercel CLI または GUI):

```bash
# Vercel CLI
vercel env add UGOKIMAP_LINT_LEVEL production
# 値: error
vercel env add UGOKIMAP_LINT_LEVEL preview
# 値: error
```

これで Vercel build もカットオーバー後の PR で red になり、CI と Vercel の判定が一致する。

### 5.3 ローカル開発 (pre-commit, optional)

`husky` + `lint-staged` は本 plan ではマンダトリーにしない (Sprint 0-5 中は warning モードで開発体験を阻害しないため)。Sprint 5 hard fail 後に「PR 作ったら CI で初めて落ちる」を避けたい開発者は各自 pre-commit に組込可:

```json
// package.json (個人運用、enforce しない)
{
  "lint-staged": {
    "*.{ts,tsx}": ["UGOKIMAP_LINT_LEVEL=error eslint --max-warnings 0"]
  }
}
```

---

## 6. Sprint 5 開始日 cutover runbook (Operator 用)

**実施担当**: Operator (Infra と GitHub repo settings 編集権限を共有)
**実施日時**: Sprint 5 開始日 0:00 JST
**事前確認**: Sprint 5 開始 3 日前までに Director と以下を check:

- [ ] `pnpm lint` がローカルで warning ゼロ (Frontend Programmer 確認)
- [ ] 過去 7 日間の PR で `bg-brand-grad*` warning が 0 件 (CI ログ確認)
- [ ] IconChip 全利用箇所に variant prop あり (`grep -rn "<IconChip" components/ app/`)

**cutover 手順** (5 分):

1. GitHub repo: `Settings → Secrets and variables → Actions → Variables` で `UGOKIMAP_LINT_LEVEL=error` を **Repository variable** として追加
2. Vercel: `vercel env add UGOKIMAP_LINT_LEVEL production` (値: `error`)、`preview` も同様
3. ダミー PR (本日 cutover の sentinel commit) を作って CI が以前と同じく green になることを確認
   - もし red になるなら Frontend に warning 残骸を直す依頼を出してから本番 cutover を 1 日延期
4. Operator は `operator_log.md` に「YYYY-MM-DD ESLint hard fail cutover 完了」を記録
5. Director に [→Director] タグで完了報告

**ロールバック手順** (緊急時):

1. GitHub repo Variables から `UGOKIMAP_LINT_LEVEL` を削除 (もしくは `warn` に変更)
2. Vercel 環境変数も同様
3. operator_log.md に rollback 理由 + 再 cutover 予定を記載

---

## 7. 完了条件

| # | 項目 | 検証方法 | 期限 |
|---|---|---|---|
| 1 | `.eslintrc.js` + `tools/eslint-plugin-ugokimap/` 配備、warning モード稼働 | `pnpm lint` 実行で existing warning が見える | Sprint 0 S0-02 直後 |
| 2 | GitHub Actions `lint.yml` 配備、warning モードで CI green | PR 起票で workflow 実行 | Sprint 0 S0-02 直後 |
| 3 | `bg-brand-grad*` warning ゼロ達成 (Frontend Programmer 消化) | CI ログ + `pnpm lint` 結果 | Sprint 5 開始 3 日前 |
| 4 | IconChip variant 全利用箇所明示 | `grep -c "<IconChip" `, ESLint 結果 0 件 | Sprint 5 開始 3 日前 |
| 5 | Sprint 5 開始日 hard fail cutover 実施 + Director 確認 | operator_log.md 記録 + Director 確認エントリ | Sprint 5 Day 1 |

---

## 8. リスクと未決事項

| # | リスク | 緩和 |
|---|---|---|
| R1 | カスタム rule の TypeScript AST 検出が React Server Components の RSC parser で動作しない | `@typescript-eslint/parser` で `parserOptions.ecmaFeatures.jsx=true`、Next.js 14 の RSC は Babel 互換、テスト済 |
| R2 | dynamic な variant (`<IconChip variant={role}>`) は ESLint で検出不能 | rule 設計で `<dynamic>` を invalid 扱いにしている。動的代入が必要なら別の高位コンポネント (`<RoleIconChip role={...} />` 内で variant 解決) を作る方針 |
| R3 | カットオーバー後に既存 PR が大量 red 化 | Sprint 5 開始 3 日前 dry-run + Frontend 消化期間で予防、ロールバック手順あり |
| R4 | Vercel 環境変数追加忘れで CI green / Vercel red のずれ | cutover runbook §6 step 2 でチェックリスト化、ダミー PR で同時確認 |
| R5 | mockup HTML (docs/fusion/mockups/) は ignorePatterns で除外しているが grep で目視チェック必要 | mockup は v17 §12 17 項目で別運用 (Designer review)、ESLint 範囲外 |

---

## 9. 改訂履歴

| ver | date | author | 概要 |
|---|---|---|---|
| 0.1 | 2026-05-16 | Infrastructure Engineer | 初版起票 (FE-Q3 + Reviewer C-3 統合) |
