// api/daily.js
// 日足・分足の始値/高値/安値/終値/出来高を返すエンドポイント
// （カードのミニチャート、「出来高急増後の値動き」「ギャップ埋まり率」パターン分析、
//   および「寄り→引け」の検証で使用）
// データ取得元: Yahoo Finance（intraday.jsと同じ非公式チャートAPI）
//
// リクエスト例:
//   /api/daily?ticker=7203.T                          → 日足1年分（従来と同じ動作）
//   /api/daily?ticker=7203.T&interval=60m&range=2y    → 60分足2年分
//   /api/daily?ticker=7203.T&interval=5m&range=60d    → 5分足60日分
//
// レスポンス: { closes, dates, times, volumes, opens, highs, lows, interval, range }
//   times = 各足のUNIX秒（分足で「どちらが先に来たか」を判定するために使用）
//
// ※interval と range を省略した場合は従来どおり日足1年分を返すので、
// 　既存の呼び出し箇所はこのまま動きます。

const YAHOO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

// Yahooが受け付ける値だけを通す（変な値をそのまま渡さないための安全弁）
const OK_INTERVAL = ["1m", "2m", "5m", "15m", "30m", "60m", "90m", "1h", "1d", "1wk", "1mo"];
const OK_RANGE = ["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "ytd", "max", "60d", "7d", "30d"];

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

  // 省略時は従来どおり「日足・1年分」
  const interval = OK_INTERVAL.includes(req.query.interval) ? req.query.interval : "1d";
  const range = OK_RANGE.includes(req.query.range) ? req.query.range : "1y";
  const isIntraday = !["1d", "1wk", "1mo"].includes(interval);

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`;
    const r = await fetch(url, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(isIntraday ? 15000 : 9000) });
    if (r.status === 429) {
      return res.status(200).json({ closes: [], dates: [], times: [], rateLimited: true });
    }
    if (!r.ok) throw new Error("Yahoo " + r.status);

    const json = await r.json();
    const result = json?.chart?.result?.[0];
    if (!result || !result.timestamp) {
      return res.status(200).json({ closes: [], dates: [], times: [], interval, range });
    }

    // 分足は「その取引所の現地時刻」に直さないと日付がズレる。
    // gmtoffset はYahooが返す取引所のUTCからのズレ（秒）で、夏時間も反映済み。
    const gmtoffset = typeof result.meta?.gmtoffset === "number" ? result.meta.gmtoffset : 0;

    const q = result.indicators?.quote?.[0] || {};
    const closesRaw = q.close || [];
    const volumesRaw = q.volume || [];
    const opensRaw = q.open || [];
    const highsRaw = q.high || [];
    const lowsRaw = q.low || [];

    const closes = [];
    const dates = [];
    const times = [];
    const volumes = [];
    const opens = [];
    const highs = [];
    const lows = [];

    for (let i = 0; i < result.timestamp.length; i++) {
      if (closesRaw[i] == null) continue;
      const ts = result.timestamp[i];
      // 日足のtimestampは既にその取引日を指すUTC時刻なので、シフトせずそのまま読む
      // （分足は実際の時刻なので、取引所の現地時刻に直してから日付を取り出す）
      const d = new Date((isIntraday ? ts + gmtoffset : ts) * 1000);
      const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      const open = opensRaw[i] == null ? closesRaw[i] : opensRaw[i];
      closes.push(closesRaw[i]);
      dates.push(dateStr);
      times.push(ts);
      volumes.push(volumesRaw[i] == null ? 0 : volumesRaw[i]);
      opens.push(open);
      highs.push(highsRaw[i] == null ? Math.max(open, closesRaw[i]) : highsRaw[i]);
      lows.push(lowsRaw[i] == null ? Math.min(open, closesRaw[i]) : lowsRaw[i]);
    }

    // 日足は値の変化が緩やかなので長め、分足は短めにキャッシュする
    res.setHeader("Cache-Control", `public, max-age=${isIntraday ? 600 : 1800}`);
    return res.status(200).json({ closes, dates, times, volumes, opens, highs, lows, interval, range, gmtoffset });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
