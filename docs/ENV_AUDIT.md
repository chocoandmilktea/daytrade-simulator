# 環境変数 全件監査レポート

対象: `daytrade-simulator`（Vercel）/ `tachibana-server`（Railway）
調査日: 2026-08-19
調査コミット: `daytrade-simulator` = `cd2025c` / `tachibana-server` = `a192288`

**本レポートは調査のみ。コードの動作変更は一切行っていない。変数の「値」は一切記載しない（変数名・用途のみ）。**

---

## 0. 結論サマリ（先に3行）

1. **`JQUANTS` を含む環境変数は、両リポジトリのコードに1箇所も存在しない**（デッドコードですらなく参照ゼロ）。両環境から削除して問題ない。
2. **Redis の接続情報は `daytrade-simulator`（Vercel）側にしか存在しない。二重化していない。** `tachibana-server` は設計上 Redis に直接繋がない（`relay.js` 冒頭コメントに明記）。
3. スキャン時刻・バッチサイズ・POST宛先は**環境変数（既定値あり）**、`PREMARKET` の収集窓と tick 間隔は**ハードコード**。ただし**バッチサイズは環境変数で上げられない**（コード側の上限5で丸められる）。

---

## 1. 全参照一覧

### 1-1. daytrade-simulator（Vercel Functions）

| 変数名 | リポジトリ | ファイル:行 | デフォルト値 | 必須/任意 | 用途（1行） |
|---|---|---|---|---|---|
| `TACHIBANA_RELAY_SECRET` | daytrade-simulator | `api/sync.js:27`<br>`api/ranking.js:135`<br>`api/premarket.js:141`<br>`api/ipo.js:29`<br>`api/stock.js:336`<br>`api/stock.js:367` | なし | **条件付き必須**（下記注1） | tachibana-server との相互認証ヘッダ `X-Relay-Secret` の値 |
| `TACHIBANA_RANKING_API` | daytrade-simulator | `api/ranking.js:131`<br>`api/premarket.js:137` | なし | 任意（注2） | 立花中継 `/ranking-data` のURL。`premarket.js` では market-price URL の導出元も兼ねる |
| `TACHIBANA_MARKET_PRICE_API` | daytrade-simulator | `api/premarket.js:136` | なし（未設定時は `TACHIBANA_RANKING_API` の `/ranking-data` を `/market-price` に置換して代用） | 任意 | 寄り前気配の一括取得URL |
| `TACHIBANA_ISSUE_DETAIL_API` | daytrade-simulator | `api/stock.js:363` | なし | 任意（注2） | 個別銘柄の財務指標取得URL |
| `TACHIBANA_TOPIX_API` | daytrade-simulator | `api/stock.js:332` | なし | 任意（注2） | TOPIX日次騰落率の取得URL |
| `TACHIBANA_NAMES_API` | daytrade-simulator | `api/ipo.js:25` | なし | 任意（注2） | 銘柄コード→会社名マスタの取得URL |
| `ANTHROPIC_API_KEY` | daytrade-simulator | `api/ai.js:14`<br>`api/news.js:12` | なし | **必須**（機能単位） | Anthropic APIプロキシの認証。未設定なら即 500 を返し機能停止 |
| `SCAN_SYNC_USER_ID` | daytrade-simulator | `api/_scan.js:139` | `""`（空文字） | 任意 | スキャン銘柄リストの組み立て元となる同期データのユーザーID（外部から受け取らず固定値のみ参照） |
| `VERCEL_URL` | daytrade-simulator | `api/_scan.js:160` | `"daytrade-simulator.vercel.app"` | 任意 | 自分自身のAPIを叩く際のホスト名（Vercelが自動注入する変数） |
| `PUSHOVER_TOKEN` | daytrade-simulator | `api/notify.js:11` | なし | 任意（注3） | Pushover通知のアプリトークン |
| `PUSHOVER_USER` | daytrade-simulator | `api/notify.js:12` | なし | 任意（注3） | Pushover通知の宛先ユーザーキー |
| `UPSTASH_REDIS_REST_URL` | daytrade-simulator | 暗黙参照（`Redis.fromEnv()`）<br>`api/_fallbackCache.js:11`<br>`api/sync.js:22`<br>`api/_scan.js:30`<br>`api/stock.js:11` | なし | **必須**（注4） | Upstash Redis の接続先URL |
| `UPSTASH_REDIS_REST_TOKEN` | daytrade-simulator | 同上（4箇所） | なし | **必須**（注4） | Upstash Redis の認証トークン |
| `KV_REST_API_URL` | daytrade-simulator | 暗黙参照（同上） | なし | 任意（注4・バージョン依存） | 上記URLの代替名。SDKの解決バージョンによっては参照されない |
| `KV_REST_API_TOKEN` | daytrade-simulator | 暗黙参照（同上） | なし | 任意（注4・バージョン依存） | 上記トークンの代替名。同上 |

#### 参考: GitHub Actions 側（Vercel/Railway とは別管轄）

`process.env` ではなく Python の `os.environ` だが、同リポジトリ内で参照している環境変数のため併記する。**GitHub Actions Secrets 管轄であり、Vercel にも Railway にも設定不要。**

| 変数名 | リポジトリ | ファイル:行 | デフォルト値 | 必須/任意 | 用途（1行） |
|---|---|---|---|---|---|
| `SYNC_URL` | daytrade-simulator | `scripts/forecast.py:19`<br>`.github/workflows/forecast.yml:36` | なし | **必須** | 予測バッチが同期データを読むAPIのベースURL（未設定なら `KeyError` で落ちる） |
| `USER_ID` | daytrade-simulator | `scripts/forecast.py:20`<br>`.github/workflows/forecast.yml:37` | なし | **必須** | 同期データのユーザーID（未設定なら `KeyError` で落ちる） |
| `MODEL` | daytrade-simulator | `scripts/forecast.py:21` | `"amazon/chronos-bolt-small"` | 任意 | 予測モデル名。workflow では未指定のため既定値で動作 |

**注1（`TACHIBANA_RELAY_SECRET` の必須度は用途で割れる）**
同じ変数だが、`api/sync.js` 内でも判定式が2種類ある。

- `api/sync.js:72` / `:88`（`tachibana-watch` / `tachibana-quote`）… `if (RELAY_SECRET && ...)` → **未設定なら認証チェック自体をスキップして通してしまう**（＝任意だが、未設定は実質「無認証で公開」）
- `api/sync.js:143`（`premarket-log`）/ `:365`（`scan-run`）… `if (!RELAY_SECRET || ...)` → **未設定なら常に 401**。この2機能は必須
- 立花中継の各API（`ranking.js` 他）… 送信ヘッダに付けるだけなので、未設定でも送信自体は成立する

したがって **`scan-run`（定時自動スキャン）と `premarket-log`（寄り前ログ保存）を動かすには必須**。両側で同じ値が必要な、唯一の意図的な二重化変数。

**注2（立花系URL変数が「任意」である理由）**
未設定時は `throw` するが、その throw は `withFallback()`（`api/_fallbackCache.js:18-34`）の内側で発生する。`withFallback` は例外を捕捉し Redis のスナップショット（3日保持）を返すため、**スナップショットが残っている間はエラーにならず古いデータで動き続ける**。スナップショットも無ければ元の例外がそのまま投げられる（`_fallbackCache.js:33`）。
＝「起動失敗はしないが、放置すると気づかないまま古い値を返す」種類の変数。運用上は必須と見なすべき。
なお `api/premarket.js` の `fetchQuotes()` は `withFallback` で包まれていない（`premarket.js:134-147`）ため、こちらは呼び出し側の try/catch（`premarket.js:177`）で捕捉される。

**注3（Pushover 2変数は未設定チェックが無い）**
`api/notify.js:11-12` は値の有無を検査せず `URLSearchParams` に積むため、未設定なら文字列 `"undefined"` を Pushover に送信し、API側でエラーになる。**コード上のガードは無い。**

**注4（Redis 変数はソースコードに文字列として存在しない）**
4ファイルとも `Redis.fromEnv()` を呼ぶだけで、変数名は `@upstash/redis` SDK 内部で解決される。詳細と必須度のバージョン依存は「2-2. Redis 接続情報」に記載。

---

### 1-2. tachibana-server（Railway）

| 変数名 | リポジトリ | ファイル:行 | デフォルト値 | 必須/任意 | 用途（1行） |
|---|---|---|---|---|---|
| `TACHIBANA_ENV` | tachibana-server | `config.js:9` | `"demo"` | 任意 | `"production"` 以外なら全てデモ環境として扱う分岐 |
| `TACHIBANA_URL_AUTH_DEMO` | tachibana-server | `config.js:14` | なし | **必須**（デモ時のみ） | デモ環境のログインURL。`must()` により未設定なら起動時に throw |
| `TACHIBANA_URL_AUTH_PROD` | tachibana-server | `config.js:15` | なし | **必須**（本番時のみ） | 本番環境のログインURL。同上（注5） |
| `TACHIBANA_AUTH_ID` | tachibana-server | `config.js:16` | なし | **必須** | 立花e支店APIのログインID。未設定なら起動時 throw |
| `TACHIBANA_PRIVATE_KEY` | tachibana-server | `config.js:17` | なし | **必須** | 仮想URL復号用の秘密鍵（複数行PEM）。未設定なら起動時 throw |
| `TACHIBANA_WATCH_API` | tachibana-server | `config.js:19` | なし | **必須** | Vercel の `tachibana-watch` エンドポイントURL。未設定なら起動時 throw |
| `TACHIBANA_QUOTE_API` | tachibana-server | `config.js:20` | なし | **必須** | Vercel の `tachibana-quote` エンドポイントURL。未設定なら起動時 throw |
| `TACHIBANA_MKT_CODE` | tachibana-server | `config.js:18` | `"00"` | 任意 | 市場コード |
| `TACHIBANA_RELAY_SECRET` | tachibana-server | `config.js:21` | `""`（空文字） | 任意（実質必須・注1） | Vercel への送信ヘッダ `X-Relay-Secret`。空でも起動はする |
| `WATCH_STALE_SECONDS` | tachibana-server | `config.js:22` | `"120"` | 任意 | 監視銘柄の情報を古いと判断するまでの秒数 |
| `QUOTE_WRITE_MIN_INTERVAL_SECONDS` | tachibana-server | `config.js:23` | `"5"` | 任意 | 株価をVercelへ書き込む最小間隔（秒） |
| `WATCH_POLL_INTERVAL_SECONDS` | tachibana-server | `config.js:24` | `"3"` | 任意 | 監視銘柄を問い合わせる間隔（秒） |
| `TACHIBANA_SEND_GAP_MS` | tachibana-server | `auth.js:87` | `"15"` | 任意 | 立花へのPOST送信間隔（ミリ秒）。`p_errno=6`（追い越し）対策 |
| `TACHIBANA_RETRY_GAP_MS` | tachibana-server | `auth.js:89` | `"150"` | 任意 | リトライ時の送信間隔（ミリ秒） |
| `PORT` | tachibana-server | `webapi.js:258` | `8080` | 任意 | HTTPサーバーの待受ポート（Railwayが自動注入） |
| `SCAN_ENABLED` | tachibana-server | `scanner.js:37` | `"true"` | 任意 | `"false"`（大小無視）なら定時自動スキャンを起動しない |
| `SCAN_TIMES` | tachibana-server | `scanner.js:38` | `"8:50,9:30,11:00,13:00,15:00"` | 任意 | 定時自動スキャンの実行時刻（カンマ区切り・JST・月〜金） |
| `SCAN_BATCH_SIZE` | tachibana-server | `scanner.js:44` | `"5"` | 任意（上げても無効・注6） | 1バッチあたりの銘柄数 |
| `VERCEL_API_BASE` | tachibana-server | `scanner.js:39`<br>`premarketLogger.js:102` | `"https://daytrade-simulator.vercel.app"` | 任意 | POST宛先のVercelベースURL。**2ファイルが同じ変数を各自で読む** |
| `PREMARKET_CODES` | tachibana-server | `premarketLogger.js:46` | `["7203"]`（`premarketLogger.js:38`） | 任意 | 寄り前ログの対象銘柄コード（カンマ区切り・出現順が優先順） |
| `PREMARKET_MAX` | tachibana-server | `premarketLogger.js:80` | `8`（`premarketLogger.js:40`） | 任意 | 1ティックで取得する銘柄数の上限 |

**注5（`TACHIBANA_URL_AUTH_DEMO` / `_PROD` は片方しか評価されない）**
`config.js:13-15` は三項演算子で、`isDemo` が真なら `must("TACHIBANA_URL_AUTH_DEMO")` のみ、偽なら `must("TACHIBANA_URL_AUTH_PROD")` のみが呼ばれる。**使っていない方が未設定でも起動する。**

**注6（`SCAN_BATCH_SIZE` は上限5で丸められる）**
`scanner.js:42` に `MAX_BATCH_SIZE = 5` がハードコードされ、`scanner.js:46` で `n > MAX_BATCH_SIZE ? MAX_BATCH_SIZE : n` と丸められる。**環境変数で5より大きい値を入れても5になる。** 5より小さくすることだけが可能（0以下・数値でない場合も5）。理由は `scanner.js:9-13` のコメントに実測根拠あり（Vercel Hobby の10秒制限、limit=8 はタイムアウト実績）。

#### 動的参照ヘルパー（変数名を直接書いていない箇所）

以下3箇所は `process.env[name]` の形で、変数名を引数で受け取る汎用アクセサ。**それ自体は特定の変数を指さない**ため上表には含めていない。呼び出し元の変数はすべて上表に展開済み。

- `tachibana-server/config.js:4` … `must(name)`。未設定なら throw（＝必須系はすべてこれ経由）
- `tachibana-server/scanner.js:30` … `envStr(name, def)`。空文字も未設定扱い
- `tachibana-server/premarketLogger.js:33` … `envStr(name, def)`。同上

#### コメント・文字列内の変数名言及（実行時参照ではない）

- `tachibana-server/scanner.js:200` … 401時のエラーメッセージ内に `TACHIBANA_RELAY_SECRET` の文字列
- `tachibana-server/premarketLogger.js:14-15` … 冒頭コメントに `PREMARKET_CODES` / `PREMARKET_MAX` の説明
- `tachibana-server/config.js:21` … 行末コメント（Vercel側と同じ値を設定する旨）
- `tachibana-server/README.md:20,24,76,95-96,104-110,117` … セットアップ手順としての言及
- `daytrade-simulator/CLAUDE.md:36` … `JQUANTS_API_KEY` は不使用である旨の記述（**コード上の参照はゼロ**）
- `daytrade-simulator/api/_scan.js:135-136` … `SCAN_SYNC_USER_ID` を固定値のみ参照する設計意図の説明

---

## 2. 重点確認項目（5点）

### 2-1. `JQUANTS` を含む変数の生死 → **完全に死んでいる（参照ゼロ）**

**両リポジトリの全ファイルを `JQUANTS` / `jquants` / `JQuants` で横断検索した結果、ヒットは `daytrade-simulator/CLAUDE.md:36` の1件のみ。** これは「J-Quantsは廃止済み・新規に使うな」という指示文であり、実行されるコードではない。

- **`api/intraday.js`**: `process.env` の参照が**1箇所も無い**。J-Quants関連の記述も無い。レートリミット制御は Yahoo Finance の HTTP 429 を見ているだけで（`api/intraday.js:76`）、429 を受けたら空の足データに `rateLimited: true` を付けて 200 で返す（`:77`）。J-Quantsのレートリミットとは無関係。
- **フロント側のレートリミット制御**: `src/App.js:341` が `json.rateLimited` を読む1箇所のみ。上記 Yahoo 429 のフラグを受けているだけで、J-Quants由来の分岐は存在しない。
- `src/App.js` / `src/index.js` / `src/lib/` には `process.env` の参照自体が存在しない。

**判定: デッドコード以前に参照が存在しない。`JQUANTS_API_KEY` は Vercel・Railway の両方から削除して差し支えない。削除してもコードには一切影響しない。**

### 2-2. Redis 接続情報の変数名 → **二重化していない。Vercel側のみ。**

| リポジトリ | Redis接続変数 | 参照方法 |
|---|---|---|
| daytrade-simulator | `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`<br>（代替名 `KV_REST_API_URL` / `KV_REST_API_TOKEN`・バージョン依存） | `Redis.fromEnv()` による暗黙参照。`api/_fallbackCache.js:11` / `api/sync.js:22` / `api/_scan.js:30` / `api/stock.js:11` の4箇所 |
| tachibana-server | **無し（0件）** | Redis・Upstash 関連の参照がコード上に一切存在しない |

**同一インスタンスを指す設計かどうか → 「そもそも tachibana-server は Redis に繋がない」ため、二重化の問題は発生しない。**
これは偶然ではなく明示的な設計判断で、`tachibana-server/relay.js:1-2` の冒頭コメントに「Redisには直接繋がず、VercelのAPI(tachibana-watch / tachibana-quote)経由でやり取りする。これによりRailway側にRedisの認証情報を持たせる必要がなくなる」と記載されている。Railway 側は Vercel の HTTP エンドポイントを叩き、Redis への読み書きは Vercel が行う。

**Railway に Redis 系の変数が設定されていれば、それは未使用。削除可能。**

#### 補足: 変数名がソースに現れない理由と、必須度のバージョン依存（重要）

`Redis.fromEnv()` は変数名を SDK 内部に持つため、リポジトリを `grep` しても変数名は出てこない。実際の変数名を確定させるため、npm から `@upstash/redis` の実体を取得して `fromEnv()` の実装を確認した。**バージョンによって挙動が異なる。**

| 解決バージョン | 参照する変数名 | 未設定時の挙動 |
|---|---|---|
| `1.22.0`（`package.json` の下限） | `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` のみ。代替名の対応**無し** | **`throw`（即エラー）** → 必須 |
| `1.38.2`（現在の最新） | 上記に加え `KV_REST_API_URL` / `KV_REST_API_TOKEN` へフォールバック | `console.warn` のみで**throw しない**（後続のRedis操作で失敗する） |

`daytrade-simulator/package.json:9` の指定は `"^1.22.0"` で、**リポジトリに `package-lock.json` / `yarn.lock` が存在しない**。したがって Vercel のビルド時に 1.x 系の任意の新しいバージョンが解決される可能性があり、**本番で実際に動いているバージョンは本調査では確定できなかった（不明）**。理由: ロックファイルが無く、デプロイ済み環境の `node_modules` を参照できないため。

実運用上は「`UPSTASH_REDIS_REST_URL` と `UPSTASH_REDIS_REST_TOKEN` の2本が必須」と扱えば、どちらのバージョンでも正しく動作する。

### 2-3. `scanner.js` が参照する変数の全件

**直接参照（4件）** — `SCAN_` プレフィックスは3件、それ以外が1件（`VERCEL_API_BASE`）。

| 変数名 | 行 | デフォルト値 |
|---|---|---|
| `SCAN_ENABLED` | `scanner.js:37` | `"true"` |
| `SCAN_TIMES` | `scanner.js:38` | `"8:50,9:30,11:00,13:00,15:00"` |
| `VERCEL_API_BASE` | `scanner.js:39` | `"https://daytrade-simulator.vercel.app"` |
| `SCAN_BATCH_SIZE` | `scanner.js:44` | `"5"`（上限5で丸め・注6） |

**間接参照（依存経由）** — ここが見落としやすい。

- `scanner.js:20` が `require("./config")` している。`scanner.js:118` で `config.relaySecret`（＝ `TACHIBANA_RELAY_SECRET`）をヘッダに使う。
- **さらに重要**: `config.js` は `require` された時点で `must()` を評価するため、**`scanner.js` を読み込むだけで `config.js` の必須変数（`TACHIBANA_AUTH_ID` / `TACHIBANA_PRIVATE_KEY` / `TACHIBANA_WATCH_API` / `TACHIBANA_QUOTE_API` / `TACHIBANA_URL_AUTH_DEMO` または `_PROD`）が全て要求される。** どれか1つでも欠けるとプロセス全体が起動しない（`index.js` が全モジュールを起動時に読み込むため）。
- `holidays.js`（`scanner.js:21`）は環境変数を参照しない。

**したがって scanner.js の動作に必要な変数は、直接4件 ＋ `TACHIBANA_RELAY_SECRET` ＋ config.js の必須群、の合計10件前後。**

### 2-4. ハードコードか環境変数か

| 項目 | 判定 | 場所 | 補足 |
|---|---|---|---|
| スキャン時刻（8:50/9:30/11:00/13:00/15:00） | **環境変数**（既定値あり） | `scanner.js:38` = `SCAN_TIMES` | ただし**slot名は別でハードコード**（`scanner.js:60` の `SLOTS` 配列）。`SCAN_TIMES` を変えても記録先slotは5種に丸められる（`slotForTime()` = `scanner.js:66-75`）。Vercel側が受け付けないslotを渡すと400になるための安全策 |
| バッチサイズ（5） | **環境変数だが実質ハードコード** | `scanner.js:44` = `SCAN_BATCH_SIZE`<br>上限は `scanner.js:42` の `MAX_BATCH_SIZE = 5` | **5より大きい値を設定しても5に丸められる**（`scanner.js:46`）。下げることのみ可能 |
| POST宛先URL（`https://daytrade-simulator.vercel.app`） | **環境変数**（既定値としてURLがハードコード） | `scanner.js:39` / `premarketLogger.js:102` = `VERCEL_API_BASE` | 2ファイルが**それぞれ独立に**同じ変数を読む。末尾スラッシュは除去される。変更時は両方に効く（1変数なので設定は1回でよい） |
| `PREMARKET` の収集窓（8:45〜9:06） | **ハードコード** | `premarketLogger.js:104`（`START_MINUTE`）<br>`premarketLogger.js:105`（`END_MINUTE`） | 環境変数化されていない。変更にはコード修正が必要。JST固定（`nowJst()` = `:114-116`）でサーバーTZに非依存 |
| tick 間隔（15秒） | **ハードコード** | `premarketLogger.js:106`（`FETCH_INTERVAL_MS = 15 * 1000`） | 環境変数化されていない。なお `premarketLogger.js:107` の `TICK_INTERVAL_MS = 60 * 1000` は「窓の外で1分ごとに時刻だけ見る」別物なので混同注意 |

### 2-5. `PREMARKET_CODES` / `PREMARKET_MAX` の参照箇所と切り取りロジック

**参照箇所**

| 変数名 | 読み出し | 既定値の定義 | 適用箇所 |
|---|---|---|---|
| `PREMARKET_CODES` | `premarketLogger.js:46`（`parsePremarketCodes()` 内） | `premarketLogger.js:38`（`DEFAULT_CODES`） | `premarketLogger.js:92` |
| `PREMARKET_MAX` | `premarketLogger.js:80`（`parsePremarketMax()` 内） | `premarketLogger.js:40`（`DEFAULT_MAX_CODES` = 8） | `premarketLogger.js:93` |

いずれも**この1ファイル以外からは参照されていない**（`scanner.js` や Vercel 側には登場しない）。

**切り取りロジック → 「先頭から N 件」で正しい。**

`premarketLogger.js:94` が `RECEIVED_CODES.slice(0, MAX_CODES)` の1行。ソート・シャッフル・優先度の再計算は一切行われず、**環境変数に書いた並び順がそのまま優先順位になる**（`premarketLogger.js:63` に「出現順を保持する（ソートは絶対にしない）」と明記）。

補足として、切り取り前に以下の正規化が入る（`parsePremarketCodes()` = `:45-75`）。件数に影響するため `PREMARKET_MAX` を上げる際の判断材料になる。

1. クォート（`"` `'`）を全除去 → カンマ区切りで分割（`:54-55`）
2. 空要素（連続カンマ・末尾カンマ）は破棄（`:58`）
3. 小文字→大文字に正規化（`278a` → `278A`）（`:59`）
4. `/^[0-9A-Z]{4}$/` に合致しないものは除外し、警告ログを出す（`:60`, `:66-68`）
5. **重複は先に出てきた方だけ残す**（`:61-62`）
6. 全て弾かれて0件になった場合は既定値 `["7203"]` に戻す（`:70-73`）

**＝「切り取り後に N 件」ではなく「正規化・重複排除の結果から先頭 N 件」。** 上限超過分は警告ログに切り捨てた銘柄コードが出る（`:96-98`）。起動時ログ（`:99-100`）に「対象X件 / 受領Y件 / 上限Z件」が出るため、実際に何件が採用されたかは Railway のログで確認できる。

#### 本日予定の `PREMARKET_MAX` 12 → 40 に関する留意点

調査中に判明した、変更の判定に影響しうる事実のみ記載する（変更作業は行っていない）。

- **値は起動時に一度だけ確定する**（`premarketLogger.js:92-93` がモジュールのトップレベル）。Railway の再デプロイ／再起動なしには反映されない。
- **`PREMARKET_MAX` を40にしても、`PREMARKET_CODES` の有効件数が40未満なら件数は増えない**（`slice` は元配列長を超えない）。上記の重複排除・書式除外を通過した後の件数が効く。
- 1ティックの所要時間が15秒を超えると警告が出る（`premarketLogger.js:241-243`）。銘柄数を増やした翌日は、Railwayログの `tick N銘柄 / Xms` 行（`:240`）で15000msに対する余裕を確認できる。
- POSTサイズは1MB超で警告（`premarketLogger.js:166-168`）、Vercelの上限は4.5MB。送信直前に「銘柄数 / KB / レコード数」がログに出る（`:164-165`）。

---

## 3. 管轄の割り当て（どちらに設定すべきか）

| 管轄 | 変数 |
|---|---|
| **Vercel のみ** | `TACHIBANA_RANKING_API`, `TACHIBANA_MARKET_PRICE_API`, `TACHIBANA_ISSUE_DETAIL_API`, `TACHIBANA_TOPIX_API`, `TACHIBANA_NAMES_API`, `ANTHROPIC_API_KEY`, `SCAN_SYNC_USER_ID`, `PUSHOVER_TOKEN`, `PUSHOVER_USER`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, （`VERCEL_URL` は自動注入） |
| **Railway のみ** | `TACHIBANA_ENV`, `TACHIBANA_URL_AUTH_DEMO` / `_PROD`, `TACHIBANA_AUTH_ID`, `TACHIBANA_PRIVATE_KEY`, `TACHIBANA_MKT_CODE`, `TACHIBANA_WATCH_API`, `TACHIBANA_QUOTE_API`, `WATCH_STALE_SECONDS`, `QUOTE_WRITE_MIN_INTERVAL_SECONDS`, `WATCH_POLL_INTERVAL_SECONDS`, `TACHIBANA_SEND_GAP_MS`, `TACHIBANA_RETRY_GAP_MS`, `SCAN_ENABLED`, `SCAN_TIMES`, `SCAN_BATCH_SIZE`, `VERCEL_API_BASE`, `PREMARKET_CODES`, `PREMARKET_MAX`, （`PORT` は自動注入） |
| **両方に同じ値が必要（意図的な二重化）** | `TACHIBANA_RELAY_SECRET` … これ1本のみ |
| **どちらにも不要（削除可）** | `JQUANTS_API_KEY`（参照ゼロ）、Railway側に Redis 系変数があればそれも不要 |
| **GitHub Actions Secrets** | `SYNC_URL`, `USER_ID`（`MODEL` は任意） |

### 再デプロイ時の危険度

| 危険度 | 変数 | 理由 |
|---|---|---|
| **高**（誤ると即停止） | `TACHIBANA_AUTH_ID`, `TACHIBANA_PRIVATE_KEY`, `TACHIBANA_WATCH_API`, `TACHIBANA_QUOTE_API`, `TACHIBANA_URL_AUTH_DEMO`/`_PROD` | `must()` により未設定・誤設定でプロセスが起動しない（`config.js:5`） |
| **高**（静かに壊れる） | `TACHIBANA_RELAY_SECRET` | 両側の値がズレると `scan-run` / `premarket-log` が401で全滅する。しかも `tachibana-watch` / `tachibana-quote` は未設定時に無認証で通るため、症状が機能ごとにバラつく |
| **高**（静かに壊れる） | `UPSTASH_REDIS_REST_URL` / `_TOKEN` | SDKのバージョン次第で throw せず warn のみ。気づきにくい |
| **中** | `TACHIBANA_*_API`（Vercel側URL群） | `withFallback` により3日間は古いデータで動き続けるため、誤りに気づくのが遅れる（注2） |
| **中** | `TACHIBANA_ENV` | `"production"` 以外は全てデモ扱い。タイプミスが黙ってデモ環境接続になる（`config.js:9`） |
| **低** | `SCAN_*`, `PREMARKET_*`, `WATCH_*`, `QUOTE_*`, `TACHIBANA_*_MS`, `VERCEL_API_BASE`, `TACHIBANA_MKT_CODE` | 全て既定値があり、不正値でも既定値に戻るか警告ログが出る |

---

## 4. 調査範囲と限界

- 検索方法: 両リポジトリの全ファイルに対する `process.env` の横断検索（テストコード・コメント・ドキュメントを含む）。加えて `JQUANTS` / `UPSTASH` / `REDIS` / `os.environ` の個別検索。
- `daytrade-simulator/src/App.js` は `process.env` / `JQUANTS` / `rateLimited` / `REACT_APP` での検索のみ実施（CLAUDE.md の全体読み込み禁止ルールに従った）。**検索でヒットしなかった行に環境変数参照が無いことは、この検索方法で担保されている**（`process.env` を含まない限り Node/CRA で環境変数は読めないため）。
- `tachibana-server` は読み取りのみ（コミット `a192288`・作業ツリーに変更なしを確認済み）。同リポジトリへのファイル作成・コミット・PR作成は一切行っていない。
- `@upstash/redis` の実際の解決バージョンは**不明**。理由: ロックファイルが存在せず、デプロイ済み環境の `node_modules` を参照できないため（詳細は 2-2）。
- 各環境（Vercel / Railway）に**実際に設定されている変数の一覧は確認していない**。本レポートは「コードが参照している変数」の一覧であり、「設定済みだがコードから参照されていない変数」は、実環境の設定画面と本表を突き合わせることで特定できる。
