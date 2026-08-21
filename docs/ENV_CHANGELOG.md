# ENV_CHANGELOG

環境変数の変更・デプロイ・マージの履歴を1ファイルに追記記録する。
過去データに不連続が見つかった際に「いつ何が変わってデータに影響したか」を遡って特定するために使う。

記録対象は daytrade-simulator（Vercel）と tachibana-server（Railway）の両方。
ファイルの物理配置を daytrade-simulator 側にしているのは、Railway に置くと Watch Paths の
除外設定が必要になり、ログ追記自体が再デプロイを誘発するため。

## 運用ルール

- **追記専用（append-only）**。過去行の書き換え・削除は行わない
- 新しい行は表の**末尾に追加**する（日付昇順）
- **種別**は次の4種のいずれか
  - `env` … 環境変数の追加・変更・削除
  - `deploy` … デプロイ実施
  - `merge` … Pull Request のマージ
  - `config` … 上記以外の設定変更・確認記録
- **データ影響**は次の3種のいずれか
  - `有` … 収集データの内容・件数・形式が変わる
  - `無` … データに影響しない
  - `不明` … 影響の有無を判断できていない
- **データ影響:有 の行は、過去データとの比較不能点を意味する**。
  その日付をまたぐデータを単純比較してはいけない

## 変更履歴

| 日付 | 種別 | 対象 | 内容 | データ影響 |
| --- | --- | --- | --- | --- |
| 2026-08-20 | merge | tachibana-server | PR#15 premarketLogger.js 修正1〜5（窓突入検知 60秒→15秒 を含む）<br>補足: 収集件数が 81件→84件 に変化。8/20以前と8/21以降で件数が不連続 | 有 |
| 2026-08-20 | config | tachibana-server | PR#13・#14 をクローズ（#15に統合） | 無 |
| 2026-08-20 | env | Railway | PREMARKET_MAX 12→40<br>補足: 収集銘柄数が変わる | 有 |
| 2026-08-20 | config | 両リポジトリ | JQUANTS_API_KEY・Redis系変数は該当なしを実測確認（Railway Service Variables 18件） | 無 |
| 2026-08-21 | merge | daytrade-simulator | PR: TACHIBANA_RELAY_SECRET の認証判定をフェイルクローズに統一（B） | 無 |
| 2026-08-21 | merge | daytrade-simulator | PR#36 package-lock.json を追加（@upstash/redis 1.38.2 固定） | 無 |
| 2026-08-21 | merge | daytrade-simulator | PR: premarket-summary の date 必須化。未指定時400（D） | 無 |
| 2026-08-21 | merge | daytrade-simulator | PR: premarket-summary の到達不能な全日列挙分岐を削除（E） | 無 |
| 2026-08-21 | env | Railway | PREMARKET_MAX 40→100<br>補足: 収集銘柄数が変わる | 有 |

## 実測基準値

データ不連続を追う際の比較基準として使う。

### 2026-08-21 PREMARKET_MAX=40 実測

- 対象 40銘柄 / 16列 = 640（「銘柄数 × 項目数 ≦ 200」制限は 640 までは不存在）
- tick 444〜641ms
- POST 790KB / 84レコード
- 収集終了 84件（エラー0件 / tick失敗0件）

### ペイロード線形性（2点実測）

- 12銘柄 → 230KB（19.2KB/銘柄）
- 40銘柄 → 790KB（19.75KB/銘柄）
- Vercel の上限は 4.5MB
