// api/fetchUS.js（Vercel Serverless Function）
// Yahoo Finance 日足データ取得（米国株・15分遅延）
// + BBグラフ用15分足データ追加取得

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { ticker, range } = req.query;
  if (!ticker) return res.status(400).json({ error: "ticker is required" });

  const r = range || "1y";

  function fill(arr) {
    var out = (arr || []).slice();
    for (var i = 0; i < out.length; i++) {
      if (out[i] == null) out[i] = i > 0 ? out[i - 1] : 0;
    }
    return out;
  }

  try {
    // ── 日足取得（スコア計算・52週レンジ用） ──────────────────────────────────
    const urlDaily = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
      `?interval=1d&range=${r}`;

    const resDaily = await fetch(urlDaily, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(12000),
    });

    if (!resDaily.ok) throw new Error("Yahoo Finance: " + resDaily.status);

    const dataDaily = await resDaily.json();
    const resultDaily = dataDaily?.chart?.result?.[0];
    if (!resultDaily) throw new Error("empty response");

    const qd = resultDaily.indicators?.quote?.[0] || {};
    const meta = resultDaily.meta || {};

    const closes  = fill(qd.close);
    const highs   = fill(qd.high);
    const lows    = fill(qd.low);
    const volumes = fill(qd.volume);

    const validCloses = closes.filter(function (v) { return v != null && !isNaN(v) && v > 0; });
    const previousClose = validCloses.length >= 2
      ? validCloses[validCloses.length - 2]
      : (meta.chartPreviousClose || meta.regularMarketPreviousClose || 0);

    // ── 15分足取得（BBグラフ用・過去2日間） ──────────────────────────────────
    var minuteCloses = null, minuteHighs = null, minuteLows = null, minuteVolumes = null;

    try {
      const url15m = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
        `?interval=15m&range=2d`;

      const res15m = await fetch(url15m, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(10000),
      });

      if (res15m.ok) {
        const data15m = await res15m.json();
        const result15m = data15m?.chart?.result?.[0];
        if (result15m) {
          const qm = result15m.indicators?.quote?.[0] || {};
          const mc = fill(qm.close);
          // 有効データが20本以上あれば採用（BB計算に必要な最低本数）
          if (mc.filter(function(v){ return v > 0; }).length >= 20) {
            minuteCloses  = mc;
            minuteHighs   = fill(qm.high);
            minuteLows    = fill(qm.low);
            minuteVolumes = fill(qm.volume);
          }
        }
      }
    } catch (e) {
      // 15分足失敗は無視（日足フォールバックで動作継続）
    }

    return res.status(200).json({
      ticker: ticker,
      // 日足データ（スコア計算・52週レンジ用）
      closes:        closes,
      highs:         highs,
      lows:          lows,
      volumes:       volumes,
      currentPrice:  meta.regularMarketPrice || closes[closes.length - 1],
      previousClose: previousClose,
      real:          true,
      dataType:      "daily",
      // 15分足データ（BBグラフ用・取得失敗時はnull）
      minuteCloses:  minuteCloses,
      minuteHighs:   minuteHighs,
      minuteLows:    minuteLows,
      minuteVolumes: minuteVolumes,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
