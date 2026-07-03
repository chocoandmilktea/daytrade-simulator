// api/ranking.js
// ハイブリッド方式：出来高上位50 + 値上がり率上位20（出来高フィルター付き）
// US: Yahoo Finance / JP: J-Quants

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { market } = req.query;

  try {
    if (market === "jp") {
      const data = await getJPRanking(req);
      return res.status(200).json({ market: "jp", stocks: data });
    } else {
      const data = await getUSRanking();
      return res.status(200).json({ market: "us", stocks: data });
    }
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// ── 共通ユーティリティ ────────────────────────────────────────────────────────

// 出来高フィルター：過去平均の1.5倍以上かどうか（平均が取れない場合はtrue）
function isVolumeAboveAvg(vol, avgVol) {
  if (!avgVol || avgVol <= 0) return true;
  return vol >= avgVol * 1.5;
}

// 重複除去マージ（出来高上位 + 値上がり率上位）
function mergeHybrid(byVolume, byChange) {
  const seen = {};
  const out = [];
  byVolume.forEach(function(s) {
    if (!seen[s.ticker]) { seen[s.ticker] = true; out.push(s); }
  });
  byChange.forEach(function(s) {
    if (!seen[s.ticker]) { seen[s.ticker] = true; out.push(s); }
  });
  return out;
}

// ── 米国株 ───────────────────────────────────────────────────────────────────

async function fetchYahooScreener(scrId, count) {
  const url = new URL("https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved");
  url.searchParams.set("formatted", "false");
  url.searchParams.set("lang", "en-US");
  url.searchParams.set("region", "US");
  url.searchParams.set("scrIds", scrId);
  url.searchParams.set("count", String(count));
  url.searchParams.set("start", "0");

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "application/json",
    },
  });
  if (!res.ok) throw new Error("Yahoo Finance screener(" + scrId + "): " + res.status);
  const json = await res.json();
  return json?.finance?.result?.[0]?.quotes || [];
}

function mapUSQuote(q) {
  return {
    ticker: q.symbol,
    name: q.shortName || q.longName || q.symbol,
    market: "US",
    tvSymbol: (q.exchange === "NYQ" ? "NYSE:" : "NASDAQ:") + q.symbol,
    volume: q.regularMarketVolume || 0,
    avgVolume: q.averageDailyVolume3Month || 0,
    price: q.regularMarketPrice || 0,
    change: q.regularMarketChangePercent || 0,
  };
}

async function getUSRanking() {
  // 出来高上位50 と 値上がり率上位50 を並列取得
  const [actives, gainers] = await Promise.all([
    fetchYahooScreener("most_actives", 50),
    fetchYahooScreener("day_gainers", 50),
  ]);

  const byVolume = actives.map(mapUSQuote);

  // 値上がり率上位から出来高フィルターを通して上位20件
  const byChange = gainers
    .map(mapUSQuote)
    .filter(function(s) { return isVolumeAboveAvg(s.volume, s.avgVolume); })
    .slice(0, 20);

  return mergeHybrid(byVolume, byChange);
}

// ── 日本株 ───────────────────────────────────────────────────────────────────

const JP_NAMES_FALLBACK = {
  "7203":"トヨタ自動車","6758":"ソニーグループ","8306":"三菱UFJ",
  "9984":"ソフトバンクG","6861":"キーエンス","7974":"任天堂",
  "8035":"東京エレクトロン","9432":"NTT","4063":"信越化学","6367":"ダイキン工業",
  "9433":"KDDI","7267":"ホンダ","6501":"日立製作所","4519":"中外製薬",
  "3382":"セブン&アイ","8411":"みずほFG","6098":"リクルートHD",
  "4661":"オリエンタルランド","8316":"三井住友FG","6594":"日本電産",
  "4568":"第一三共","7751":"キヤノン","6702":"富士通","8058":"三菱商事",
  "8031":"三井物産","7011":"三菱重工","5108":"ブリヂストン","4452":"花王",
  "6857":"アドバンテスト","9101":"日本郵船",
};

async function fetchNameMap(req) {
  try {
    const host = req.headers.host || "daytrade-simulator.vercel.app";
    const protocol = host.includes("localhost") ? "http" : "https";
    const r = await fetch(`${protocol}://${host}/api/ipo`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error("ipo api: " + r.status);
    const json = await r.json();
    return json?.names || {};
  } catch (e) {
    return {};
  }
}

// J-Quants /v2/equities/master：指定日時点の全上場銘柄マスタ（会社名を含む）を取得
// dateStr8: "YYYYMMDD"形式（ハイフン無し）
async function fetchJQuantsNameMap(apiKey, dateStr8) {
  try {
    const url = `https://api.jquants.com/v2/equities/master?date=${dateStr8}`;
    const res = await fetch(url, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) throw new Error("master api: " + res.status);
    const json = await res.json();
    const rows = json?.data || json || [];
    const map = {};
    rows.forEach(function(row) {
      const code = String(row.Code || "").replace(/0$/, "");
      if (code && row.CoName) map[code] = row.CoName;
    });
    return map;
  } catch (e) {
    return {};
  }
}

function getTargetBusinessDay() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const hhmm = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  const MARKET_CLOSE = 15 * 60 + 30;

  let d = new Date(jst);
  if (hhmm < MARKET_CLOSE || d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() - 1);
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
      d.setUTCDate(d.getUTCDate() - 1);
    }
  }
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// J-Quants bars/daily には前日終値(PC)フィールドが存在しないため、
// 変化率は当日始値(O)比で計算する（API仕様上これが最善）
function calcChangeRate(bar) {
  const open = bar.O || 0;
  const close = bar.C || 0;
  return open > 0 ? (close - open) / open : 0;
}

// 会社名の優先順位：IPO専用API > J-Quants銘柄マスタ > ハードコード一覧 > コードそのまま
function mapJPBar(bar, names, jqNames) {
  const code = String(bar.Code || "").replace(/0$/, "");
  const name = names[code] || jqNames[code] || JP_NAMES_FALLBACK[code] || code;
  return {
    ticker: code + ".T",
    name: name,
    market: "JP",
    tvSymbol: "TSE:" + code,
    volume: bar.Vo || 0,
    avgVolume: bar.AvgVo || 0,
    price: bar.C || 0,
    change: parseFloat((calcChangeRate(bar) * 100).toFixed(2)),
  };
}

async function getJPRanking(req) {
  const apiKey = process.env.JQUANTS_API_KEY;
  if (!apiKey) throw new Error("JQUANTS_API_KEY not set");

  const dateStr = getTargetBusinessDay();

  const [nameMap, jqNameMap, barsResult] = await Promise.allSettled([
    fetchNameMap(req),
    fetchJQuantsNameMap(apiKey, dateStr.replace(/-/g, "")),
    (async () => {
      const url = `https://api.jquants.com/v2/equities/bars/daily?date=${dateStr}`;
      const res = await fetch(url, {
        headers: { "x-api-key": apiKey },
        signal: AbortSignal.timeout(9000),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error("J-Quants error: " + res.status + " " + errText);
      }
      return res.json();
    })(),
  ]);

  const names = nameMap.status === "fulfilled" ? nameMap.value : {};
  const jqNames = jqNameMap.status === "fulfilled" ? jqNameMap.value : {};
  if (barsResult.status === "rejected") throw barsResult.reason;
  const bars = (barsResult.value?.data || []).filter(function(bar) {
    return (bar.Vo || 0) > 0 && (bar.C || 0) > 0;
  });

  if (!bars.length) throw new Error("No JP bar data");

  // 出来高上位50
  const byVolume = bars
    .slice()
    .sort(function(a, b) { return (b.Vo || 0) - (a.Vo || 0); })
    .slice(0, 50)
    .map(function(bar) { return mapJPBar(bar, names, jqNames); });

  // 値上がり率上位：出来高フィルター通過後20件
  // avgVolumeが取れない場合は当日全銘柄の中央値で代替
  const allVols = bars.map(function(b) { return b.Vo || 0; }).sort(function(a, b) { return a - b; });
  const medianVol = allVols[Math.floor(allVols.length / 2)] || 0;

  const byChange = bars
    .slice()
    .sort(function(a, b) { return calcChangeRate(b) - calcChangeRate(a); })
    .filter(function(bar) {
      const avg = bar.AvgVo || medianVol;
      return isVolumeAboveAvg(bar.Vo || 0, avg);
    })
    .slice(0, 20)
    .map(function(bar) { return mapJPBar(bar, names, jqNames); });

  return mergeHybrid(byVolume, byChange);
}
