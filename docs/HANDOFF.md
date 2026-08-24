# 作業引き継ぎ（最終更新: 2026-08-24）

このファイルは「今どうなっているか」だけを書く。
恒久的な制約は CLAUDE.md（実装向け）と docs/OPERATIONS.md（運用向け）に書き、
ここには重複させない。更新は GitHub Web エディタで main 直コミット。

## 現在の課題

- `PREMARKET_MAX=100` の実測判定は 8/24 朝に**全項目通過**。凍結解除済みで、以降は通常の作業順に戻る
- 次の山は **金曜夕方の `PREMARKET_MAX` 158（全件）引き上げ**。それまでに `CLAUDE.md` 第2弾と `premarketLogger.js` のログ整理を終えておきたい

## 進行中の案件

### `CLAUDE.md` 第2弾修正

- 状態: 第1弾（PR #43）・参照書式と関数枠（PR #44）は完了。第2弾は未着手。**これが次の着手対象**
- 触るファイル: `CLAUDE.md`／`docs/OPERATIONS.md`・`docs/HANDOFF.md`（TTL等の移設先）
- 次の一手: 指示文を作成して Claude Code へ

第2弾の対象:

- 米国株関連の陳腐化（L3 / L18 / L36）
- `sync.js` の resource 7種（現在3種のみ記載。`premarket-summary` は date 未指定を意図的に400で弾く）
- `tachibana:quote:last:` スナップショット（TTL3日・休場中の板表示用）
- Redis 1MB制限と `"gz:"` プレフィックス、`unpackSync()` の意図的な二重実装
- `limit=5` の根拠と `scan-run` 並列実行の絶対禁止
- 構造上の誤読リスク (b) L50 / (c) L23
- 早見表に `api/news.js` / `api/premarket.js` を追加
- `tachibana-server` のファイル列挙漏れ（`config.js` / `holidays.js` / `premarketLogger.js`）
- TTL一覧の移設（下記「暫定保持」から `CLAUDE.md` へ移し、こちらからは削除する）

### `premarketLogger.js` のログ分類整理

- 状態: 未着手。判定終了により**凍結解除済み**（触ってよい）
- 触るファイル: `tachibana-server/premarketLogger.js`
- 次の一手: 下記2点を1つのPRにまとめて指示文を作成

内容:

1. `console.warn` 6箇所を `warn()` ヘルパー経由に変更（Railway で `[err]` 分類されるのを避ける）
2. POSTサイズ警告の閾値見直し。現行1MBは実運用値（現1.91MB / 158件時3.09MB）に対して低すぎ、毎日 `[err]` が出続ける

反映には Railway 再起動が必要。マージは安全枠（10:00〜10:45 / 13:30〜14:45 / 15:30以降）で行う。

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

推定 3.09MB（19.58KB/銘柄 × 158）＝ Vercel上限4.5MB の69%。判定基準は100件時と同じ順（`tick失敗` → `エラー` → POSTサイズ → 件数 → tick所要）。ロールバック先は 100。

## 次にやること

上から順に:

1. `CLAUDE.md` 第2弾修正
2. `premarketLogger.js` のログ分類整理（`console.warn` 6箇所 ＋ POSTサイズ閾値）
3. `/api/daily` 連打の**調査のみ**
4. `parts.ranking` 6016ms の原因調査（**調査のみ**）
5. README 更新
6. Phase 2B（ギャップ予測を気配ベースへ）
7. `PREMARKET_MAX` を 158 へ ← **金曜夕方**

## 未決の判断

- なし（`tachibana-server` の残ブランチ3本は削除済み。`premarketLogger.js` の修正は main から新規PRで作る）

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

派生する事実:

- ペイロード線形性 **19.58KB/銘柄**（12→230KB / 40→790KB / 100→1958KB）。Vercel上限4.5MB
- 40銘柄444〜641ms に対し100銘柄432〜876ms。**銘柄数増加による tick 遅延はほぼ無い**。ボトルネックは POST サイズ側
- 158銘柄の推定は約3.09MB（上限の69%）
- 定時スロットからの自動組み立てで業種フィルタが効くことを初確認（`SCAN_SYNC_USER_ID` 修正が本番反映済み）
- 組み立てが 8:50 ではなく 9:30 に走ったのは `scan:universe:built`（3日TTL）が8:50時点で未期限だったため。仕様どおり
- 「銘柄数 × 項目数 ≦ 200」制限は 1600（100×16）までは不存在

## 暫定保持（CLAUDE.md 第2弾で移設後に削除する）

TTL 一覧:

| Redisキー | TTL | 識別子 / 定義ファイル |
|---|---|---|
| `scan:universe` | 7日 | `UNIVERSE_TTL`（`api/_scan.js`） |
| `scan:universe:meta` | 7日 | `UNIVERSE_TTL` 流用 |
| `scan:universe:built` | 3日 | `UNIVERSE_BUILD_TTL`（`api/_scan.js`） |
| `user:<userId>` | 90日 | `api/sync.js` |
| `premarket:log:<日付>` | 30日 | gzip圧縮で追記保存 |
| `tachibana:quote:last:<ticker>` | 3日 | `api/sync.js`。休場中の板表示用 |
| `tachibana:quote:<ticker>` | 30秒 | ライブ値 |
| （購読） | 5分 | `WATCH_TTL`（`api/sync.js`）。**実効は2分**（`watchStaleSeconds`） |

`premarketLogger.js` の壊してはいけない前提:

1. `console.warn` を使わない（Railway で `[err]` 分類）
2. `running` の解除は `.finally()` のみ
3. `lastSessionDate` ガードは維持
4. `errorCount` と `tickErrorCount` を混ぜない
5. `PREMARKET_CODES` のパースは `/^[0-9A-Z]{4}$/`
6. `PREMARKET_MAX` は起動時に一度だけ確定。変更には再起動が必須
7. 1ティック＝立花への POST 1回。ボトルネックは Vercel へのペイロードサイズ
8. 検証窓は平日 8:45〜9:06 の21分のみ。失敗の検知は翌営業日

`tick失敗` と `エラー` は別カウンタ。必ず `tick失敗` を先に見る。

修正時に巻き込む恐れのある箇所:

- `api/sync.js` — `lastSectors` 未送信時に既存値を維持
- `api/_scan.js` — 組み立てはスロット先頭の1回だけ。マークが先に立つ
- `api/_scan.js` `saveUniverse` — `source` が `"ranking"` 以外だと保存拒否
- `api/_scan.js` `unpackSync()` — `sync.js` の展開処理と意図的に二重実装（循環参照回避）。片方だけ直すと自動スキャンが同期データを読めない
- `src/lib/analyze.js` — `App.js` と `api/_scan.js` の共有。変更すると自動スキャンの保存スコアも変わる
- `src/App.js` `PUSH_SYNC` — 触るとお気に入りが巻き戻る
- `src/App.js` `applySyncedData` — SyncPanel の ID 切り替え時に `last_sectors` を上書き
- `api/sector.js` `sectorCache` と分岐 — 触ると AI 呼び出しが復活
- `scan-run` の並列実行は絶対禁止（`mergeResults` が read-modify-write）

組み立ての起動経路:

- 唯一の入口: `POST /api/sync?resource=scan-run` → `runScanBatch` → `buildUniverse`
- フロントの手動スキャンでは走らない（`buildStockUniverse` はブラウザ内組み立て）
- `offset:0` かつ `scan:universe:built` のマークが無いときだけ組み立て
- 組み立て回はスキャンせず `done:0 / nextOffset:0` で即返す

固定事項:

- `PREMARKET_CODES` は158件固定の定点観測（`scan:universe` と非連動）
