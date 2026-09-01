# DaySimulator（daytrade-simulator）

日本株のスキャン、スコアリング、トレード記録を行う株式情報アプリ。

## 作業ルール（トークン節約・最優先）

- `src/App.js` は約7200行。**全体を読むことを禁止する。**
- 修正依頼を受けたら、まず `grep -n "キーワード" 対象ファイル` で該当行を特定し、その前後50〜100行だけを offset/limit 指定で読む。
- 読み込む前に「どの関数を何行目付近から読むか」を1行で宣言する。
- 編集は Edit（部分置換）のみ。Write によるファイル全体の書き換えは禁止。
- 1回の依頼で触るファイルは原則1つ。関連ファイルは必要になってから読む。
- 回答は結論を先に5行以内。変更後のコード全文を再掲しない（差分の要約のみ）。
- 動作確認は該当機能のみ。全体ビルド確認は明示的な指示があった時だけ。

## 報告の書き方

- 冒頭3行は「アプリを触ったときに何がどう変わるか」を書く。関数名・変数名・ファイル名を使わない
- そのあとに技術的な詳細を書く。変更箇所は関数名単位で列挙する
- 変更ごとに「なぜその実装にしたか」を1行添える。何をしたかだけでは人間が判断できない
- 専門用語を初めて使うときは直後に丸括弧で1行の言い換えを添える
- 今回の変更で起こり得る副作用と、それが表に出る条件を書く
- 変更後のコード全文は再掲しない。差分の要約のみ

## 関連ドキュメント

- `docs/OPERATIONS.md` … デプロイ可否の時間帯、ログ確認手順、ツール制約（人間向け・運用情報）
- `docs/HANDOFF.md` … 現在の作業状態。進行中の案件と次にやること
- `docs/ENV_CHANGELOG.md` … 環境変数の変更履歴（追記専用）

## このドキュメント内の参照の書き方

- コード上の値・設定を参照するときは、**行番号ではなく識別子名で書く**（例: `UNIVERSE_BUILD_TTL` / `WATCH_TTL` / `watchStaleSeconds`）
- 識別子名なら `grep` で追跡できるが、行番号はコード変更で必ずズレるため
- 識別子が存在しない箇所（コメント・処理ブロック等）に限り行番号を書いてよい。その場合は「※行番号は目安」と明記する
- 別リポジトリ（`tachibana-server`）の行番号は当リポジトリから検証できないため書かない。ファイル名までにとどめる

## ファイル早見表（読む前の当たり付け用）

- `src/App.js` … フロント全体（React）。UI・状態管理・全API呼び出し・スキャンのキュー制御。**スコア計算の本体は `src/lib/analyze.js` に分離済み**
- `src/lib/analyze.js` … スコア計算本体（約1050行）。`src/App.js` と `api/_scan.js` の両方が import する共有モジュール。変更するとフロント表示だけでなく自動スキャンの保存スコアも同時に変わる
- `api/ranking.js` … 出来高／値上がりランキング生成（日本株のみ・立花）。米国株ランキング（Yahooのスクリーナー）は削除済み
- `api/sector.js` … AI選定業種で絞ったランキング（`ranking.js` の関数を再利用）。キャッシュと分岐の扱いは「開発ルール・よくある落とし穴」の節を参照
- `api/stock.js` … 個別銘柄の詳細（分足: Yahoo、財務指標/TOPIX: 立花）。内部は並列取得
- `api/daily.js` … ミニチャート用の日足（直近3ヶ月・Yahoo）
- `api/intraday.js` … 当日1分足（Yahoo）。銘柄選択時のみ呼ばれ、スキャン時は呼ばれない
- `api/premarket.js` … 「今朝の地合い」を1レスポンスで返す。日経225先物・SOX・S&P500・NASDAQ・ドル円・VIX・NYダウの前日比をYahooから集め、加重平均して寄り付きの想定ギャップ `marketBias` を出す。`codes` 指定時のみ立花の `/market-price`（寄り前気配）も中継する
- `api/sync.js` … 同期・中継の総合窓口。`resource` パラメータで8種に分岐（詳細は後述）。TTL は用途ごとに5種類あるため、単一の値では表せない
- `api/ai.js` … Anthropic APIプロキシ（system prompt・web_search対応）
- `api/news.js` … TDnet（適時開示）とYahooファイナンスの見出しを取得し、Anthropic APIで5カテゴリに要約する。**Web検索は使わず、取得した実データだけをAIに渡す**
- `api/ipo.js` … 銘柄コード→会社名（立花・1時間キャッシュ）
- `api/notify.js` … Pushover通知
- `api/_fallbackCache.js` … 取得失敗時のRedisフォールバック共通ヘルパー（`_` 始まりはVercelにエンドポイント扱いさせないため）
- `api/_scan.js` … 定時自動スキャンの本体（対象銘柄リストの組み立て・スコア計算・結果保存）。窓口は `sync.js?resource=scan-run`
- **⚠️ Vercel Hobbyはサーバーレス関数12個まで。新しい `api/*.js` を増やさず既存に相乗りさせる**（`sync.js` が立花中継を兼ねるのはこのため）

### Vercel関数枠の残量（実測値）

- **現在の消費数: 11個 / 上限 12個（Vercel Hobbyプランの上限）。残り枠は1つだけ**
- 数え方の根拠
  - `api/` 直下の `.js` ファイルは、1つにつき関数枠を1つ消費する
  - ファイル名が `_` で始まるものは Vercel がエンドポイントとして扱わないため、枠を消費しない（共通モジュール用。現状 `api/_scan.js` と `api/_fallbackCache.js` の2つが該当）
- 枠を消費するファイル一覧（11個）
  - `api/ai.js` / `api/daily.js` / `api/intraday.js` / `api/ipo.js` / `api/news.js` / `api/notify.js` / `api/premarket.js` / `api/ranking.js` / `api/sector.js` / `api/stock.js` / `api/sync.js`
- **新規エンドポイントを追加する前に、必ず `api/` を数え直すこと。** 枠が足りない場合は、次のどちらかで実装できないか先に検討する
  - 既存エンドポイントに `resource` パラメータで相乗りさせる（`sync.js?resource=scan-run` と同じ方式）
  - `_` 接頭辞の共通モジュールとして実装し、呼び出しは既存エンドポイントから行う

## 環境変数

値はここに書かない。既定値はコード上の定数のため記載する。実際に設定されている値は Vercel の Environment Variables 画面で確認する。

### Vercel Functions

| 変数名 | 必須・任意 | 用途 |
| --- | --- | --- |
| `UPSTASH_REDIS_REST_URL` | 必須 | Upstash Redis の REST 接続先。`Redis.fromEnv()` が読む。未設定でも起動は継続し、Redis を使う経路が最初のアクセスで失敗する |
| `UPSTASH_REDIS_REST_TOKEN` | 必須 | 同上のトークン。未設定時の挙動も同じ |
| `TACHIBANA_RELAY_SECRET` | 必須 | `tachibana-server` との共有の合言葉。受信側は `api/sync.js` の `isAuthed()` で照合し、未設定だと認証が要る5経路（`tachibana-watch` の GET、`tachibana-quote` の POST、`premarket-log` の POST、`premarket-prediction` の POST、`scan-run` の POST）がすべて 401 になる。送信側は未設定でもヘッダを付けずに動く |
| `TACHIBANA_RANKING_API` | 任意 | 立花の `ranking-data` の中継先URL。未設定なら例外になるが `withFallback` が Redis の前回成功データを返す。`TACHIBANA_MARKET_PRICE_API` の導出元も兼ねる |
| `TACHIBANA_ISSUE_DETAIL_API` | 任意 | 立花の `issue-detail` の中継先URL。未設定時は `withFallback` が肩代わりする |
| `TACHIBANA_TOPIX_API` | 任意 | 立花の `topix` の中継先URL。未設定時は `withFallback` が肩代わりする |
| `TACHIBANA_NAMES_API` | 任意 | 立花の `names` の中継先URL。未設定時は `withFallback` が肩代わりする |
| `TACHIBANA_MARKET_PRICE_API` | 任意（既定は `TACHIBANA_RANKING_API` から導出） | 寄り前気配の `market-price` の中継先URL。既定値は `TACHIBANA_RANKING_API` の `ranking-data` の部分を `market-price` に置き換えたもの。両方とも未設定の場合は `quotes` にエラーを載せた 200 を返す |
| `ANTHROPIC_API_KEY` | 必須（`api/ai.js` と `api/news.js` のみ） | Anthropic API プロキシの認証。未設定なら即 500 を返す |
| `PUSHOVER_TOKEN` | 必須（通知を使う場合） | Pushover のアプリトークン。未設定チェックが無いため、未設定でも API は 200 を返すが通知は届かない |
| `PUSHOVER_USER` | 必須（通知を使う場合） | Pushover の宛先ユーザーキー。未設定時の挙動は上と同じ |
| `SCAN_SYNC_USER_ID` | 任意（既定は空文字） | 自動スキャンの銘柄リスト組み立て時に、お気に入り・トレード中銘柄を読むための固定ユーザーID。未設定でも警告ログが出るだけで処理は続き、お気に入りが銘柄リストに加わらなくなる |
| `VERCEL_URL` | 自動注入 | 自分自身の `/api/sector` と `/api/ranking` を叩くためのホスト名。Vercel が自動で入れるため人は設定しない。既定は `daytrade-simulator.vercel.app` |
| `PM_Q_SLOPE` | 任意（既定 0.058） | 寄り前予想の較正係数。買い比率1ポイントあたりの予想ギャップの大きさ。**当面は設定しないこと。** 設定するとサーバー側だけが変わり、`src/App.js` にある同名の直書き定数と食い違う |
| `PM_Q_INTERCEPT` | 任意（既定 -0.105） | 寄り前予想の較正係数。買い比率50%のときの予想ギャップ。注意点は `PM_Q_SLOPE` と同じ |

※ `KV_REST_API_URL` と `KV_REST_API_TOKEN` は当リポジトリのコードには書かれていないが、`@upstash/redis` が `UPSTASH_REDIS_REST_` 系の代替名として読む。Vercel の Upstash 連携がこの名前を注入することがあり、コードを `grep` しても出てこないのに効く場合がある
※ `TACHIBANA_WATCH_API` と `TACHIBANA_QUOTE_API` は `tachibana-server` 側の環境変数。`src/App.js` にも同名の定数があるが、そちらは直書きの JS 定数であり環境変数ではない

### GitHub Actions

| 変数名 | 必須・任意 | 用途 |
| --- | --- | --- |
| `SYNC_URL` | 必須 | 予測バッチが同期APIを読むためのアプリURL。未設定なら `KeyError` で即失敗する |
| `USER_ID` | 必須 | 予測対象のお気に入りを引くデバイス同期ID。未設定なら `KeyError` で即失敗する |
| `MODEL` | 任意（既定 `amazon/chronos-bolt-small`） | 予測モデル名。`forecast.yml` が渡していないため現状は常に既定値で動く |

※ `forecast.yml` の `Commit result` ステップの push は、明示的なトークン参照を持たず、`actions/checkout` が埋め込む既定のトークン（`permissions` の `contents: write`）に依存する

変数ごとの参照箇所の詳細は `docs/ENV_AUDIT.md` にある（2026-08-20 時点で凍結）。

## 構成・データ源

- バックエンド: Vercel Functions（`api/`）／ストア: Upstash Redis（同期データ・フォールバック用スナップショット）／リアルタイム中継: Railway上の別リポジトリ `tachibana-server`（常時起動）
- 立花証券e支店API: 日本株の現在値・板情報・出来高ランキング・業種・会社名・PER/PBR/EPS/BPS/配当利回り/権利落ち日・TOPIX日次騰落率
- Yahoo Finance: 分足・日足ミニチャート・市況指数（日経225先物／米国主要指数／SOX／VIX／ドル円）／東証（JPX）公式Excel（認証不要）: 決算発表予定日
- **J-Quantsは2026年7月に完全廃止済み。新たにJ-Quantsを使うコードを書かないこと**（`JQUANTS_API_KEY` は不使用）

### 米国株の扱い（コードはあるが運用していない）

- **米国株は現在まったく運用していない。対象は日本株のみ**
- ただしコード上には米国株向けの実装が残存している。主なものは次の2種類
  - `market==="US"` の分岐（`src/App.js`。市場バッジ `MKT.US`、ドル円換算表示、ユニバース組み立て時の `market` 判定など）
  - 米国株向けの価格処理（`src/lib/analyze.js` の `tickSizeFor` / `roundTickPrice` の `isJP=false` 側は呼値0.01・小数2桁、`src/App.js` の `fmtMoney` / `fmtPnl` は `$` 表記）
- **依頼されていない限り、米国株関連のコードを削除しないこと。** 動作している既存機能を壊すリスクがあるため
- 新機能を実装するとき、米国株対応を考慮する必要はない
- なお `api/premarket.js` がS&P500・NASDAQ・NYダウ等を取るのは「日本株の寄り付き想定ギャップの材料」であり、米国株の運用ではない

## 立花証券APIの扱い方（重要）

Vercelから立花APIを**直接叩かない**。`App.js → api/*.js → tachibana-server(webapi.js) → 立花e支店API`（tachibana-server側は `index.js`（起動）/ `config.js`（設定値。`watchStaleSeconds` などの定義元）/ `auth.js`（ログイン・仮想URL復号）/ `eventClient.js`（WebSocket）/ `relay.js` / `watcher.js` / `webapi.js` / `scanner.js`（定時スキャンのスケジューラ）/ `holidays.js`（日本の祝日判定）/ `premarketLogger.js`（寄り付き前の気配データ収集。平日 8:45〜9:06））。

- エンドポイントは5つ。**Vercel側キャッシュとサーバー側（tachibana-server）キャッシュは別物**なので混同しないこと:
  - `/topix` … 呼び出し元 `api/stock.js`（Vercel側キャッシュ: 1時間 / `TOPIX_TTL`）｜サーバー側キャッシュ: 未確認
  - `/issue-detail?code=XXXX` … 呼び出し元 `api/stock.js`（Vercel側キャッシュ: 1時間 / `ISSUE_DETAIL_TTL`）｜サーバー側キャッシュ: 未確認
  - `/ranking-data` … 呼び出し元 `api/ranking.js`（Vercel側キャッシュ: なし。`withFallback` は失敗時フォールバックであってキャッシュではない）｜サーバー側キャッシュ: 3分（`tachibana-server` の `webapi.js`）
  - `/names` … 呼び出し元 `api/ipo.js`（Vercel側キャッシュ: 1時間 / `CACHE_TTL`）｜サーバー側キャッシュ: 24時間（銘柄マスタ）。**Vercel側とサーバー側で保持時間が異なる**
  - `/market-price` … 呼び出し元 `api/premarket.js`（Vercel側キャッシュ: なし）｜サーバー側キャッシュ: なし
  - これらはすべてモジュールスコープの変数（プロセス内メモリ）であり Redis ではない。Lambda コンテナが再利用されたときだけ効くため、実効ヒット率は記載の時間ほど高くない。唯一の例外は `api/stock.js` の決算日マップで、メモリ6時間 → Redis 24時間（`jpx:earnings-map`）の二段構え
  - `api/premarket.js` の `PREMARKET_TTL`（3分・メモリ）がキャッシュしているのは Yahoo 由来の地合いデータ（`marketBias` / `indicators`）であって、立花の `/market-price`（寄り前気配）ではない。気配は `fetchQuotes()` で毎回そのまま取得しており、`codes` 指定時は `Cache-Control: no-store` を返して CDN・ブラウザにもキャッシュさせない。秒単位で変わるデータのため
- URLは環境変数から読む（`TACHIBANA_RANKING_API` / `TACHIBANA_ISSUE_DETAIL_API` / `TACHIBANA_TOPIX_API` / `TACHIBANA_NAMES_API` / `TACHIBANA_MARKET_PRICE_API`）、認証はヘッダ `X-Relay-Secret`（`TACHIBANA_RELAY_SECRET`）
  - `TACHIBANA_MARKET_PRICE_API` … 立花 `/market-price` の URL。`api/premarket.js` が読む。未設定の場合は `TACHIBANA_RANKING_API` の `/ranking-data` を `/market-price` に文字列置換してフォールバックする
- 立花APIの取得は原則 `withFallback(key, fn)`（`api/_fallbackCache.js`）で包み、`AbortSignal.timeout()` を付ける（8秒目安、一括取得系は15秒）。ただし全5エンドポイント中、実際に包んでいるのは4つ
  - 包んでいる … `api/stock.js`（`/topix`・`/issue-detail`）、`api/ranking.js`（`/ranking-data`）、`api/ipo.js`（`/names`）
  - 包んでいない … `api/premarket.js` の `fetchQuotes()`（立花 `/market-price`）と `fetchMarketSentiment()`（Yahoo）。`AbortSignal.timeout` は付いている
  - 新しい取得処理を追加する場合は `withFallback` を使うこと。上記2つが例外である理由はコード上に明示されていない
- 毎日3:00〜8:30はシステムメンテナンスでAPIが落ちるが、`withFallback` がRedisの前回成功データ（3日保持）を返すため問い合わせ自体をスキップしない

### リアルタイム株価・板情報（選択中の1銘柄のみ購読）

データの流れは3ステップ。**1行につき主語は1つ**。時間の値がどのコンポーネントのものかを取り違えないこと

1. **`App.js`（`TachibanaBoard`）が60秒おきに** `sync.js?resource=tachibana-watch` へPOSTし、「この銘柄を購読中」と伝え続ける
2. **`tachibana-server` が** その購読要求を見てWebSocketで立花から受信し、更新のたびに `sync.js?resource=tachibana-quote` へPOSTする。Vercel側は受け取った値を **Redisキー `tachibana:quote:<ticker>` にTTL30秒で保存する**
3. **`App.js`（`TachibanaBoard`）が7秒おきに** `sync.js?resource=tachibana-quote` をGETし、取得した値を表示する

- GET間隔（7秒）＜ 値のTTL（30秒）なので、サーバーが更新を投げ続けている正常時はGETすれば必ず値がある。**値が空で返ってきたら「30秒以上更新が届いていない」という異常のサイン**（GETのタイミングの問題ではない）

- `tachibana:quote:<ticker>`（TTL30秒）と同時に、`tachibana:quote:last:<ticker>`（TTL3日）へ同じ内容を書いている。後者は休場中のフォールバックで、立花が閉まってライブ値の30秒が切れている時間帯でも直近の板を表示するためのもの。3日なのは連休を挟んでも切れないようにするため
  - GET でライブ値が無いときはこちらを返し、レスポンスに `stale: true` を付ける。`src/App.js` はこの `stale` を見て、板パネルを非表示にする・ヘッダー色を変える・リアルタイム値を採用せず Yahoo に任せる、といった分岐をしている
  - 読み書きしているのは `api/sync.js` の `handleTachibanaQuote()` のみで、他ファイル・`tachibana-server` からの参照はない

- 購読の寿命は2段構成。**混同しないこと**
  - Redis TTL: 5分（`WATCH_TTL`（`api/sync.js`））… 購読リクエストのキー自体が消えるまでの時間
  - 実効タイムアウト: 2分（`watchStaleSeconds` / `tachibana-server` の `config.js`・`watcher.js`）… サーバーが「古い購読」とみなして切る時間
  - **購読が実際に切れるのは2分側。ポーリング間隔は必ず2分を基準に判断すること**（5分を基準にすると切断に気付けない）
- フィールド名は `p_1_DPP`（現在値）、`p_1_DYRP`（騰落率）、`p_1_GAV1〜10`（売気配数量）、`p_1_GBV1〜10`（買気配数量）など
- 受信イベントには「全項目入り」と「価格のみの軽量更新」があるため、**丸ごと置き換えず既存fieldsにマージする**こと（気配値が消えるバグの原因）

## 定時自動スキャン（`scanner.js` → `api/_scan.js`）

時計とループ制御は `tachibana-server/scanner.js` だけが担当し、銘柄リストの組み立て・スコア計算・保存はすべて `api/_scan.js`。scanner.js は Vercel の `/api/sync?resource=scan-run` を `nextOffset` が返らなくなるまで繰り返し呼ぶ。

- 実行時刻は 8:50 / 9:30 / 11:00 / 13:00 / 15:00（月〜金のみ。土日・祝日はバッチを投げない）、バッチサイズ5・直列。対象は日本株のみ（絞り込みは `_scan.js` 側）
  - `limit=5` は1回の `scan-run` で株価取得とスコア計算を行う銘柄数（`universe.slice(offset, offset + limit)`）
  - 根拠は Vercel Hobby の関数タイムアウト10秒。`tachibana-server/scanner.js` の冒頭コメントに実測値が残っており、`limit=5` で4.5秒、`limit=8` はタイムアウトして失敗した
  - 値は3箇所にある
    - `api/sync.js` `SCAN_DEFAULT_LIMIT`（5）… リクエストに `limit` が無いときの既定値
    - `api/_scan.js` `DEFAULT_LIMIT`（5）… `runScanBatch()` で `limit` が不正なときの既定値
    - `tachibana-server/scanner.js` `MAX_BATCH_SIZE`（5）… 実際に送る件数の上限
  - **Vercel 側に上限チェックはない。** `api/sync.js` は受け取った `body.limit` をそのまま `_scan.js` へ渡すため、5を超える値を外部から送れば通ってしまう。5に丸めているのは呼び出し側の `scanner.js` だけで、環境変数 `SCAN_BATCH_SIZE`（既定 "5"）で下方向には変更できる。固定値ではない
- **`scan-run` の並列実行は絶対禁止。** Redis の read-modify-write が複数箇所にあるため
  - `api/_scan.js` `mergeResults(key, rows)` … 本命。`scan:<date>:<slot>` を `get` → ticker 単位でマージ → `set` で書き戻す。同時実行すると後勝ちで片方のバッチ結果が丸ごと消える
  - `api/_scan.js` `runScanBatch()` の `offset === 0` のブロック … `UNIVERSE_BUILD_KEY` を `get` して比較してから `set` する check-then-act。同時実行すると両方が「組み立て回」と判定し `buildUniverse()` が二重に走る
  - **Vercel 側にロック機構は一切ない。** 壊れていないのは実装が安全だからではなく、呼び出し側の `tachibana-server/scanner.js` が `running` / `runningSlot` フラグで排他し、バッチを必ず前の応答を待ってから次を投げる直列呼び出しにしているため。この前提が崩れる変更（並列化、別クライアントからの `scan-run` 呼び出し）はデータ破壊に直結する
  - 同種の read-modify-write は `api/sync.js` にもある。`handlePremarketLog()` の POST（`premarket:log:<日付>` を `get` → `push` → `set`）と、デバイス間同期の POST（`lastSectors` 未送信時に `user:<userId>` を `get` してから `set`）
- 停滞検知あり: 同一 `offset` が3回連続で返った場合はループを中断する（`MAX_SAME_OFFSET = 3`）
- スキャン対象の銘柄リスト（ユニバース）は**サーバー側で組み立てる**。以前あった無認証のPOST口は廃止済み
- ユニバース本体 `scan:universe` のTTLは7日（`UNIVERSE_TTL`）。`scan:universe:meta` も同じ7日
- 組み立て済みマーク `scan:universe:built` のTTLは3日。本体（7日）より短いのは意図的
  - 値の定義: `UNIVERSE_BUILD_TTL`（`api/_scan.js`）
  - 理由の説明コメント: `api/_scan.js:33-34`（本体がマークより先に失効すると「組み立て済み扱いなのに中身が空」になる）。※行番号は目安。`UNIVERSE_TTL` の定義の直上にあるコメントなので、ズレていたら `UNIVERSE_TTL` を grep して追うこと
- マークの書き込みに失敗した場合は `buildUniverse` を呼ばずエラーを返し、呼び出し側のループを止める（空回り防止）
- `userId` はリクエストから受け取らず、環境変数 `SCAN_SYNC_USER_ID` で固定
- 業種絞り込みは同期データの `lastSectors` を参照し、無い場合は `/api/ranking` にフォールバックする

### 銘柄リストの組み立て

- **組み立ての唯一の入口は `POST /api/sync?resource=scan-run` → `runScanBatch()` → `buildUniverse()` の経路だけ。** ほかに `scan:universe` を書く経路は存在しない
- **フロントのスキャンボタンでは組み立ては走らない。** `src/App.js` の `buildStockUniverse()` はブラウザ内でランキングを組んで画面に出すだけで、`scan:universe` には保存しない（保存口を外部に晒さないため）
- 組み立てが走るのは、`offset` が0で、**かつ組み立て済みマークの値が「今日の日付とスロットの組み合わせ」と一致しないとき**だけ。「マークが存在しないとき」ではない。マークが残っていても日付やスロットが変われば走る（スロットごとに最新のランキングで組み直すため）
- **マークは組み立ての前に立てる。** 関数が時間切れで落ちても同一スロットで組み立てを繰り返さず、前回のリストでスキャンへ進めるようにするため
- 組み立てを行った回はスキャンせず、処理件数0・次のオフセット0で即座に返す。呼び出し側はもう一度同じ `offset` で呼び直すことになる（組み立てとスキャンを1回に詰めると Vercel の10秒制限を超えるため）
- `saveUniverse()` は `source` が `ranking` 以外のとき保存を拒否する。意図しない経路から銘柄リストが上書きされるのを防ぐため

## Redis キーと TTL 一覧

以下はすべて Redis（Upstash）に保存されるキー。前述の「Vercel側メモリキャッシュ」とは別物なので混同しないこと。

| キー | TTL | 定数名 | 書き込み元 |
| --- | --- | --- | --- |
| `snapshot:<key>`（実績: `snapshot:topix` / `snapshot:issue-detail:<コード>` / `snapshot:ranking-data` / `snapshot:names`） | 3日 | `SNAPSHOT_TTL` | `api/_fallbackCache.js` |
| `jpx:earnings-map` | 24時間 | `EARNINGS_REDIS_TTL` | `api/stock.js` |
| `tachibana:watch` | 5分 | `WATCH_TTL` | `api/sync.js` |
| `tachibana:quote:<ticker>` | 30秒 | 定数なし・直書き | `api/sync.js` |
| `tachibana:quote:last:<ticker>` | 3日 | `QUOTE_SNAPSHOT_TTL` | `api/sync.js` |
| `premarket:log:<YYYY-MM-DD>` | 30日 | `PREMARKET_LOG_TTL` | `api/sync.js` |
| `premarket:pred:<YYYY-MM-DD>` | 30日 | `PREMARKET_PRED_TTL` | `api/sync.js` |
| `user:<userId>` | 90日 | `TTL` | `api/sync.js` |
| `scan:universe` | 7日 | `UNIVERSE_TTL` | `api/_scan.js` |
| `scan:universe:meta` | 7日 | `UNIVERSE_TTL` を流用（キー名は直書き） | `api/_scan.js` |
| `scan:universe:built` | 3日 | `UNIVERSE_BUILD_TTL` | `api/_scan.js` |
| `scan:<YYYY-MM-DD>:<slot>` | 30日 | `RESULT_TTL` | `api/_scan.js` |

- `scan:universe` と `scan:universe:meta` は同じ `UNIVERSE_TTL`（7日）だが、`scan:universe:built` だけは別定数 `UNIVERSE_BUILD_TTL`（3日）である。混同しないこと
- `scan:universe:built` の**値**が「今日の日付とスロットの組み合わせ」と一致する間は、自動スキャン時のユニバース組み立てがスキップされる。キーが残っているだけではスキップされない（日付やスロットが変われば組み立てが走る）。手動テストで組み立てを走らせたい場合は Upstash Data Browser でこのキーを削除する
- 寄り予想の記録は2系統ある。サーバー側は `premarket:pred:<日付>`（全端末共通）、ブラウザ側は `localStorage` の `pm_<ticker>`（端末間同期の対象外）。移行期間中は併存しているため、的中率の集計がどちらを見ているかを確認してから触ること
- `tachibana:watch` の TTL は5分だが、購読が有効とみなされる実効時間は2分。判定しているのは `tachibana-server/config.js` の `watchStaleSeconds`（120秒）で、Vercel 側の `WATCH_TTL` とは別の値。CLAUDE.md 上の5分だけを見て「2分以上前の購読も有効」と判断しないこと

## Redis への保存形式（gzip）

- `api/sync.js` の `packForRedis()` は、渡されたオブジェクトを**閾値なしで常に** gzip 圧縮し、base64 化して先頭に `gz:` を付けて保存する。「サイズが一定を超えたら圧縮する」という実装ではない
- 展開は `unpackFromRedis()`。`gz:` で始まれば展開し、そうでなければ素の JSON として `JSON.parse` するため、圧縮導入前の古いデータも読める
- 実際に `gz:` 付きで保存されるのは `user:<userId>` と `premarket:log:<日付>` と `premarket:pred:<日付>` の3つだけ。`api/_scan.js` 側（`scan:universe` など）は `JSON.stringify` の素の文字列で保存しており圧縮していない
- 圧縮の設計理由である「Redis の1リクエストあたり1MB」という制限は、コード上に数値としては存在しない（`api/sync.js` 冒頭のブロックコメントに文章として記載があるのみ）。サイズチェックの実装もない
- 別物として、`tachibana-server/premarketLogger.js` の `POST_SIZE_LIMIT_KB=4500` は Vercel のリクエストボディ上限であり、Redis の制限ではない。混同しないこと

### 展開処理の二重実装

展開処理は2ファイルに同じ実装が存在する。**関数名が異なる**ので注意。

- `api/sync.js` … `unpackFromRedis(data)`
- `api/_scan.js` … `unpackSync(data)`
- 実装は実質同一（差分は `var`/`const` とクォート記号のみ）。これは意図的な重複で、`api/sync.js` が `scan-*` の処理時に `./_scan.js` を動的 import しているため、`_scan.js` から `sync.js` を import すると循環参照になることが理由。`api/_scan.js` の `unpackSync()` 直上にその旨のコメントがある
- **片方だけを修正すると自動スキャンが同期データを読めなくなる。** 展開処理を変更する場合は必ず両方を同時に直すこと
- `GZ_PREFIX = 'gz:'` も両ファイルに独立して定義されている

## api/sync.js の resource 一覧

| resource | メソッド | 内容 |
| --- | --- | --- |
| `tachibana-watch` | POST・GET | POST=購読中の銘柄を `tachibana:watch` に書く（無認証）。GET=購読中の銘柄を返す（`X-Relay-Secret` 必須） |
| `tachibana-quote` | POST・GET | POST=立花のリアルタイム値をライブ用（30秒）とスナップショット用（3日）へ同時に書く（認証必須）。GET=ライブ値、無ければスナップショットを `stale:true` 付きで返す |
| `premarket-log` | POST・GET | POST=`premarketLogger.js` から届く寄り前気配の生ログを追記（認証必須）。GET=その日の生ログ。`date=list` で保存済み日付一覧 |
| `premarket-summary` | GET のみ | 寄り前ログを日付×銘柄で1行に集計して返す読み取り専用。保存もTTL延長もしない |
| `premarket-prediction` | POST・GET | POST=その日の寄り前ログから気配ベースの寄り予想を生成して保存（認証必須）。`tachibana-server` の収集終了後に自動で1回叩かれる。生ログが1件も無い日は保存せず件数だけ返す。GET=保存済みの予想を返す読み取り専用（無認証・`date` 必須） |
| `scan-universe` | GET のみ | スキャン対象銘柄リストの現在値を返す。書き込み口は廃止済み（保存は `_scan.js` の `buildUniverse` がサーバー側で行う） |
| `scan-run` | POST のみ | 定時スキャン1バッチの実行窓口。`_scan.js` を動的 import して `runScanBatch()` を呼ぶ（認証必須） |
| `scan-result` | GET のみ | `date` 指定で全 slot の保存結果を `mget` してまとめて返す |
| （`resource` 無し・未知の値） | POST・GET | デバイス間同期にフォールバック。`userId` 必須。`user:<userId>` を読み書き（90日、GET時に延長） |

- `premarket-summary` は `date` 未指定だと Redis に触る前に `400 date required` を返す。これは意図的な仕様で、日付を省くと保存済み全日分（最大30日）を展開して応答が数十MBに達し、Vercel の上限と実行時間を圧迫するため。`date` が `YYYY-MM-DD` 形式でない場合も `400 invalid date`。`premarket-log` で使える `date=list` は `premarket-summary` では使えない
- `summarizePremarketDate()` は **`premarket-summary` 本体・`mode=calib`・`mode=coverage`・`premarket-prediction` の4箇所が共有している。** ここで行の作り方を変えると4つの出力が同時に変わる。片方だけを書き直すと数字が食い違う
- `resource` 無しのデバイス間同期は、`lastSectors` が送られてこなかった場合に**既存の値を維持する**（未送信を「空で上書き」と解釈しない）。古い版のアプリからの同期で業種選定が消えるのを防ぐため

### validCount の意味（2026-09-01 の実測で確定）

寄り前ログの集計行（`summarizePremarketDate()` が作る行）に載る `validCount` は、**その日の収集セッションで、その銘柄が何回目の tick（気配の取得1回）まで気配のまま＝まだ寄っていない状態だったかを表す通し番号**である。観測回数でも、有効データの件数でもない。

- 2026-09-01 の実測値: 総 tick 数 84回、収集時間 1260秒、平均間隔 15秒。60回目の tick は 08:59:54 JST に打たれている
- したがって `validCount=60` は「9:00 の寄り付きで正常に寄った」を意味する。61以上は寄りが遅れた銘柄、**総 tick 数と同じ値は 9:06（収集窓の終わり）まで寄らなかった銘柄**
- `validCount` が総 tick 数と一致する銘柄は、`premarket-summary` の `mode=coverage` が返す `noOpen` と件数・銘柄が完全に一致する（8/31 は16件、9/1 は4件で一致を確認済み）
- **総 tick 数は収集窓の長さと取得間隔で変わりうるため、84 を定数として扱わないこと。** 未寄りの判定は「その日の総 tick 数と等しいか」で行う
- 実測値は 21・50・60・61・62・64・66・69・72・75・77・79・80・82・84 など連続値を取る。12の倍数に限られない。**以前あった「12刻み＝3分刻み」という理解は誤り**
- **最小値は60ではない。** 8/31 に 50、9/1 に 21 が観測されている。`PM_Q_MIN_TICKS` を撤去した際（PR #63）の「実測の最小値は60」という前提は誤りだった。なお 21 も 50 も 5 より大きいため、PR #63 の判断そのものの結論は変わらない
- `src/App.js` の寄り前予想の理由表示（`reasons`）では `validCount` を「観測回数」というラベルで出しているが、実際の意味は上記のとおり寄り付きの遅さである。**ラベルが実装と食い違っている**

## 開発ルール・よくある落とし穴

- **既存のコードスタイルを踏襲する**: `var` / `function` 式 / インライン `style` オブジェクト。ES6+の書き換えやCSSファイル化はしない。コメントは日本語で書く
- 依頼されていない箇所は変更しない／新しいライブラリを勝手に追加しない／秘密鍵・APIキーは直書きせず環境変数
- 外部API呼び出しには必ずタイムアウトとエラーハンドリングを付ける。変更後は「何をどう変えたか」を日本語で要約する
- 日本株の前日比は `PrevC`（前日終値）を優先。無い場合のみ始値比で代用する
- 銘柄コードは4桁。`ticker` は `"7203.T"` 形式、立花APIへは `.T` を外して渡す。スキャン時は `CACHE` をクリアして必ず最新データを取る
- **`src/App.js` の `PUSH_SYNC` を触るとお気に入りが巻き戻る。** スキャン処理が `useCallback` のため、その中で掴む値は初回描画のまま古くなる。これを避けるため、描画のたびに最新の同期関数を `PUSH_SYNC` へ書き写している（`FAV_GROUP_CACHE` と同じ方式）
- **`src/App.js` の `applySyncedData()` は、同期パネルで ID を切り替えたときに `last_sectors` を上書きする。** 受け取った `lastSectors` が空でない場合に `localStorage` を書き換えるため、ID を切り替えた直後は業種選定が切替先のものに変わる
- **`api/sector.js` の `sectorCache` と分岐を触ると AI 呼び出しが増える。** `?sectors=` が付かない呼び出しは `getPromisingSectors()` → `askAIForSectors()` で `/api/ai` を叩く実装が現役で、回数を抑えているのは `sectorCache`（24時間・プロセス内メモリ）だけ。キャッシュの条件を緩める（保持時間の短縮・判定の削除）と課金が発生する。なおフロントは前回の業種を `?sectors=` で渡すため通常運用では AI 選定に入らないが、業種が空のときは入る。「今はAIを呼んでいない」を前提に条件を書き換えないこと
