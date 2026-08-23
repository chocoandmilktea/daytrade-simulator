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
- GitHub Web エディタ … main 直コミット用
- 立花証券API / Pushover / TradingView
