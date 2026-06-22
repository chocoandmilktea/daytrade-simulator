// api/fetchUS.js（Vercel Serverless Function）
// Yahoo Finance 日足データ取得（将来: interval=5m&range=1d で5分足に切替可能）

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { ticker, range } = req.query;
  if (!ticker) return res.status(400).json({ error: "ticker is required" });

  const r = range || "1y";

  // 将来の分足切替ポイント:
  // interval を "1d" → "5m"、range を "1y" → "1d" に変えるだけ
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?interval=1d&range=${r}`;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(12000),
    });

    if (!response.ok) throw new Error("Yahoo Finance: " + response.status);

    const data = await response.json();
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error("empty response");

    const q = result.indicators?.quote?.[0] || {};
    const meta = result.meta || {};

    // null埋め
    function fill(arr) {
      var out = (arr || []).slice();
      for (var i = 0; i < out.length; i++) {
        if (out[i] == null) out[i] = i > 0 ? out[i - 1] : 0;
      }
      return out;
    }

    const closes = fill(q.close);
    const highs = fill(q.high);
    const lows = fill(q.low);
    const volumes = fill(q.volume);

    // previousClose: 終値配列の最後から2番目で確定
    const validCloses = closes.filter(function (v) { return v != null && !isNaN(v) && v > 0; });
    const previousClose = validCloses.length >= 2
      ? validCloses[validCloses.length - 2]
      : (meta.chartPreviousClose || meta.regularMarketPreviousClose || 0);

    return res.status(200).json({
      ticker: ticker,
      closes: closes,
      highs: highs,
      lows: lows,
      volumes: volumes,
      currentPrice: meta.regularMarketPrice || closes[closes.length - 1],
      previousClose: previousClose,
      real: true,
      // フォールバック用フラグ（将来: "minute" or "daily"）
      dataType: "daily",
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

