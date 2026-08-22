# DaySimulator（daytrade-simulator）

日本株・米国株のスキャン、スコアリング、トレード記録を行う株式情報アプリ。

## 作業ルール（トークン節約・最優先）

- `src/App.js` は約7200行。**全体を読むことを禁止する。**
- 修正依頼を受けたら、まず `grep -n "キーワード" 対象ファイル` で該当行を特定し、その前後50〜100行だけを offset/limit 指定で読む。
- 読み込む前に「どの関数を何行目付近から読むか」を1行で宣言する。
- 編集は Edit（部分置換）のみ。Write によるファイル全体の書き換えは禁止。
- 1回の依頼で触るファイルは原則1つ。関連ファイルは必要になってから読む。
- 回答は結論を先に5行以内。変更後のコード全文を再掲しない（差分の要約のみ）。
- 動作確認は該当機能のみ。全体ビルド確認は明示的な指示があった時だけ。

## ファイル早見表（読む前の当たり付け用）

- `src/App.js` … フロント全体（React・単一ファイル）。UI・状態管理・全API呼び出し・スキャンのキュー制御
- `api/ranking.js` … 出来高／値上がりランキング生成（JP: 立花、US: Yahoo）
- `api/sector.js` … AI選定業種で絞ったランキング（`ranking.js` の関数を再利用）
- `api/stock.js` … 個別銘柄の詳細（分足: Yahoo、財務指標/TOPIX: 立花）。内部は並列取得
- `api/daily.js` … ミニチャート用の日足（直近3ヶ月・Yahoo）
- `api/intraday.js` … 当日1分足（Yahoo）。銘柄選択時のみ呼ばれ、スキャン時は呼ばれない
- `api/sync.js` … デバイス間同期（TTL90日）＋ 立花リアルタイム中継の窓口
- `api/ai.js` … Anthropic APIプロキシ（system prompt・web_search対応）
- `api/ipo.js` … 銘柄コード→会社名（立花・1時間キャッシュ）
- `api/notify.js` … Pushover通知
- `api/_fallbackCache.js` … 取得失敗時のRedisフォールバック共通ヘルパー（`_` 始まりはVercelにエンドポイント扱いさせないため）
- `api/_scan.js` … 定時自動スキャンの本体（対象銘柄リストの組み立て・スコア計算・結果保存）。窓口は `sync.js?resource=scan-run`
- `api/index.js` … 用途未確認のため触らない
- **⚠️ Vercel Hobbyはサーバーレス関数12個まで。新しい `api/*.js` を増やさず既存に相乗りさせる**（`sync.js` が立花中継を兼ねるのはこのため）

## 構成・データ源

- バックエンド: Vercel Functions（`api/`）／ストア: Upstash Redis（同期データ・フォールバック用スナップショット）／リアルタイム中継: Railway上の別リポジトリ `tachibana-server`（常時起動）
- 立花証券e支店API: 日本株の現在値・板情報・出来高ランキング・業種・会社名・PER/PBR/EPS/BPS/配当利回り/権利落ち日・TOPIX日次騰落率
- Yahoo Finance: 分足・日足ミニチャート・米国株全般／東証（JPX）公式Excel（認証不要）: 決算発表予定日
- **J-Quantsは2026年7月に完全廃止済み。新たにJ-Quantsを使うコードを書かないこと**（`JQUANTS_API_KEY` は不使用）

## 立花証券APIの扱い方（重要）

Vercelから立花APIを**直接叩かない**。`App.js → api/*.js → tachibana-server(webapi.js) → 立花e支店API`（tachibana-server側は `index.js`（起動）/ `auth.js`（ログイン・仮想URL復号）/ `eventClient.js`（WebSocket）/ `relay.js` / `watcher.js` / `webapi.js` / `scanner.js`（定時スキャンのスケジューラ））。

- エンドポイントは4つ: `/ranking-data`（`api/ranking.js`・1〜3分キャッシュ）、`/issue-detail?code=XXXX`（`api/stock.js`・1時間）、`/topix`（`api/stock.js`・1時間）、`/names`（`api/ipo.js`・24時間）
- URLは環境変数から読む（`TACHIBANA_RANKING_API` / `TACHIBANA_ISSUE_DETAIL_API` / `TACHIBANA_TOPIX_API` / `TACHIBANA_NAMES_API`）、認証はヘッダ `X-Relay-Secret`（`TACHIBANA_RELAY_SECRET`）
- 取得は必ず `withFallback(key, fn)`（`api/_fallbackCache.js`）で包み、`AbortSignal.timeout()` を付ける（8秒目安、一括取得系は15秒）
- 毎日3:00〜8:30はシステムメンテナンスでAPIが落ちるが、`withFallback` がRedisの前回成功データ（3日保持）を返すため問い合わせ自体をスキップしない

### リアルタイム株価・板情報（選択中の1銘柄のみ購読）

`App.js` の `TachibanaBoard` が60秒おきに `sync.js?resource=tachibana-watch` へPOST（5分でタイムアウト）→ `tachibana-server` がWebSocketで購読し `tachibana-quote` へPOST（Redis TTL 30秒）→ `App.js` が7秒おきにGETして表示。

- フィールド名は `p_1_DPP`（現在値）、`p_1_DYRP`（騰落率）、`p_1_GAV1〜10`（売気配数量）、`p_1_GBV1〜10`（買気配数量）など
- 受信イベントには「全項目入り」と「価格のみの軽量更新」があるため、**丸ごと置き換えず既存fieldsにマージする**こと（気配値が消えるバグの原因）

## 定時自動スキャン（`scanner.js` → `api/_scan.js`）

時計とループ制御は `tachibana-server/scanner.js` だけが担当し、銘柄リストの組み立て・スコア計算・保存はすべて `api/_scan.js`。scanner.js は Vercel の `/api/sync?resource=scan-run` を `nextOffset` が返らなくなるまで繰り返し呼ぶ。

- 実行時刻は 8:50 / 9:30 / 11:00 / 13:00 / 15:00（月〜金のみ。土日・祝日はバッチを投げない）、バッチサイズ5・直列。対象は日本株のみ（絞り込みは `_scan.js` 側）
- 停滞検知あり: 同一 `offset` が3回連続で返った場合はループを中断する（`MAX_SAME_OFFSET = 3`）
- スキャン対象の銘柄リスト（ユニバース）は**サーバー側で組み立てる**。以前あった無認証のPOST口は廃止済み
- ユニバース本体 `scan:universe` のTTLは7日（`UNIVERSE_TTL`）。`scan:universe:meta` も同じ7日
- 組み立て済みマーク `scan:universe:built` のTTLは3日（`UNIVERSE_BUILD_TTL`）。本体より短いのは意図的（`_scan.js:33-34`）
- マークの書き込みに失敗した場合は `buildUniverse` を呼ばずエラーを返し、呼び出し側のループを止める（空回り防止）
- `userId` はリクエストから受け取らず、環境変数 `SCAN_SYNC_USER_ID` で固定
- 業種絞り込みは同期データの `lastSectors` を参照し、無い場合は `/api/ranking` にフォールバックする

## 開発ルール・よくある落とし穴

- **既存のコードスタイルを踏襲する**: `var` / `function` 式 / インライン `style` オブジェクト。ES6+の書き換えやCSSファイル化はしない。コメントは日本語で書く
- 依頼されていない箇所は変更しない／新しいライブラリを勝手に追加しない／秘密鍵・APIキーは直書きせず環境変数
- 外部API呼び出しには必ずタイムアウトとエラーハンドリングを付ける。変更後は「何をどう変えたか」を日本語で要約する
- 日本株の前日比は `PrevC`（前日終値）を優先。無い場合のみ始値比で代用する
- 銘柄コードは4桁。`ticker` は `"7203.T"` 形式、立花APIへは `.T` を外して渡す。スキャン時は `CACHE` をクリアして必ず最新データを取る
