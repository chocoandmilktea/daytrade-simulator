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

// ── 日本株：J-Quants V2 + 主要銘柄リスト ─────────────────────────────────────
// J-Quants FreeプランはコードごとにAPIを叩く形式のため
// 主要50銘柄の価格・出来高を取得して出来高順に並べる
const JP_CODES = [
  "7203","6758","8306","9984","6861","7974","8035","9432","4063","6367",
  "9433","7267","6501","4519","3382","9020","8411","6098","4661","8316",
  "6594","4568","7751","6702","8058","8031","7011","5108","4452","6857",
  "9022","2914","4901","6902","7733","6645","8766","9101","4503","6971",
  "7201","8802","3289","9613","4578","6954","2802","4151","6869","8309"
];

const JP_NAMES = {
  "7203":"トヨタ自動車","6758":"ソニーグループ","8306":"三菱UFJ",
  "9984":"ソフトバンクG","6861":"キーエンス","7974":"任天堂",
  "8035":"東京エレクトロン","9432":"NTT","4063":"信越化学","6367":"ダイキン工業",
  "9433":"KDDI","7267":"ホンダ","6501":"日立製作所","4519":"中外製薬",
  "3382":"セブン&アイ","9020":"JR東日本","8411":"みずほFG","6098":"リクルートHD",
  "4661":"オリエンタルランド","8316":"三井住友FG","6594":"日本電産","4568":"第一三共",
  "7751":"キヤノン","6702":"富士通","8058":"三菱商事","8031":"三井物産",
  "7011":"三菱重工","5108":"ブリヂストン","4452":"花王","6857":"アドバンテスト",
  "9022":"JR東海","2914":"JT","4901":"富士フイルム","6902":"デンソー",
  "7733":"オリンパス","6645":"オムロン","8766":"東京海上HD","9101":"日本郵船",
  "4503":"アステラス製薬","6971":"京セラ","9022":"JR東海","2914":"JT",
  "7201":"日産自動車","8802":"三菱地所","3289":"東急不動産","9613":"NTTデータ",
  "4578":"大塚HD","6954":"ファナック","2802":"味の素","4151":"協和キリン",
  "6869":"シスメックス","8309":"三井住友トラスト"
};

async function getJPRanking() {
  const apiKey = process.env.JQUANTS_API_KEY;
  if (!apiKey) throw new Error("JQUANTS_API_KEY not set");

  const dateStr = getLatestTradingDay(new Date());

  // 並列で複数銘柄を取得（5銘柄ずつバッチ処理）
  const results = [];
  const BATCH = 5;

  for (let i = 0; i < JP_CODES.slice(0, 30).length; i += BATCH) {
    const batch = JP_CODES.slice(i, i + BATCH);
    const batchResults = await Promise.all(batch.map(async (code) => {
      try {
        const url = `https://api.jquants.com/v2/equities/bars/daily?code=${code}&date=${dateStr}`;
        const res = await fetch(url, {
          headers: { "x-api-key": apiKey },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return null;
        const json = await res.json();
        const bars = json?.daily_bars || json?.bars || json?.data || [];
        if (!bars.length) return null;
        const bar = bars[0];
        const close = bar.C || bar.Close || 0;
        const open = bar.O || bar.Open || 0;
        const vol = bar.Vo || bar.Volume || 0;
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
      } catch(e) {
        return null;
      }
    }));
    results.push(...batchResults.filter(Boolean));
  }

  // 出来高順にソート
  return results.sort((a, b) => b.volume - a.volume);
}

function getLatestTradingDay(date) {
  const d = new Date(date);
  const jstHour = (d.getUTCHours() + 9) % 24;
  if (jstHour < 16) d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
