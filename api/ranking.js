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

async function getUSRanking() {
  const url = new URL("https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved");
url.searchParams.set("formatted", "false");
url.searchParams.set("lang", "en-US");
url.searchParams.set("region", "US");
url.searchParams.set("scrIds", "most_actives");
url.searchParams.set("count", "50");
url.searchParams.set("start", "0");
const res = await fetch(url.toString(), {

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

const JP_NAMES = {
  "7203":"トヨタ自動車","6758":"ソニーグループ","8306":"三菱UFJ",
  "9984":"ソフトバンクG","6861":"キーエンス","7974":"任天堂",
  "8035":"東京エレクトロン","9432":"NTT","4063":"信越化学","6367":"ダイキン工業",
  "9433":"KDDI","7267":"ホンダ","6501":"日立製作所","4519":"中外製薬",
  "3382":"セブン&アイ","8411":"みずほFG","6098":"リクルートHD",
  "4661":"オリエンタルランド","8316":"三井住友FG","6594":"日本電産",
  "4568":"第一三共","7751":"キヤノン","6702":"富士通","8058":"三菱商事",
  "8031":"三井物産","7011":"三菱重工","5108":"ブリヂストン","4452":"花王",
  "6857":"アドバンテスト","9101":"日本郵船"
};

function getLatestBusinessDay() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  let d = new Date(jst);
  // 常に前営業日を使う（当日データは夕方以降しか確定しないため）
  d.setUTCDate(d.getUTCDate() - 1);
  // 土日を除く
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}


async function getJPRanking() {
  const apiKey = process.env.JQUANTS_API_KEY;
  if (!apiKey) throw new Error("JQUANTS_API_KEY not set");

  const dateStr = getLatestBusinessDay();
  const url = `https://api.jquants.com/v2/equities/bars/daily?date=${dateStr}`;
  
  const res = await fetch(url, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(9000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error("J-Quants error: " + res.status + " " + errText);
  }

  const json = await res.json();
  const bars = json?.data || [];

  if (!bars.length) {
    throw new Error("No data. Keys: " + Object.keys(json).join(","));
  }

  return bars
    .filter(function(bar) {
      return (bar.Vo || 0) > 0 && (bar.C || 0) > 0;
    })
    .sort(function(a, b) {
      return (b.Vo || 0) - (a.Vo || 0);
    })
    .slice(0, 50)
    .map(function(bar) {
      const code = String(bar.Code || "").replace(/0$/, "");
      const close = bar.C || 0;
      const open = bar.O || 0;
      const vol = bar.Vo || 0;
      const change = open > 0 ? ((close - open) / open * 100) : 0;
      return {
        ticker: code + ".T",
        name: JP_NAMES[code] || code,
        market: "JP",
        tvSymbol: "TSE:" + code,
        volume: vol,
        price: close,
        change: parseFloat(change.toFixed(2)),
      };
    });
}


