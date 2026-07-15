import { getTargetBusinessDay, calcChangeRate } from "./ranking.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: "ticker is required" });

  if (ticker.endsWith(".T")) return handleJP(ticker, res);
  return handleUS(ticker, res);
}

// ── JP: J-Quants 1分足（20営業日 / バッファ込み30日）────────────────────
async function handleJP(ticker, res) {
  try {
    const apiKey = process.env.JQUANTS_API_KEY;
    if (!apiKey) throw new Error("JQUANTS_API_KEY not set");

    const code = ticker.replace(".T", "") + "0";

    const today = getJSTDate(0);
    const from  = getJSTDate(30); // 土日祝込みで約20営業日カバー

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

    allBars.sort(function(a, b) {
      const ka = a.Date + a.Time;
      const kb = b.Date + b.Time;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

    const closes  = allBars.map(function(b) { return b.C  || 0; });
    const highs   = allBars.map(function(b) { return b.H  || 0; });
    const lows    = allBars.map(function(b) { return b.L  || 0; });
    const volumes = allBars.map(function(b) { return b.Vo || 0; });

    let currentPrice = closes[closes.length - 1];

    const todayDate = allBars[allBars.length - 1]?.Date;
    let previousClose = currentPrice;
    for (let i = allBars.length - 1; i >= 0; i--) {
      if (allBars[i].Date !== todayDate) {
        previousClose = allBars[i].C || currentPrice;
        break;
      }
    }

    // Yahoo Financeで現在値のみ上書き（15〜20分遅延、失敗時はJ-Quants値のまま）
    try {
      const yRes = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`,
        { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }, signal: AbortSignal.timeout(5000) }
      );
      if (yRes.ok) {
        const yMeta = (await yRes.json())?.chart?.result?.[0]?.meta;
        if (yMeta?.regularMarketPrice) {
          currentPrice = yMeta.regularMarketPrice;
          previousClose = yMeta.chartPreviousClose || yMeta.previousClose || previousClose;
        }
      }
    } catch (e) {}

    // 決算発表予定日（翌営業日カレンダーをキャッシュして照合。対象外ならnull）
    let earningsDate = null;
    try {
      const emap = await fetchJPEarningsMap(apiKey);
      earningsDate = emap[code] || null;
    } catch (e) {}

    // 対TOPIX相対強弱用：直近のTOPIX騰落率（全銘柄共通の値なので1時間キャッシュ）
    let topixChange = null;
    try {
      topixChange = await fetchTopixChange(apiKey);
    } catch (e) {}

    // 対業種相対強弱用：この銘柄が属する業種の平均騰落率（全銘柄集計を1時間キャッシュ）
    let sectorChange = null, sectorName = null;
    try {
      const codeShort = ticker.replace(".T", "");
      const sectorData = await fetchSectorAverages(apiKey);
      sectorName = sectorData.sectorOfCode[codeShort] || null;
      sectorChange = sectorName != null ? (sectorData.avgBySector[sectorName] ?? null) : null;
    } catch (e) {}

    // PER/PBR（財務情報のBPS・予想EPSから算出。24時間キャッシュ）
    // 権利落ち日（配当ありの銘柄のみ、次期末日の1営業日前を「予想」として概算）
    let per = null, pbr = null, exRightsDate = null;
    try {
      const fin = await fetchJPFinancials(apiKey, code);
      if (fin.bps > 0) pbr = currentPrice / fin.bps;
      if (fin.feps > 0) per = currentPrice / fin.feps;
      if (fin.hasDividend && fin.fyEnd) exRightsDate = subtractBusinessDays(fin.fyEnd, 1);
    } catch (e) {}
    if (pbr && (!isFinite(pbr) || pbr <= 0 || pbr > 1000)) pbr = null;
    if (per && (!isFinite(per) || per <= 0 || per > 10000)) per = null;

    return res.status(200).json({
      chart: {
        result: [{
          meta: {
            regularMarketPrice: currentPrice,
            chartPreviousClose: previousClose,
            dataInterval: "1m",
            dataRange: "20d",
          },
          indicators: {
            quote: [{ close: closes, high: highs, low: lows, volume: volumes }],
          },
          per: per, pbr: pbr, analystTarget: null, sector: null,
          earningsDate: earningsDate,
          exRightsDate: exRightsDate,
          topixChange: topixChange,
          sectorChange: sectorChange,
          sectorName: sectorName,
        }],
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// ── 権利落ち日の概算：基準日のn営業日前（土日のみ考慮、祝日は非考慮の概算値）──
function subtractBusinessDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  let remaining = n;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() - 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) remaining--;
  }
  return d.toISOString().slice(0, 10);
}

// ── PER/PBR算出用の財務データ（BPS・予想EPS・次期末日・配当有無）。24時間キャッシュ ──
// J-Quants /v2/fins/summary は開示履歴を古い順に全件返す仕様のため、
// 末尾から遡って直近の有効な値を採用する
var finCache = {}; // { code: {ts, bps, feps, fyEnd, hasDividend} }
var FIN_TTL = 24 * 60 * 60 * 1000; // 24時間

async function fetchJPFinancials(apiKey, code) {
  const now = Date.now();
  if (finCache[code] && now - finCache[code].ts < FIN_TTL) return finCache[code];

  const res = await fetch("https://api.jquants.com/v2/fins/summary?code=" + code, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error("fins/summary " + res.status);
  const json = await res.json();
  const rows = json.data || [];

  let bps = null, feps = null, fyEnd = null, hasDividend = false;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (bps == null && row.BPS !== "" && row.BPS != null) bps = parseFloat(row.BPS);
    if (feps == null && row.FEPS !== "" && row.FEPS != null) feps = parseFloat(row.FEPS);
    if (fyEnd == null) {
      const fy = row.NxtFYEn || row.CurFYEn;
      if (fy) fyEnd = fy;
    }
    if (!hasDividend) {
      if ((row.FDivFY && row.FDivFY !== "") || (row.DivFY && row.DivFY !== "") ||
          (row.FDivAnn && row.FDivAnn !== "") || (row.DivAnn && row.DivAnn !== "")) hasDividend = true;
    }
    if (bps != null && feps != null && fyEnd != null && hasDividend) break;
  }

  const result = { ts: now, bps: bps, feps: feps, fyEnd: fyEnd, hasDividend: hasDividend };
  finCache[code] = result;
  return result;
}

// ── 決算発表予定（翌営業日）キャッシュ ──────────────────────────────────
// J-Quants /v2/equities/earnings-calendar は日付単位でその日の全社リストを返す仕様
// （codeで絞り込めないため、1回取得してコード→日付のマップにしてから照合する）
var earningsCache = { map: null, ts: 0 };
var EARNINGS_TTL = 60 * 60 * 1000; // 1時間

async function fetchJPEarningsMap(apiKey) {
  const now = Date.now();
  if (earningsCache.map && now - earningsCache.ts < EARNINGS_TTL) return earningsCache.map;

  const res = await fetch("https://api.jquants.com/v2/equities/earnings-calendar", {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error("earnings-calendar " + res.status);
  const json = await res.json();
  const rows = json.data || [];
  const map = {};
  rows.forEach(function(row) { if (row.Code) map[row.Code] = row.Date; });

  earningsCache = { map: map, ts: now };
  return map;
}

// ── 対TOPIX相対強弱：直近のTOPIX騰落率（全銘柄で共通の値のため1時間キャッシュ）──
// J-Quants /v2/indices/bars/daily/topix は日次更新（O/H/L/Cの四本値）のため、
// 直近10日分を取得して末尾2本（最新・その前日）から前日比%を算出する
var topixCache = { change: null, ts: 0 };
var TOPIX_TTL = 60 * 60 * 1000; // 1時間

async function fetchTopixChange(apiKey) {
  const now = Date.now();
  if (topixCache.change !== null && now - topixCache.ts < TOPIX_TTL) return topixCache.change;

  const to = getJSTDate(0);
  const from = getJSTDate(10); // 休場日を挟んでも確実に2本以上取れる余裕を持たせる

  const res = await fetch(`https://api.jquants.com/v2/indices/bars/daily/topix?from=${from}&to=${to}`, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error("topix " + res.status);
  const json = await res.json();
  const rows = (json.data || []).slice().sort(function(a, b) {
    return a.Date < b.Date ? -1 : a.Date > b.Date ? 1 : 0;
  });
  if (rows.length < 2) throw new Error("insufficient topix data");

  const last = rows[rows.length - 1], prev = rows[rows.length - 2];
  const change = (last.C - prev.C) / prev.C * 100;

  topixCache = { change: change, ts: now };
  return change;
}

// ── 対業種相対強弱：業種別の平均騰落率（全銘柄を1回だけ集計し1時間キャッシュ）──
// 銘柄1件ごとに毎回全銘柄集計をやり直すと重いため、初回アクセス時にまとめて
// 計算し、以後は同じ結果を使い回す（topixCacheと同じ考え方）。
// 対象日は ranking.js と同じ基準（getTargetBusinessDay）で揃える。
var sectorAvgCache = { ts: 0, avgBySector: null, sectorOfCode: null };
var SECTOR_AVG_TTL = 60 * 60 * 1000; // 1時間

async function fetchSectorAverages(apiKey) {
  const now = Date.now();
  if (sectorAvgCache.avgBySector && now - sectorAvgCache.ts < SECTOR_AVG_TTL) {
    return sectorAvgCache;
  }

  const dateStr = getTargetBusinessDay();
  const dateStr8 = dateStr.replace(/-/g, "");

  const [masterRes, barsRes] = await Promise.all([
    fetch(`https://api.jquants.com/v2/equities/master?date=${dateStr8}`, {
      headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(9000),
    }),
    fetch(`https://api.jquants.com/v2/equities/bars/daily?date=${dateStr}`, {
      headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(9000),
    }),
  ]);
  if (!masterRes.ok) throw new Error("master api: " + masterRes.status);
  if (!barsRes.ok) throw new Error("bars api: " + barsRes.status);

  const masterJson = await masterRes.json();
  const sectorOfCode = {};
  (masterJson.data || masterJson || []).forEach(function(row) {
    const code = String(row.Code || "").replace(/0$/, "");
    if (code && row.S33Nm) sectorOfCode[code] = row.S33Nm;
  });

  const barsJson = await barsRes.json();
  const sums = {}, counts = {};
  (barsJson.data || []).forEach(function(bar) {
    if (!((bar.Vo || 0) > 0 && (bar.C || 0) > 0)) return;
    const code = String(bar.Code || "").replace(/0$/, "");
    const sector = sectorOfCode[code];
    if (!sector) return;
    const chg = calcChangeRate(bar) * 100;
    sums[sector] = (sums[sector] || 0) + chg;
    counts[sector] = (counts[sector] || 0) + 1;
  });

  const avgBySector = {};
  Object.keys(sums).forEach(function(sector) {
    avgBySector[sector] = sums[sector] / counts[sector];
  });

  sectorAvgCache = { ts: now, avgBySector: avgBySector, sectorOfCode: sectorOfCode };
  return sectorAvgCache;
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

// ── US: Yahoo Finance 5分足 / 30日固定 ──────────────────────────────────
async function handleUS(ticker, res) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=5m&range=30d`;

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
      // 前日終値はYahoo公式のmeta値を最優先（正確な前営業日の終値）。
      // 5分足配列からの推定値（末尾から2番目のバー＝数分前の価格）は
      // meta値が取得できない場合の最終手段としてのみ使う。
      const previousClose =
        meta.chartPreviousClose || meta.regularMarketPreviousClose
        || (validCloses.length >= 2 ? validCloses[validCloses.length - 2] : null)
        || 0;
      result.meta.chartPreviousClose = previousClose;
      result.meta.dataInterval = "5m";
      result.meta.dataRange = "30d";
    }

    let per = null, pbr = null, analystTarget = null, sector = null, earningsDate = null;
    const chartMeta = data?.chart?.result?.[0]?.meta || {};
    if (chartMeta.trailingPE) per = chartMeta.trailingPE;
    if (chartMeta.priceToBook) pbr = chartMeta.priceToBook;

    if (!per || !pbr || !analystTarget || !sector || !earningsDate) {
      try {
        const summaryUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=defaultKeyStatistics,summaryDetail,financialData,assetProfile,calendarEvents`;
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

          // 決算発表予定日（epoch秒 → YYYY-MM-DD）。複数候補があれば先頭日を採用
          const earnRaw = detail?.calendarEvents?.earnings?.earningsDate;
          if (Array.isArray(earnRaw) && earnRaw.length > 0 && earnRaw[0]?.raw) {
            earningsDate = new Date(earnRaw[0].raw * 1000).toISOString().slice(0, 10);
          }
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
      data.chart.result[0].earningsDate = earningsDate;
    }

    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
