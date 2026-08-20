# 環境変数 全件調査レポート

対象: `daytrade-simulator`（Vercel）/ `tachibana-server`（Railway）
調査日: 2026-08-20
調査時点のコミット: daytrade-simulator `6d7a706` / tachibana-server `a192288`

本書は調査結果のみを記載する。コードの動作変更は行っていない。
**変数の値は一切記載しない（変数名と用途のみ）。**

## 調査方法と範囲

- 両リポジトリの Git 追跡ファイル全件に対し `process.env` / `os.environ` / `secrets.` を全文検索
- `node_modules` は未インストールのため対象外。ただし `Redis.fromEnv()` が読む変数名だけは
  `@upstash/redis@1.22.0`（`package.json` の指定は `^1.22.0`）のパッケージ本体
  `script/platforms/nodejs.js:97,102` を実際に取得して確認した
- `process.env[name]` の形で動的に読む箇所（`config.js:4` / `scanner.js:30` /
  `premarketLogger.js:33`）は、呼び出し側を辿って実際の変数名まで展開した
- コメント・ドキュメント内だけに出てくる変数名も「参照箇所」として記録した

---

## 1. 全参照一覧

### 1-1. daytrade-simulator（Vercel Functions / GitHub Actions）

| 変数名 | リポジトリ | ファイル:行 | デフォルト値 | 必須/任意 | 用途 |
|---|---|---|---|---|---|
| `UPSTASH_REDIS_REST_URL` | daytrade-simulator | `api/_fallbackCache.js:11`, `api/_scan.js:30`, `api/stock.js:11`, `api/sync.js:22`（いずれも `Redis.fromEnv()` 経由） | なし | **必須** | Upstash Redis の REST 接続先。未設定だと `fromEnv()` が即 throw し、当該4ファイルを読み込む全APIがモジュール読み込み時点で落ちる |
| `UPSTASH_REDIS_REST_TOKEN` | daytrade-simulator | 同上 | なし | **必須** | Upstash Redis の REST トークン。未設定時の挙動は上と同じ |
| `TACHIBANA_RELAY_SECRET` | daytrade-simulator | `api/stock.js:336,367`, `api/ranking.js:135`, `api/ipo.js:29`, `api/premarket.js:141`, `api/sync.js:27,72,88,143,365` | なし | 任意（ただし後述の一部経路は実質必須） | tachibana-server との共有合言葉。送信側では `X-Relay-Secret` ヘッダに付与、`sync.js` では受信側の照合に使う |
| `TACHIBANA_RANKING_API` | daytrade-simulator | `api/ranking.js:131`, `api/premarket.js:137` | なし | 任意 | tachibana-server の `/ranking-data` のURL。未設定なら throw するが `withFallback` がRedisの前回成功データを返す |
| `TACHIBANA_ISSUE_DETAIL_API` | daytrade-simulator | `api/stock.js:363` | なし | 任意 | tachibana-server の `/issue-detail` のURL。未設定時は `withFallback` が肩代わり |
| `TACHIBANA_TOPIX_API` | daytrade-simulator | `api/stock.js:332` | なし | 任意 | tachibana-server の `/topix` のURL。未設定時は `withFallback` が肩代わり |
| `TACHIBANA_NAMES_API` | daytrade-simulator | `api/ipo.js:25` | なし | 任意 | tachibana-server の `/names` のURL。未設定時は `withFallback` が肩代わり |
| `TACHIBANA_MARKET_PRICE_API` | daytrade-simulator | `api/premarket.js:136` | `TACHIBANA_RANKING_API` の `/ranking-data` を `/market-price` に置換したもの（`api/premarket.js:137`） | 任意 | 寄り前気配の中継先。専用URLが無ければランキングURLから導出する |
| `ANTHROPIC_API_KEY` | daytrade-simulator | `api/ai.js:14`, `api/news.js:12` | なし | **必須**（当該2エンドポイントのみ） | Anthropic APIプロキシの認証。未設定なら 500 を返して即終了（`api/ai.js:15` / `api/news.js:13`） |
| `PUSHOVER_TOKEN` | daytrade-simulator | `api/notify.js:11` | なし | **必須**（当該エンドポイントのみ） | Pushover のアプリトークン。未設定でも throw はしないが Pushover 側で通知が失敗する |
| `PUSHOVER_USER` | daytrade-simulator | `api/notify.js:12` | なし | **必須**（当該エンドポイントのみ） | Pushover の宛先ユーザーキー。挙動は上と同じ |
| `SCAN_SYNC_USER_ID` | daytrade-simulator | 宣言 `api/_scan.js:139` / 使用 `api/_scan.js:218,222` | `""`（空文字） | 任意 | 自動スキャンの銘柄リスト組み立て時に、お気に入り・トレード中銘柄を読むための固定ユーザーID。未設定でも警告ログのみで処理は継続（`api/_scan.js:219`） |
| `VERCEL_URL` | daytrade-simulator | `api/_scan.js:160` | `"daytrade-simulator.vercel.app"` | 任意 | 自分自身のAPI（`/api/sector` `/api/ranking`）を叩くためのホスト名。Vercel が自動注入する |
| `SYNC_URL` | daytrade-simulator | `.github/workflows/forecast.yml:36`（`secrets.SYNC_URL`）, `scripts/forecast.py:19` | なし | **必須** | 予測バッチが同期データを読み書きするアプリURL。`os.environ[...]` のため未設定なら `KeyError` で即失敗 |
| `USER_ID` | daytrade-simulator | `.github/workflows/forecast.yml:37`（`secrets.USER_ID`）, `scripts/forecast.py:20` | なし | **必須** | 予測対象のお気に入りを引くデバイス同期ID。未設定なら `KeyError` で即失敗 |
| `MODEL` | daytrade-simulator | `scripts/forecast.py:21` | `"amazon/chronos-bolt-small"` | 任意 | 予測モデル名。`forecast.yml` では渡していないため常に既定値 |
| `JQUANTS_API_KEY` | daytrade-simulator | `CLAUDE.md:36`（文書中の記述のみ。実行コードに参照なし） | — | **不使用** | 詳細は「2-1」を参照 |

補足（`TACHIBANA_RELAY_SECRET` の必須度が経路で変わる点）:

- `api/sync.js:72,88` … `RELAY_SECRET` が空なら照合をスキップする（＝任意）
- `api/sync.js:143,365` … `!RELAY_SECRET` の時点で拒否する（＝そのリソースは実質必須）

### 1-2. tachibana-server（Railway）

`config.js:1` で `dotenv` を読み込んでいる（`daytrade-simulator` 側に `dotenv` は無い）。
`config.js:3-7` の `must()` は未設定なら `throw` する。`index.js` が
`watcher` / `webapi` / `scanner` / `premarketLogger` を読み込み、そのすべてが
`config.js` を読み込むため、`must()` 対象が1つでも欠けるとプロセス全体が起動できない。

| 変数名 | リポジトリ | ファイル:行 | デフォルト値 | 必須/任意 | 用途 |
|---|---|---|---|---|---|
| `TACHIBANA_ENV` | tachibana-server | `config.js:9` | `"demo"` | 任意 | `production` 以外はすべてデモ環境として扱う。認証URLの選択に効く |
| `TACHIBANA_URL_AUTH_DEMO` | tachibana-server | `config.js:14`（`must`） | なし | **必須**（デモ時） | デモ環境のログインURL。デモ時に未設定なら起動失敗 |
| `TACHIBANA_URL_AUTH_PROD` | tachibana-server | `config.js:15`（`must`） | なし | **必須**（本番時） | 本番環境のログインURL。本番時に未設定なら起動失敗 |
| `TACHIBANA_AUTH_ID` | tachibana-server | `config.js:16`（`must`） | なし | **必須** | 立花証券e支店APIのログインID |
| `TACHIBANA_PRIVATE_KEY` | tachibana-server | `config.js:17`（`must`） | なし | **必須** | 仮想URLの復号に使う秘密鍵（PEM・複数行） |
| `TACHIBANA_MKT_CODE` | tachibana-server | `config.js:18` | `"00"` | 任意 | 市場コード |
| `TACHIBANA_WATCH_API` | tachibana-server | `config.js:19`（`must`） | なし | **必須** | Vercel側 `sync.js?resource=tachibana-watch` のURL。未設定なら起動失敗 |
| `TACHIBANA_QUOTE_API` | tachibana-server | `config.js:20`（`must`） | なし | **必須** | Vercel側 `sync.js?resource=tachibana-quote` のURL。未設定なら起動失敗 |
| `TACHIBANA_RELAY_SECRET` | tachibana-server | `config.js:21`、`README.md:24,117` | `""`（空文字） | 任意 | Vercelへ送るリクエストの `X-Relay-Secret` ヘッダ。空なら付与しない（`scanner.js:118` / `premarketLogger.js:155` / `relay.js`） |
| `WATCH_STALE_SECONDS` | tachibana-server | `config.js:22` | `"120"` | 任意 | 購読中銘柄の情報が古いと判断するまでの秒数 |
| `QUOTE_WRITE_MIN_INTERVAL_SECONDS` | tachibana-server | `config.js:23` | `"5"` | 任意 | リアルタイム値をVercelへ書き戻す最小間隔（間引き） |
| `WATCH_POLL_INTERVAL_SECONDS` | tachibana-server | `config.js:24` | `"3"` | 任意 | 「今フロントで選択中の銘柄」を確認する間隔 |
| `TACHIBANA_SEND_GAP_MS` | tachibana-server | `auth.js:87`、`README.md:107` | `"15"` | 任意 | 立花APIへの送信と次の `p_no` 採番の間隔（ms）。`p_errno=6` 対策 |
| `TACHIBANA_RETRY_GAP_MS` | tachibana-server | `auth.js:89`、`README.md:110` | `"150"` | 任意 | `p_errno=6` でリトライする際の間隔（ms） |
| `PORT` | tachibana-server | `webapi.js:258` | `8080` | 任意 | HTTPサーバーの待ち受けポート。Railway が自動注入する |
| `SCAN_ENABLED` | tachibana-server | `scanner.js:37` | `"true"` | 任意 | `false`（大文字小文字問わず）で定時自動スキャンを起動しない |
| `SCAN_TIMES` | tachibana-server | `scanner.js:38` | `"8:50,9:30,11:00,13:00,15:00"` | 任意 | 自動スキャンの実行時刻（カンマ区切り、JST・月〜金） |
| `VERCEL_API_BASE` | tachibana-server | `scanner.js:39`, `premarketLogger.js:102` | `"https://daytrade-simulator.vercel.app"` | 任意 | POST先のVercelアプリのベースURL。末尾スラッシュは除去される |
| `SCAN_BATCH_SIZE` | tachibana-server | `scanner.js:44` | `"5"` | 任意 | 1バッチの銘柄数。`MAX_BATCH_SIZE = 5`（`scanner.js:42`）で上限に丸められる |
| `PREMARKET_CODES` | tachibana-server | `premarketLogger.js:46` | `["7203"]`（`DEFAULT_CODES`、`premarketLogger.js:38`） | 任意 | 寄り前ロガーの対象銘柄コード（カンマ区切り） |
| `PREMARKET_MAX` | tachibana-server | `premarketLogger.js:80` | `8`（`DEFAULT_MAX_CODES`、`premarketLogger.js:40`） | 任意 | 1ティックあたりの銘柄数の上限 |

---

## 2. 重点確認項目（5点）

### 2-1. `JQUANTS` を含む変数の生死 → **デッドコードですらない（参照ゼロ）**

- 両リポジトリの Git 追跡ファイル全件を `jquants`（大文字小文字無視）で検索した結果、
  ヒットは **`daytrade-simulator/CLAUDE.md:36` の1件のみ**。しかもそこは
  「J-Quantsは廃止済み。新たに使うコードを書かないこと」という**注意書きの文章**であり、
  `process.env.JQUANTS_API_KEY` の形での参照は**両リポジトリのどこにも存在しない**。
- 重点指定された `api/intraday.js`（全105行）に `process.env` は**1箇所も無い**。
  同ファイルのレートリミット関連は `api/intraday.js:76-77` の
  「Yahoo が 429 を返したら空データ＋`rateLimited: true` を返す」処理のみで、
  環境変数もJ-Quants由来の分岐も持たない。
- フロント側のレートリミット制御も `src/App.js:341-344` の
  「`rateLimited` を受けたら `INTRADAY_PAUSED_UNTIL` を 120 秒先に設定してキュー全体を止める」
  だけで、**120秒はハードコード**。環境変数もJ-Quants関連コードも無い。
- **結論**: `JQUANTS_API_KEY` は「到達不能なデッドコードが残っている」のではなく、
  **コードから完全に消えている**。Vercel/Railway 側に値が残っていても、
  どちらのアプリも読まないため削除して差し支えない。

### 2-2. Redis 接続情報の変数名 → **daytrade-simulator 側のみが持つ。tachibana-server は持たない設計**

| リポジトリ | 変数名 | 参照箇所 |
|---|---|---|
| daytrade-simulator | `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | `Redis.fromEnv()` を呼ぶ4ファイル（`api/_fallbackCache.js:11`, `api/_scan.js:30`, `api/stock.js:11`, `api/sync.js:22`） |
| tachibana-server | **なし** | Redis に関する `process.env` 参照は0件 |

- 変数名がコードに直接書かれていないのは `Redis.fromEnv()` を使っているため。
  `@upstash/redis@1.22.0` の `script/platforms/nodejs.js:97,102` で
  `process.env["UPSTASH_REDIS_REST_URL"]` / `process.env["UPSTASH_REDIS_REST_TOKEN"]` を読み、
  どちらか欠けると `throw` することを確認済み。
- `package.json` の指定は `^1.22.0` のため、Vercel 上で実際に解決される 1.x のマイナー版は
  1.22.0 と異なる可能性がある（本番の `node_modules` を確認していないため、そこは**不明**）。
- **同一インスタンスを指す設計か**: いいえ。「名前が違う」のではなく
  **tachibana-server は Redis の認証情報を一切持たない**。
  `README.md:5-6,116` に明記されているとおり、tachibana-server は Redis に直接繋がず、
  Vercel の API（`TACHIBANA_WATCH_API` / `TACHIBANA_QUOTE_API` / `VERCEL_API_BASE`）
  経由でのみ読み書きする。したがって Redis 接続情報の**二重化は発生していない**。
- 二重化しているのは `TACHIBANA_RELAY_SECRET` の1つのみ
  （daytrade-simulator `api/sync.js:27` ほか ⇔ tachibana-server `config.js:21`）。
  両側で同じ値を設定する前提のため、片側だけ変更すると
  `scanner.js:199-201` の 401 中断や `sync.js:143,365` の拒否につながる。

### 2-3. `scanner.js` が参照する変数の全件

直接参照（`scanner.js` 内の `envStr()` / `process.env`）:

| 変数名 | 行 | デフォルト値 |
|---|---|---|
| `SCAN_ENABLED` | `scanner.js:37` | `"true"` |
| `SCAN_TIMES` | `scanner.js:38` | `"8:50,9:30,11:00,13:00,15:00"` |
| `VERCEL_API_BASE` | `scanner.js:39` | `"https://daytrade-simulator.vercel.app"` |
| `SCAN_BATCH_SIZE` | `scanner.js:44` | `"5"`（`MAX_BATCH_SIZE=5` で上限丸め） |

間接参照（`scanner.js:20` の `require("./config")` 経由）:

| 変数名 | 実際に使う箇所 | 備考 |
|---|---|---|
| `TACHIBANA_RELAY_SECRET` | `scanner.js:118`（`config.relaySecret` を `X-Relay-Secret` に付与） | scanner が値として使う唯一の config 項目 |
| `TACHIBANA_ENV` / `TACHIBANA_URL_AUTH_DEMO` / `TACHIBANA_URL_AUTH_PROD` / `TACHIBANA_AUTH_ID` / `TACHIBANA_PRIVATE_KEY` / `TACHIBANA_MKT_CODE` / `TACHIBANA_WATCH_API` / `TACHIBANA_QUOTE_API` / `WATCH_STALE_SECONDS` / `QUOTE_WRITE_MIN_INTERVAL_SECONDS` / `WATCH_POLL_INTERVAL_SECONDS` | `config.js:9-24` | scanner 自身は値を読まないが、`require` 時に `config.js` 全体が評価されるため `must()` 対象が欠けると scanner ごと起動できない |

`SCAN_` プレフィックスでない直接参照は **`VERCEL_API_BASE` の1件**（`scanner.js:39`）。

### 2-4. ハードコードか環境変数か

| 項目 | 判定 | 根拠 |
|---|---|---|
| スキャン時刻（8:50/9:30/11:00/13:00/15:00） | **環境変数（既定値がこの5つ）＋ 別途ハードコードの制約あり** | `SCAN_TIMES`（`scanner.js:38`）で変更できる。ただし送信する slot は `scanner.js:60` の `SLOTS = ["0850","0930","1100","1300","1500"]` に `slotForTime()`（`scanner.js:66-75`）で丸められる。この配列は**ハードコード**で、Vercel側 `api/_scan.js:43-50` の `SLOT_SESSIONS`（`"0830"` を加えた6件）とも**ハードコードで対応**している。つまり時刻は自由に変えられるが、集計先のslotは5枠から増やせない |
| バッチサイズ（5） | **環境変数だが上限がハードコード** | `SCAN_BATCH_SIZE`（`scanner.js:44`、既定 `"5"`）。ただし `MAX_BATCH_SIZE = 5`（`scanner.js:42`）で丸められるため（`scanner.js:45-46`）、**5より大きくはできず、小さくすることしかできない**。Vercel受信側の既定値 `SCAN_DEFAULT_LIMIT = 5`（`api/sync.js:32`）と `DEFAULT_LIMIT = 5`（`api/_scan.js:53`）も**ハードコード** |
| POST 宛先URL（`https://daytrade-simulator.vercel.app`） | **環境変数（既定値がこのURL）** | `VERCEL_API_BASE`（`scanner.js:39`, `premarketLogger.js:102`）。パス部分 `/api/sync?resource=scan-run`（`scanner.js:123`）と `/api/sync?resource=premarket-log`（`premarketLogger.js:179`）は**ハードコード** |
| PREMARKET の収集窓（8:45〜9:06） | **完全にハードコード** | `START_MINUTE = 8*60+45`（`premarketLogger.js:104`）、`END_MINUTE = 9*60+6`（`premarketLogger.js:105`）。対応する環境変数は存在しない |
| tick 間隔（15秒） | **完全にハードコード** | `FETCH_INTERVAL_MS = 15*1000`（`premarketLogger.js:106`）。対応する環境変数は存在しない。なお時間外の時刻判定間隔 `TICK_INTERVAL_MS = 60*1000`（`premarketLogger.js:107`）もハードコード |

### 2-5. `PREMARKET_CODES` / `PREMARKET_MAX` の参照箇所と切り取りロジック → **先頭から N 件を取る実装で正しい**

参照箇所:

- `PREMARKET_CODES` … `premarketLogger.js:46`（`parsePremarketCodes()` 内、この1箇所のみ）
- `PREMARKET_MAX` … `premarketLogger.js:80`（`parsePremarketMax()` 内、この1箇所のみ）
- 両方とも `premarketLogger.js:92-94` で**モジュール読み込み時に一度だけ**評価され、
  以後は定数 `CODES` として使われる（`premarketLogger.js:145,215,240,256`）。
  実行中に環境変数を変えても反映されない＝反映には Railway の再デプロイが必要。

切り取りロジック（`premarketLogger.js:92-98`）:

```
RECEIVED_CODES = parsePremarketCodes()
MAX_CODES      = parsePremarketMax()
CODES          = RECEIVED_CODES.slice(0, MAX_CODES)
```

- **`slice(0, MAX_CODES)`＝先頭から N 件**。ご認識のとおり。
- 切り取り前の `parsePremarketCodes()`（`premarketLogger.js:45-75`）は
  出現順を保持する（`premarketLogger.js:63` にソート禁止のコメントあり）ため、
  **環境変数に書いた並び順がそのまま優先順位になる**。
- 除外・正規化の順序は「クォート除去 → カンマ分割 → 空要素破棄 → 大文字化 →
  `/^[0-9A-Z]{4}$/` 以外を除外 → 重複は先勝ち」（`premarketLogger.js:53-64`）。
  除外は**切り取りより前**に行われるので、不正値が混ざっていても
  有効な銘柄が先頭から N 件確保される。
- フォールバック: `PREMARKET_CODES` が未設定・空文字なら `DEFAULT_CODES`（`premarketLogger.js:47`）、
  全件が弾かれた場合も `DEFAULT_CODES` に戻す（`premarketLogger.js:70-73`）。
  `PREMARKET_MAX` は未設定・非数値・1未満なら既定8（`premarketLogger.js:81-86`）。
- 切り捨てが発生した場合は警告ログに残る（`premarketLogger.js:96-98`）。

---

## 3. 管轄の整理（1・2の結果から）

| 管轄 | 変数 |
|---|---|
| Vercel のみ | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `TACHIBANA_RANKING_API`, `TACHIBANA_ISSUE_DETAIL_API`, `TACHIBANA_TOPIX_API`, `TACHIBANA_NAMES_API`, `TACHIBANA_MARKET_PRICE_API`, `ANTHROPIC_API_KEY`, `PUSHOVER_TOKEN`, `PUSHOVER_USER`, `SCAN_SYNC_USER_ID`, `VERCEL_URL`（自動注入） |
| Railway のみ | `TACHIBANA_ENV`, `TACHIBANA_URL_AUTH_DEMO`, `TACHIBANA_URL_AUTH_PROD`, `TACHIBANA_AUTH_ID`, `TACHIBANA_PRIVATE_KEY`, `TACHIBANA_MKT_CODE`, `TACHIBANA_WATCH_API`, `TACHIBANA_QUOTE_API`, `WATCH_STALE_SECONDS`, `QUOTE_WRITE_MIN_INTERVAL_SECONDS`, `WATCH_POLL_INTERVAL_SECONDS`, `TACHIBANA_SEND_GAP_MS`, `TACHIBANA_RETRY_GAP_MS`, `PORT`（自動注入）, `SCAN_ENABLED`, `SCAN_TIMES`, `VERCEL_API_BASE`, `SCAN_BATCH_SIZE`, `PREMARKET_CODES`, `PREMARKET_MAX` |
| GitHub Actions Secrets | `SYNC_URL`, `USER_ID`（`MODEL` は未設定・既定値のみ） |
| **両側に同じ値が必要（二重化）** | `TACHIBANA_RELAY_SECRET` |
| どちらでも不使用 | `JQUANTS_API_KEY` |

Railway 側の再デプロイが必要になる変更の危険度:

- **起動不能に直結（`must()` 対象）**: `TACHIBANA_AUTH_ID`, `TACHIBANA_PRIVATE_KEY`,
  `TACHIBANA_WATCH_API`, `TACHIBANA_QUOTE_API`,
  および `TACHIBANA_ENV` の値に応じて `TACHIBANA_URL_AUTH_DEMO` / `TACHIBANA_URL_AUTH_PROD`
- **片側だけ変えると通信が止まる**: `TACHIBANA_RELAY_SECRET`（Vercel と同時に変更すること）
- 上記以外はすべて既定値を持つため、未設定・削除しても起動自体は継続する

---

## 4. 確認できなかった項目

- `@upstash/redis` の**本番で実際に解決されているバージョン**は未確認
  （`node_modules` が未インストールで、Vercel のビルド結果を参照できないため）。
  変数名は 1.22.0 のパッケージ本体で確認したが、1.x の別マイナー版で
  `fromEnv()` の読む変数名が変わっていないことまでは検証していない。
- Vercel / Railway / GitHub に**実際に登録されている**環境変数の一覧は未確認
  （コードからの静的調査のみで、各サービスの管理画面にアクセスしていないため）。
  したがって「コードは読むが未設定」「設定されているがコードは読まない」変数の有無は判定できない。
