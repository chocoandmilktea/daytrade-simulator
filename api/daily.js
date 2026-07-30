// api/daily.js
// 直近の日足終値・出来高・始値・高値・安値を返すエンドポイント（カードのミニチャート、
// 「出来高急増後の値動き」「ギャップ埋まり率」パターン分析用）
// データ取得元: Yahoo Finance（intraday.jsと同じ非公式チャートAPI）
//
// リクエスト例: /api/daily?ticker=7203.T
// レスポンス: { closes:[...], dates:[...], volumes:[...], opens:[...], highs:[...], lows:[...] }
//   （直近1年分、JSTの日付文字列）
// ※パターン分析は「出来高が急増した日」「ギャップが開いた日」がある程度の回数
// 　無いと意味が無いため、3ヶ月から1年に延長（母数を増やして信頼度を上げるため）

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
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1y`;
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
    const volumesRaw = result.indicators?.quote?.[0]?.volume || [];
    const opensRaw = result.indicators?.quote?.[0]?.open || [];
    const highsRaw = result.indicators?.quote?.[0]?.high || [];
    const lowsRaw = result.indicators?.quote?.[0]?.low || [];
    const closes = [];
    const dates = [];
    const volumes = [];
    const opens = [];
    const highs = [];
    const lows = [];
    for (let i = 0; i < result.timestamp.length; i++) {
      if (closesRaw[i] == null) continue;
      // 日足のtimestampは既にその取引日を指すUTC時刻なので、シフトせずそのまま読む
      // （分足と違い時刻情報は使わないため、+9時間シフトすると日付が前後にズレる場合があった）
      const d = new Date(result.timestamp[i] * 1000);
      const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      const open = opensRaw[i] == null ? closesRaw[i] : opensRaw[i];
      closes.push(closesRaw[i]);
      dates.push(dateStr);
      volumes.push(volumesRaw[i] == null ? 0 : volumesRaw[i]);
      opens.push(open);
      highs.push(highsRaw[i] == null ? Math.max(open, closesRaw[i]) : highsRaw[i]);
      lows.push(lowsRaw[i] == null ? Math.min(open, closesRaw[i]) : lowsRaw[i]);
    }

    // 日足は値の変化が緩やかなので、分足より長めにキャッシュしてよい
    res.setHeader("Cache-Control", "public, max-age=1800");
    return res.status(200).json({ closes, dates, volumes, opens, highs, lows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
