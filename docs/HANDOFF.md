# 作業引き継ぎ（最終更新: 2026-08-25）

このファイルは「今どうなっているか」だけを書く。
恒久的な制約は CLAUDE.md（実装向け）と docs/OPERATIONS.md（運用向け）に書き、
ここには重複させない。更新は GitHub Web エディタで main 直コミット。

進行中の案件には必ず PR 番号を書く。番号が無いものは未投入。
「指示文作成済み」だけの記述は、投入済みかどうかが読めないため使わない。

## 現在の課題

- 急ぎの案件なし。PREMARKET_MAX 158 と CLAUDE.md 第2弾 の一連の作業はいずれも完了
- 次の着手候補は PR D（api/ 配下のコメント修正2件）

## 進行中の案件

### api/ 配下のコメント修正（PR D）

- 状態: 未投入（PR番号なし）。指示文も未作成
- 触るファイル: api/sync.js / api/premarket.js
- 次の一手: 指示文を作成して投入 → PR を確認 → マージ・ブランチ削除

対象2件（いずれもコメントのみ。動作に影響なし）:

1. api/sync.js の寄り前ログ節のコメントが「8:31〜9:06」。実装は 8:45〜9:06
2. api/premarket.js の PREMARKET_TTL 行内コメントが「サーバー側キャッシュ（3分）」。
   CLAUDE.md の用語法では「サーバー側」は tachibana-server を指すため逆の意味に読める。
   Vercel 側のメモリキャッシュだと分かる表現にする

Vercel の再デプロイは無害なため時間帯制約なし。

### /api/daily 連打の調査

- 状態: 未着手。未投入（PR番号なし）
- 触るファイル: src/App.js（grep・範囲指定読みのみ。全体読み禁止）
- 次の一手: useEffect 周辺を grep で特定。調査のみ・変更なしで指示。PUSH_SYNC には触らせない

### parts.ranking の原因調査

- 状態: 計測済み（8/24: 6016ms、totalMs 6754 の89%）。原因調査は未着手。未投入（PR番号なし）
- 触るファイル: 未定（api/ranking.js / tachibana-server/webapi.js が候補）
- 次の一手: Vercel → tachibana-server → 立花API のどの区間で時間を食っているかを分解する。
  調査のみ・変更なしで指示

## 次にやること

上から順に:

1. PR D（api/ 配下のコメント修正2件）
2. /api/daily 連打の調査のみ
3. parts.ranking 6016ms の原因調査（調査のみ）
4. README 更新
5. Phase 2B（ギャップ予測を気配ベースへ）。158件のデータ蓄積が始まったところ

## 未決の判断

- 暫定保持に残る項目（premarketLogger.js の9前提、修正時に巻き込む恐れのある箇所7件、
  組み立ての起動経路、PREMARKET_CODES 158件固定）の移設先。docs/OPERATIONS.md が候補だが未着手
- CLAUDE.md のみの変更を ENV_CHANGELOG.md に記録するかどうか。同ファイルは本来
  「環境変数の変更履歴」であり、ドキュメント修正は対象外という整理もあり得る

## 未確認の仮説

- 8/18 の気配データが 3.2KB と小さいのは初日の部分取得と見られるが、未確認。
  8/19・8/20 が 27KB で一致しているため、12件時の定常値は 27KB
- readBody() の {gz:"..."} 受信パスはどの送信側からも使われていない死んだ経路。害はないが未整理
- 101〜158番目の銘柄が小型で板が薄いためデータ量が小さい、という POST サイズ予測外れの解釈。
  銘柄ごとの内訳では未検証（推論のみ）

## 直近の実測値

### PREMARKET_MAX=158（8/25朝・全項目通過）

| 項目 | 実測 | 判定 |
|---|---|---|
| tick失敗 | 0件 | 通過 |
| エラー | 0件 | 通過 |
| POST サイズ | 2352KB | 通過（WARN 3500KB まで 1148KB の余裕） |
| レコード件数 | 84件 | 通過 |
| tick 所要 | 439〜645ms / 平均493ms | 通過 |
| 起動ログ 対象 | 158件 / 158件 / 158件 | 通過 |

- 158 で確定。ロールバック先は 100
- 収集時間 1260秒＝21分ちょうど。84ティック × 15秒と完全一致。窓の取りこぼしなし
- 8:35 JST の日次再ログイン成功。メンテ明けの関門を通過
- 8:50 スキャン 203件 / 4分9秒 / 失敗0件
- 4:29・4:39 JST の watcher 読み込み失敗2件はメンテ帯（3:00〜8:30）内で想定内

### ペイロード線形性の前提が更新された

- 予測 3093KB（19.58KB/銘柄 × 158）に対し実測 2352KB（14.89KB/銘柄）。マイナス741KB、予測比76%
- 19.58KB/銘柄は上位100銘柄に限った値であり、全件には適用できない。
  PREMARKET_CODES は 7203 / 8306 / 9984 と大型株から並んでおり、
  101番目以降は板が薄く1銘柄あたりのデータ量が小さい
- Vercel 上限 4.5MB に対して 52%。当面の余裕は想定以上にある

### 気配データの日次サイズ（Upstash premarket:log:<日付>、gzip 後）

| 日付 | Size | 銘柄数 | 1銘柄あたり |
|---|---|---|---|
| 8/18 | 3.2KB | 12 | — |
| 8/19 | 27KB | 12 | — |
| 8/20 | 26.7KB | 12 | — |
| 8/21 | 91.5KB | 40 | 2.29KB |
| 8/24 | 201KB | 100 | 2.01KB |

## 暫定保持（移設先が決まり次第、順次ここから削除する）

premarketLogger.js の壊してはいけない前提:

1. warn() ヘルパーの内部は console.log。console.warn に戻さない（Railway で [err] 分類される）
2. running の解除は .finally() のみ
3. lastSessionDate ガードは維持
4. errorCount と tickErrorCount を混ぜない
5. PREMARKET_CODES のパースは /^[0-9A-Z]{4}$/
6. PREMARKET_MAX は起動時に一度だけ確定。変更には再起動が必須
7. 1ティック＝立花への POST 1回。ボトルネックは Vercel へのペイロードサイズ
8. 検証窓は平日 8:45〜9:06 の21分のみ。失敗の検知は翌営業日
9. POSTサイズ閾値は POST_SIZE_WARN_KB=3500 / POST_SIZE_ERROR_KB=4000 / POST_SIZE_LIMIT_KB=4500。
   error() は console.error のまま維持する

tick失敗 と エラー は別カウンタ。必ず tick失敗 を先に見る。

修正時に巻き込む恐れのある箇所:

- api/sync.js — lastSectors 未送信時に既存値を維持
- api/_scan.js — 組み立てはスロット先頭の1回だけ。マークが先に立つ
- api/_scan.js の saveUniverse — source が "ranking" 以外だと保存拒否
- src/lib/analyze.js — App.js と api/_scan.js の共有。変更すると自動スキャンの保存スコアも変わる
- src/App.js の PUSH_SYNC — 触るとお気に入りが巻き戻る
- src/App.js の applySyncedData — SyncPanel の ID 切り替え時に last_sectors を上書き
- api/sector.js の sectorCache と分岐 — 触ると AI 呼び出しが復活

組み立ての起動経路:

- 唯一の入口: POST /api/sync?resource=scan-run → runScanBatch → buildUniverse
- フロントの手動スキャンでは走らない（buildStockUniverse はブラウザ内組み立て）
- offset:0 かつ scan:universe:built のマークが無いときだけ組み立て
- 組み立て回はスキャンせず done:0 / nextOffset:0 で即返す

固定事項:

- PREMARKET_CODES は158件固定の定点観測（scan:universe と非連動）。
  PREMARKET_MAX=158 により現在は全件を収集している
