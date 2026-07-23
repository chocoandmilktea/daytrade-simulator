import XLSX from "xlsx";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

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

// ── 1分足を指定分数の足に集計（O=区間内最初/H=区間内最大/L=区間内最小/C=区間内最後/Vo=区間内合計）──
// 時刻を15分境界（00/15/30/45）で区切ってグルーピングするため、取引時間の途中で
// データが欠けても境界がズレない。barsはDate+Time昇順ソート済みが前提。
function aggregateBars(bars, intervalMinutes) {
  const order = [];
  const map = {};
  bars.forEach(function (b) {
    const digits = String(b.Time || "").replace(/\D/g, "");
    const hh = parseInt(digits.slice(0, 2), 10) || 0;
    const mm = parseInt(digits.slice(2, 4), 10) || 0;
    const totalMin = hh * 60 + mm;
    const bucketStart = Math.floor(totalMin / intervalMinutes) * intervalMinutes;
    const key = b.Date + "_" + bucketStart;
    if (!map[key]) {
      map[key] = { Date: b.Date, O: b.C || 0, H: b.H || 0, L: b.L || 0, C: b.C || 0, Vo: 0 };
      order.push(key);
    }
    const g = map[key];
    if ((b.H || 0) > g.H) g.H = b.H;
    if ((b.L || 0) < g.L || g.L === 0) g.L = b.L;
    g.C = b.C || g.C; // 昇順ソート済みなので最後に処理した値が区間の終値になる
    g.Vo += b.Vo || 0;
  });
  return order.map(function (k) { return map[k]; });
}

// ── JP: Yahoo Finance 15分足 / 30日（USと同じ取得方法に統一）─────────────
async function handleJP(ticker, res) {
  try {
    const code4 = ticker.replace(".T", "");
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=15m&range=30d`;

    // Yahoo Finance（分足）・決算発表予定日・TOPIX・PER/PBR等は互いに依存関係が無いため並列取得する
    // （以前は上から順番に待っていたため、その分だけ余計に時間がかかっていた）
    const [yahooResult, earningsResult, topixResult, detailResult] = await Promise.allSettled([
      fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(9000),
      }).then(function(r) {
        if (!r.ok) throw new Error(`Yahoo Finance returned ${r.status}`);
        return r.json();
      }),
      fetchJPEarningsMap(),
      fetchTopixChange(),
      fetchTachibanaIssueDetail(code4),
    ]);

    if (yahooResult.status === "rejected") throw yahooResult.reason;
    const data = yahooResult.value;

    const result = data?.chart?.result?.[0];
    if (!result) throw new Error("no JP minute data");

    const closes  = result.indicators?.quote?.[0]?.close  || [];
    const highs   = result.indicators?.quote?.[0]?.high   || [];
    const lows    = result.indicators?.quote?.[0]?.low    || [];
    const volumes = result.indicators?.quote?.[0]?.volume || [];
    const meta = result.meta || {};

    const currentPrice = meta.regularMarketPrice || 0;
    const previousClose = meta.chartPreviousClose || meta.regularMarketPreviousClose || 0;

    // 決算発表予定日（東証公式Excelをキャッシュして照合。対象外ならnull）
    let earningsDate = null;
    if (earningsResult.status === "fulfilled") {
      earningsDate = earningsResult.value[code4] || null;
    } else {
      console.log("[jpx-earnings] 取得エラー:", earningsResult.reason?.message);
    }

    // 対TOPIX相対強弱用：直近のTOPIX騰落率（全銘柄共通の値なので1時間キャッシュ）
    const topixChange = topixResult.status === "fulfilled" ? topixResult.value : null;

    // PER/PBR/EPS/BPS/配当利回り（立花証券API経由。取得・1時間キャッシュはtachibana-server側）
    // 権利落ち日も立花証券の実績値をそのまま使用（従来は決算期末日からの概算値だった）
    let per = null, pbr = null, eps = null, bps = null, dividendYield = null, exRightsDate = null;
    if (detailResult.status === "fulfilled") {
      const detail = detailResult.value;
      per = detail.per;
      pbr = detail.pbr;
      eps = detail.eps;
      bps = detail.bps;
      dividendYield = detail.dividendYield;
      exRightsDate = detail.exRightsDate;
    }
    if (pbr && (!isFinite(pbr) || pbr <= 0 || pbr > 1000)) pbr = null;
    if (per && (!isFinite(per) || per <= 0 || per > 10000)) per = null;

    return res.status(200).json({
      chart: {
        result: [{
          meta: {
            regularMarketPrice: currentPrice,
            chartPreviousClose: previousClose,
            dataInterval: "15m",
            dataRange: "30d",
          },
          indicators: {
            quote: [{ close: closes, high: highs, low: lows, volume: volumes }],
          },
          per: per, pbr: pbr, eps: eps, bps: bps, dividendYield: dividendYield,
          analystTarget: null, sector: null,
          earningsDate: earningsDate,
          exRightsDate: exRightsDate,
          topixChange: topixChange,
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

// ── 決算発表予定日キャッシュ ──────────────────────────────────────────
// 東証公式「決算発表予定日」ページ(無料・毎営業日17時頃更新)のExcelを直接解析する。
// https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html
// ページ内に決算期末の月ごとの.xlsxリンクが複数掲載されているので、全部拾って合算する。
// J-Quantsと違い認証キー不要（誰でも取得できる公開データ）。
//
// 【要npmパッケージ】xlsx (SheetJS) を package.json の dependencies に追加してください。
//   npm install xlsx
//
// 【注意】Excelの列見出しは東証側の仕様変更で変わる可能性があるため、
// 列名に含まれるキーワードで探す作りにしてある。もし emap が空になる場合は、
// COLUMN_KEYWORDS を実際のExcelの見出しに合わせて調整してください
// （Vercelのログに [jpx-earnings] 検出列 という行が出るので、そこで見出し名を確認できます）。
var earningsCache = { map: null, ts: 0 };
var EARNINGS_TTL = 6 * 60 * 60 * 1000; // メモリキャッシュ6時間（同一コンテナ内の高速化用）
var EARNINGS_REDIS_KEY = "jpx:earnings-map";
var EARNINGS_REDIS_TTL = 24 * 60 * 60; // Redisキャッシュ24時間（秒）。東証の更新頻度(1日1回)に合わせる

var JPX_PAGE_URL = "https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html";
var CODE_KEYWORDS = ["コード"];
var DATE_KEYWORDS = ["決算発表予定日", "発表予定日", "予定日"];

// ページHTMLから .xlsx へのリンクをすべて抜き出す（正規表現。軽量化のためHTMLパーサーは使わない）
function extractXlsxLinks(html) {
  var links = [];
  var re = /href="([^"]+\.xlsx)"/g;
  var m;
  while ((m = re.exec(html)) !== null) {
    var url = m[1];
    if (url.indexOf("http") !== 0) {
      // 相対URLの場合はJPXのドメインを補う
      url = "https://www.jpx.co.jp" + (url.indexOf("/") === 0 ? "" : "/") + url;
    }
    links.push(url);
  }
  return links;
}

// 1つのExcelファイルから {code: "YYYY-MM-DD"} のマップを作る
function parseXlsxToMap(buf) {
  var wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  var map = {};
  wb.SheetNames.forEach(function (sheetName) {
    var sheet = wb.Sheets[sheetName];
    var rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
    if (rows.length === 0) return;

    // ヘッダー行を探す（コード列・予定日列の両方のキーワードが含まれる行）
    var headerRowIdx = -1, codeColIdx = -1, dateColIdx = -1;
    for (var r = 0; r < Math.min(rows.length, 10); r++) {
      var row = rows[r];
      var cIdx = row.findIndex(function (cell) {
        return CODE_KEYWORDS.some(function (kw) { return String(cell).indexOf(kw) !== -1; });
      });
      var dIdx = row.findIndex(function (cell) {
        return DATE_KEYWORDS.some(function (kw) { return String(cell).indexOf(kw) !== -1; });
      });
      if (cIdx !== -1 && dIdx !== -1) {
        headerRowIdx = r; codeColIdx = cIdx; dateColIdx = dIdx;
        break;
      }
    }
    if (headerRowIdx === -1) {
      console.log("[jpx-earnings] シート「" + sheetName + "」でヘッダー行が見つかりませんでした。先頭行:", rows[0]);
      return;
    }
    console.log("[jpx-earnings] 検出列: シート=" + sheetName + " コード列=" + codeColIdx + " 予定日列=" + dateColIdx + " (ヘッダー行:" + JSON.stringify(rows[headerRowIdx]) + ")");

    for (var i = headerRowIdx + 1; i < rows.length; i++) {
      var dataRow = rows[i];
      var codeRaw = String(dataRow[codeColIdx] || "").trim();
      var dateRaw = dataRow[dateColIdx];
      if (!codeRaw || !dateRaw) continue;

      // コードは4桁数字部分だけ抜き出す（末尾0付きの5桁で来る場合に対応）
      var codeMatch = codeRaw.match(/\d{4}/);
      if (!codeMatch) continue;
      var code = codeMatch[0];

      var dateStr = normalizeDate(dateRaw);
      if (!dateStr) continue;

      map[code] = dateStr;
    }
  });
  return map;
}

// セル値（Dateオブジェクト or "2026/7/25" 等の文字列）を "YYYY-MM-DD" に正規化
function normalizeDate(v) {
  if (v instanceof Date) {
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return v.getFullYear() + "-" + pad(v.getMonth() + 1) + "-" + pad(v.getDate());
  }
  var s = String(v).trim();
  // 「2026年8月5日」のような日本語表記に対応
  var jp = s.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (jp) s = jp[1] + "-" + jp[2] + "-" + jp[3];
  else s = s.replace(/\//g, "-");
  var d = new Date(s);
  if (isNaN(d.getTime())) return null;
  var pad2 = function (n) { return String(n).padStart(2, "0"); };
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

async function fetchJPEarningsMap() {
  const now = Date.now();
  if (earningsCache.map && now - earningsCache.ts < EARNINGS_TTL) {
    console.log("[jpx-earnings] メモリキャッシュ使用。件数:", Object.keys(earningsCache.map).length, " 7203:", earningsCache.map["7203"] || "(該当なし)");
    return earningsCache.map;
  }

  // Redisに保存済みならそれを使う（コンテナが変わっても共有されるため、東証への
  // 重いアクセス（xlsxダウンロード・解析）を毎リクエストやり直さずに済む）
  try {
    const cached = await redis.get(EARNINGS_REDIS_KEY);
    if (cached) {
      const map = typeof cached === "string" ? JSON.parse(cached) : cached;
      console.log("[jpx-earnings] Redisキャッシュ使用。件数:", Object.keys(map).length, " 7203:", map["7203"] || "(該当なし)");
      earningsCache = { map: map, ts: now };
      return map;
    }
  } catch (e) {
    console.log("[jpx-earnings] Redis読み込み失敗（東証から直接取得します）:", e.message);
  }

  const pageRes = await fetch(JPX_PAGE_URL, { signal: AbortSignal.timeout(8000) });
  if (!pageRes.ok) throw new Error("jpx page " + pageRes.status);
  const html = await pageRes.text();
  const xlsxUrls = extractXlsxLinks(html);
  if (xlsxUrls.length === 0) throw new Error("jpx page: xlsxリンクが見つかりませんでした");

  var map = {};
  var failCount = 0;
  for (var i = 0; i < xlsxUrls.length; i++) {
    try {
      const fileRes = await fetch(xlsxUrls[i], { signal: AbortSignal.timeout(10000) });
      if (!fileRes.ok) { console.log("[jpx-earnings] ダウンロード失敗:", xlsxUrls[i], fileRes.status); failCount++; continue; }
      const buf = Buffer.from(await fileRes.arrayBuffer());
      const partial = parseXlsxToMap(buf);
      Object.assign(map, partial);
    } catch (e) {
      console.log("[jpx-earnings] 解析失敗:", xlsxUrls[i], e.message);
      failCount++;
    }
  }

  const mapSize = Object.keys(map).length;
  if (mapSize === 0) throw new Error("jpx-earnings: 全ファイルの解析に失敗しました");
  var sample = Object.entries(map).slice(0, 5);
  console.log("[jpx-earnings] 東証から新規取得。合計件数:", mapSize, "/対象ファイル数:", xlsxUrls.length, "/失敗:", failCount, " サンプル:", JSON.stringify(sample));
  console.log("[jpx-earnings] 7203の照合結果:", map["7203"] || "(該当なし)");

  if (failCount > 0) {
    // 一部ファイルの取得に失敗している＝不完全なデータの可能性が高いため、
    // 他のコンテナや以後24時間分を巻き添えにしないよう、今回はキャッシュに保存しない
    // （このリクエストの応答にはそのまま使うが、次回また取得し直しになる）
    console.log("[jpx-earnings] 一部ファイル取得に失敗したため、キャッシュ保存はスキップします");
    return map;
  }

  try {
    await redis.set(EARNINGS_REDIS_KEY, JSON.stringify(map), { ex: EARNINGS_REDIS_TTL });
  } catch (e) {
    console.log("[jpx-earnings] Redis書き込み失敗:", e.message);
  }

  earningsCache = { map: map, ts: now };
  return map;
}

// ── 対TOPIX相対強弱：直近のTOPIX騰落率 ──────────────────────────────────
// 立花証券API経由（tachibana-serverの/topixエンドポイントを呼ぶだけ）。
// 実際のTOPIX取得・1時間キャッシュはtachibana-server側（webapi.js）で行っている。
var topixCache = { change: null, ts: 0 };
var TOPIX_TTL = 60 * 60 * 1000; // 1時間（tachibana-server側キャッシュに加え、こちらでも軽くキャッシュ）

async function fetchTopixChange() {
  const now = Date.now();
  if (topixCache.change !== null && now - topixCache.ts < TOPIX_TTL) return topixCache.change;

  const apiUrl = process.env.TACHIBANA_TOPIX_API;
  if (!apiUrl) throw new Error("TACHIBANA_TOPIX_API not set");

  const headers = {};
  if (process.env.TACHIBANA_RELAY_SECRET) headers["X-Relay-Secret"] = process.env.TACHIBANA_RELAY_SECRET;

  const res = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error("topix " + res.status);
  const json = await res.json();
  if (json.change == null) throw new Error("topix: change値がありません");

  topixCache = { change: json.change, ts: now };
  return json.change;
}

// ── PER/PBR/EPS/BPS/配当利回り ────────────────────────────────────────
// 立花証券API経由（tachibana-serverの/issue-detailエンドポイントを呼ぶだけ）。
// 実際の取得・1時間キャッシュはtachibana-server側（webapi.js）で行っている。
var issueDetailCache = {}; // code4 -> { data, ts }
var ISSUE_DETAIL_TTL = 60 * 60 * 1000; // 1時間

async function fetchTachibanaIssueDetail(code4) {
  const now = Date.now();
  const cached = issueDetailCache[code4];
  if (cached && now - cached.ts < ISSUE_DETAIL_TTL) return cached.data;

  const apiUrl = process.env.TACHIBANA_ISSUE_DETAIL_API;
  if (!apiUrl) throw new Error("TACHIBANA_ISSUE_DETAIL_API not set");

  const headers = {};
  if (process.env.TACHIBANA_RELAY_SECRET) headers["X-Relay-Secret"] = process.env.TACHIBANA_RELAY_SECRET;

  const res = await fetch(`${apiUrl}?code=${code4}`, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error("issue-detail " + res.status);
  const data = await res.json();

  issueDetailCache[code4] = { data: data, ts: now };
  return data;
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

// ── US: Yahoo Finance 15分足 / 30日（JPの取得期間・バー本数と揃える）────────
async function handleUS(ticker, res) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=15m&range=30d`;

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
      // 15分足配列からの推定値（末尾から2番目のバー＝数分前の価格）は
      // meta値が取得できない場合の最終手段としてのみ使う。
      const previousClose =
        meta.chartPreviousClose || meta.regularMarketPreviousClose
        || (validCloses.length >= 2 ? validCloses[validCloses.length - 2] : null)
        || 0;
      result.meta.chartPreviousClose = previousClose;
      result.meta.dataInterval = "15m";
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
