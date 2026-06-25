export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { ticker, range } = req.query;
  if (!ticker) return res.status(400).json({ error: "ticker is required" });

  if (ticker.endsWith(".T")) return handleJP(ticker, res);
  return handleUS(ticker, range, res);
}

// ── JP: J-Quants 1分足（from/toで期間指定・1リクエスト）────────────────────
async function handleJP(ticker, res) {
  try {
    const apiKey = process.env.JQUANTS_API_KEY;
    if (!apiKey) throw new Error("JQUANTS_API_KEY not set");

    const code = ticker.replace(".T", "") + "0";

    // 過去10営業日のfrom/toを計算（JSTで今日から10営業日前）
    const today = getJSTDate(0);
    const from  = getJSTDate(16); // 土日祝を考慮して多めに16日前

    const url = `https://api.jquants.com/v2/equities/bars/minute?code=${code}&from=${from}&to=${today}`;
    const r = await fetch(url, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`J-Quants ${r.status}: ${errText}`);
    }
    const json = await r.json();
    const allBars = json.data || [];

    if (!allBars.length) throw new Error("no JP minute data");

    // 日付昇順でソート（念のため）
    allBars.sort(function(a, b) {
      const ka = a.Date + a.Time;
      const kb = b.Date + b.Time;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

    const closes  = allBars.map(function(b) { return b.C  || 0; });
    const highs   = allBars.map(function(b) { return b.H  || 0; });
    const lows    = allBars.map(function(b) { return b.L  || 0; });
    const volumes = allBars.map(function(b) { return b.Vo || 0; });

    // currentPrice: 当日最終バーの終値
    const currentPrice = closes[closes.length - 1];

    // previousClose: 前営業日の最終バー終値
    const todayDate = allBars[allBars.length - 1]?.Date;
    let previousClose = currentPrice;
    for (let i = allBars.length - 1; i >= 0; i--) {
      if (allBars[i].Date !== todayDate) {
        previousClose = allBars[i].C || currentPrice;
        break;
      }
    }

    return res.status(200).json({
      chart: {
        result: [{
          meta: {
            regularMarketPrice: currentPrice,
            chartPreviousClose: previousClose,
            dataInterval: "1m",
            dataRange: "10d",
          },
          indicators: {
            quote: [{ close: closes, high: highs, low: lows, volume: volumes }],
          },
          per: null, pbr: null, analystTarget: null, sector: null,
        }],
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// ── JST日付文字列を取得（daysAgo日前、YYYYMMDD形式）────────────────────────
function getJSTDate(daysAgo) {
  const d = new Date();
  d.setTime(d.getTime() + 9 * 60 * 60 * 1000);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

// ── US: Yahoo Finance（既存コードそのまま）──────────────────────────────────
async function handleUS(ticker, range, res) {
  const r = range || "60d";
  const isIntraday = ["1d","5d","1mo","60d"].includes(r);
  const interval = isIntraday ? "15m" : "1d";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${r}`;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
      },
    });
    if (!response.ok) throw new Error(`Yahoo Finance returned ${response.status}`);
    const data = await response.json();

    const result = data?.chart?.result?.[0];
    if (result) {
      const closes = result.indicators?.quote?.[0]?.close || [];
      const meta = result.meta || {};
      const validCloses = closes.filter(v => v != null && !isNaN(v));
      const previousClose =
        (validCloses.length >= 2 ? validCloses[validCloses.length - 2] : null)
        || meta.chartPreviousClose || meta.regularMarketPreviousClose || 0;
      result.meta.chartPreviousClose = previousClose;
      result.meta.dataInterval = interval;
      result.meta.dataRange = r;
    }

    let per = null, pbr = null, analystTarget = null, sector = null;
    const chartMeta = data?.chart?.result?.[0]?.meta || {};
    if (chartMeta.trailingPE) per = chartMeta.trailingPE;
    if (chartMeta.priceToBook) pbr = chartMeta.priceToBook;

    if (!per || !pbr || !analystTarget || !sector) {
      try {
        const summaryUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=defaultKeyStatistics,summaryDetail,financialData,assetProfile`;
        const summaryRes = await fetch(summaryUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json",
            "Accept-Language": "en-US,en;q=0.9",
          },
          signal: AbortSignal.timeout(6000),
        });
        if (summaryRes.ok) {
          const summary = await summaryRes.json();
          const detail = summary?.quoteSummary?.result?.[0];
          if (!per) {
            per = detail?.summaryDetail?.trailingPE?.raw || null;
            if (!per && detail?.defaultKeyStatistics?.trailingEps?.raw && chartMeta.regularMarketPrice) {
              const eps = detail.defaultKeyStatistics.trailingEps.raw;
              if (eps > 0) per = chartMeta.regularMarketPrice / eps;
            }
          }
          if (!pbr) pbr = detail?.defaultKeyStatistics?.priceToBook?.raw || null;
          if (detail?.financialData?.targetMeanPrice?.raw) analystTarget = detail.financialData.targetMeanPrice.raw;
          if (detail?.assetProfile?.sector) sector = detail.assetProfile.sector;
        }
      } catch(e) {}
    }

    if (!per || !pbr) {
      try {
        const quoteUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ticker)}&fields=trailingPE,priceToBook`;
        const quoteRes = await fetch(quoteUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(5000),
        });
        if (quoteRes.ok) {
          const quoteData = await quoteRes.json();
          const q = quoteData?.quoteResponse?.result?.[0];
          if (q) {
            if (!per && q.trailingPE) per = q.trailingPE;
            if (!pbr && q.priceToBook) pbr = q.priceToBook;
          }
        }
      } catch(e) {}
    }

    if (per && (!isFinite(per) || per <= 0 || per > 10000)) per = null;
    if (pbr && (!isFinite(pbr) || pbr <= 0 || pbr > 1000)) pbr = null;
    if (analystTarget && (!isFinite(analystTarget) || analystTarget <= 0)) analystTarget = null;

    if (data?.chart?.result?.[0]) {
      data.chart.result[0].per = per;
      data.chart.result[0].pbr = pbr;
      data.chart.result[0].analystTarget = analystTarget;
      data.chart.result[0].sector = sector;
    }

    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
