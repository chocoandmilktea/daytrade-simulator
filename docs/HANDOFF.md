# 作業引き継ぎ（最終更新: 2026-08-25）

このファイルは「今どうなっているか」だけを書く。
恒久的な制約は CLAUDE.md（実装向け）と docs/OPERATIONS.md（運用向け）に書き、
ここには重複させない。更新は GitHub Web エディタで main 直コミット。

## 現在の課題

- 当初の完成条件（自動定時スキャン・自動寄り前データ収集の両方が正常稼働）に到達。以降はスコア精度と予測チューニングの運用フェーズに入る
- 最優先の検証案件は無い。ドキュメント整合と調査系の積み残しを順に片付ける段階

## 進行中の案件

### CLAUDE.md PR B

- 状態: 未着手。PR A（PR #48）は 8/25 マージ済み。ENV_CHANGELOG も追記済み
- 触るファイル: `CLAUDE.md` / `api/premarket.js`（行内コメント1行のみ）
- 次の一手: 指示文を作成する。対象は次の3点

  1. `api/sync.js` の「TTL 90日」表記の修正（TTL表の移設に依存）
  2. `api/premarket.js` の `PREMARKET_TTL` 行内コメントを「サーバー側キャッシュ（3分）」→「Vercel側キャッシュ（3分・サーバーレス関数インスタンスが生きている間のみ）」に修正。CLAUDE.md の用語法（サーバー側＝`tachibana-server`）だと現状の文言は逆に読める
  3. その他の付随修正

- 注意: `api/premarket.js` を含めるとコードファイル変更となり Vercel 再デプロイが走る。マージ時刻はスキャンスロットの±5分を外す

### `/api/daily` 連打の調査

- 状態: 未着手
- 触るファイル: 調査のみ。`src/App.js` の `PUSH_SYNC` には触らせない
- 次の一手: 調査専用の指示文を作成（変更・commit・push・PR作成を一切行わない旨を明記）

### `parts.ranking` の latency 計測

- 状態: 未着手。約5738ms を観測したのみで再現性は未確認
- 触るファイル: 未定（計測のみ）
- 次の一手: 再現条件の切り分け

### README 更新

- 状態: 未着手
- 触るファイル: `README.md`
- 次の一手: `PREMARKET_MAX=158` 到達後の構成に合わせて記述を更新

### Phase 2B（ギャップ予測の気配ベース化）

- 状態: 着手条件が整いつつある。158件体制でのデータ蓄積が 8/25 から開始
- 触るファイル: `src/App.js`（`pm*` 系）／`api/premarket.js`
- 次の一手: 数営業日ぶんの158件データが貯まるまで待機。`PM_SRC_BETA` に加えて `"quote"` を記録する形へ

## 次にやること

1. `CLAUDE.md` PR B
2. `/api/daily` 連打の**調査のみ**
3. `parts.ranking`（5738ms）の計測
4. README 更新
5. Phase 2B

## 未決の判断

- `PM_HIST_MAX`（現在90件）の引き上げ要否。Phase 2B で `src` が `beta` / `quote` の2種になると、保持できる日数が実質半分（45営業日）になる

## 未確認の仮説

- `validCount` は寄り付き時刻の代理指標の可能性（0/57/69/81 の4値・12刻み）。`validCount=81` と `open=null` が完全一致。例外: `5242`
- `buyRatioLast` > `buyRatioAvg`（9銘柄で 7/9 vs 6/9）。サンプル不足。5変種（First / Last / Min / Max / Avg）を保存継続中
- 101〜158番目の銘柄は板が薄いためデータ量が小さい、という推定（下記の実測差から導いたが、銘柄別の内訳では未検証）

## 直近の実測値

`PREMARKET_MAX=158`（8/25朝・全項目クリア・以後この値で確定）:

- tick失敗 0件 / エラー 0件
- POST 2352KB / 84レコード
- tick 所要 439〜645ms・平均493ms・中央値483ms
- 収集時間 1260秒（84ティック × 15秒。窓の取りこぼしなし）
- 起動ログ 対象158件 / 受領158件 / 上限158件
- 8:35 JST の日次再ログイン成功
- `[scan] 0850 done 203件 / 4分9秒 / 失敗0件`

派生する事実:

- **ペイロード線形性 19.58KB/銘柄は上位100銘柄限定の値**。全件では 14.89KB/銘柄。予測3093KBに対し実測2352KB（予測比76%・マイナス741KB）
- Vercel 上限4.5MB に対して 52%。三段しきい値の WARN(3500KB) まで 1148KB の余裕
- レコード件数84件は「窓21分 ÷ 取得間隔15秒」そのもの。1ティックが15秒を超えない限り件数は減らない

参考（過去の値）:

- `PREMARKET_MAX=100`（8/24朝・全項目クリア）… POST 1958KB / 84レコード / tick 432〜876ms 平均489ms
- `PREMARKET_MAX=40`（8/21朝・全項目クリア）… POST 790KB / 84レコード / tick 444〜641ms

ロールバック方針（現行）:

- 一次退避 `PREMARKET_MAX=100`（8/24 に本番で全項目検証済み）
- 二次退避 `PREMARKET_MAX=40`（8/21 に本番で全項目検証済み）

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
