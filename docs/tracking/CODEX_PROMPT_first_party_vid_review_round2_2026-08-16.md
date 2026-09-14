# Codex Desktop 用プロンプト (2回目・最終確認): 第一者 Set-Cookie 設計書 v3

> 対象リポジトリ: `C:\Users\M2603\ugokimap-saas`
> 前提: 1回目レビュー (REJECT、findings 7件) を全件反映した v3 です。
> 往復を減らしたいので、**今回は「7件が本当に直ったか」の確認を主目的**にしてください。

---PROMPT---

前回 (1回目) の T1 レビューで REJECT・findings 7件 ([HIGH]×3, [MEDIUM]×4) を出しました。
すべて反映した v3 です: `docs/tracking/FIRST_PARTY_VID_DESIGN_2026-08-16.md`
(文末の「付録2: v2 → v3 の変更理由」に対応表があります)。

## 依頼

### 主目的: 7件の fix 確認

以下7件それぞれについて、**実際に直っているか**を確認してください。各項目、
CONFIRMED FIXED / STILL BROKEN / PARTIALLY FIXED のいずれかで判定し、根拠を書いてください。

1. [HIGH] payload の visitor_id 未検証 → §3-1 step 2 で Cookie 値・payload 値の両方に
   同一 regex を適用する記述になっているか
2. [HIGH] S-4「XSS 必須」の誤り → §4 S-4 が host-only の残存リスク (同一ホスト別ポート、
   cookie tossing) を正直に記載し、「XSS が無ければ安全」という誤った限定をしていないか
3. [HIGH] SameSite=Lax の過大評価 → §1 D-3 が「Cookie 付き偽造の防止」と
   「payload 偽造 (既存・別問題)」を明確に分離し、後者を §7 でスコープ外化しているか
4. [MEDIUM] workers.dev 直叩き時の S-8 未検証 → §4 S-8 の断定が緩和され、
   §6 にブラウザ別実機確認が追加されているか
5. [MEDIUM] HTTP サイトで Secure Cookie 発行不可 → §2・§5 に HTTPS 必須の前提条件があるか
6. [MEDIUM] Set-Cookie 発行対象の応答分岐未定義 → §3-1 step 5 が
   `acceptedEvents.length > 0` の応答のみに限定すると確定しているか
7. [MEDIUM] Sentry 記載の誤り → §3-4 が「Worker に Sentry SDK は無い、対応不要」と
   訂正され、Cloudflare ログ確認が確認コマンド・合格条件・停止条件付きで
   具体化されているか

**直っていることを確認できた項目を再度指摘するのはやめてください** (時間の無駄になるため)。
STILL BROKEN / PARTIALLY FIXED の項目だけ詳しく書いてください。

### 副次目的: 新規の見落とし (あれば)

fix の過程で新たに導入された記述 (§3-1 の payload 検証ロジック、§3-4 の CF ログ確認手順、
§1 D-3 の書き換え等) に、今回新たに気づいた問題があれば findings として追加してください。
**1回目レビューで既に指摘済みで v3 が対応方針を示している論点の蒸し返しは不要**です
(例: パターンB不採用の是非、HttpOnly非採用の是非、CORS wildcard 自体の是非 — これらは
1回目で「現行コードと整合」「妥当」と既に判定済みです)。

## 出力形式

1. 7件の fix 確認結果 (番号順、CONFIRMED FIXED / STILL BROKEN / PARTIALLY FIXED + 根拠)
2. 新規 findings (あれば。severity 付き)
3. 総合判定: APPROVE / APPROVE-WITH-CHANGES / REJECT
4. 判定理由 (3行以内)

明白な誤字・実コードとの行番号ズレ等は直接修正して構いません (前回同様)。
