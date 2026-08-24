# 作業引き継ぎ（最終更新: 2026-08-24）

このファイルは「今どうなっているか」だけを書く。
恒久的な制約は CLAUDE.md（実装向け）と docs/OPERATIONS.md（運用向け）に書き、
ここには重複させない。更新は GitHub Web エディタで main 直コミット。

## 現在の課題

- 8/25 朝の収集窓で `[err]` 0件を確認する（PR #17 の実効検証）。これで premarketLogger.js の件は完了
- 次の山は **金曜夕方の `PREMARKET_MAX` 158（全件）引き上げ**

## 進行中の案件

### `CLAUDE.md` 第2弾A（誤りの修正・記述の分割）

- 状態: 指示文を作成済み。Claude Code へ投入する段階。Vercel側のみで時間帯制約なし
- 触るファイル: `CLAUDE.md` のみ
- 次の一手: 指示文を投入 → 実装前確認の報告を受ける → PR を確認してマージ

Aの対象（5項目）:

1. tachibana-server のファイル列挙に `config.js` / `holidays.js` / `premarketLogger.js` を追加
2. ファイル早見表に `api/news.js` / `api/premarket.js` を追加（関数枠一覧には既にあるが早見表に無い。役割はコードを読んで確認させる）
3. 「開発ルール・よくある落とし穴」末尾の `/ranking-data` 重複2行を削除。ただし定義元（`webapi.js`）の情報は残す側へ統合
4. 米国株の記述3箇所を訂正。**米国株は運用していない（日本株のみ）。ただしコード上に `market==="US"` の分岐等が現存するため削除禁止**の旨を明記
5. リアルタイム購読の1文（主語3つ・時間3つ）を主語ごとに行分割。7秒GETに対しTTL30秒である関係が読めるようにする

### `CLAUDE.md` 第2弾B（情報の追加・移設）

- 状態: 未着手。A のマージ後に着手する（同一ファイルの並行編集はコンフリクトするため）
- 触るファイル: `CLAUDE.md` / `docs/HANDOFF.md`（TTL一覧の移設元）
- 次の一手: A のマージ後に指示文を作成

Bの対象:

- TTL一覧を本ファイル「暫定保持」から `CLAUDE.md` へ移設（移設後はこちらから削除）
- `api/sync.js` の「TTL90日」記述の修正。**同ファイルは5種のTTLを持つ**ため単一値を書かず「詳細はTTL一覧を参照」とする（TTL一覧の移設とセットで行う）
- `api/sync.js` の resource 7種の列挙（現在は早見表に「同期＋立花中継の窓口」とだけ。`premarket-summary` は date 未指定を意図的に400で弾く）
- `tachibana:quote:last:` スナップショット（TTL3日・休場中の板表示用）
- Redis 1MB制限と `"gz:"` プレフィックス
- `unpackSync()` の意図的な二重実装（循環参照回避）
- `limit=5` の根拠と `scan-run` 並列実行の絶対禁止

### `parts.ranking` の原因調査

- 状態: **計測は完了**（8/24: 6016ms、`totalMs` 6754 の89%）。原因調査は未着手
- 触るファイル: 未定（調査結果次第。`api/ranking.js` / `tachibana-server/webapi.js` が候補）
- 次の一手: Vercel → tachibana-server → 立花API のどの区間で時間を食っているかを分解する調査タスク。**調査のみ・変更なし**で指示

### `/api/daily` 連打の調査

- 状態: 未着手
- 触るファイル: `src/App.js`（grep・範囲指定読みのみ。全体読み禁止）
- 次の一手: useEffect 周辺を grep で特定。**調査のみ**。`PUSH_SYNC` には触らせない

### `PREMARKET_MAX` 158（全件）引き上げ

- 状態: 100の通過により実行条件は満たした。**金曜夕方**に実施予定
- 触るファイル: なし（Railway の環境変数 `PREMARKET_MAX`）
- 次の一手: 金曜夕方に 100 → 158 へ変更 → 起動ログで `対象 158件` を確認 → 翌月曜朝に実測判定

推定 3.09MB（19.58KB/銘柄 × 158）＝ Vercel上限4.5MB の69%。判定基準は100件時と同じ順（`tick失敗` → `エラー` → POSTサイズ → 件数 → tick所要）。ロールバック先は 100。PR #17 の閾値設定により、この規模でも `[err]` は出ない想定。

## 次にやること

上から順に:

1. `CLAUDE.md` 第2弾A（指示文は作成済み・投入待ち）
2. `CLAUDE.md` 第2弾B（Aのマージ後）
3. `/api/daily` 連打の**調査のみ**
4. `parts.ranking` 6016ms の原因調査（**調査のみ**）
5. README 更新
6. Phase 2B（ギャップ予測を気配ベースへ）
7. `PREMARKET_MAX` を 158 へ ← **金曜夕方**

## 未決の判断

- `docs/ENV_CHANGELOG.md` の表に PR#42〜#45（8/22〜23のドキュメント変更）を遡って追記するか。索引としての完全性を取るなら追記、「これ以前の変更は記録していない」という冒頭宣言との整合を取るなら現状維持。追記する場合は各PRのマージ日を Pull requests → Closed で確認して埋める必要がある

## 未確認の仮説

- `validCount` は寄り付き時刻の代理指標の可能性（0/57/69/81 の4値・12刻み）。`validCount=81` と `open=null` が完全一致。例外: `5242`
- `buyRatioLast` > `buyRatioAvg`（9銘柄で 7/9 vs 6/9）。サンプル不足。5変種（First / Last / Min / Max / Avg）を保存継続中
- `parts.ranking` の6秒は立花API側の応答待ちが支配的（未検証）

## 直近の実測値

`PREMARKET_MAX=100`（8/24朝・全項目通過）:

- 100銘柄 / tick 82回すべて完走 / 収集窓1260秒
- tick 所要 432〜876ms（平均489 / 中央値479）
- POST 1958KB（1.91MB）/ 84レコード
- `tick失敗` 0件 / `エラー` 0件

自動スキャン（8/24）:

- 8:50 スロット `done 203件 / 4分14秒 / 失敗0件`
- 9:30 スロット `done 200件 / 3分12秒 / 失敗0件`
- `scan:universe:meta`: `builtAt` `2026-08-24T00:30:07.387Z`（JST 9:30）／`source` `sector(精密機器/情報・通信業/海運業)`／`count` 200／`saved` true
- `totalMs` 6754（`sync` 565 / `ranking` 6016 / `merge` 0 / `save` 173）

PR #17 マージ後の再起動（8/24 13:48）:

- `対象 100件 / 受領 158件 / 上限 100件` を確認。起動時 `[err]` 0件
- 切り捨てログ（`上限により58件を切り捨てました`）が `[inf]` 側に出力されることを確認

派生する事実:

- ペイロード線形性 **19.58KB/銘柄**（12→230KB / 40→790KB / 100→1958KB）。Vercel上限4.5MB
- 40銘柄444〜641ms に対し100銘柄432〜876ms。**銘柄数増加による tick 遅延はほぼ無い**。ボトルネックは POST サイズ側
- 158銘柄の推定は約3.09MB（上限の69%）
- 定時スロットからの自動組み立てで業種フィルタが効くことを初確認（`SCAN_SYNC_USER_ID` 修正が本番反映済み）
- 組み立てが 8:50 ではなく 9:30 に走ったのは `scan:universe:built`（3日TTL）が8:50時点で未期限だったため。仕様どおり
- 「銘柄数 × 項目数 ≦ 200」制限は 1600（100×16）までは不存在

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

