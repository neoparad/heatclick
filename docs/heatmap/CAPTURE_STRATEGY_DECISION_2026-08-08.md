# スクショ撮影戦略の判定 — クローラー側改修 vs Workers Paid

> 2026-08-08 / 発端: オーナー問い「Workers Paid を払わずクローラー改修で解決できないか?」
> 判定: **クローラー改修だけでは不可能 (REFUTED)**。かつ**もっと安く簡単な第3の道**がある。
> 6-agent 実コード検証、全主張 file:line 付き。

---

## 0. 用語の整理 (混同されやすい)

| | 役割 | 今日の状態 | コスト |
|---|---|---|---|
| **R2** | 画像の**置き場** | 本日修理完了 (5/29から壊れていた) | 約 $0.01/月 |
| **Workers / Browser Rendering** | スクショを**撮るブラウザ**を動かす場所 | **無料枠**: 1回/20秒・10分/日 → 429 頻発 | $5/月で解除 |

## 1. 判定: クローラー改修だけでは Workers Paid を回避できない

CF を叩く経路は `/api/heatmap/screenshot` の1本のみで、R2 fresh ヒット時に CF を呼ばないことはコード+テスト(15/15 pass)で確認済み。方向性自体は正しい。

しかし **ugokimap 側のコードを触らない限り、CF 呼び出しは消えない**:

| # | 残存経路 | 根拠 | クローラーで解決可? |
|---|---|---|---|
| 1 | **3デバイス先読みが 0/4/8秒間隔で発火** → 無料枠「1回/20秒」を設計上必ず破る | `heatmap-canvas.tsx:392-403` | **不可能** (ugokimap の client コード) |
| 2 | **FRESH_TTL=24h + SWR** → バックフィル間隔が24hを超えた瞬間、閲覧のたびに background capture | `r2-screenshot-cache.ts:75, :199-204` | **不可能** (ugokimap の定数) |
| 3 | tab(820) がクローラーに無い → 閲覧ページごとに必ず1撮影 | `design_capture.py:56-59` | 追加可 (ただし MAX_VIEWPORTS=2 上限に抵触) |
| 4 | CAPTURE_VERSION bump が事前生成物を全無効化 (12 commits / 31日) | `:340, :491` | 不可 (運用ゲート化が必要) |
| 5 | R2 read 失敗が**無言で**同期 capture に落ちる | `:189 .catch(() => null)` | 不可 |

→ ①③はクローラーでは絶対に解決できない。**「クローラー改修だけで回避」は成立しない。**

## 2. クローラー側実装の実コスト (やる場合)

### ブロッカー: 本番に Chromium が入っていない
`deploy/docker-compose.crawler-api.yml:24` は api/worker/beat/rag_indexer 全サービスを `Dockerfile.api` 単一イメージから起動するが、**全45行に `playwright install` が無い** (Python パッケージのみ)。`p.chromium.launch()` は "Executable doesn't exist" で即死。Chromium を持つ `Dockerfile.crawler` は本番 compose から参照されていない。
→ Dockerfile 改修 + イメージ +400MB + 再デプロイ。

### メモリが構造的に足りない (過去2回の障害の再来リスク)
- 全 RAM **7.6GiB** に対し **ClickHouse 単独で 6.81GiB** を許可済み
- 加えて worker 2g + rag_indexer 1400m + ollama 3GB の上限が積まれ、**上限総和は既に RAM を大幅超過**(「全部同時にピークに来ない」前提で成立)
- Chromium 並列8 = 約 2.0-2.5GB (full-page ビットマップ 104MB × 8)
- 過去2回の障害はいずれも「CH メモリ超過 → crash loop → ログ洪水 → disk full → **PostgreSQL 巻き添え**」の連鎖

### 無言で失敗する罠が3つ
- `playwright_pool.py:455-457` のメモリバックオフに**デッドラインが無い** → CH の merge で全体80%超過時、夜間バッチが**無期限ハング**
- `screenshot_store.py:42` の **2MB cap は例外でなく None を返す** → 実測で bihadashop の4枚中3枚(2.28-3.93MB)が該当。**最も必要な縦長ページだけが無言で捨てられ、バックフィルは成功に見える**
- `design_capture._lazy_scroll:258-285` は**スクロールするだけ**で、worker.ts:249-296 の4種の lazy 昇格 (data-src / srcset / data-bg / noscript) と naturalWidth>0 待ちが無い + 1.5秒 cap → **画像が抜けた状態で R2 に焼き込まれる** (ugokimap が v4→v12 の7回 bump で潰してきた不具合の再導入)

### 朗報 (公平のため)
- **Playwright ブラウザプールは完成済み** (`playwright_pool.py`: 再利用・並列上限2×4・メモリ閾値バックオフ・寿命ローテ・ゾンビkill)。`content_map.py:230` の撮影ごと launch をこれに載せ替えるだけ
- 最良の土台は `design_defect_batch.py` + `design_defect_render.py` (ページ列挙・所有者検証・SSRF・セマフォ・timeout・予算・決定的選定が全部済み、「撮らない」ことだけ意図的に外してある)
- 時間は問題にならない: 549撮影が並列8で **3.7〜23分**
- 中間ファイル不要 (boto3 導入済み、R2 認証も worker に配線済み、bytes 返し撮影の既存例あり)
- 空き容量捻出策: **ollama を Gemini に寄せて落とせば約3GB空く** (compose:99-101 が既に「CX33 では Gemma 4 系は載らないためホスト API へ寄せる」と結論済み)

**総工数感**: 2リポジトリ横断で 2-3週間 + OOM リスク + 無言失敗の運用負債。

## 3. 第3の道 — Workers Paid + 既存経路でバックフィル (推奨)

Paid にすると **1回/秒** に緩和され、**browser hours 10時間/月が基本料に含まれる**。

- **バックフィル1周 = 3.65時間 → 含有枠内で $0**
- 撮影は**今日動いている既存コードパス**をそのまま使う (`/api/heatmap/screenshot` を各ページ×デバイスで叩くだけ)
- **9項目のパリティ要件が全て不要**。キー生成もメタJSONも既存コードが正しく作る
- Chromium インストール不要、Hetzner のメモリに一切触らない、OOM リスクゼロ
- 実装は「認証付きで API を順に叩くスクリプト」のみ

| 方式 | 初期工数 | 月額 | リスク |
|---|---|---|---|
| クローラー側事前生成 | **2-3週間** (2リポジトリ) | $0 | OOM で PG 巻き添え / 無言失敗 / 画像欠け |
| **Workers Paid + 既存経路バックフィル** | **半日** | **$5** | ほぼ無し |

**判定: $5/月を払う方が圧倒的に合理的。** 2-3週間の工数と本番サーバの OOM リスクを、月$5(コーヒー2杯)の節約のために負うのは割に合わない。

### ただし将来の条件付き再検討
SaaS として**100サイト規模**になると CF 撮影は毎日で $895/月・週次で $51/月になる。その規模ではクローラー側事前生成の経済性が逆転する。**今日の分析はその時点で再利用できる** (本文書 §2 が実装ガイドになる)。

## 4. 無料のまま 429 だけ止める応急策 (非推奨・参考)

env 4本 (`SCREENSHOT_WORKER_URL` / `SCREENSHOT_WORKER_TOKEN` / `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`) を **unset するだけでコード変更ゼロで CF 呼び出しがゼロになる** (provider chain が Microlink 単独に落ちる)。
⚠ `screenshot-provider.ts:732` が `CLOUDFLARE_ACCOUNT_ID ?? R2_ACCOUNT_ID` とフォールバックするため、**CLOUDFLARE_API_TOKEN を消さないと R2_ACCOUNT_ID 経由で CF BR が生き続ける**。
代償: 全て Microlink 品質 (lazy 画像欠落・上部のみになりうる) + provider='microlink' で 1h fresh → 再撮影ループ。**画質低下が今日の不満そのものなので推奨しない。**

## 5. 推奨実行順

1. **Workers Paid 化 ($5/月)** — 429 と画質劣化が即座に止まる。工数ゼロ
2. **バックフィルスクリプト** (半日) — 549撮影を既存 API 経由で 1周。含有枠内で $0
3. **FRESH_TTL の見直し** — バックフィル間隔 (週次なら7日) 以上に延長。でないと SWR が再撮影を誘発
4. **CAPTURE_VERSION bump のデプロイゲート化** — 唯一の大量再撮影イベントを制御
5. (任意) 先読み間隔の見直し / tab の扱い

## 6. 補足: 未検証事項

- **CPU コア数がリポジトリ内で矛盾** (compose:99「4コア」 vs playwright_pool.py:2「2vCPU」)。クローラー案を採る場合は着手前に `nproc` / `free -h` / `df -h` の実測が必要
- ディスク実測は 2026-07-09 (root 空き17G) が最新で1ヶ月前の値
- `tier=r2-fresh` は本日のログ窓にまだ出ておらず、**R2 経由のヒットは未実証** (R2 PUT 成功は確認済み)。次回計測で確認が必要
