// api/daily.js
// 直近の日足終値を返すエンドポイント（カードのミニチャート用）
// データ取得元: Yahoo Finance（intraday.jsと同じ非公式チャートAPI）
//
// リクエスト例: /api/daily?ticker=7203.T
// レスポンス: { closes:[...], dates:[...] }（直近3ヶ月分、JSTの日付文字列）

const YAHOO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const ticker = req.query.ticker;
  if (!ticker) {
    return res.status(400).json({ error: "ticker is required" });
  }

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=3mo`;
    const r = await fetch(url, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(9000) });
    if (r.status === 429) {
      return res.status(200).json({ closes: [], dates: [], rateLimited: true });
    }
    if (!r.ok) throw new Error("Yahoo " + r.status);

    const json = await r.json();
    const result = json?.chart?.result?.[0];
    if (!result || !result.timestamp) {
      return res.status(200).json({ closes: [], dates: [] });
    }

    const closesRaw = result.indicators?.quote?.[0]?.close || [];
    const closes = [];
    const dates = [];
    for (let i = 0; i < result.timestamp.length; i++) {
      if (closesRaw[i] == null) continue;
      // 日足のtimestampは既にその取引日を指すUTC時刻なので、シフトせずそのまま読む
      // （分足と違い時刻情報は使わないため、+9時間シフトすると日付が前後にズレる場合があった）
      const d = new Date(result.timestamp[i] * 1000);
      const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      closes.push(closesRaw[i]);
      dates.push(dateStr);
    }

    // 日足は値の変化が緩やかなので、分足より長めにキャッシュしてよい
    res.setHeader("Cache-Control", "public, max-age=1800");
    return res.status(200).json({ closes, dates });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
