export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { market } = req.query;

  try {
    if (market === "jp") {
      const data = await getJPRanking();
      return res.status(200).json({ market: "jp", stocks: data });
    } else {
      const data = await getUSRanking();
      return res.status(200).json({ market: "us", stocks: data });
    }
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// ── 米国株：Yahoo Finance Screener ────────────────────────────────────────────
async function getUSRanking() {
  const url = "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved"
    + "?formatted=false&lang=en-US&region=US&scrIds=most_actives&count=50&start=0";

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "application/json",
    },
  });
  if (!res.ok) throw new Error("Yahoo Finance screener: " + res.status);
  const json = await res.json();

  const quotes = json?.finance?.result?.[0]?.quotes || [];
  return quotes.map(function(q) {
    return {
      ticker: q.symbol,
      name: q.shortName || q.longName || q.symbol,
      market: "US",
      tvSymbol: (q.exchange === "NYQ" ? "NYSE:" : "NASDAQ:") + q.symbol,
      volume: q.regularMarketVolume || 0,
      price: q.regularMarketPrice || 0,
      change: q.regularMarketChangePercent || 0,
    };
  });
}

// ── 日本株：J-Quants API V2 ───────────────────────────────────────────────────
async function getJPRanking() {
  const apiKey = process.env.JQUANTS_API_KEY;
  if (!apiKey) throw new Error("JQUANTS_API_KEY not set");

  const dateStr = getLatestTradingDay(new Date());

  // V2エンドポイント・x-api-keyヘッダー
  const url = `https://api.jquants.com/v2/equities/prices/daily?date=${dateStr}`;
  const res = await fetch(url, {
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error("J-Quants API error: " + res.status + " " + errText);
  }

  const json = await res.json();
  // V2のレスポンスキーを確認（daily_quotes or data）
  const quotes = json?.daily_quotes || json?.data || json?.prices || [];

  if (quotes.length === 0) {
    throw new Error("J-Quants: no data returned. Keys: " + Object.keys(json).join(","));
  }

  // V2カラム名: Vo=出来高, C=終値, O=始値
  const sorted = quotes
    .filter(function(q) {
      const vol = q.Vo || q.Volume || 0;
      const close = q.C || q.Close || 0;
      return vol > 0 && close > 0;
    })
    .sort(function(a, b) {
      const va = a.Vo || a.Volume || 0;
      const vb = b.Vo || b.Volume || 0;
      return vb - va;
    })
    .slice(0, 50);

  return sorted.map(function(q) {
    const code = String(q.Code || q.code || "").replace(/0$/, "");
    const close = q.C || q.Close || 0;
    const open = q.O || q.Open || 0;
    const change = open > 0 ? ((close - open) / open * 100) : 0;
    return {
      ticker: code + ".T",
      name: q.CompanyName || q.company_name || code,
      market: "JP",
      tvSymbol: "TSE:" + code,
      volume: q.Vo || q.Volume || 0,
      price: close,
      change: parseFloat(change.toFixed(2)),
    };
  });
}

// 直近営業日
function getLatestTradingDay(date) {
  const d = new Date(date);
  const jstHour = (d.getUTCHours() + 9) % 24;
  if (jstHour < 16) d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
