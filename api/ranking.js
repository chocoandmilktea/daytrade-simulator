export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { market } = req.query; // "us" or "jp"

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
    + "?formatted=false&lang=en-US&region=US&scrIds=most_actives"
    + "&count=50&start=0";

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

// ── 日本株：J-Quants API ──────────────────────────────────────────────────────
async function getJPRanking() {
  const apiKey = process.env.JQUANTS_API_KEY;
  if (!apiKey) throw new Error("JQUANTS_API_KEY not set");

  // 今日・前営業日の日付を取得
  const today = new Date();
  const dateStr = getLatestTradingDay(today);

  // 出来高上位を取得（J-Quants: 株価情報エンドポイント）
  const url = `https://api.jquants.com/v1/prices/daily_quotes?date=${dateStr}`;
  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error("J-Quants API error: " + res.status + " " + errText);
  }

  const json = await res.json();
  const quotes = json?.daily_quotes || [];

  // 出来高でソートして上位50を返す
  const sorted = quotes
    .filter(function(q) { return q.Volume && q.Volume > 0 && q.Close && q.Close > 0; })
    .sort(function(a, b) { return (b.Volume || 0) - (a.Volume || 0); })
    .slice(0, 50);

  return sorted.map(function(q) {
    const code = String(q.Code).replace(/0$/, ""); // 末尾の0を除去
    const change = q.Open && q.Close
      ? ((q.Close - q.Open) / q.Open * 100)
      : 0;
    return {
      ticker: code + ".T",
      name: q.CompanyName || code,
      market: "JP",
      tvSymbol: "TSE:" + code,
      volume: q.Volume || 0,
      price: q.Close || 0,
      change: parseFloat(change.toFixed(2)),
    };
  });
}

// 直近営業日を返す（土日を除く）
function getLatestTradingDay(date) {
  const d = new Date(date);
  // 日本時間で当日15:30以前なら前営業日を使う
  const jstHour = (d.getUTCHours() + 9) % 24;
  if (jstHour < 15) d.setDate(d.getDate() - 1);

  // 土日をスキップ
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
