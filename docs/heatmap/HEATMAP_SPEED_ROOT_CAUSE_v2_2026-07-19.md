# ヒートマップ表示 10-12秒 — 根因分析 v2 (Claude 再点検済み)

> 作成: 2026-07-19 / v1 (CODEX_PROMPT_sol_heatmap_speed_2026-07-18.md の前提部) を 4-agent 実コード検証にかけ、
> REFUTED 3 / PARTIALLY_WRONG 4 を訂正した版。全主張 file:line 付き。
> 症状: ヒートマップ画面の表示完了まで 10-12秒 (オーナー実測、本番)。Clarity は 1-2秒。

---

## 0. v1 から覆った前提 (誤読防止のため冒頭に明記)

| v1 の主張 | 検証結果 | 実態 |
|---|---|---|
| W1「スクショが first paint をブロック → 先行描画を実装せよ」 | **REFUTED** | 続128+P3 で **provisional 先行描画は実装済み** (`heatmap-canvas.tsx:254,810`)。tiles が届けばスクショなしで即描画される。スクショは「最後に乗る画素」 |
| W2「tiles 直列ループを1発化せよ」 | **REFUTED (happy path)** | 続131 で **all-bands 1 CHクエリ化が実装済み** (`app/api/heatmap/route.ts:217-256`)。通常経路は HTTP 1往復・CH 1クエリ。直列 11往復が残るのは all-bands 失敗時の fallback のみ |
| 「cold capture = Microlink (60s)」 | PARTIALLY_WRONG | 本番 primary は**自前 Puppeteer Screenshot Worker** (Cloudflare Browser Rendering、55s cap)。Microlink は最終 fallback (`screenshot-provider.ts:941-951`) |
| 「imageUrl が function proxy なら R2 直に」 | **REFUTED** | 既に R2 **presigned 直URL** (5分署名) でブラウザ直 read (`r2-screenshot-cache.ts:342-349`)。ただし `r2.cloudflarestorage.com` は S3 API エンドポイントで **CDN cache が効かない** — 別の改善余地が正しい |
| 「tenantTracksUrl が各 API の往復を足す」 | 範囲限定 | CH ownership チェックは **screenshot route のみ** (`screenshot/route.ts:147`)。tiles/stats/elements は in-memory site_ids 照合のみ |

## 1. 確定した表示シーケンス (実コード)

```
t0 ナビゲーション
├─ [直列A] Server Component: getServerSession + fetchPagesCached (CHクエリ, 5分 unstable_cache)
│   完了まで HTML ゼロ (app/(proof)/heatmap/page.tsx:59-62)
├─ [直列B] ssr:false client chunk の DL+parse+mount (page.tsx:21-24)
│   完了まで全 fetch 開始不可
└─ t_mount: 4 fetch 並行発火
    ├─ tiles: HTTP 1往復・CH 1クエリ (all-bands)。ただし click 2パスSQL 実測 ~3s
    │   (続130 コメント「実証 3s/数十MB」route.ts:592) ← first meaningful paint のゲート
    ├─ page-stats: CH 1クエリ (非ブロッキング)
    ├─ elements: **CH 5クエリを直列 await** (elements/route.ts:148→180→226→268→317)
    └─ screenshot: session → CH ownership (warm でも必ず1往復) → L1/R2 → JSON
        → 署名URL → <img> が MB級 full-page JPEG を非CDN R2 origin から DL
        (cold なら Puppeteer Worker 10-55s: autoScroll 最大~6.8s + networkidle0 25s cap)
```

**1回の初期表示の勘定** (happy path): Vercel function 5起動 / latency 経路上の CH SELECT **8本** (tiles 1 + stats 1 + elements 5 + ownership 1) / CH は Cloudflare Tunnel `ch.bihadashop.jp` 経由 (直結 8123 は firewall block 実測確認、tunnel ping 0.85s 実測)。

## 2. 10-12秒の帰属仮説 (計測前・区間レンジ推定)

| 区間 | warm 推定 | 根拠 |
|---|---|---|
| A: SSR gate (session+pages CH) | 0.3-1.5s | 5分 cache miss 時 CH 1往復 |
| B: client chunk load | 0.5-1.5s | ssr:false 全量 |
| C: tiles CH クエリ | 2-4s | 実測コメント ~3s (route.ts:592)。2パス同一WHERE 2回スキャン + 毎行 regex URL照合 (canonical-url.ts:38-40) で index pruning 無効 |
| D: screenshot warm 鎖 | 2-5s | function+CH ownership+R2署名+**MB級 JPEG 非CDN DL** |
| E: elements 5直列 | 1.5-4s | RTT×5 (サイドパネル、canvas 非ブロック) |
| **視覚完成 (A+B+C+D)** | **8-13s** | **オーナー実測 10-12s と整合 — cold なしで再現可能** |
| (cold screenshot 時) | +10-55s | Worker render。同期 cold 経路に dedupe lock なし |

**中核仮説: 10-12秒は cold の事故ではなく、warm path の構造コスト (SSR直列 + chunk + tiles CHクエリ + スクショ配信鎖) の合算である。**

## 3. 訂正済み改善候補 (優先順・全て計測で裏取り後に着手)

1. **計測 (最優先)**: Server-Timing (5 route) + client marks。⚠ ローカル計測は無効 — `.env.local` の CH 直結 URL は firewall block で常に dummy fallback になる (実測 timeout 確認済み)。本番 or tunnel URL で行う
2. **tiles クエリ短縮 + サーバ側キャッシュ**: 現状 `cached:false` ハードコード (route.ts:242-243) でナビ毎に ~3s を再実行。応答キャッシュ (数分 TTL) + 2パスSQLの1パス化/regex照合の事前正規化列化を検討
3. **elements 5クエリの並列化**: 直列 await → Promise.all。最安改修 (RTT×5→×1)
4. **screenshot 配信の CDN 化**: presigned S3 API URL は CDN 不可 → public bucket + custom domain または Worker 経由 Cache API。+ degrade 時の base64 inline JSON (数MB) 排除
5. **ownership 結果の短TTLメモ化**: warm path から CH 1往復排除 (screenshot route のみ対象)
6. **SSR gate の解消**: pages 一覧を Suspense/streaming 化 or client fetch 化して HTML 先出し
7. **cold 対策 (構造)**: 同期 cold 経路に dedupe lock 追加 / Plan C (クローラースクショ流用、設計済み未実装) / CAPTURE_VERSION bump (現 v12) の全 cache 無効化運用の見直し
8. **SWR background 再撮影の完了保証**: Next 14.2 に after() が無く detached promise は Vercel で freeze され得る (r2-screenshot-cache.ts:592-607) — 再撮影が完了しない疑い

## 4. 積み残しの疑問 (Codex 独自調査に期待)

- 実測での区間比率 (§2 の推定の当否) — CH query_log で heatmap 系クエリの duration 分布が取れるはず
- Vercel リージョン⇔Cloudflare Tunnel⇔Hetzner の実効 RTT
- R2 画像の実サイズ分布 (メタ JSON に naturalWidth/Height あり)
- tiles ~3s の内訳: CH 実行時間 vs 転送 (数十MB?) vs tunnel RTT
- 10-12s が「常時」か「CH 遅延時のロングテール」か (analytics_reader の request_timeout 30s でハングする劣化モードあり)
