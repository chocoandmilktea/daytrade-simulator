# 作業引き継ぎ（最終更新: 2026-08-24）

このファイルは「今どうなっているか」だけを書く。
恒久的な制約は CLAUDE.md（実装向け）と docs/OPERATIONS.md（運用向け）に書き、
ここには重複させない。更新は GitHub Web エディタで main 直コミット。

## 現在の課題

- `CLAUDE.md` 第2弾C の指示文を Claude Code へ投入する（作成済み・投入待ち）
- 金曜夕方の `PREMARKET_MAX` 158（全件）引き上げ

## 進行中の案件

### `CLAUDE.md` 第2弾C（キャッシュ層・外部API・並列禁止）

- 状態: 指示文を作成済み。Claude Code へ投入する段階。Vercel側のみで時間帯制約なし
- 触るファイル: `CLAUDE.md` のみ
- 次の一手: 指示文を投入 → 実装前確認の報告を受ける → PR を確認してマージ → ブランチ削除

対象9項目:

1. `tachibana:watch` の実効2分（`watchStaleSeconds`）を TTL 一覧へ追記
2. gzip は閾値なしで常時圧縮。1MB はコメント上の設計理由のみで実装なし
3. 展開処理の二重実装（`unpackFromRedis` と `unpackSync`、関数名が異なる）
4. `limit=5` の根拠（Hobby 10秒・実測4.5秒・limit=8 で失敗）と Vercel 側に上限チェックなし
5. `scan-run` 並列禁止の理由と、防御が `scanner.js` の直列化のみである事実
6. `/market-price` の Vercel側キャッシュを「3分」→「なし」に訂正
7. `withFallback` の例外2つ（`api/premarket.js` の `fetchQuotes` / `fetchMarketSentiment`）
8. 環境変数に `TACHIBANA_MARKET_PRICE_API` を追加
9. 早見表の `api/premarket.js` に `marketBias` の Yahoo 由来が読み取れるか確認

マージ後、`docs/HANDOFF.md` の暫定保持から `unpackSync` と `scan-run` 並列禁止の2行を削除する。

### `PREMARKET_MAX` 158（全件）引き上げ

- 状態: 100の判定通過により実行条件を満たした。金曜夕方に実施予定
- 触るファイル: なし（Railway の環境変数 `PREMARKET_MAX`）
- 次の一手: 金曜夕方に 100 → 158 へ変更 → 起動ログで `対象 158件` を確認 → 翌月曜朝に実測判定

推定 3.09MB（19.58KB/銘柄 × 158）＝ Vercel上限4.5MB の69%。判定順は `tick失敗` → `エラー` → POSTサイズ → 件数 → tick所要。ロールバック先は 100。

### `parts.ranking` の原因調査

- 状態: 計測済み（8/24: 6016ms、`totalMs` 6754 の89%）。原因調査は未着手
- 触るファイル: 未定（`api/ranking.js` / `tachibana-server/webapi.js` が候補）
- 次の一手: Vercel → tachibana-server → 立花API のどの区間で時間を食っているかを分解する。調査のみ・変更なしで指示

### `/api/daily` 連打の調査

- 状態: 未着手
- 触るファイル: `src/App.js`（grep・範囲指定読みのみ。全体読み禁止）
- 次の一手: useEffect 周辺を grep で特定。調査のみ。`PUSH_SYNC` には触らせない

## 次にやること

上から順に:

1. `CLAUDE.md` 第2弾C（指示文は作成済み・投入待ち）
2. 第2弾C マージ後、暫定保持から2行削除
3. 金曜夕方の `PREMARKET_MAX` 158 引き上げ
4. `/api/daily` 連打の調査のみ
5. `parts.ranking` 6016ms の原因調査（調査のみ）
6. README 更新
7. Phase 2B（ギャップ予測を気配ベースへ）

## 未決の判断

- `CLAUDE.md` 第2弾C の完了後、暫定保持に残る項目（`premarketLogger.js` の9前提、修正時に巻き込む恐れのある箇所7件、組み立ての起動経路、`PREMARKET_CODES` 158件固定）の移設先。`docs/OPERATIONS.md` が候補だが未着手
- `CLAUDE.md` のみの変更を `ENV_CHANGELOG.md` に記録するかどうか。同ファイルは本来「環境変数の変更履歴」であり、ドキュメント修正は対象外という整理もあり得る

## 未確認の仮説

- 8/18 の気配データが 3.2KB と小さいのは初日の部分取得と見られるが、未確認。8/19・8/20 が 27KB で一致しているため、12件時の定常値は 27KB
- `api/sync.js` の寄り前ログ節のコメントが「8:31〜9:06」となっており実装（8:45〜9:06）と食い違う。修正するならコード側だが未着手（PR D 候補）
- `readBody()` の `{gz:"..."}` 受信パスはどの送信側からも使われていない死んだ経路。害はないが未整理

## 直近の実測値

気配データの日次サイズ（Upstash `premarket:log:<日付>`、gzip 後）:

| 日付 | Size | 銘柄数 | 1銘柄あたり |
|---|---|---|---|
| 8/18 | 3.2KB | 12 | — |
| 8/19 | 27KB | 12 | — |
| 8/20 | 26.7KB | 12 | — |
| 8/21 | 91.5KB | 40 | 2.29KB |
| 8/24 | 201KB | 100 | 2.01KB |

- `PREMARKET_MAX=100` は 8/24 判定合格。欠損日なし。TTL 30日も正常付与
- 8/24 の 15:00 スキャン: 197件 / 4分3秒 / 失敗0件
- Railway コンテナ起動 13:48 JST（PR #17 のデプロイ）。起動ログで `対象 100件 / 受領 158件 / 上限 100件` を確認
- 8/24 朝の `tick失敗` 件数・POSTサイズ・tick レイテンシは Railway ログ未取得のため不明。Redis 側でデータ保存を確認済みのため判定には支障なし

## 暫定保持（移設先が決まり次第、順次ここから削除する）

未移設: `tachibana:watch` の TTL は CLAUDE.md 上 5分（`WATCH_TTL`）だが、実効は2分。判定しているのは `tachibana-server/config.js` の `watchStaleSeconds=120`。PR C で CLAUDE.md へ追記する

`premarketLogger.js` の壊してはいけない前提:

1. `warn()` ヘルパーの内部は `console.log`。`console.warn` に戻さない（Railway で `[err]` 分類される）
2. `running` の解除は `.finally()` のみ
3. `lastSessionDate` ガードは維持
4. `errorCount` と `tickErrorCount` を混ぜない
5. `PREMARKET_CODES` のパースは `/^[0-9A-Z]{4}$/`
6. `PREMARKET_MAX` は起動時に一度だけ確定。変更には再起動が必須
7. 1ティック＝立花への POST 1回。ボトルネックは Vercel へのペイロードサイズ
8. 検証窓は平日 8:45〜9:06 の21分のみ。失敗の検知は翌営業日
9. POSTサイズ閾値は `POST_SIZE_WARN_KB=3500` / `POST_SIZE_ERROR_KB=4000` / `POST_SIZE_LIMIT_KB=4500`。`error()` は `console.error` のまま維持する

`tick失敗` と `エラー` は別カウンタ。必ず `tick失敗` を先に見る。

修正時に巻き込む恐れのある箇所:

- `api/sync.js` — `lastSectors` 未送信時に既存値を維持
- `api/_scan.js` — 組み立てはスロット先頭の1回だけ。マークが先に立つ
- `api/_scan.js` `saveUniverse` — `source` が `"ranking"` 以外だと保存拒否
- `api/_scan.js` `unpackSync()` — `sync.js` の `unpackFromRedis()` と意図的に二重実装（循環参照回避）。片方だけ直すと自動スキャンが同期データを読めない ※PR C で CLAUDE.md へ移設予定
- `src/lib/analyze.js` — `App.js` と `api/_scan.js` の共有。変更すると自動スキャンの保存スコアも変わる
- `src/App.js` `PUSH_SYNC` — 触るとお気に入りが巻き戻る
- `src/App.js` `applySyncedData` — SyncPanel の ID 切り替え時に `last_sectors` を上書き
- `api/sector.js` `sectorCache` と分岐 — 触ると AI 呼び出しが復活
- `scan-run` の並列実行は絶対禁止（`mergeResults` が read-modify-write）※PR C で CLAUDE.md へ移設予定

組み立ての起動経路:

- 唯一の入口: `POST /api/sync?resource=scan-run` → `runScanBatch` → `buildUniverse`
- フロントの手動スキャンでは走らない（`buildStockUniverse` はブラウザ内組み立て）
- `offset:0` かつ `scan:universe:built` のマークが無いときだけ組み立て
- 組み立て回はスキャンせず `done:0 / nextOffset:0` で即返す

固定事項:

- `PREMARKET_CODES` は158件固定の定点観測（`scan:universe` と非連動）

