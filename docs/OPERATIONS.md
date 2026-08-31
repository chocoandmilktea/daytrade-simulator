# 運用ルール（人間向け）

このファイルは運用手順をまとめたもの。実装時の制約は CLAUDE.md を参照。
現在の作業状態は docs/HANDOFF.md を参照。

## デプロイ可否の時間帯

平日のみ適用。土日は制限なし。

- 全面禁止: 3:00〜9:40
- 回避: 各スキャンスロットの前後5分（8:50 / 9:30 / 11:00 / 13:00 / 15:00）
- 安全帯: 10:00〜10:45 / 13:30〜14:45 / 15:30以降

大きな変更は金曜午前に行う（週末に回復時間を確保できるため）。

## デプロイの挙動

- Railway の環境変数を変更すると、コンテナ全体が自動で再デプロイされる。複数の変数を変える場合は1回の保存操作にまとめ、再デプロイ回数を減らす
- Railway のデプロイは「新コンテナ起動 → 旧コンテナ停止」の順。同時置換ではない
- Vercel の再デプロイは無害。Railway 上で動いているプロセスは再起動しない
- Railway でデプロイが失敗した場合、Redeploy ボタンが表示されない。空コミットを push して再デプロイを促す
- docs/ 配下は daytrade-simulator 側にあるため、更新しても Railway は再起動しない

## ログ・環境変数の制約

- Vercel Hobby のログ保持は1時間。`Last day` 以降は Pro が必要
- Vercel の `Sensitive` 環境変数は保存後に値を読み戻せない。上書きのみ可能。値は Railway の Variables 側から読める
- Railway のログはブラウザ表示が JST、ダウンロードは UTC
- JSONL でログをエクスポートすると `duration` と `message` が欠落する。必要な場合はダッシュボード上で個別の行をクリックする
- 開発端末は iPad。DevTools は使えない。API の確認は Safari の URL 直接入力で行う

### 寄り前収集のログの読み方

該当ファイルは tachibana-server の premarketLogger.js。

- tick失敗 と エラー は別のカウンタで、収集終了のログの同じ行に並ぶ。**必ず tick失敗 を先に見ること。** tick失敗 は取得そのものが失敗した回数、エラー は取れたデータ側の異常の件数で、原因の切り分けが変わる
- tick失敗 の数え方は変わっている。以前は1ティック単位だったが、寄り前収集をチャンク分割方式に変えて以降はチャンク単位。1ティックが複数チャンクに分かれるため、同じ障害でも以前より数字が大きく出る。**過去のログの数字と直接比較しないこと**
- 判定の目安は、チャンク単位で20件以上の tick失敗 が出ていれば異常とみなす。以前の基準（10件以上）をそのまま当てはめないこと

### 寄り前収集の対象銘柄

- 寄り前収集の対象銘柄は Railway の環境変数 `PREMARKET_CODES` で決まる。現在は158銘柄の定点観測
- この件数はコードには存在せず、Railway の Variables 画面でしか確認できない
- 対象銘柄は自動スキャンの銘柄リスト（`scan:universe`）とは連動していない。片方を変えてももう片方は変わらない

## ドキュメントの更新方法

| ファイル | 更新頻度 | 更新方法 |
|---|---|---|
| CLAUDE.md | 低 | Claude Code に指示 |
| docs/OPERATIONS.md | 低 | Claude Code に指示、または GitHub Web エディタ |
| docs/HANDOFF.md | 高 | GitHub Web エディタで main 直コミット |
| docs/ENV_CHANGELOG.md | 中 | GitHub Web エディタで main 直コミット |

- ENV_CHANGELOG.md は追記専用。実際にデプロイ・マージされたものだけを記録する
- CLAUDE.md に関わるコード変更を Claude Code に依頼するときは、指示文の末尾に「変更に伴い CLAUDE.md の該当記述も更新すること」を付け加える

## ブランチ・PR の運用

- PR のマージ判断は必ず人間が行う。Claude Code にマージさせない
- ブランチの要否は GitHub の Branches 画面で Ahead を見て手動判断する。Claude Code のリモートブランチに関する調査結果は当てにならない
- Ahead 0 のブランチは中身を確認せず削除してよい
- `Able to merge` は「テキスト上の衝突がない」ことだけを意味する。意味的な整合性は保証されない

## 手動スキャンの起動（iPad ショートカット）

「URLの内容を取得」アクションに以下を設定する。

- URL: https://daytrade-simulator.vercel.app/api/sync?resource=scan-run
- メソッド: POST
- ヘッダ: `Content-Type: application/json` と `X-Relay-Secret`
- 本文: JSON モードで `date`（テキスト）・`slot`（テキスト）・`offset`（数字）・`limit`（数字）

`slot` を数字型にすると `unknown slot` エラーになる。本文に「テキスト」モードは無い。

運用ルール:

- 必ず終了済みのスロットを指定する（未来のスロットを指定すると、まだ来ていない時刻の `scan:universe:built` マークを立ててしまう）
- 1回で止める。2回目は実スキャンに入り `scan:result` を汚す
- Railway 側のスキャンと同時に叩かない
- 手動テストの前に、Upstash Data Browser から `scan:universe:built` を削除する。残っていると組み立て処理がスキップされる

## ツール

- Vercel … daytrade-simulator。Hobby プラン（関数枠の残量は CLAUDE.md を参照）
- Railway … tachibana-server。常時起動コンテナ
- Upstash Redis … upstash-kv-copper-notebook。キーの確認・手動削除に使用
  - 料金プランは Pay As You Go（100Kコマンドあたり0.2ドル）。上限は Max Budget 20ドルに設定してある
  - **上限に到達するとデータベースが停止し、読み書きが両方止まる。** 使用量の70%と90%でメール通知が届く
  - プラン変更の導線は Vercel のダッシュボード側にしかない。Upstash のコンソールにある Choose Plan は常時無効になっている
  - 月に一度、使用量と金額を確認すること
- GitHub Web エディタ … main 直コミット用
- 立花証券API / Pushover / TradingView
