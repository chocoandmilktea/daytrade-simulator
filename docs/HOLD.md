# 暫定保持

移設先が決まり次第、順次ここから削除する

件数: 28件 ／ 最終棚卸し:2026-08-31

## 暫定保持／premarketLogger.js の前提

premarketLogger.js の壊してはいけない前提:

1. 暫定保持01／warn は console.log：warn() ヘルパーの内部は console.log。console.warn に戻さない（Railway で [err] 分類される）
   - 移設先候補: 未記入
2. 暫定保持02／running の解除：running の解除は .finally() のみ
   - 移設先候補: 未記入
3. 暫定保持03／lastSessionDate ガード：lastSessionDate ガードは維持する
   - 移設先候補: 未記入
4. 暫定保持04／errorCount と tickErrorCount：errorCount と tickErrorCount を混ぜない。
   errorCount は加算式ではなく収集終了時に records から導出している
   - 移設先候補: 未記入
5. 暫定保持05／PREMARKET_CODES のパース：PREMARKET_CODES のパースは /^[0-9A-Z]{4}$/
   - 移設先候補: 未記入
6. 暫定保持06／起動時に一度だけ確定：PREMARKET_MAX と PREMARKET_CHUNK_SIZE は起動時に一度だけ確定。変更には再起動が必須
   - 移設先候補: 未記入
7. 暫定保持07／1ティックのチャンク分割：1ティック＝立花への POST がチャンク数ぶん（現在は80件×2の直列）。
   ボトルネックは Vercel へのペイロードサイズ
   - 移設先候補: 未記入
8. 暫定保持08／検証窓 8:45〜9:06：検証窓は平日 8:45〜9:06 の21分のみ。失敗の検知は翌営業日。
   実体は START_MINUTE（8:45）/ END_MINUTE（9:06）
   - 移設先候補: 未記入
9. 暫定保持09／POSTサイズ閾値：POSTサイズ閾値は POST_SIZE_WARN_KB=3500 / POST_SIZE_ERROR_KB=4000 /
   POST_SIZE_LIMIT_KB=4500。error() は console.error のまま維持する
   - 移設先候補: 未記入
10. 暫定保持10／立花120件上限：立花への1回の要求で返るのは先頭120件まで。この上限自体は解消していない。
    PR #19 は要求を80件ずつに割ることで回避している
    - 移設先候補: 未記入
11. 暫定保持11／予想生成の呼び出し条件：予想生成の呼び出し（postPrediction）は生ログ保存成功時のみ。
    失敗しても収集の成否に影響させない
    - 移設先候補: 未記入

## 暫定保持／tick失敗とエラーの区別

12. 暫定保持12／tick失敗とエラーの区別：tick失敗 と エラー は別カウンタ。必ず tick失敗 を先に見る。
    tick失敗の単位は PR #19 以降チャンク単位。過去の数字と直接比較しないこと。
    - 移設先候補: 未記入

## 暫定保持／修正時に巻き込む恐れのある箇所

修正時に巻き込む恐れのある箇所:

13. 暫定保持13／lastSectors の維持：api/sync.js — lastSectors 未送信時に既存値を維持
    - 移設先候補: 未記入
14. 暫定保持14／summarizePremarketDate の依存：api/sync.js の summarizePremarketDate — mode=calib / mode=coverage /
    premarket-prediction の3つが依存。変更すると数字が食い違う
    - 移設先候補: 未記入
15. 暫定保持15／組み立てはスロット先頭のみ：api/_scan.js — 組み立てはスロット先頭の1回だけ。マークが先に立つ
    - 移設先候補: 未記入
16. 暫定保持16／saveUniverse の保存拒否：api/_scan.js の saveUniverse — source が "ranking" 以外だと保存拒否
    - 移設先候補: 未記入
17. 暫定保持17／analyze.js の共有：src/lib/analyze.js — App.js と api/_scan.js の共有。変更すると自動スキャンの保存スコアも変わる
    - 移設先候補: 未記入
18. 暫定保持18／PUSH_SYNC とお気に入り：src/App.js の PUSH_SYNC — 触るとお気に入りが巻き戻る
    - 移設先候補: 未記入
19. 暫定保持19／applySyncedData の上書き：src/App.js の applySyncedData — SyncPanel の ID 切り替え時に last_sectors を上書き
    - 移設先候補: 未記入
20. 暫定保持20／sectorCache と AI 呼び出し：api/sector.js の sectorCache と分岐 — 触ると AI 呼び出しが復活
    - 移設先候補: 未記入
21. 暫定保持21／較正係数が2箇所：較正係数が2箇所にある（api/sync.js は環境変数・src/App.js は直書き）。
    片方だけ変えると2つの予想がズレる
    - 移設先候補: 未記入

## 暫定保持／組み立ての起動経路

組み立ての起動経路:

22. 暫定保持22／組み立ての唯一の入口：唯一の入口: POST /api/sync?resource=scan-run → runScanBatch → buildUniverse
    - 移設先候補: 未記入
23. 暫定保持23／手動スキャンでは走らない：フロントの手動スキャンでは走らない（buildStockUniverse はブラウザ内組み立て）
    - 移設先候補: 未記入
24. 暫定保持24／組み立ての条件：offset:0 かつ scan:universe:built のマークが無いときだけ組み立て
    - 移設先候補: 未記入
25. 暫定保持25／組み立て回は即返す：組み立て回はスキャンせず done:0 / nextOffset:0 で即返す
    - 移設先候補: 未記入

## 暫定保持／固定事項

固定事項:

26. 暫定保持26／PREMARKET_CODES は158件固定：PREMARKET_CODES は158件固定の定点観測（scan:universe と非連動）
    - 移設先候補: 未記入
27. 暫定保持27／予想レコードは2系統：予想レコードは2系統ある。
    サーバー側は premarket:pred:<日付>（30日・全端末共通）、
    ブラウザ側は localStorage の pm_<ticker>（端末間同期の対象外・最大180件）。
    移行期間中は併存する
    - 移設先候補: 未記入
28. 暫定保持28／Upstash の料金プラン：Upstash は Pay As You Go（$0.2 / 100Kコマンド）。Max Budget 20ドル。
    上限到達時はデータベースが停止する。70%・90%でメール通知
    - 移設先候補: 未記入
