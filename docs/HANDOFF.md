# 作業引き継ぎ（最終更新: 2026-08-23）

このファイルは「今どうなっているか」だけを書く。
恒久的な制約は CLAUDE.md（実装向け）と docs/OPERATIONS.md（運用向け）に書き、
ここには重複させない。更新は GitHub Web エディタで main 直コミット。

## 現在の課題

- 月曜（8/24）朝の `PREMARKET_MAX=100` 実測判定が最優先。これが通るまで他の作業は着手しない
- `premarketLogger.js` は月曜判定が終わるまで一切触らない（変更すると Railway が再起動し、検証窓が飛ぶ）

## 進行中の案件

### PREMARKET_MAX=100 の実測判定

- 状態: 8/21 に値を 100 へ変更し反映済み（起動ログ `対象 100件 / 受領 158件 / 上限 100件`）。月曜朝の実測待ち
- 触るファイル: なし（判定のみ。ロールバック時は Railway の環境変数 `PREMARKET_MAX`）
- 次の一手: 月曜 9:10〜9:25 に Railway のログを確認。`tick失敗` → `エラー` → POST サイズ → レコード件数 → tick 所要 の順

判定基準:

| 項目 | 通過 | 要ロールバック |
|---|---|---|
| `tick失敗` | 0件 | 10件以上 |
| POST サイズ | 2.0MB前後 | 2.5MB超 |
| レコード件数 | 84件 | 84未満は要調査 |
| tick 所要 | 1000〜2000ms | 5000ms超 |
| 起動ログ `対象` | 100件 | 40件なら変数未反映 |

ロールバック手順: Railway Variables で `PREMARKET_MAX` を 40 に変更 → 自動再デプロイ → 起動ログで `対象 40件` 確認。実行は 10:00〜10:45。ENV_CHANGELOG に実測値つきで追記。

ログが取れなかった場合: `premarket-summary?date=...` で件数・銘柄数のみ確認可。POST サイズは 19.75KB/銘柄で推定。`tick失敗` は取得不能のため**判定不能**（通過ではない）。火曜に再判定。

### CLAUDE.md 第2弾修正

- 状態: 第1弾（PR #43）・参照書式と関数枠（PR #44）は完了。第2弾は未着手。月曜判定通過後に開始
- 触るファイル: `CLAUDE.md`（第2弾）／`docs/OPERATIONS.md`・`docs/HANDOFF.md`（TTL等の移設先）
- 次の一手: 月曜判定通過後、指示文を作成

第2弾の対象:

- 米国株関連の陳腐化（L3 / L18 / L36）
- `sync.js` の resource 7種（現在3種のみ記載。`premarket-summary` は date 未指定を意図的に400で弾く）
- `tachibana:quote:last:` スナップショット（TTL3日・休場中の板表示用）
- Redis 1MB制限と `"gz:"` プレフィックス、`unpackSync()` の意図的な二重実装
- `limit=5` の根拠と `scan-run` 並列実行の絶対禁止
- 構造上の誤読リスク (b) L50 / (c) L23
- 早見表に `api/news.js` / `api/premarket.js` を追加（#43・#44 の両方で「参考」に計上）
- `tachibana-server` のファイル列挙漏れ（`config.js` / `holidays.js` / `premarketLogger.js`）
- TTL一覧の移設（下記「暫定保持」から `CLAUDE.md` へ移し、こちらからは削除する）

### ドキュメント3層化

- 状態: PR #45 で `docs/OPERATIONS.md`・`docs/HANDOFF.md` を新設。マージ待ち
- 触るファイル: `CLAUDE.md` / `docs/OPERATIONS.md` / `docs/HANDOFF.md`
- 次の一手: 「進行中の案件」を案件別見出しに変更 → PR #45 をマージ・ブランチ削除 → 本ファイルに中身を記入

## 次にやること

月曜判定通過後、上から順に:

1. `CLAUDE.md` 第2弾修正
2. `/api/daily` 連打の**調査のみ**（`src/App.js` の `PUSH_SYNC` に触らせない）
3. `parts.ranking`（5738ms）の計測
4. `premarketLogger.js` の `console.warn` 6箇所を解消（`warn()` ヘルパー経由）
5. README 更新
6. Phase 2B（ギャップ予測を気配ベースへ）
7. `PREMARKET_MAX` を 158（全件）へ引き上げ — **金曜夕方**。推定3.12MB＝Vercel上限の69%

## 未決の判断

- なし（行番号→識別子名、関数枠明記はいずれも PR #44 で採用・完了）

## 未確認の仮説

- `validCount` は寄り付き時刻の代理指標の可能性（0/57/69/81 の4値・12刻み）。`validCount=81` と `open=null` が完全一致。例外: `5242`
- `buyRatioLast` > `buyRatioAvg`（9銘柄で 7/9 vs 6/9）。サンプル不足。5変種（First / Last / Min / Max / Avg）を保存継続中

## 直近の実測値

`PREMARKET_MAX=40`（8/21朝・全項目クリア）:

- 40銘柄 × 16項目 = 640データ点
- tick 所要 444〜641ms
- POST 790KB / 84レコード
- `tick失敗` 0件

派生する事実:

- ペイロード線形性 19.75KB/銘柄（12銘柄→230KB / 40銘柄→790KB）。Vercel上限4.5MB
- 「銘柄数 × 項目数 ≦ 200」制限は640までは不存在（640〜1600は未検証）
- PR #15 の修正2（窓突入検知 60秒→15秒）で収集件数が 81→84。**8/20以前と8/21以降でデータ不連続**

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
