// api/intraday.js
// 当日の株価5分足を返すエンドポイント（カードのミニチャート用）
// J-Quants API (/v2/equities/bars/minute) は「1分足」を返すので、ここで5本ごとに
// まとめて疑似的な「5分足の終値」を作る。
//
// 必要な環境変数（Vercelのプロジェクト設定 > Environment Variables で設定）:
//   JQUANTS_API_KEY = J-Quantsダッシュボードで発行したAPIキー
//
// リクエスト例: /api/intraday?ticker=7203.T
// レスポンス例: { "closes": [2810, 2812, ...] }

export default async function handler(req, res) {
  const ticker = req.query.ticker;
  if (!ticker) {
    return res.status(400).json({ error: "ticker is required" });
  }

  // "7203.T" -> "7203"（J-Quantsは末尾の".T"を付けない銘柄コード）
  const code = String(ticker).replace(".T", "");

  // 本日の日付を YYYYMMDD 形式で作成
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, "0");
  const d = String(today.getDate()).padStart(2, "0");
  const dateStr = `${y}${m}${d}`;

  try {
    const apiKey = process.env.JQUANTS_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "JQUANTS_API_KEY not set" });
    }

    const url = `https://api.jquants.com/v2/equities/bars/minute?code=${encodeURIComponent(code)}&date=${dateStr}`;
    const r = await fetch(url, { headers: { "x-api-key": apiKey } });

    if (!r.ok) {
      // 休日・取引時間外などでデータが無い場合もここに来る
      return res.status(200).json({ closes: [] });
    }

    const json = await r.json();
    const bars = json.data || []; // 1分足の配列（時系列順）

    // 5本（5分）ごとにグループ化し、各グループの最後の終値(C)を5分足の終値とする
    const closes = [];
    for (let i = 0; i < bars.length; i += 5) {
      const group = bars.slice(i, i + 5);
      const last = group[group.length - 1];
      if (last && typeof last.C === "number") closes.push(last.C);
    }

    // ブラウザ側の短時間キャッシュ用ヘッダー（同一分内の再取得を減らす）
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.status(200).json({ closes });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
