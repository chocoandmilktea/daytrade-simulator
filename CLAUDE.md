# DaySimulator（daytrade-simulator）

株式情報の管理・取得アプリ。日本株・米国株のスキャン、スコアリング、トレード記録を行う。

## 構成

- **フロント**: `src/App.js`（React・約3950行・単一ファイル）
- **バックエンド**: Vercel Functions（`api/` 配下）
- **リアルタイム中継**: Railway 上の別リポジトリ `tachibana-server`（常時起動）
- **ストア**: Upstash Redis（同期データ・フォールバック用スナップショット）

## データ源

| 用途 | データ源 |
| --- | --- |
| 日本株の現在値・板情報（リアルタイム） | 立花証券e支店API |
| 日本株の出来高ランキング・業種・会社名 | 立花証券e支店API |
| PER / PBR / EPS / BPS / 配当利回り / 権利落ち日 | 立花証券e支店API |
| TOPIX 日次騰落率 | 立花証券e支店API |
| 分足・日足ミニチャート・米国株全般 | Yahoo Finance |
| 決算発表予定日 | 東証（JPX）公式Excel（認証不要） |

**J-Quantsは2026年7月に完全廃止済み。立花証券APIへ全面移行しているので、新たにJ-Quantsを使うコードを書かないこと。** `JQUANTS_API_KEY` は使用していない。

## 立花証券APIの扱い方（重要）

Vercel側から立花証券APIを**直接叩くことはない**。必ず `tachibana-server` のHTTPエンドポイントを経由する。

```
App.js → Vercel(api/*.js) → tachibana-server(webapi.js) → 立花証券e支店API
```

### tachibana-server の4エンドポイント

| エンドポイント | 返すもの | 呼び出し元 | キャッシュ |
| --- | --- | --- | --- |
| `/ranking-data` | 市場全体の出来高・現在値・名前・業種 | `api/ranking.js` | 1〜3分 |
| `/issue-detail?code=XXXX` | PER/PBR/EPS/BPS/配当利回り/権利落ち日 | `api/stock.js` | 1時間 |
| `/topix` | TOPIX騰落率 | `api/stock.js` | 1時間 |
| `/names` | 銘柄コード→会社名の対応表 | `api/ipo.js` | 24時間 |

呼び出し時のルール:

- URLは環境変数から読む（`TACHIBANA_RANKING_API` / `TACHIBANA_ISSUE_DETAIL_API` / `TACHIBANA_TOPIX_API` / `TACHIBANA_NAMES_API`）
- 認証はヘッダ `X-Relay-Secret`（`TACHIBANA_RELAY_SECRET`）
- 取得は必ず `api/_fallbackCache.js` の `withFallback(key, fn)` で包む。失敗時にRedis保存済みの直近成功データを返すため
- `AbortSignal.timeout()` を必ず付ける（8秒目安、一括取得系は15秒）

### リアルタイム株価・板情報

選択中の**1銘柄のみ**を購読する仕組み。

1. `App.js` の `TachibanaBoard` が60秒おきに `sync.js?resource=tachibana-watch` へPOST（監視対象を伝える。5分でタイムアウト）
2. `tachibana-server` がそれを読み、WebSocketで購読して `tachibana-quote` へPOST（Redis TTL 30秒）
3. `App.js` が7秒おきに `tachibana-quote` をGETして表示

- 板データのフィールド名は `p_1_DPP`（現在値）、`p_1_DYRP`（騰落率）、`p_1_GAV1〜10`（売気配数量）、`p_1_GBV1〜10`（買気配数量）など
- 受信イベントには「全項目入り」と「価格のみの軽量更新」があるため、**丸ごと置き換えず既存fieldsにマージする**こと（気配値が消えるバグの原因になる）

### メンテナンス時間帯

立花証券は毎日3:00〜8:30がシステムメンテナンス。この間はAPIが落ちるが、`withFallback` がRedisの前回成功データ（3日保持）を返すため、問い合わせ自体をスキップしないこと。

## ファイルの役割

**フロント**
- `src/App.js` — UI・状態管理・全API呼び出し・スキャン時のキュー制御

**Vercel API（`api/`）**
- `ai.js` — Anthropic APIへのプロキシ（system prompt・web_search対応）
- `ranking.js` — 出来高・値上がり率のハイブリッドランキング（JP: 立花、US: Yahoo）
- `sector.js` — AI選定業種で絞り込んだランキング（`ranking.js` の関数を再利用）
- `stock.js` — 個別銘柄の詳細（分足: Yahoo、財務指標/TOPIX: 立花）。内部は並列取得
- `daily.js` — カード用ミニチャート（直近3ヶ月日足・Yahoo）
- `intraday.js` — 当日1分足（Yahoo）。銘柄選択時のみ呼ばれ、スキャン時は呼ばれない
- `ipo.js` — 銘柄コード→会社名の対応表（立花・1時間キャッシュ）
- `sync.js` — デバイス間同期（TTL90日）＋ 立花リアルタイム中継の窓口
- `notify.js` — Pushover通知
- `_fallbackCache.js` — 取得失敗時のRedisフォールバック共通ヘルパー（`_`始まりはVercelにエンドポイントとして扱わせないため）

**⚠️ Vercel Hobbyプランはサーバーレス関数12個までの制限がある。新しい `api/*.js` を安易に増やさず、既存ファイルに相乗りさせること**（`sync.js` が立花中継を兼ねているのはこのため）。

**tachibana-server（別リポジトリ・Railway）**
- `index.js` — 起動（watcher + webapi）
- `auth.js` — ログイン・秘密鍵での仮想URL復号・日次自動再ログイン
- `eventClient.js` — EVENT I/F（WebSocket）クライアント
- `relay.js` — Vercel API との通信
- `watcher.js` — 銘柄切り替え・データ中継のメインループ
- `webapi.js` — 上記4エンドポイントのHTTPサーバー

## 開発ルール

- **既存のコードスタイルを踏襲する**: `var` / `function` 式 / インライン `style` オブジェクト。ES6+の書き換えやCSSファイル化はしない
- コメントは日本語で書く
- 依頼されていない箇所は変更しない
- 新しいライブラリを勝手に追加しない
- 外部API呼び出しには必ずタイムアウトとエラーハンドリングを付ける
- 変更後は「何をどう変えたか」を日本語で要約する
- 秘密鍵・APIキーをコードに直書きしない（すべて環境変数）

## よくある落とし穴

- 日本株の前日比は `PrevC`（前日終値）を優先。無い場合のみ始値比で代用する
- 銘柄コードは4桁。`ticker` は `"7203.T"` 形式、立花APIへは `.T` を外して渡す
- スキャン時は `CACHE` をクリアして必ず最新データを取る
- `api/index.js` は用途未確認のため触らない

