# 作業引き継ぎ（最終更新: 2026-08-28）

このファイルは「今どうなっているか」だけを書く。
恒久的な制約は CLAUDE.md（実装向け）と docs/OPERATIONS.md（運用向け）に書き、
ここには重複させない。更新は GitHub Web エディタで main 直コミット。

進行中の案件には必ず PR 番号を書く。番号が無いものは未投入。
「指示文作成済み」だけの記述は、投入済みかどうかが読めないため使わない。

## 現在の課題

- 急ぎの課題はない。PR #50・#51 はいずれもマージ・効果確認まで完了している
- PR #50 の3点のうち、ネガティブキャッシュと2分停止は 429 が発生しなかったため未発火。
  再連射が止まったことは確認できたが、停止機能そのものの作動は未確認のまま
- parts.ranking の調査は完了。原因はほぼ特定できたが、修正は見送りとした（下記参照）

## 進行中の案件

### parts.ranking の原因調査（調査完了・修正は見送り）

- 状態: 8/28 に Claude Code で調査実施（変更なし）。未投入（PR番号なし）。
  修正は当面着手しない
- 触るファイル: なし（修正に着手する場合は api/ranking.js と api/_scan.js が候補）
- 調査で確定した内容:
  - parts.ranking は buildUniverse の tSync〜tRanking 区間。内訳は
    /api/sector または /api/ranking への内部HTTP1〜2本と、その内側の
    /ranking-data（Railway）・/api/ipo 取得
  - 6016ms の主因は tachibana-server の getRankingData。全銘柄価格を
    120件ずつ・並列5で取得する処理で、コード上に「約4秒で完了する」と明記がある。
    キャッシュ保持は3分でスキャン間隔（最短40分）より短く、毎回ミスが確定する
  - 上記2点は 8/28 に webapi.js を目視確認済み。推測ではない
  - 次に重いのは withFallback の redis.set。全銘柄行データと全銘柄名マップを
    await して保存するため、その時間がまるごと所要msに乗る
- 見送りの理由: 組み立て回はスキャンせず即返す仕様のため、6秒は体感に出ない。
  totalMs 6754ms はタイムアウトではなく正常完了
- 次の一手: 予算超過（下記の未確認の仮説）が実際に観測された時点で再評価する。
  その場合は計測より先に、失敗時の検知と再試行の設計から入る

### /api/daily 連打対策（PR #50・完了・停止機能のみ作動未確認）

- 状態: PR #50 マージ済み・ブランチ削除済み・ENV_CHANGELOG.md 追記済み。
  8/27 夜に Mac の Chrome DevTools で効果確認を実施し、再連射の停止を確認
- 触るファイル: なし
- 次の一手: 場中（9:00〜15:30）に同じ手順で再確認できれば、429 検知時の
  一時停止（DAILY_PAUSED_UNTIL）の作動まで見られる。ただし 429 を意図的に
  誘発する必要はなく、機会があれば見る程度でよい

### /api/daily の呼び出し量そのものの削減（PR2）

- 状態: 未着手。未投入（PR番号なし）。8/27 の実測を受けて優先度を引き下げた
- 触るファイル: src/App.js の fillDayNightFor と visibilitychange のリスナ登録部分
- 次の一手: 当面は観測のみ。表示銘柄数が増えて 429 が再発したときに着手する。
  案D（fillDayNightFor の直列ループに400ms程度の待機＋失敗銘柄への再試行抑止マーク）
  と案E（visibilitychange 経由の再開に最小間隔）。
  案F（pmFetchRecentDaily の cache no-store を force 時のみに限定）は効果の切り分けのため単独PR。
  案C（daily 専用キュー）は PM_FETCH_CONCURRENCY と二重制御になるため最終手段

優先度を下げた理由:

- 429 が0件で、転送量も最大14.1kB と軽い。今すぐ直さないと壊れる状態ではない
- ただし「表示銘柄数ぶんのリクエストが一度に飛ぶ」構造は変わっていない。
  PREMARKET_CODES と違って上限が無く、銘柄数に連動して増えるため、見送りではなく後回し

### ENV_CHANGELOG.md の可読性改善

- 状態: 未着手。未投入（PR番号なし）。内容列に修正内容とPR番号を詰め込んでおり把握しづらい
- 触るファイル: docs/ENV_CHANGELOG.md（追記専用のため既存行は書き換えない）
- 次の一手: 冒頭部分と末尾数行を確認したうえで、内容列の書き方ルールと、
  ファイル冒頭に置く見本1行の案を作る。恒久ルールの記載先は未決

## 次にやること

上から順に:

1. ENV_CHANGELOG.md の書式改善
2. README 更新
3. Phase 2B（ギャップ予測を気配ベースへ）。158件のデータ蓄積が始まったところ
4. PR2 の着手判断。429 が再発するか、表示銘柄数が大きく増えた時点で再評価
5. parts.ranking の修正着手判断。組み立ての予算超過が観測された時点で再評価

## 未決の判断

- 暫定保持に残る項目（premarketLogger.js の9前提、修正時に巻き込む恐れのある箇所7件、
  組み立ての起動経路、PREMARKET_CODES 158件固定）の移設先。docs/OPERATIONS.md が候補だが未着手
- CLAUDE.md のみの変更を ENV_CHANGELOG.md に記録するかどうか。同ファイルは本来
  「環境変数の変更履歴」であり、ドキュメント修正は対象外という整理もあり得る。
  8/26 の CLAUDE.md 修正は記録しない扱いで進めている
- ENV_CHANGELOG.md の書き方ルールを CLAUDE.md と docs/OPERATIONS.md のどちらに置くか
- PM_HIST_MAX を90件より増やすかどうか。Phase 2B で src の型が2種類になるため、
  実質の履歴深さが約45営業日に半減する
- Mac mini で DevTools が使えることが判明した。開発端末は iPad という前提で書かれている
  docs/OPERATIONS.md の記述を更新するかどうか

## 未確認の仮説

- 組み立ての時間予算 BUILD_BUDGET_MS 8000ms に対し、8/24 の totalMs は 6754ms で84%。
  立花側が普段より遅い日は fetchJsonWithin が先に切れる可能性がある。実際に切れた観測は無い
- 分岐C（/api/ranking へのフォールバック）の fetchJsonWithin には try/catch が無く、
  例外が buildUniverse の外へ出る。コード上の事実だが、発生した観測は無い
- 組み立て失敗時、scan:universe:built のマークは組み立ての前に立つため、
  そのスロットは再試行されない可能性がある。未検証
- 内側のタイムアウト（/api/ipo が8秒、/ranking-data が15秒）より外側の予算8秒が
  先に切れる逆転構造になっている。内側の値は実質的に効いていないとみられる
- tachibana-server の getRankingData には topix にある取得中Promise共有（inflight）が無い。
  同時に2本来ると全銘柄取得が二重に走る可能性がある。発生の観測は無い
- scan:universe:meta の source が「ranking(業種で取れなかったため代替)」の場合、
  /api/sector が例外だったのか200で0件だったのかは meta からは区別できない。
  所要時間が大きく違うため、切り分けが必要になったら記録の追加を検討する
- 8/18 の気配データが 3.2KB と小さいのは初日の部分取得と見られるが、未確認。
  8/19・8/20 が 27KB で一致しているため、12件時の定常値は 27KB
- readBody() の {gz:"..."} 受信パスはどの送信側からも使われていない死んだ経路。害はないが未整理
- 101〜158番目の銘柄が小型で板が薄いためデータ量が小さい、という POST サイズ予測外れの解釈。
  銘柄ごとの内訳では未検証（推論のみ）
- api/premarket.js の cache 変数直上のコメント「3分キャッシュ（サーバーレス関数の
  インスタンスが生きている間だけ有効）」は内容は正確だが「Vercel側」の語がない。
  PR #49 では対応不要と判断。用語統一が必要になったときの候補
- validCount は寄り付き時刻の代理指標の可能性（0/57/69/81 の4値・12刻み）。
  validCount=81 と open=null が完全一致。例外は 5242
- buyRatioLast が buyRatioAvg より有効の可能性（9銘柄で 7/9 vs 6/9）。サンプル不足。
  5変種（First / Last / Min / Max / Avg）を保存継続中
- iPad の Web エディタでの貼り付けは、複数行の Markdown で改行が失われることがある。
  8/26 に1回発生（CLAUDE.md）。再発するならドキュメント修正も Claude Code 経由に統一する

## 直近の実測値

### /api/daily 連打対策の効果確認（8/27 夜・Mac の Chrome DevTools）

| 項目 | 実測 | 判定 |
|---|---|---|
| daily リクエスト件数 | 157件（表示銘柄 157件と一致） | 通過（重複取得なし） |
| ステータス | 200 と 304 のみ。429 は0件 | 通過 |
| 裏表の往復による追加リクエスト | 0件 | 通過（再連射なし） |
| 転送量 | 2.0KB / 12.1KB / 14.1KB（3回分） | 通過 |

- 429 が発生しなかったため、ネガティブキャッシュと2分停止は未発火。作動は未確認
- 20:24 の回は大半が disk cache（1ms）、20:32 と 21:25 の回は大半が 304（0.1KB）。
  キャッシュ期限切れ後も再検証だけで済んでおり、本文の再送は起きていない
- 確認したURLはプレビュー用ドメイン。コンソールに出る Vercel の sso-api への
  CORS ブロックと ERR_FAILED はプレビュー認証の副作用で、アプリとは無関係。
  本番ドメインでは出ない
- apple-mobile-web-app-capable の非推奨警告が1件。表示・動作への影響なし

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
8. 検証窓は平日 8:45〜9:06 の21分のみ。失敗の検知は翌営業日。
   実体は START_MINUTE（8:45）/ END_MINUTE（9:06）
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
