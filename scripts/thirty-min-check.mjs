// scripts/thirty-min-check.mjs
// 場中の各時点で「30分後の値段が今より上がっているか」を、アプリのスコア（src/lib/analyze.js の analyzeStock）の
// 各項目で予測できるかを、過去の15分足で確かめる。アプリ本体とは無関係の単発検証スクリプト。
//
// 判定時点: 各銘柄・各営業日・各15分足の終わりの時点。判定時点までの足だけを analyzeStock に渡し、
//           現在値はその足の終値にする（regularMarketPrice に 0 を渡すと toPriceData が最後の足の終値を使う）。
// 結果    : 2本後の足（30分後）の終値 ÷ 判定時点の終値 − 1。
// 先読みの禁止: 判定時点より後の足・当日の日足は計算に一切渡さない。実行時に、判定時点より後の値を
//           でたらめな値に書き換えて計算し直し、結果が1件も変わらないことを抜き取りで確かめる（leakCheck）。
//
// 銘柄群・analyzeStock の呼び方は scripts/score-parts-check.mjs（PR #90）と同じ。
//   - 銘柄群: 日ごとに、前日の確定値で出来高上位40と、値上がり率上位20（出来高が全銘柄の中央値の1.5倍以上）を重複なしで並べたもの
//   - 呼び方: api/stock.js が返す形の payload を組み立て、api/_scan.js の toPriceData・normalizeStock を通し、
//            自動スキャンと同じく VIX なし・opts は空で呼ぶ。Date を判定時点に固定する
// PR #90 のスクリプトは処理がすべて main() の中にあり import できないため、取得・候補作り・時計の差し替えを写した
// （元のファイルは変更しない）。S1 は src/App.js の calcS1 を写した（App.js は import しない。
// 写し間違いが無いことは実行時に App.js の該当部分と文字列で突き合わせて確かめる）。
// 新しい npm パッケージは使わず、既存の依存関係に含まれる xlsx・@upstash/redis（api/_scan.js の読み込みに必要）と
// Node 標準の fetch のみを使う。
//
// 実行: node scripts/thirty-min-check.mjs
// 出力: docs/thirty-min-result.md
//
// 任意: 環境変数 THIRTY_MIN_CHECK_CACHE にディレクトリを指定すると、Yahoo の取得結果を
//       そこに JSON で保存し、次回以降はそれを読む（形式は PR #90 の SCORE_PARTS_CHECK_CACHE と同じ）。
//       取得結果はリポジトリの外に置くこと（commit しない）

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { analyzeStock, currentSessionDate, calcVWAP } from "../src/lib/analyze.js";

// ---------- PR #90 と同じ設定 ----------

var YAHOO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};
var RANGE = "6mo";
var WAIT_MS = 300;
var RETRY_WAITS = [5000, 10000, 20000, 40000, 80000];
var ERROR_RETRY_WAITS = [3000, 6000];

var INTRADAY_INTERVAL = "15m";
var INTRADAY_RANGE = "60d";
var MIN_BARS = 600; // スコア計算に渡す15分足が600本以上ある場合だけ計算する
var REF_TICKER = "7203.T";

var TOPIX_TICKERS = ["^TOPX", "998405.T"];
var TOPIX_PROXY = "1306.T";

var JPX_PAGE = "https://www.jpx.co.jp/markets/statistics-equities/misc/01.html";
var TARGET_MARKETS = ["プライム（内国株式）", "スタンダード（内国株式）", "グロース（内国株式）"];

var NORMAL_VOL_TOP = 40;
var CHANGE_TOP = 20;
var VOL_MULT = 1.5;
var JP_DAY_MIN_RATIO = 0.5;

var PART_LABELS = [
  "VWAP", "VWAP傾き", "Pivot", "ATR(値幅)", "ATR消化率", "対TOPIX", "トレンド", "EMA整列", "MACD", "RSI",
  "BB", "Stoch", "重複ボーナス", "出来高/OBV", "ギャップ", "当日ブレイク", "寄り付きレンジ", "コンフルエンス",
  "実績反映調整", "上限抑制(下降/デッドクロス/VWAP)", "VIXキャップ",
];

// ---------- 今回の設定 ----------

// 場中に analyzeStock へ渡す15分足の長さ。api/stock.js は range=30d で取得しており、実測では
// 「当日を含む直近30取引日」が返る。このため当日（判定時点まで）＋その前の29取引日に切る
var PRIOR_DAYS = 29;
var STEP_SEC = 15 * 60;
var AHEAD_BARS = 2; // 30分後 = 2本後の足
var BACK_BARS = 2;  // 直近30分 = 2本前の足
// 判定時点（足の終わり）から30分後が場中に収まる足の開始時刻
// 前場: 9:00〜10:45 開始の足（2本後は 11:15 開始の足まで。11:30 の足は前場引けの1点だけの足）
// 後場: 12:30〜14:45 開始の足（2本後は 15:15 開始の足まで）
var AM_LAST_START = "10:45";
var PM_FIRST_START = "12:30";
var PM_LAST_START = "14:45";
var AM_END = "11:30";
// 時間帯（判定時点＝足の終わりの時刻で分ける）
var ZONES = [
  { key: "z1", label: "9:00〜9:59", test: function (end) { return end < "10:00"; } },
  { key: "z2", label: "10:00〜11:29", test: function (end) { return end >= "10:00" && end < "11:30"; } },
  { key: "z3", label: "後場", test: function (end) { return end >= "12:30"; } },
];
var NBANDS = 5;
var MIN_GROUP_SHARE = 0.01; // 一覧（6）で「ベースラインとの差」を取るグループの最低件数（全件数に対する割合）
var LEAK_SAMPLES = 300;     // 先読み検査で計算し直す判定時点の数

// ---------- src/App.js の calcS1 の写し（App.js は import しない） ----------
// 写し間違いが無いことは、実行時に src/App.js の該当部分と文字列で突き合わせて確認する（checkS1Copy）
var S1_LABELS=["VWAP傾き","Pivot","ATR(値幅)","ATR消化率","MACD","RSI","BB","Stoch","重複ボーナス"];
function calcS1(breakdown){
  if(!Array.isArray(breakdown)) return null;
  var sum=0;
  breakdown.forEach(function(b){
    if(b&&S1_LABELS.indexOf(b.label)>=0&&typeof b.delta==="number"&&isFinite(b.delta)) sum+=b.delta;
  });
  return sum;
}

var checkS1Copy = function () {
  var src = readFileSync(fileURLToPath(new URL("../src/App.js", import.meta.url)), "utf8");
  var lm = src.match(/\nvar S1_LABELS=\[[^\]]*\];/);
  var fm = src.match(/\nfunction calcS1\(breakdown\)\{[\s\S]*?\n\}/);
  var labelsOk = !!lm && lm[0].slice(1) === "var S1_LABELS=" + JSON.stringify(S1_LABELS) + ";";
  var fnOk = !!fm && fm[0].slice(1) === calcS1.toString();
  return labelsOk && fnOk;
};

var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
var isNum = function (v) { return typeof v === "number" && isFinite(v); };

// ---------- api/stock.js と同じ加工（PR #90 と同じ） ----------

function toLocalDates(timestamps, gmtoffset) {
  const off = (typeof gmtoffset === "number" ? gmtoffset : 0) * 1000;
  return (timestamps || []).map(function (t) {
    return t == null ? null : new Date(t * 1000 + off).toISOString().slice(0, 10);
  });
}

var checkToLocalDatesCopy = function () {
  var src = readFileSync(fileURLToPath(new URL("../api/stock.js", import.meta.url)), "utf8");
  var m = src.match(/function toLocalDates\([\s\S]*?\n\}/);
  return !!m && m[0] === toLocalDates.toString();
};

var loadScanModule = async function () {
  var warn = console.warn;
  console.warn = function () {};
  try {
    return await import("../api/_scan.js");
  } finally {
    console.warn = warn;
  }
};

// ---------- 時計の差し替え（PR #90 と同じ） ----------

var RealDate = Date;
var withClock = function (ms, fn) {
  var FakeDate = function () {
    var args = Array.prototype.slice.call(arguments);
    if (!new.target) return new RealDate(ms).toString();
    return args.length ? Reflect.construct(RealDate, args) : new RealDate(ms);
  };
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = function () { return ms; };
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;
  globalThis.Date = FakeDate;
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
};

// ---------- 取得（PR #90 と同じ） ----------

var fetchJpxList = async function () {
  var r = await fetch(JPX_PAGE, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("JPX page " + r.status);
  var html = await r.text();
  var m = html.match(/href="([^"]+\.xlsx?)"/);
  if (!m) throw new Error("JPX: xlsx のリンクが見つからない");
  var url = new URL(m[1], JPX_PAGE).toString();
  var x = await fetch(url, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(30000) });
  if (!x.ok) throw new Error("JPX xlsx " + x.status);
  var buf = Buffer.from(await x.arrayBuffer());
  var wb = XLSX.read(buf, { type: "buffer" });
  var rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  var head = rows[0];
  var iDate = head.indexOf("日付"), iCode = head.indexOf("コード"), iName = head.indexOf("銘柄名");
  var iMkt = head.indexOf("市場・商品区分"), iS17 = head.indexOf("17業種区分");
  if (iCode < 0 || iMkt < 0 || iS17 < 0) throw new Error("JPX: 想定した列が無い " + JSON.stringify(head));
  var list = [];
  var asOf = null;
  rows.slice(1).forEach(function (row) {
    if (!row || row[iCode] == null) return;
    if (asOf == null && iDate >= 0) asOf = row[iDate];
    if (TARGET_MARKETS.indexOf(row[iMkt]) < 0) return;
    list.push({ code: String(row[iCode]).trim(), name: row[iName], market: row[iMkt], sector: String(row[iS17]).trim() });
  });
  return { url: url, asOf: asOf, list: list };
};

var parseChart = function (json) {
  var result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result || !result.timestamp) return null;
  var q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  var adj = (result.indicators && result.indicators.adjclose && result.indicators.adjclose[0] && result.indicators.adjclose[0].adjclose) || [];
  var rows = [];
  for (var i = 0; i < result.timestamp.length; i++) {
    var d = new Date(result.timestamp[i] * 1000);
    var date = d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
    rows.push({
      date: date,
      open: q.open ? q.open[i] : null,
      high: q.high ? q.high[i] : null,
      low: q.low ? q.low[i] : null,
      close: q.close ? q.close[i] : null,
      adj: adj[i] == null ? null : adj[i],
      volume: q.volume ? q.volume[i] : null,
    });
  }
  return rows;
};

var parseIntraday = function (json) {
  var result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result || !result.timestamp) return null;
  var q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  var n = result.timestamp.length;
  var col = function (a) { return a ? a.slice(0, n) : new Array(n).fill(null); };
  return {
    gmtoffset: result.meta && result.meta.gmtoffset != null ? result.meta.gmtoffset : null,
    ts: result.timestamp.slice(),
    open: col(q.open), high: col(q.high), low: col(q.low), close: col(q.close), volume: col(q.volume),
  };
};

var fetchChart = async function (ticker, query, parse) {
  var url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(ticker) + "?" + query;
  var n429 = 0, nErr = 0;
  var out = null;
  while (!out) {
    var r = null, err = null;
    try {
      r = await fetch(url, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(15000) });
    } catch (e) {
      err = e;
    }
    if (r && r.status === 429) {
      if (n429 >= RETRY_WAITS.length) { out = { error: "429（再試行上限）" }; break; }
      await sleep(RETRY_WAITS[n429++]);
      continue;
    }
    if (err || (r && r.status >= 500)) {
      if (nErr >= ERROR_RETRY_WAITS.length) { out = { error: err ? String(err.message || err) : "Yahoo " + r.status }; break; }
      await sleep(ERROR_RETRY_WAITS[nErr++]);
      continue;
    }
    if (!r.ok) { out = { error: "Yahoo " + r.status }; break; }
    var data;
    try {
      data = parse(await r.json());
    } catch (e) {
      out = { error: "JSON 解析失敗" };
      break;
    }
    var empty = !data || (Array.isArray(data) ? !data.length : !data.ts.length);
    out = empty ? { error: "データなし" } : { data: data };
  }
  return out;
};

var cachedFetch = async function (cacheDir, fileName, fetcher) {
  var cachePath = cacheDir ? join(cacheDir, fileName.replace(/[^A-Za-z0-9._^-]/g, "_")) : null;
  if (cachePath && existsSync(cachePath)) return { res: JSON.parse(readFileSync(cachePath, "utf8")), fromCache: true };
  var res = await fetcher();
  if (cachePath && !(res.error && res.error.indexOf("429") === 0)) writeFileSync(cachePath, JSON.stringify(res));
  return { res: res, fromCache: false };
};

var fetchDaily = function (ticker, cacheDir) {
  return cachedFetch(cacheDir, ticker + ".json", function () {
    return fetchChart(ticker, "interval=1d&range=" + RANGE, parseChart);
  });
};

var fetchIntraday = function (ticker, cacheDir) {
  return cachedFetch(cacheDir, ticker + ".15m.json", function () {
    return fetchChart(ticker, "interval=" + INTRADAY_INTERVAL + "&range=" + INTRADAY_RANGE, parseIntraday);
  });
};

// ---------- 統計 ----------

var mean = function (a) { return a.reduce(function (s, v) { return s + v; }, 0) / a.length; };

var sd = function (a) {
  if (a.length < 2) return NaN;
  var m = mean(a);
  return Math.sqrt(a.reduce(function (s, v) { return s + (v - m) * (v - m); }, 0) / (a.length - 1));
};

var corr = function (xs, ys) {
  var n = xs.length;
  if (n < 2) return NaN;
  var mx = mean(xs), my = mean(ys);
  var sxy = 0, sxx = 0, syy = 0;
  for (var i = 0; i < n; i++) {
    var dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
};

var pct3 = function (v) { return isNum(v) ? (v >= 0 ? "+" : "") + (v * 100).toFixed(3) + "%" : "-"; };
var pct1 = function (v) { return isNum(v) ? (v * 100).toFixed(1) + "%" : "-"; };
var pt1 = function (v) { return isNum(v) ? (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "pt" : "-"; };
var num2 = function (v) { return isNum(v) ? v.toFixed(2) : "-"; };
var num3 = function (v) { return isNum(v) ? (v >= 0 ? "+" : "") + v.toFixed(3) : "-"; };
var int = function (v) { return Number(v).toLocaleString("en-US"); };

// ---------- 候補の作り方（PR #90 と同じ） ----------

var appMedian = function (vols) {
  var s = vols.slice().sort(function (a, b) { return a - b; });
  return s[Math.floor(s.length / 2)] || 0;
};

var buildCandidates = function (pop, volTop) {
  if (!pop.length) return { all: [], byVol: [], byChange: [] };
  var byVol = pop.slice().sort(function (a, b) { return b.prevVol - a.prevVol || a.idx - b.idx; }).slice(0, volTop);
  var med = appMedian(pop.map(function (p) { return p.prevVol; }));
  var byChange = pop
    .filter(function (p) { return p.prevVol >= med * VOL_MULT; })
    .sort(function (a, b) { return b.prevRet - a.prevRet || a.idx - b.idx; })
    .slice(0, CHANGE_TOP);
  var seen = new Set();
  var out = [];
  byVol.concat(byChange).forEach(function (p) {
    if (seen.has(p.idx)) return;
    seen.add(p.idx);
    out.push(p.idx);
  });
  var toIdx = function (p) { return p.idx; };
  return { all: out, byVol: byVol.map(toIdx), byChange: byChange.map(toIdx) };
};

// ---------- 5等分（同じ値は必ず同じグループに入れる） ----------

// 値の小さい順に並べ、各値を「その値の並びの中央の位置」で5つのグループに割り当てる
// （中央の位置 ÷ 全件数 × 5 の整数部分。0 が最も小さいグループ）。
// 同じ値が多い項目（0点が大半の部品など）は、空のグループができる
var bandsOf = function (vals) {
  var N = vals.length;
  var sorted = vals.slice().sort(function (a, b) { return a - b; });
  var lower = new Map(), eq = new Map();
  sorted.forEach(function (v, i) {
    if (!lower.has(v)) lower.set(v, i);
    eq.set(v, (eq.get(v) || 0) + 1);
  });
  return vals.map(function (v) {
    var mid = lower.get(v) + eq.get(v) / 2;
    return Math.min(NBANDS - 1, Math.floor(mid / N * NBANDS));
  });
};

var groupStats = function (list) {
  if (!list.length) return { n: 0 };
  var up = 0, flat = 0, down = 0, sum = 0, min = Infinity, max = -Infinity;
  list.forEach(function (x) {
    if (x.ret > 0) up++; else if (x.ret < 0) down++; else flat++;
    sum += x.ret;
    if (x.v < min) min = x.v;
    if (x.v > max) max = x.v;
  });
  return { n: list.length, up: up / list.length, flat: flat / list.length, down: down / list.length, avg: sum / list.length, min: min, max: max };
};

// 項目の値と30分後の騰落率の組（xs）を5等分して、グループごとの成績を返す
var quintiles = function (xs) {
  var b = bandsOf(xs.map(function (x) { return x.v; }));
  var groups = [];
  for (var k = 0; k < NBANDS; k++) groups.push([]);
  xs.forEach(function (x, i) { groups[b[i]].push(x); });
  return { band: b, stats: groups.map(groupStats) };
};

// ---------- 本体 ----------

var main = async function () {
  var cacheDir = process.env.THIRTY_MIN_CHECK_CACHE || null;
  if (cacheDir) mkdirSync(cacheDir, { recursive: true });

  var datesCopyOk = checkToLocalDatesCopy();
  if (!datesCopyOk) throw new Error("api/stock.js の toLocalDates と写しが一致しない（api/stock.js が変更された可能性）");
  var s1CopyOk = checkS1Copy();
  if (!s1CopyOk) throw new Error("src/App.js の calcS1 と写しが一致しない（src/App.js が変更された可能性）");
  var scan = await loadScanModule();
  var runDate = new RealDate(RealDate.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

  // 1. 銘柄一覧
  var jpx = await fetchJpxList();
  console.log("JPX 銘柄一覧: " + jpx.list.length + "銘柄（" + jpx.url + "）");

  // 2. TOPIX（日足: 前日終値に使う / 15分足: 判定時点の値に使う）
  var topixSource = null, topixRows = null, topixTried = [];
  var topixCandidates = TOPIX_TICKERS.concat([TOPIX_PROXY]);
  for (var ti = 0; ti < topixCandidates.length && !topixRows; ti++) {
    var tr = (await fetchDaily(topixCandidates[ti], cacheDir)).res;
    var ti15 = tr.error ? null : (await fetchIntraday(topixCandidates[ti], cacheDir)).res;
    topixTried.push(topixCandidates[ti] + "（日足: " + (tr.error ? tr.error : "取得成功") + (ti15 ? " / 15分足: " + (ti15.error ? ti15.error : "取得成功") : "") + "）");
    if (!tr.error && ti15 && !ti15.error) { topixSource = topixCandidates[ti]; topixRows = { daily: tr.data, intraday: ti15.data }; }
    await sleep(WAIT_MS);
  }
  if (!topixRows) throw new Error("TOPIX の日足・15分足が取れない: " + topixTried.join(" / "));
  console.log("TOPIX: " + topixSource);

  // 3. 日本株の日足（直列・1件ごとに待つ）
  var stocks = [];
  var failed = [];
  for (var k = 0; k < jpx.list.length; k++) {
    var s = jpx.list[k];
    var ticker = s.code + ".T";
    var got = await fetchDaily(ticker, cacheDir);
    if (got.res.error) failed.push({ ticker: ticker, error: got.res.error });
    else stocks.push({ ticker: ticker, sector: s.sector, rows: got.res.data });
    if (!got.fromCache) await sleep(WAIT_MS);
    if ((k + 1) % 200 === 0) console.log("  日本株 " + (k + 1) + "/" + jpx.list.length + "（失敗 " + failed.length + "）");
  }
  console.log("日本株 取得成功 " + stocks.length + " / 失敗 " + failed.length);

  // ---------- 取引日（PR #90 と同じ） ----------

  var jpCount = new Map();
  stocks.forEach(function (st) {
    st.rows.forEach(function (r) { if (isNum(r.close)) jpCount.set(r.date, (jpCount.get(r.date) || 0) + 1); });
  });
  var maxCount = 0;
  jpCount.forEach(function (c) { if (c > maxCount) maxCount = c; });
  var jpDays = Array.from(jpCount.keys()).filter(function (d) { return jpCount.get(d) >= maxCount * JP_DAY_MIN_RATIO; }).sort();
  var jpDayIndex = new Map();
  jpDays.forEach(function (d, j) { jpDayIndex.set(d, j); });

  var toDayArray = function (rows) {
    var arr = new Array(jpDays.length).fill(null);
    rows.forEach(function (r) {
      var j = jpDayIndex.get(r.date);
      if (j != null) arr[j] = r;
    });
    return arr;
  };
  var bars = stocks.map(function (st) { return toDayArray(st.rows); });
  var topixDaily = toDayArray(topixRows.daily);

  // ---------- 15分足の索引 ----------

  var hmOf = function (ts, off) { return new RealDate((ts + off) * 1000).toISOString().slice(11, 16); };
  var indexIntraday = function (raw) {
    var off = raw.gmtoffset != null ? raw.gmtoffset : 32400;
    var dates = toLocalDates(raw.ts, off);
    var dayList = [], dayStart = {}, dayEnd = {};
    dates.forEach(function (d, i) {
      if (!(d in dayStart)) { dayStart[d] = i; dayList.push(d); }
      dayEnd[d] = i + 1;
    });
    return { raw: raw, off: off, dates: dates, dayList: dayList, dayStart: dayStart, dayEnd: dayEnd };
  };
  // T当日より前の直近 PRIOR_DAYS 取引日の始まりの位置
  var priorStart = function (ix, date) {
    var prevDays = ix.dayList.filter(function (d) { return d < date; });
    if (!prevDays.length) return null;
    var first = prevDays[Math.max(0, prevDays.length - PRIOR_DAYS)];
    return { from: ix.dayStart[first], lastDay: prevDays[prevDays.length - 1], days: Math.min(PRIOR_DAYS, prevDays.length) };
  };

  // ---------- 検証する日 ----------
  // 基準銘柄の15分足に、T当日の足と、その前の29取引日が揃っている日（スコア計算に渡す長さが毎日同じになる）

  var refGot = (await fetchIntraday(REF_TICKER, cacheDir)).res;
  if (refGot.error) throw new Error(REF_TICKER + " の15分足: " + refGot.error);
  await sleep(WAIT_MS);
  var refIx = indexIntraday(refGot.data);
  var periodStart = refIx.dayList[0], periodEnd = refIx.dayList[refIx.dayList.length - 1];
  var testDays = [];
  jpDays.forEach(function (d) {
    var t = jpDayIndex.get(d);
    if (t < 2 || refIx.dayStart[d] == null) return;
    var p = priorStart(refIx, d);
    if (!p || p.days < PRIOR_DAYS || p.lastDay !== jpDays[t - 1]) return;
    testDays.push({ t: t, date: d });
  });
  console.log("15分足の期間: " + periodStart + " 〜 " + periodEnd + " / 検証日 " + testDays.length + "日");
  if (!testDays.length) throw new Error("検証日が無い");

  // ---------- 日ごとの候補（PR #90 と同じ。前日までの確定値だけで決まる） ----------

  testDays.forEach(function (td) {
    var t = td.t;
    var pop = [];
    for (var si = 0; si < bars.length; si++) {
      var p1 = bars[si][t - 1], p2 = bars[si][t - 2];
      if (!p1 || !p2 || !isNum(p1.adj) || !isNum(p2.adj) || p2.adj <= 0 || !isNum(p1.volume)) continue;
      pop.push({ idx: si, prevVol: p1.volume, prevRet: p1.adj / p2.adj - 1 });
    }
    td.cands = buildCandidates(pop, NORMAL_VOL_TOP).all;
  });

  // ---------- 15分足の取得（期間中に一度でも候補になった銘柄だけ） ----------

  var targetSet = new Set();
  testDays.forEach(function (td) { td.cands.forEach(function (si2) { targetSet.add(si2); }); });
  var targets = Array.from(targetSet).sort(function (a, b) { return a - b; });
  console.log("15分足の取得対象: " + targets.length + "銘柄");

  var intraday = new Array(stocks.length).fill(null);
  var intradayFailed = [];
  for (var hi = 0; hi < targets.length; hi++) {
    var hTicker = stocks[targets[hi]].ticker;
    var hr = await fetchIntraday(hTicker, cacheDir);
    if (hr.res.error) intradayFailed.push({ ticker: hTicker, error: hr.res.error });
    else intraday[targets[hi]] = indexIntraday(hr.res.data);
    if (!hr.fromCache) await sleep(WAIT_MS);
    if ((hi + 1) % 100 === 0) console.log("  15分足 " + (hi + 1) + "/" + targets.length + "（失敗 " + intradayFailed.length + "）");
  }
  console.log("15分足 取得成功 " + (targets.length - intradayFailed.length) + " / 失敗 " + intradayFailed.length);

  var topixIx = indexIntraday(topixRows.intraday);

  // ---------- 判定時点ごとの計算 ----------

  // api/stock.js の fetchJPPayload が返す形に組み立てる（PR #90 と同じ形。現在値は 0 を渡して最後の足の終値にする）
  var buildPayload = function (raw, from, to, officialPrevClose, topixChange) {
    var sl = function (a) { return a.slice(from, to); };
    var ts = sl(raw.ts);
    return {
      chart: {
        result: [{
          meta: {
            regularMarketPrice: 0,
            chartPreviousClose: 0,
            regularMarketPreviousClose: officialPrevClose,
            dataInterval: "15m",
            dataRange: "30d",
          },
          indicators: {
            quote: [{
              close: sl(raw.close), high: sl(raw.high), low: sl(raw.low), volume: sl(raw.volume), open: sl(raw.open),
              date: toLocalDates(ts, raw.gmtoffset != null ? raw.gmtoffset : 32400),
            }],
          },
          per: null, pbr: null, eps: null, bps: null, dividendYield: null,
          analystTarget: null, sector: null,
          earningsDate: null,
          exRightsDate: null,
          topixChange: topixChange,
        }],
      },
    };
  };

  // 判定時点（i 本目の足の終わり）の TOPIX 前日比（%）。T当日の TOPIX の15分足のうち、開始時刻が i 本目以下の
  // 最後の終値 ÷ TOPIX の前日終値（日足）。判定時点より後の足は見ない
  var topixChangeAt = function (date, t, ts) {
    var p = topixDaily[t - 1];
    if (!p || !isNum(p.close) || p.close <= 0) return null;
    var ds = topixIx.dayStart[date];
    if (ds == null) return null;
    var last = null;
    for (var j = ds; j < topixIx.dayEnd[date] && topixIx.raw.ts[j] <= ts; j++) {
      if (topixIx.raw.close[j] != null) last = topixIx.raw.close[j];
    }
    return last == null ? null : (last / p.close - 1) * 100;
  };

  // 1つの判定時点を計算する。raw は15分足（先読み検査ではでたらめな値に書き換えたものを渡す）
  // 返り値: { rec } または { skip: 理由 }
  var evalPoint = function (st, raw, ws, i, date, t, prevDailyClose) {
    var ts = raw.ts[i];
    if (raw.close[i] == null) return { skip: "nowNull" };
    var topixChange = topixChangeAt(date, t, ts);
    if (topixChange == null) return { skip: "noTopix" };
    // 判定時点までの足だけ（[ws, i]）を渡す
    var pd = scan.toPriceData(buildPayload(raw, ws, i + 1, prevDailyClose, topixChange));
    var clockMs = (ts + STEP_SEC) * 1000; // 判定時点（足の終わり）
    var a = withClock(clockMs, function () { return analyzeStock(scan.normalizeStock(st.ticker), pd, null, {}); });
    var n = pd.closes.length - 1;
    var price = pd.closes[n];
    // 当日の足の始まり（analyzeStock の todayStart と同じく、日付が変わる位置）
    var todayStart = n;
    while (todayStart > 0 && pd.dates[todayStart - 1] === date) todayStart--;
    var vwap = calcVWAP(pd.closes.slice(todayStart), pd.highs.slice(todayStart), pd.lows.slice(todayStart), pd.volumes.slice(todayStart));
    var parts = {};
    PART_LABELS.forEach(function (lb) { parts[lb] = 0; });
    var partSum = 0, unknown = null;
    a.breakdown.forEach(function (b) {
      if (!(b.label in parts)) unknown = b.label;
      parts[b.label] = (parts[b.label] || 0) + b.delta;
      partSum += b.delta;
    });
    // 結果（30分後）。ここだけが判定時点より後の足を見る
    var fut = raw.close[i + AHEAD_BARS];
    return {
      rec: {
        sessionStarted: a.sessionStarted,
        rawPrice: a.rawPrice,
        price: price,
        score: a.score,
        parts: parts,
        partSumOk: Math.abs(partSum - a.score) < 1e-9,
        unknown: unknown,
        s1: calcS1(a.breakdown),
        past30: n >= BACK_BARS && pd.closes[n - BACK_BARS] > 0 ? price / pd.closes[n - BACK_BARS] - 1 : null,
        dayRet: price / prevDailyClose - 1,
        vwapDev: vwap > 0 ? price / vwap - 1 : null,
        topix: topixChange,
        ret: fut != null ? fut / raw.close[i] - 1 : null,
      },
    };
  };

  var skipDay = { noIntraday: 0, noPrevBars: 0, fewBars: 0, noPrevClose: 0, noTodayBars: 0 };
  var skipPoint = { lunch: 0, close: 0, nowNull: 0, futMissing: 0, noTopix: 0, noPast: 0, noVwap: 0 };
  var skipDayPoints = 0; // 銘柄日ごと除外した銘柄日の、その日の足の本数
  var stockDays = 0, stockDaysUsed = 0;
  var recs = [];
  var leakPool = []; // 先読み検査の候補（銘柄・日・位置）
  var sessionMismatch = 0, priceMismatch = 0, sumMismatch = 0, unknownLabels = new Set();

  testDays.forEach(function (td, tdi) {
    var t = td.t, date = td.date;
    td.cands.forEach(function (si2) {
      stockDays++;
      var st = stocks[si2];
      var ix = intraday[si2];
      if (!ix) { skipDay.noIntraday++; return; }
      var ds = ix.dayStart[date];
      if (ds == null) { skipDay.noTodayBars++; return; }
      var de = ix.dayEnd[date];
      var dayBarCount = 0;
      for (var q = ds; q < de; q++) if (ix.raw.close[q] != null) dayBarCount++;
      var p = priorStart(ix, date);
      if (!p || p.lastDay !== jpDays[t - 1]) { skipDay.noPrevBars++; skipDayPoints += dayBarCount; return; }
      if (ds - p.from + 1 < MIN_BARS) { skipDay.fewBars++; skipDayPoints += dayBarCount; return; }
      var pPrev = bars[si2][t - 1];
      var prevDailyClose = pPrev && isNum(pPrev.close) && pPrev.close > 0 ? pPrev.close : null;
      if (prevDailyClose == null) { skipDay.noPrevClose++; skipDayPoints += dayBarCount; return; }
      stockDaysUsed++;
      var raw = ix.raw;
      for (var i = ds; i < de; i++) {
        var start = hmOf(raw.ts[i], ix.off);
        // 昼休みの空の足（約定が無く値が null）は判定時点として数えない
        if (start > AM_END && start < PM_FIRST_START) continue;
        // 30分後が昼休み（11:30〜12:30）や大引けをまたぐ判定時点は除外
        if (start < PM_FIRST_START && start > AM_LAST_START) { skipPoint.lunch++; continue; }
        if (start > PM_LAST_START) { skipPoint.close++; continue; }
        if (raw.close[i] == null) { skipPoint.nowNull++; continue; }
        // 2本後の足が同じ日の30分後の足で、値があること
        var j = i + AHEAD_BARS;
        if (j >= de || raw.ts[j] !== raw.ts[i] + AHEAD_BARS * STEP_SEC || raw.close[j] == null) { skipPoint.futMissing++; continue; }
        var r = evalPoint(st, raw, p.from, i, date, t, prevDailyClose);
        if (r.skip) { skipPoint[r.skip]++; continue; }
        var rec = r.rec;
        if (!rec.sessionStarted) sessionMismatch++;
        if (rec.rawPrice !== raw.close[i]) priceMismatch++;
        if (!rec.partSumOk) sumMismatch++;
        if (rec.unknown) unknownLabels.add(rec.unknown);
        if (!isNum(rec.past30)) { skipPoint.noPast++; continue; }
        if (!isNum(rec.vwapDev)) { skipPoint.noVwap++; continue; }
        rec.day = date;
        rec.dayIdx = tdi;
        rec.ticker = st.ticker;
        rec.start = start;
        rec.end = hmOf(raw.ts[i] + STEP_SEC, ix.off);
        rec.zone = ZONES.filter(function (z) { return z.test(rec.end); })[0].key;
        recs.push(rec);
        leakPool.push({ si: si2, ix: ix, from: p.from, i: i, date: date, t: t, prevDailyClose: prevDailyClose, rec: rec });
      }
    });
    if ((tdi + 1) % 5 === 0) console.log("  計算 " + (tdi + 1) + "/" + testDays.length + "日（判定時点 " + recs.length + "件）");
  });
  console.log("判定時点 " + recs.length + "件");
  if (unknownLabels.size) throw new Error("PART_LABELS に無い部品: " + Array.from(unknownLabels).join(", "));
  if (sumMismatch) throw new Error("部品の点数の合計がスコアと一致しない判定時点がある: " + sumMismatch);
  if (sessionMismatch) throw new Error("寄り付き後扱いにならなかった判定時点がある: " + sessionMismatch);
  if (priceMismatch) throw new Error("現在値が判定時点の足の終値にならなかった判定時点がある: " + priceMismatch);

  // ---------- 先読み検査 ----------
  // 抜き取った判定時点について、判定時点より後の15分足（その銘柄・TOPIX）と、T当日以降の日足を
  // でたらめな値に書き換えてから計算し直し、結果以外の値（スコア・各項目・S1・3つの騰落率）が変わらないことを確かめる
  var leakChecked = 0, leakDiff = 0;
  var seed = 12345;
  var rnd = function () { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  var scramble = function (a, from) {
    var b = a.slice();
    for (var z = from; z < b.length; z++) if (b[z] != null) b[z] = b[z] * (0.5 + rnd());
    return b;
  };
  var step = Math.max(1, Math.floor(leakPool.length / LEAK_SAMPLES));
  for (var li = 0; li < leakPool.length && leakChecked < LEAK_SAMPLES; li += step) {
    var lp = leakPool[li];
    var r0 = lp.ix.raw;
    var raw2 = { gmtoffset: r0.gmtoffset, ts: r0.ts, open: scramble(r0.open, lp.i + 1), high: scramble(r0.high, lp.i + 1), low: scramble(r0.low, lp.i + 1), close: scramble(r0.close, lp.i + 1), volume: scramble(r0.volume, lp.i + 1) };
    var savedTopix = topixIx.raw, savedDaily = topixDaily.slice(), savedBars = bars[lp.si].slice();
    var tsCut = r0.ts[lp.i];
    var cutTopix = 0;
    while (cutTopix < savedTopix.ts.length && savedTopix.ts[cutTopix] <= tsCut) cutTopix++;
    topixIx.raw = { gmtoffset: savedTopix.gmtoffset, ts: savedTopix.ts, open: savedTopix.open, high: savedTopix.high, low: savedTopix.low, close: scramble(savedTopix.close, cutTopix), volume: savedTopix.volume };
    for (var dz = lp.t; dz < topixDaily.length; dz++) if (topixDaily[dz]) topixDaily[dz] = Object.assign({}, topixDaily[dz], { close: topixDaily[dz].close * (0.5 + rnd()) });
    for (var bz = lp.t; bz < bars[lp.si].length; bz++) if (bars[lp.si][bz]) bars[lp.si][bz] = Object.assign({}, bars[lp.si][bz], { close: bars[lp.si][bz].close * (0.5 + rnd()) });
    try {
      var rr = evalPoint(stocks[lp.si], raw2, lp.from, lp.i, lp.date, lp.t, lp.prevDailyClose);
      var a0 = lp.rec, a1 = rr.rec;
      var same = !!a1 && a0.score === a1.score && a0.s1 === a1.s1 && a0.past30 === a1.past30 && a0.dayRet === a1.dayRet &&
        a0.vwapDev === a1.vwapDev && a0.topix === a1.topix &&
        PART_LABELS.every(function (lb) { return a0.parts[lb] === a1.parts[lb]; });
      if (!same) leakDiff++;
      leakChecked++;
    } finally {
      topixIx.raw = savedTopix;
      for (var dz2 = 0; dz2 < savedDaily.length; dz2++) topixDaily[dz2] = savedDaily[dz2];
      bars[lp.si] = savedBars;
    }
  }
  console.log("先読み検査 " + leakChecked + "件（結果が変わった " + leakDiff + "件）");
  if (leakDiff) throw new Error("判定時点より後のデータを書き換えると計算結果が変わる判定時点がある: " + leakDiff);

  // ---------- 集計 ----------

  var N = recs.length;
  var dayCount = testDays.length;
  var tickerSet = new Set(recs.map(function (r) { return r.ticker; }));
  var dayUsedSet = new Set(recs.map(function (r) { return r.day; }));

  // 項目（判定時点ごとの値の取り出し方）
  var partInfo = PART_LABELS.map(function (lb) {
    var alwaysZero = recs.every(function (r) { return r.parts[lb] === 0; });
    return { label: lb, alwaysZero: alwaysZero };
  });
  var ITEMS = [{ key: "score", label: "総合スコア", get: function (r) { return r.score; }, kind: "スコア" }];
  partInfo.forEach(function (p) {
    if (p.alwaysZero) return;
    ITEMS.push({ key: "part:" + p.label, label: p.label, get: function (r) { return r.parts[p.label]; }, kind: "部品" });
  });
  ITEMS.push({ key: "s1", label: "S1", get: function (r) { return r.s1; }, kind: "スコア" });
  ITEMS.push({ key: "past30", label: "直近30分の騰落率", get: function (r) { return r.past30; }, kind: "値動き", pct: true });
  ITEMS.push({ key: "dayRet", label: "当日の騰落率", get: function (r) { return r.dayRet; }, kind: "値動き", pct: true });
  ITEMS.push({ key: "vwapDev", label: "VWAP乖離率", get: function (r) { return r.vwapDev; }, kind: "値動き", pct: true });
  var fmtVal = function (item, v) { return item.pct ? pct3(v) : (Number.isInteger(v) ? String(v) : v.toFixed(2)); };

  // 1. ベースライン
  var base = groupStats(recs.map(function (r) { return { v: 0, ret: r.ret }; }));
  var baseZone = {};
  ZONES.forEach(function (z) {
    baseZone[z.key] = groupStats(recs.filter(function (r) { return r.zone === z.key; }).map(function (r) { return { v: 0, ret: r.ret }; }));
  });

  // 2〜6. 項目ごと
  var minGroup = Math.ceil(N * MIN_GROUP_SHARE);
  var results = ITEMS.map(function (item) {
    var xs = recs.map(function (r) { return { v: item.get(r), ret: r.ret, day: r.dayIdx, zone: r.zone }; });
    var q = quintiles(xs);
    var nonEmpty = [];
    q.stats.forEach(function (g, k) { if (g.n) nonEmpty.push(k); });
    var lo = nonEmpty[0], hi = nonEmpty[nonEmpty.length - 1];
    var c = corr(xs.map(function (x) { return x.v; }), xs.map(function (x) { return x.ret; }));
    // 時間帯別（時間帯ごとに5等分し直す）
    var byZone = {};
    ZONES.forEach(function (z) {
      var zx = xs.filter(function (x) { return x.zone === z.key; });
      byZone[z.key] = { q: quintiles(zx), corr: corr(zx.map(function (x) { return x.v; }), zx.map(function (x) { return x.ret; })) };
    });
    // 日ごとの一貫性: 全体の5等分で、いちばん上のグループといちばん下のグループの平均騰落率をその日ごとに比べる
    var dayDiffs = [], better = 0;
    if (lo !== hi) {
      for (var d = 0; d < dayCount; d++) {
        var top = [], bot = [];
        xs.forEach(function (x, ii) {
          if (x.day !== d) return;
          if (q.band[ii] === hi) top.push(x.ret);
          else if (q.band[ii] === lo) bot.push(x.ret);
        });
        if (!top.length || !bot.length) continue;
        var diff = mean(top) - mean(bot);
        dayDiffs.push(diff);
        if (diff > 0) better++;
      }
    }
    var ddMean = dayDiffs.length ? mean(dayDiffs) : NaN, ddSd = sd(dayDiffs);
    // ベースラインとの差（件数が全体の1%以上のグループのうち、上昇割合がベースラインから最も離れたもの）
    var maxDev = null;
    q.stats.forEach(function (g, k) {
      if (!g.n || g.n < minGroup) return;
      var dev = g.up - base.up;
      if (!maxDev || Math.abs(dev) > Math.abs(maxDev.dev)) maxDev = { k: k, dev: dev, avgDev: g.avg - base.avg, g: g };
    });
    return {
      item: item, q: q, lo: lo, hi: hi, corr: c, byZone: byZone,
      dayDays: dayDiffs.length, dayBetter: better, dayShare: dayDiffs.length ? better / dayDiffs.length : NaN,
      ddMean: ddMean, ddT: ddMean / (ddSd / Math.sqrt(dayDiffs.length)),
      spreadUp: lo !== hi ? q.stats[hi].up - q.stats[lo].up : NaN,
      spreadAvg: lo !== hi ? q.stats[hi].avg - q.stats[lo].avg : NaN,
      maxDev: maxDev,
    };
  });
  var ranked = results.slice().sort(function (a, b) {
    var x = a.maxDev ? Math.abs(a.maxDev.dev) : -1, y = b.maxDev ? Math.abs(b.maxDev.dev) : -1;
    return y - x;
  });

  // ---------- レポート ----------

  var bandName = function (k) { return "G" + (k + 1); };
  var L = [];
  L.push("# 30分後の値上がりをスコアの各項目で予測できるか 検証結果");
  L.push("");

  // 結論（データから組み立てる）
  var strongCorr = results.filter(function (r) { return Math.abs(r.corr) >= 0.05; });
  var top1 = ranked[0];
  var bestDaily = results.filter(function (r) { return isNum(r.dayShare); }).sort(function (a, b) { return Math.abs(b.dayShare - 0.5) - Math.abs(a.dayShare - 0.5); })[0];
  var scoreRes = results.filter(function (r) { return r.item.key === "score"; })[0];
  L.push("## 結論");
  L.push("");
  L.push("- 30分後に上がっていた割合は全体で " + pct1(base.up) + "（変わらず " + pct1(base.flat) + "）。どの項目も30分後の騰落率との相関係数は " +
    (strongCorr.length ? "最大 " + num3(results.slice().sort(function (a, b) { return Math.abs(b.corr) - Math.abs(a.corr); })[0].corr) + "（" + results.slice().sort(function (a, b) { return Math.abs(b.corr) - Math.abs(a.corr); })[0].item.label + "）" : "±0.05 未満") +
    "で、単独で30分後の上げ下げを言い当てられる項目は無い");
  L.push("- ベースラインとの差が最も大きいのは「" + top1.item.label + "」の " + bandName(top1.maxDev.k) + "（上がった割合 " + pct1(top1.maxDev.g.up) + "、ベースラインとの差 " + pt1(top1.maxDev.dev) + "）。" +
    "日ごとの一貫性が最も偏っていたのは「" + bestDaily.item.label + "」（上位グループの方が良かった日 " + bestDaily.dayBetter + "/" + bestDaily.dayDays + "日）");
  L.push("- 総合スコアは、上位グループと下位グループの上がった割合の差 " + pt1(scoreRes.spreadUp) + "・平均騰落率の差 " + pct3(scoreRes.spreadAvg) + "、相関係数 " + num3(scoreRes.corr) + "。片道0.05%（往復0.1%）の売買コストと比べてどの程度かは4章の表で確かめられる");
  L.push("");

  L.push("## 0. 前提");
  L.push("");
  L.push("- 生成: `node scripts/thirty-min-check.mjs`（実行日 " + runDate + "）");
  L.push("- 銘柄群: `scripts/score-parts-check.mjs`（PR #90）と同じ作り方。日ごとに、前日の確定値で出来高上位" + NORMAL_VOL_TOP + "と、値上がり率上位" + CHANGE_TOP + "（出来高が全銘柄の中央値の" + VOL_MULT + "倍以上のもの）を重複なしで並べた銘柄。対象市場は JPX 東証上場銘柄一覧（" + (jpx.asOf || "-") + " 時点）のプライム・スタンダード・グロースの内国株式 " + jpx.list.length + "銘柄（日足の取得失敗 " + failed.length + "銘柄）");
  L.push("- 15分足: Yahoo Finance（interval=15m、range=60d）。取得できた期間は " + periodStart + " 〜 " + periodEnd + "（" + refIx.dayList.length + "営業日分）");
  L.push("- **検証した営業日数: " + dayCount + "日**（" + testDays[0].date + " 〜 " + testDays[testDays.length - 1].date + "）。基準銘柄 " + REF_TICKER + " の15分足に、その日の足と、その前の" + PRIOR_DAYS + "営業日分の足が揃っている日（15分足の期間の最初の" + (refIx.dayList.length - dayCount) + "営業日は、前の" + PRIOR_DAYS + "営業日が揃わないため対象外）");
  L.push("- **検証した銘柄数: " + tickerSet.size + "銘柄**（候補になった銘柄日 " + int(stockDays) + "、うち計算に使えた銘柄日 " + int(stockDaysUsed) + "）");
  L.push("- **判定時点の件数: " + int(N) + "件**");
  L.push("- TOPIX: " + topixTried.join(" / ") + "。TOPIX そのものは Yahoo に無いため、TOPIX 連動ETF（" + topixSource + "）の15分足で代用した");
  L.push("");
  L.push("言葉の意味:");
  L.push("");
  L.push("- 判定時点: 各銘柄・各営業日の、各15分足の終わりの時点。例えば 9:00〜9:15 の足なら 9:15。その時点で手に入る足だけを使ってスコアを計算する");
  L.push("- 30分後の騰落率（結果）: 2本後の足の終値 ÷ 判定時点の足の終値 − 1。売買コストは引いていない。0より大きければ「上がった」、0なら「変わらず」、0未満なら「下がった」");
  L.push("- ベースライン: 項目で絞り込まずに全判定時点をまとめたときの、上がった割合と平均騰落率。項目で選んだグループの成績がこれより良くなければ、その項目に予測の力は無い");
  L.push("- 5等分: 項目の値の小さい順に判定時点を並べ、件数がほぼ同じになるように5つのグループ（G1＝最も小さい 〜 G5＝最も大きい）に分けること。同じ値の判定時点は必ず同じグループに入れるため、0点が大半を占める部品などは空のグループができ、件数も揃わない");
  L.push("- 相関係数: 項目の値と30分後の騰落率が一緒に動く度合いを −1〜+1 で表した数（ピアソンの相関係数）。+1 に近いほど「値が大きいほど上がる」、0 に近いほど関係が無い");
  L.push("");
  L.push("記録した項目:");
  L.push("");
  L.push("- 総合スコア・breakdown の各項目（部品）: `analyzeStock()` の `score` と `breakdown`。常に0点だった部品（" + partInfo.filter(function (p) { return p.alwaysZero; }).map(function (p) { return p.label; }).join("・") + "）は集計から外した。自動スキャンと同じく VIX と過去の的中率を渡していないため");
  L.push("- S1: `src/App.js` の `calcS1()` と同じ計算（breakdown のうち " + S1_LABELS.join("・") + " の点数の合計）");
  L.push("- 直近30分の騰落率: 判定時点の終値 ÷ 2本前の足の終値 − 1。足は `analyzeStock()` に渡す並び（空の足は直前の値で埋めたもの）で数える。このため 9:00・9:15 の足では2本前が前日の後場の足になり、夜間の値動き（ギャップ）を含む。12:30・12:45 の足では2本前が昼休みの空の足になり、前場引け（11:30）の値と比べることになる");
  L.push("- 当日の騰落率: 判定時点の終値 ÷ 前日終値（Yahoo の日足の終値）− 1");
  L.push("- VWAP乖離率: 判定時点の終値 ÷ 当日の VWAP − 1。VWAP は `analyze.js` の `calcVWAP()` を当日の足（判定時点まで）に当てたもの（`analyzeStock()` と同じ計算）");
  L.push("");

  L.push("## 1. 実装前確認の結果");
  L.push("");
  L.push("1. 銘柄群と呼び方: `scripts/score-parts-check.mjs` は、PR #88 の候補（前日の出来高上位" + NORMAL_VOL_TOP + "＋値上がり率上位" + CHANGE_TOP + "）を対象に、`api/stock.js` が返す形の payload を組み立て、`api/_scan.js` の `toPriceData()`・`normalizeStock()` を通して `analyzeStock(stock, pd, null, {})` を呼んでいる（VIX なし・opts は空）。`Date` は対象時刻に固定している。今回も同じ形で呼んだ。PR #90 のスクリプトは処理がすべて `main()` の中にあり import できないため、取得・候補作り・時計の差し替えを写した。検証日は PR #90 の36日（2026-07-31 〜 2026-09-24）ではなく、今回取得できた15分足で前の" + PRIOR_DAYS + "営業日が揃う日すべてにした（Yahoo の15分足は直近60日分しか返らないため）");
  L.push("2. 現在値の差し替え: `analyzeStock()` の現在値は `pd.currentPrice || closes[n]`、`toPriceData()` の `currentPrice` は `meta.regularMarketPrice || 最後の足の終値`。PR #90 と同じく `regularMarketPrice` に 0 を渡すと、渡した最後の足（判定時点の足）の終値になる。全 " + int(N) + "件で、返り値の現在値が判定時点の足の終値と一致した（不一致 " + priceMismatch + "件）");
  L.push("3. TOPIX の切り取り: `analyzeStock()` は `pd.topixChange`（TOPIX の前日比%）を1つの数として受け取るだけなので、判定時点の値を外から渡せる。Yahoo に TOPIX（^TOPX・998405.T）の15分足は無いが、TOPIX 連動ETF（1306.T）の15分足はあるため、判定時点までの最後の終値 ÷ 前日終値（日足）で判定時点の前日比を作って渡した。アプリ本番は立花証券の TOPIX 日足から前日比を取っており、場中にどの値が返るかはこのリポジトリからは確かめられない");
  L.push("4. 先読み: `analyzeStock()` は渡された配列の最後（`n = closes.length - 1`）までしか見ず、それより後を参照する箇所は無い。`Date.now()` は寄り付き後かどうかの判定（`currentSessionDate`）と、点数に関係しない買値プランの注意書きにだけ使われる。空の足の埋め方（`toPriceData()` の `fill`）は直前の値で埋める（先頭だけは最初の値）ので、渡した範囲より後の値は入らない。実行時の確認として、" + int(leakChecked) + "件の判定時点を抜き取り、判定時点より後の15分足（その銘柄と TOPIX）と当日以降の日足をでたらめな値に書き換えて計算し直した。スコア・各項目・S1・3つの騰落率・TOPIX 前日比が変わった判定時点は " + leakDiff + "件");
  L.push("5. Yahoo の15分足: 取得できた（" + periodStart + " 〜 " + periodEnd + " の " + refIx.dayList.length + "営業日分、" + REF_TICKER + " で確認）。1日の足は 9:00〜11:15 の10本、11:30 の前場引けの足（値が1つだけの足）、11:45〜12:15 の空の足（値が null）3本、12:30〜15:15 の12本で、実行日当日の分だけ 15:30 の大引けの足が付く");
  L.push("6. S1: `src/App.js` の `S1_LABELS` と `calcS1()` を範囲指定で読み、スクリプトに書き写した（App.js は import していない）。写しが App.js の該当部分と一字一句同じであることを実行時に確かめた（" + (s1CopyOk ? "一致" : "不一致") + "）");
  L.push("");
  L.push("そのほかの確認: 全判定時点で寄り付き後扱いになった（`sessionStarted` が false だった件数 " + sessionMismatch + "）。部品の点数の合計はすべてスコアと一致した（不一致 " + sumMismatch + "件）。`api/stock.js` の `toLocalDates()` の写しは一字一句同じ（" + (datesCopyOk ? "一致" : "不一致") + "）");
  L.push("");

  L.push("## 2. 件数と除外");
  L.push("");
  L.push("判定時点は、計算に使えた銘柄日の各15分足（昼休みの空の足 11:45〜12:15 は除く）。");
  L.push("");
  var totalPoints = N + skipPoint.lunch + skipPoint.close + skipPoint.nowNull + skipPoint.futMissing + skipPoint.noTopix + skipPoint.noPast + skipPoint.noVwap;
  L.push("| 区分 | 件数 | 理由 |");
  L.push("| --- | ---: | --- |");
  L.push("| 判定時点の候補 | " + int(totalPoints) + " | 計算に使えた " + int(stockDaysUsed) + "銘柄日の足 |");
  L.push("| 除外: 30分後が昼休み | " + int(skipPoint.lunch) + " | 11:00・11:15 の足と 11:30 の前場引けの足。30分後が昼休み（11:30〜12:30）にかかる |");
  L.push("| 除外: 30分後が大引けをまたぐ | " + int(skipPoint.close) + " | 15:00・15:15 の足（と実行日当日の 15:30 の足） |");
  L.push("| 除外: 判定時点の足に約定なし | " + int(skipPoint.nowNull) + " | その15分間に売買が無く、値が null の足 |");
  L.push("| 除外: 30分後の足が無い | " + int(skipPoint.futMissing) + " | 2本後の足が欠けている、または売買が無く値が null |");
  L.push("| 除外: TOPIX の値が無い | " + int(skipPoint.noTopix) + " | 判定時点までに 1306.T の当日の足が無い |");
  L.push("| 除外: 直近30分の騰落率が出せない | " + int(skipPoint.noPast) + " | 2本前の足が無い |");
  L.push("| 除外: VWAP が出せない | " + int(skipPoint.noVwap) + " | 当日の出来高が0 |");
  L.push("| **集計に使った判定時点** | **" + int(N) + "** | " + dayUsedSet.size + "営業日・" + tickerSet.size + "銘柄 |");
  L.push("");
  L.push("銘柄日ごと除外したもの（候補 " + int(stockDays) + "銘柄日のうち " + int(stockDays - stockDaysUsed) + "銘柄日。その日の値のある足 " + int(skipDayPoints) + "本ぶん。15分足が取れなかった銘柄日は本数を数えていない）:");
  L.push("");
  L.push("| 理由 | 銘柄日 |");
  L.push("| --- | ---: |");
  L.push("| 15分足が取れなかった（取得失敗 " + intradayFailed.length + "銘柄） | " + skipDay.noIntraday + " |");
  L.push("| その日の15分足が無い | " + skipDay.noTodayBars + " |");
  L.push("| 前営業日の15分足が無い | " + skipDay.noPrevBars + " |");
  L.push("| 渡す15分足が" + MIN_BARS + "本未満（PR #90 と同じ条件） | " + skipDay.fewBars + " |");
  L.push("| 前日終値（日足）が無い | " + skipDay.noPrevClose + " |");
  L.push("");
  var zoneCount = {};
  ZONES.forEach(function (z) { zoneCount[z.key] = recs.filter(function (r) { return r.zone === z.key; }).length; });
  L.push("時間帯別の件数（判定時点＝足の終わりの時刻で分ける）: " + ZONES.map(function (z) { return z.label + " " + int(zoneCount[z.key]) + "件"; }).join("、") +
    "。9:00〜9:59 は 9:00・9:15・9:30 の足（判定 9:15・9:30・9:45）、10:00〜11:29 は 9:45〜10:45 の足、後場は 12:30〜14:45 の足");
  L.push("");

  L.push("## 3. ベースライン");
  L.push("");
  L.push("| 範囲 | 件数 | 上がった | 変わらず | 下がった | 平均騰落率 |");
  L.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  L.push("| 全体 | " + int(base.n) + " | " + pct1(base.up) + " | " + pct1(base.flat) + " | " + pct1(base.down) + " | " + pct3(base.avg) + " |");
  ZONES.forEach(function (z) {
    var b = baseZone[z.key];
    L.push("| " + z.label + " | " + int(b.n) + " | " + pct1(b.up) + " | " + pct1(b.flat) + " | " + pct1(b.down) + " | " + pct3(b.avg) + " |");
  });
  L.push("");
  L.push("「変わらず」が多いのは、15分足2本ぶんの値動きが呼値（値段の刻み）1つに届かないことが多いため。上がった割合は「変わらず」も分母に含めた値なので、50%を下回るのが普通である。");
  L.push("");

  L.push("## 4. 項目ごとの一覧（ベースラインとの差が大きい順）");
  L.push("");
  L.push("- ベースラインとの差: 5等分したグループ（件数が全体の" + pct1(MIN_GROUP_SHARE).replace(".0", "") + "＝" + int(minGroup) + "件以上のもの）のうち、上がった割合がベースライン（" + pct1(base.up) + "）から最も離れたグループの差");
  L.push("- 上位−下位: 値が最も大きいグループ（空でないもの）と最も小さいグループの差");
  L.push("- 日ごとの一貫性: その日の上位グループ（値が最も大きいグループ）の平均騰落率が、下位グループ（値が最も小さいグループ）より良かった日の割合。グループは全期間で5等分したものを使い、両方に判定時点がある日だけ数えた。偶然なら50%前後になる");
  L.push("- t値: 日ごとの「上位−下位の平均騰落率の差」の平均 ÷ 標準誤差。日をまたいで同じ向きの差が出ているかの目安で、絶対値が2を超えると偶然では出にくい");
  L.push("");
  L.push("| 順位 | 項目 | 差が最大のグループ | そのグループの上がった割合 | ベースラインとの差 | 平均騰落率の差 | 上位−下位（上がった割合） | 上位−下位（平均騰落率） | 相関係数 | 日ごとの一貫性 | t値 |");
  L.push("| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  ranked.forEach(function (r, k) {
    var m = r.maxDev;
    L.push("| " + (k + 1) + " | " + r.item.label + " | " + (m ? bandName(m.k) + "（" + int(m.g.n) + "件）" : "-") + " | " + (m ? pct1(m.g.up) : "-") + " | " + (m ? pt1(m.dev) : "-") + " | " + (m ? pct3(m.avgDev) : "-") +
      " | " + pt1(r.spreadUp) + " | " + pct3(r.spreadAvg) + " | " + num3(r.corr) + " | " + (r.dayDays ? pct1(r.dayShare) + "（" + r.dayBetter + "/" + r.dayDays + "日）" : "-") + " | " + num2(r.ddT) + " |");
  });
  L.push("");

  L.push("## 5. 相関係数");
  L.push("");
  L.push("| 項目 | 全体 | " + ZONES.map(function (z) { return z.label; }).join(" | ") + " |");
  L.push("| --- | ---: | " + ZONES.map(function () { return "---:"; }).join(" | ") + " |");
  results.forEach(function (r) {
    L.push("| " + r.item.label + " | " + num3(r.corr) + " | " + ZONES.map(function (z) { return num3(r.byZone[z.key].corr); }).join(" | ") + " |");
  });
  L.push("");

  L.push("## 6. 項目ごとの5等分（全時間帯）");
  L.push("");
  L.push("G1 が値の最も小さいグループ、G5 が最も大きいグループ。空のグループは「-」。");
  L.push("");
  results.forEach(function (r) {
    L.push("### " + r.item.label);
    L.push("");
    L.push("| グループ | 値の範囲 | 件数 | 上がった | 変わらず | 下がった | 平均騰落率 |");
    L.push("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
    r.q.stats.forEach(function (g, k) {
      if (!g.n) { L.push("| " + bandName(k) + " | - | 0 | - | - | - | - |"); return; }
      var range = g.min === g.max ? fmtVal(r.item, g.min) : fmtVal(r.item, g.min) + " 〜 " + fmtVal(r.item, g.max);
      L.push("| " + bandName(k) + " | " + range + " | " + int(g.n) + " | " + pct1(g.up) + " | " + pct1(g.flat) + " | " + pct1(g.down) + " | " + pct3(g.avg) + " |");
    });
    L.push("");
  });

  L.push("## 7. 項目ごとの5等分（時間帯別）");
  L.push("");
  L.push("時間帯ごとに5等分し直した。各欄は「上がった割合 / 平均騰落率 / 件数」。各時間帯のベースライン: " + ZONES.map(function (z) { return z.label + " " + pct1(baseZone[z.key].up) + " / " + pct3(baseZone[z.key].avg); }).join("、") + "。");
  L.push("");
  results.forEach(function (r) {
    L.push("### " + r.item.label);
    L.push("");
    L.push("| グループ | " + ZONES.map(function (z) { return z.label; }).join(" | ") + " |");
    L.push("| --- | " + ZONES.map(function () { return "---"; }).join(" | ") + " |");
    for (var k = 0; k < NBANDS; k++) {
      L.push("| " + bandName(k) + " | " + ZONES.map(function (z) {
        var g = r.byZone[z.key].q.stats[k];
        return g.n ? pct1(g.up) + " / " + pct3(g.avg) + " / " + int(g.n) : "-";
      }).join(" | ") + " |");
    }
    L.push("");
  });

  L.push("## 8. 日ごとの一貫性");
  L.push("");
  L.push("| 項目 | 上位グループ | 下位グループ | 上位の方が良かった日 | 割合 | 上位−下位の平均騰落率（日ごとの平均） | t値 |");
  L.push("| --- | --- | --- | ---: | ---: | ---: | ---: |");
  results.forEach(function (r) {
    if (!r.dayDays) { L.push("| " + r.item.label + " | - | - | - | - | - | - |"); return; }
    L.push("| " + r.item.label + " | " + bandName(r.hi) + " | " + bandName(r.lo) + " | " + r.dayBetter + "/" + r.dayDays + "日 | " + pct1(r.dayShare) + " | " + pct3(r.ddMean) + " | " + num2(r.ddT) + " |");
  });
  L.push("");

  L.push("## 9. 注意点");
  L.push("");
  L.push("- 同じ日の判定時点は、相場全体の上げ下げを共有しているため互いに独立ではない。件数が多くても、日をまたいで同じ向きの差が出ているか（8章）を合わせて見ること");
  L.push("- 30分後の騰落率は売買コストを引いていない。往復0.1%のコストは、ここで出ている平均騰落率の差より大きいことが多い");
  L.push("- TOPIX は連動ETF（1306.T）の値で代用した。本番の立花証券の TOPIX 前日比とは場中の値の取り方が違う可能性がある");
  L.push("- 銘柄群は前日の出来高・値上がり率の上位で、売買が活発な銘柄に偏っている。全銘柄に当てはまるとは限らない");
  L.push("");

  var outPath = fileURLToPath(new URL("../docs/thirty-min-result.md", import.meta.url));
  writeFileSync(outPath, L.join("\n") + "\n");
  console.log("\n→ " + outPath);
};

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
