# Codex 委譲プロンプト — C1-f bihadashop seed + 実CH検証

> 作成: 2026-07-17 / 親設計: docs/cv/CV_DEFINITIONS_DESIGN.md §6 seed / §9 検証
> 宛先: Codex デスクトップ (実CH接続・.env.local 保持)
> 前提 commit: `0208feb` (C1-c repository) / `3f9aa3d` (C1-d API)。branch `feat/conversions-c1a`。

---

## 役割とゴール

bihadashop (tenant=`linkth_internal` / site=`CIP_EcwUTHEZdIOAUqum`) に CV定義 4 件を投入する
operator スクリプトを実装し、**投入前に実CHで遡及復元数を検証**する。
これにより 2026-03-20 から止まっていたアフィリCV計測が、過去分ごと数字に戻る。

あなた (Codex) が先の調査で確定させた事実をそのまま使う:
- 過去 conversion_type 721 行 (rakuten 331 / amazon 274 / qoo10 114 / other 2)、全て event_type='click' 行
- ラベルなしアフィリクリックは継続中 (2026-04: 303 sess / 05: 230 / 06: 378 / 07: 56)
- 実在 host: amzn.to, www.amazon.co.jp, hb.afl.rakuten.co.jp, item.rakuten.co.jp, www.qoo10.jp。r10.to は 90日データで未観測
- `affiliate_other` 候補のうち a8.net / felmat.net は ASP リダイレクトで妥当。**cosme.net / lipscosme.com はコンテンツサイトなので含めない (CV捏造になる)**

## 成果物

### 1. `scripts/operator/seed-bihadashop-cvdefs.mts` (TypeScript)

- 実行方法: `npx tsx scripts/operator/seed-bihadashop-cvdefs.mts` — **`tsx` は devDependencies に無い**。npx の一時取得で実行する (package.json への依存追加はしない)。
- `.env.local` を読み込む (既存 `scripts/seed-auth-registry.mjs` の env 読み込みパターンを踏襲)。

**絶対制約 (最重要)**:
- **`lib/conversions/repository.ts` の `createCvDefinitionRepository()` 経由で投入する。**
  KV key (`cvdefs/...` / `cvdef-index/...`) の直書き・Cloudflare KV REST の直叩きは禁止。
  直書きは C1-c のテナント再検証 (REQ-SEC-004)・cvKey 重複チェック・index 整合を全て迂回するため。
- **冪等**: 投入前に `listCvDefinitions(tenant, site)` し、同 `cvKey` が既存なら skip (親設計 §9)。
- **dry-run 既定**: 引数なし実行は「何を作るか」の計画表示のみ。`--apply` 付きでのみ KV 書込。
  **`--apply` の実行は Owner の明示承認後** (本番 KV へのデータ変更のため)。
- `created_by: 'operator_seed_c1f'` 固定。

### 2. 投入する 4 定義 (この内容から変更しない)

全定義共通: `enabled: true` / `value: { mode: 'none' }` / trigger.kind = `'click'`

| cvKey | name | conditions.hrefHosts |
|---|---|---|
| `affiliate_rakuten` | 楽天アフィリ送客 | `['rakuten.co.jp']` (suffix一致で hb.afl / item を包含) |
| `affiliate_amazon` | Amazonアフィリ送客 | `['amazon.co.jp', 'amzn.to']` (別ドメインのため2つ必須) |
| `affiliate_qoo10` | Qoo10アフィリ送客 | `['qoo10.jp']` |
| `affiliate_other` | その他アフィリ送客 (ASP) | `['a8.net', 'felmat.net']` |

注: cvKey が過去の生 conversion_type と同名なのは**意図的** (親設計 §2 和集合解決 — 定義述語 OR 生ラベル一致で時系列連続性を保証)。r10.to は未観測につき入れない (観測されたら定義を編集すれば遡及適用される)。

### 3. 実CH検証 (投入判断の根拠、`--apply` 前に dry-run とセットで実施)

親設計 §9 の3点。ClickHouse は `https://ch.bihadashop.jp` (Cloudflare Tunnel) 経由、`is_agent=0` / tenant / site 束縛を忘れない:

1. **述語カウント vs 生ラベルカウントの期間別比較** — 各 cvKey について月別に
   `uniqExactIf(session_id, <定義述語>)` と `uniqExactIf(session_id, conversion_type='<key>')` と両者の和集合を並べる。
   期待: 和集合 ≥ 生ラベル (欠けないこと) かつ 2026-04〜07 の和集合が調査値 (303/230/378/56 セッション規模、rakuten+amazon+qoo10 合算) と整合。
2. **アフィリ href 行の event_type 分布** — `SELECT event_type, count() WHERE domain(element_href) LIKE '%rakuten%' GROUP BY event_type`。
   click/rage_click/dead_click の混入率を実測し、述語の IN 3種 (親設計 §3) の妥当性を裏取り。
3. **ゼロ一致の負例** — 存在しないホスト (例 `example-nonexistent.test`) の定義述語が 0 件を返すこと (捏造なし確認)。

検証クエリは `buildCvPredicate` (lib/conversions/predicate.ts) が生成する SQL をそのまま使う (手書き SQL で再発明しない — ズレたら検証にならない)。stats-query の `computeCvStats` を実CHクライアントで呼ぶ形が理想。

### 4. 検証レポート

`docs/cv/C1F_SEED_VERIFICATION_2026-07-17.md` に結果を記録:
月別比較表 / event_type 分布 / 負例結果 / 「--apply 可否」の判定と根拠。

## 完了条件・commit 規律

- `npx tsc --noEmit` EXIT 0 (スクリプト含む。tsconfig の include 外なら型チェック方法を明記)
- 既存テスト無傷: `npx jest lib/conversions --runInBand` 47 tests green
- **git add はこの2つのみ** (個別 add、`git add .` 禁止):
  `scripts/operator/seed-bihadashop-cvdefs.mts` と `docs/cv/C1F_SEED_VERIFICATION_2026-07-17.md`
- commit: `feat(conversions): CV定義 C1-f bihadashop seedスクリプト+実CH検証`
- **並行ストリームの差分に触れない**: `app/api/auth/magic-link/*` / `app/api/cv-journey/*` / `lib/cv-journey/*` / `components/heatmap/*`
- push / PR / deploy / `--apply` 実行は Owner 指示待ち。

## 判断に迷ったら

- 述語やスキーマの解釈は `lib/conversions/types.ts` / `predicate.ts` / `docs/cv/CV_DEFINITIONS_DESIGN.md` §2-3 が真実源。
- KV 接続情報が .env.local に見つからない場合は中断して報告 (代替手段で直書きに走らない)。
- 検証で月別数字が調査値と大きく乖離した場合も中断して報告 (定義を勝手に調整しない)。
