// scripts/signal-rise-check.mjs
// 場中に株価が上がり始める前に、アプリのスコア（src/lib/analyze.js の analyzeStock）のどの項目の点数が
// 上がり始めているかを、過去の15分足で確かめる。アプリ本体とは無関係の単発検証スクリプト。
//
// 判定時点 t: 各営業日の 9:30〜14:45 の15分ごと。t より前に終わった足（開始時刻が t より前の足）だけを
//             analyzeStock に渡し、時計を t に固定する。
// 比べ方    : breakdown の各項目と総合スコアを、同じ日の t の15分前の値と比べ「上がった／変わらない／下がった」に分ける。
// 買い方    : すぐ買う＝t に始まる足の始値。15分遅れ＝t の15分後に始まる足の始値。シグナルはどちらも t の時点のもの。
// 売り方    : 買った足から後の高値・安値で、+2.0% と −0.75% のどちらに先に届いたか。同じ足で両方なら判定不能。
//             どちらにも届かなければ大引け（日足の終値。無ければ15分足の最後の終値）。手数料は引かない。
// 先読みの禁止: t より後の足・当日以降の日足は計算に一切渡さない。実行時に、t より後の値をでたらめな値に
//             書き換えて計算し直し、点数が1件も変わらないことを抜き取りで確かめる（leakCheck）。
//
// 銘柄群・analyzeStock の呼び方・時計の差し替え・先読み検査は scripts/thirty-min-check.mjs（PR #101）と同じ。
// 元のスクリプトは処理がすべて main() の中にあり import できないため、必要な部分を写した（元のファイルは変更しない）。
//   - 銘柄群: 日ごとに、前日の確定値で出来高上位40と、値上がり率上位20（出来高が全銘柄の中央値の1.5倍以上）を重複なしで並べたもの
//   - 呼び方: api/stock.js が返す形の payload を組み立て、api/_scan.js の toPriceData・normalizeStock を通し、
//            自動スキャンと同じく VIX なし・opts は空で呼ぶ
//
// データ:
//   - 日本株の15分足・日足: daytrade-data リポジトリの data/15m・data/1d（読み取りのみ）。
//     環境変数 SIGNAL_RISE_DATA に、daytrade-data を取得したディレクトリ（リポジトリの外）を指定する
//   - TOPIX の代わりの 1306.T（TOPIX 連動ETF）の15分足・日足: daytrade-data に無いため Yahoo から取得する
//     （15分足は直近60営業日分しか返らない）
// 新しい npm パッケージは使わず、既存の依存関係に含まれる @upstash/redis（api/_scan.js の読み込みに必要）と
// Node 標準の fetch・zlib のみを使う。
//
// 実行: SIGNAL_RISE_DATA=<daytrade-data のディレクトリ> node scripts/signal-rise-check.mjs
// 出力: docs/signal-rise-result.md
//
// 任意: 環境変数 SIGNAL_RISE_CACHE にディレクトリを指定すると、Yahoo の取得結果（1306.T）を
//       そこに JSON で保存し、次回以降はそれを読む。取得結果はリポジトリの外に置くこと（commit しない）

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { analyzeStock } from "../src/lib/analyze.js";

// ---------- PR #101 と同じ設定 ----------

var YAHOO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};
var RETRY_WAITS = [5000, 10000, 20000, 40000, 80000];
var ERROR_RETRY_WAITS = [3000, 6000];

var MIN_BARS = 600;   // スコア計算に渡す15分足が600本以上ある場合だけ計算する
var PRIOR_DAYS = 29;  // 当日（t まで）＋その前の29取引日を渡す（api/stock.js の range=30d と同じ長さ）
var TOPIX_PROXY = "1306.T";

var NORMAL_VOL_TOP = 40;
var CHANGE_TOP = 20;
var VOL_MULT = 1.5;

var PART_LABELS = [
  "VWAP", "VWAP傾き", "Pivot", "ATR(値幅)", "ATR消化率", "対TOPIX", "トレンド", "EMA整列", "MACD", "RSI",
  "BB", "Stoch", "重複ボーナス", "出来高/OBV", "ギャップ", "当日ブレイク", "寄り付きレンジ", "コンフルエンス",
  "実績反映調整", "上限抑制(下降/デッドクロス/VWAP)", "VIXキャップ",
];

// ---------- 今回の設定 ----------

var BAR_FIRST = 9 * 60;        // 1日の最初の足の開始（9:00）
var BAR_COUNT = 26;            // 9:00〜15:15 開始の26本（daytrade-data の15分足の1日分）
var STEP_MIN = 15;
var T_FIRST = 9 * 60 + 30;     // 判定時点の最初（9:30）
var T_LAST = 14 * 60 + 45;     // 判定時点の最後（14:45）
var TAKE = 0.02;               // 利確 +2.0%
var STOP = 0.0075;             // 損切り −0.75%
var DELTA_EPS = 1e-9;          // 点数の差がこれ以下なら「変わらない」
var MIN_DAYS = 25;             // 判定に使える日数の下限（これ未満なら止める）
var PASS_DIFF = 0.05;          // 合格ライン1: 先着率の差 5ポイント以上
var LEAK_SAMPLES = 300;        // 先読み検査で計算し直す判定時点の数
// 分割・併合の疑い: 前日終値に対する値段の比がこの範囲を外れる日が窓（前の29取引日と当日の寄り）にあれば、
// 銘柄日ごと外す。daytrade-data は保存した時点の値段で固定されており、後から分割があっても過去の値段は直らないため
var SPLIT_LO = 0.6, SPLIT_HI = 1.6;
// 大引けの手じまいに日足の終値を使うのは、15分足の最後の終値との差がこの割合以内のときだけ
// （daytrade-data の日足には、値段が桁違いになっている行が少数あるため）
var CLOSE_GAP_MAX = 0.2;

var METHODS = [
  { key: "now", label: "すぐ買う", lag: 0, desc: "t に始まる15分足の始値で買う" },
  { key: "lag", label: "15分遅れ", lag: 1, desc: "t の15分後に始まる15分足の始値で買う" },
];
var GROUPS = [
  { key: "up", label: "上がった" },
  { key: "flat", label: "変わらない" },
  { key: "down", label: "下がった" },
  { key: "notUp", label: "上がらなかった（変わらない＋下がった）" },
];

var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
var isNum = function (v) { return typeof v === "number" && isFinite(v); };
var hm = function (m) { return Math.floor(m / 60) + ":" + String(m % 60).padStart(2, "0"); };
var hm2 = function (m) { return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); };

var loadScanModule = async function () {
  var warn = console.warn;
  console.warn = function () {};
  try {
    return await import("../api/_scan.js");
  } finally {
    console.warn = warn;
  }
};

// ---------- 時計の差し替え（PR #101 と同じ） ----------

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

// ---------- Yahoo の取得（PR #101 と同じ。1306.T だけに使う） ----------

var parseChart = function (json) {
  var result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result || !result.timestamp) return null;
  var q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  var off = (result.meta && result.meta.gmtoffset != null ? result.meta.gmtoffset : 32400) * 1000;
  var rows = [];
  for (var i = 0; i < result.timestamp.length; i++) {
    var iso = new RealDate(result.timestamp[i] * 1000 + off).toISOString();
    rows.push({
      date: iso.slice(0, 10),
      min: Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16)),
      open: q.open ? q.open[i] : null,
      high: q.high ? q.high[i] : null,
      low: q.low ? q.low[i] : null,
      close: q.close ? q.close[i] : null,
      volume: q.volume ? q.volume[i] : null,
    });
  }
  return rows;
};

var fetchChart = async function (ticker, query) {
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
      data = parseChart(await r.json());
    } catch (e) {
      out = { error: "JSON 解析失敗" };
      break;
    }
    out = !data || !data.length ? { error: "データなし" } : { data: data };
  }
  return out;
};

var cachedFetch = async function (cacheDir, fileName, ticker, query) {
  var cachePath = cacheDir ? join(cacheDir, fileName.replace(/[^A-Za-z0-9._^-]/g, "_")) : null;
  if (cachePath && existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, "utf8"));
  var res = await fetchChart(ticker, query);
  res.fetchedAt = new RealDate().toISOString();
  if (cachePath && !res.error) writeFileSync(cachePath, JSON.stringify(res));
  return res;
};

// ---------- daytrade-data の読み込み ----------

var numOrNull = function (s) { return s === "" || s == null ? null : Number(s); };

var readCsvGz = function (path) {
  var lines = gunzipSync(readFileSync(path)).toString("utf8").split("\n");
  var head = lines[0].split(",");
  return { head: head, lines: lines.slice(1).filter(function (x) { return x.length; }) };
};

var listDays = function (dir) {
  var out = [];
  readdirSync(dir).forEach(function (y) {
    readdirSync(join(dir, y)).forEach(function (f) {
      var m = f.match(/^(\d{4}-\d{2}-\d{2})\.csv\.gz$/);
      if (m) out.push({ date: m[1], path: join(dir, y, f) });
    });
  });
  return out.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
};

// ---------- 統計 ----------

var mean = function (a) { return a.reduce(function (s, v) { return s + v; }, 0) / a.length; };

var pct1 = function (v) { return isNum(v) ? (v * 100).toFixed(1) + "%" : "-"; };
var pct3 = function (v) { return isNum(v) ? (v >= 0 ? "+" : "") + (v * 100).toFixed(3) + "%" : "-"; };
var pt1 = function (v) { return isNum(v) ? (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "pt" : "-"; };
var num2 = function (v) { return isNum(v) ? v.toFixed(2) : "-"; };
var int = function (v) { return Number(v).toLocaleString("en-US"); };

// ---------- 候補の作り方（PR #101 と同じ） ----------

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

// ---------- 成績の集計 ----------

// xs: { res: "win"|"loss"|"close"|"amb", pnl, day } の並び。判定不能（amb）は件数だけ数えて外す
var outcomeStats = function (xs) {
  var n = 0, amb = 0, win = 0, sum = 0;
  var byDay = new Map();
  xs.forEach(function (x) {
    if (x.res === "amb") { amb++; return; }
    n++;
    if (x.res === "win") win++;
    sum += x.pnl;
    var d = byDay.get(x.day);
    if (!d) { d = { n: 0, win: 0, sum: 0 }; byDay.set(x.day, d); }
    d.n++;
    if (x.res === "win") d.win++;
    d.sum += x.pnl;
  });
  var dayRates = [], dayAvgs = [];
  byDay.forEach(function (d) { dayRates.push(d.win / d.n); dayAvgs.push(d.sum / d.n); });
  return {
    n: n, amb: amb, win: win,
    rate: n ? win / n : NaN,
    avg: n ? sum / n : NaN,
    days: byDay.size,
    dayRate: dayRates.length ? mean(dayRates) : NaN,
    dayAvg: dayAvgs.length ? mean(dayAvgs) : NaN,
  };
};

// ---------- 本体 ----------

var main = async function () {
  var startedAt = RealDate.now();
  var dataDir = process.env.SIGNAL_RISE_DATA;
  if (!dataDir) throw new Error("環境変数 SIGNAL_RISE_DATA に daytrade-data のディレクトリを指定すること");
  var cacheDir = process.env.SIGNAL_RISE_CACHE || null;
  if (cacheDir) mkdirSync(cacheDir, { recursive: true });
  var dataRev = null;
  try {
    dataRev = execFileSync("git", ["-C", dataDir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch (e) {
    dataRev = null;
  }

  var scan = await loadScanModule();
  var runDate = new RealDate(RealDate.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

  // 1. 日足（daytrade-data の data/1d。全銘柄）
  var d1Files = listDays(join(dataDir, "data/1d"));
  var d1Days = d1Files.map(function (f) { return f.date; });
  var d1Index = new Map();
  d1Days.forEach(function (d, j) { d1Index.set(d, j); });
  var daily = d1Files.map(function (f) {
    var csv = readCsvGz(f.path);
    var h = csv.head;
    var iC = h.indexOf("code"), iO = h.indexOf("open"), iCl = h.indexOf("close"), iA = h.indexOf("adjclose"), iV = h.indexOf("volume");
    if (iC < 0 || iCl < 0 || iA < 0 || iV < 0) throw new Error("日足の列が想定と違う: " + f.path);
    var m = new Map();
    csv.lines.forEach(function (ln) {
      var p = ln.split(",");
      m.set(p[iC], { open: numOrNull(p[iO]), close: numOrNull(p[iCl]), adj: numOrNull(p[iA]), volume: numOrNull(p[iV]) });
    });
    return m;
  });
  var allCodes = new Set();
  daily.forEach(function (m) { m.forEach(function (_, c) { allCodes.add(c); }); });
  var codeList = Array.from(allCodes).sort();
  var codeIdx = new Map();
  codeList.forEach(function (c, i) { codeIdx.set(c, i); });
  console.log("日足: " + d1Days.length + "日（" + d1Days[0] + " 〜 " + d1Days[d1Days.length - 1] + "）・" + codeList.length + "銘柄");

  // 2. 15分足の日の一覧（中身はあとで対象銘柄だけ読む）
  var m15Files = listDays(join(dataDir, "data/15m"));
  var m15Days = m15Files.map(function (f) { return f.date; });
  var m15Set = new Set(m15Days);
  console.log("15分足: " + m15Days.length + "日（" + m15Days[0] + " 〜 " + m15Days[m15Days.length - 1] + "）");

  // 3. 1306.T（Yahoo）
  var tpx15 = await cachedFetch(cacheDir, TOPIX_PROXY + ".15m.json", TOPIX_PROXY, "interval=15m&range=60d");
  if (tpx15.error) throw new Error(TOPIX_PROXY + " の15分足: " + tpx15.error);
  await sleep(300);
  var tpx1d = await cachedFetch(cacheDir, TOPIX_PROXY + ".json", TOPIX_PROXY, "interval=1d&range=6mo");
  if (tpx1d.error) throw new Error(TOPIX_PROXY + " の日足: " + tpx1d.error);
  var tpxDay = new Map(); // 日付 → その日の15分足 [{ min, close }]
  tpx15.data.forEach(function (r) {
    if (!tpxDay.has(r.date)) tpxDay.set(r.date, []);
    tpxDay.get(r.date).push({ min: r.min, close: r.close });
  });
  var tpxDaily = new Map();
  tpx1d.data.forEach(function (r) { tpxDaily.set(r.date, r.close); });
  var tpxDays = Array.from(tpxDay.keys()).sort();
  console.log(TOPIX_PROXY + " 15分足: " + tpxDays.length + "日（" + tpxDays[0] + " 〜 " + tpxDays[tpxDays.length - 1] + "）");

  // ---------- 判定に使う日 ----------
  // 15分足に、その日と、その前の29取引日（日足の取引日で数える）がすべて揃い、
  // 1306.T にその日の15分足と前日の日足がある日
  var warmDays = [];
  var noTopixDays = [];
  m15Days.forEach(function (d) {
    var t = d1Index.get(d);
    if (t == null || t < PRIOR_DAYS || t < 2) return;
    for (var k = 1; k <= PRIOR_DAYS; k++) if (!m15Set.has(d1Days[t - k])) return;
    warmDays.push(d);
  });
  var evalDays = [];
  warmDays.forEach(function (d) {
    var t = d1Index.get(d);
    if (!tpxDay.has(d) || !isNum(tpxDaily.get(d1Days[t - 1]))) { noTopixDays.push(d); return; }
    evalDays.push({ date: d, t: t });
  });
  console.log("助走（前の" + PRIOR_DAYS + "取引日）が揃う日 " + warmDays.length + "日 / そのうち 1306.T もある日 " + evalDays.length + "日");
  if (evalDays.length < MIN_DAYS) throw new Error("判定に使える日数が " + evalDays.length + "日で " + MIN_DAYS + "日未満");
  var half = Math.floor(evalDays.length / 2);
  evalDays.forEach(function (ed, i) { ed.half = i < half ? 0 : 1; ed.idx = i; });

  // ---------- 日ごとの候補（PR #101 と同じ。前日までの確定値だけで決まる） ----------

  evalDays.forEach(function (ed) {
    var p1m = daily[ed.t - 1], p2m = daily[ed.t - 2];
    var pop = [];
    p1m.forEach(function (p1, code) {
      var p2 = p2m.get(code);
      if (!p2 || !isNum(p1.adj) || !isNum(p2.adj) || p2.adj <= 0 || !isNum(p1.volume)) return;
      pop.push({ idx: codeIdx.get(code), prevVol: p1.volume, prevRet: p1.adj / p2.adj - 1 });
    });
    ed.cands = buildCandidates(pop, NORMAL_VOL_TOP).all.map(function (i) { return codeList[i]; });
  });
  var targetSet = new Set();
  evalDays.forEach(function (ed) { ed.cands.forEach(function (c) { targetSet.add(c); }); });
  var candStockDays = evalDays.reduce(function (s, ed) { return s + ed.cands.length; }, 0);
  console.log("候補: " + int(candStockDays) + "銘柄日（1日平均 " + (candStockDays / evalDays.length).toFixed(1) + "）・" + targetSet.size + "銘柄");

  // ---------- 15分足（対象銘柄だけ） ----------
  // bars15.get(code).get(date) = その日の行 [{ min, o, h, l, c, v }]
  var bars15 = new Map();
  targetSet.forEach(function (c) { bars15.set(c, new Map()); });
  var firstNeeded = d1Days[evalDays[0].t - PRIOR_DAYS];
  m15Files.forEach(function (f) {
    if (f.date < firstNeeded) return;
    var csv = readCsvGz(f.path);
    var h = csv.head;
    var iC = h.indexOf("code"), iT = h.indexOf("time"), iO = h.indexOf("open"), iH = h.indexOf("high"), iL = h.indexOf("low"), iCl = h.indexOf("close"), iV = h.indexOf("volume");
    if (iC < 0 || iT < 0 || iO < 0 || iH < 0 || iL < 0 || iCl < 0 || iV < 0) throw new Error("15分足の列が想定と違う: " + f.path);
    csv.lines.forEach(function (ln) {
      var comma = ln.indexOf(",");
      var m = bars15.get(ln.slice(0, comma));
      if (!m) return;
      var p = ln.split(",");
      if (!m.has(f.date)) m.set(f.date, []);
      m.get(f.date).push({ min: Number(p[iT].slice(0, 2)) * 60 + Number(p[iT].slice(3, 5)), o: numOrNull(p[iO]), h: numOrNull(p[iH]), l: numOrNull(p[iL]), c: numOrNull(p[iCl]), v: numOrNull(p[iV]) });
    });
  });
  console.log("15分足の読み込み完了（" + ((RealDate.now() - startedAt) / 1000).toFixed(0) + "秒）");

  // ---------- 判定時点ごとの計算 ----------

  var T_LIST = [];
  for (var tm = T_FIRST; tm <= T_LAST; tm += STEP_MIN) T_LIST.push(tm);

  // api/stock.js の fetchJPPayload が返す形に組み立てる（PR #101 と同じ形。現在値は 0 を渡して最後の足の終値にする）
  var buildPayload = function (src, end, officialPrevClose, topixChange) {
    var sl = function (a) { return a.slice(0, end); };
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
              close: sl(src.c), high: sl(src.h), low: sl(src.l), volume: sl(src.v), open: sl(src.o),
              date: sl(src.dates),
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

  // t の時点の TOPIX 前日比（%）。その日の 1306.T の15分足のうち、開始時刻が t より前の足の最後の終値 ÷ 前日終値（日足）
  var topixChangeAt = function (dayBars, tMin, prevClose) {
    if (!dayBars || !isNum(prevClose) || prevClose <= 0) return null;
    var last = null;
    dayBars.forEach(function (b) { if (b.min < tMin && b.close != null) last = b.close; });
    return last == null ? null : (last / prevClose - 1) * 100;
  };

  // 1つの判定時点の点数。src は窓の15分足（先読み検査ではでたらめな値に書き換えたものを渡す）。
  // end は渡す足の本数（開始時刻が t より前の足まで）
  var evalPoint = function (code, src, end, date, tMin, prevDailyClose, topixBars, topixPrev) {
    var topixChange = topixChangeAt(topixBars, tMin, topixPrev);
    if (topixChange == null) return { skip: "noTopix" };
    var pd = scan.toPriceData(buildPayload(src, end, prevDailyClose, topixChange));
    var clockMs = RealDate.parse(date + "T" + hm2(tMin) + ":00+09:00");
    var a = withClock(clockMs, function () { return analyzeStock(scan.normalizeStock(code + ".T"), pd, null, {}); });
    var parts = {};
    PART_LABELS.forEach(function (lb) { parts[lb] = 0; });
    var partSum = 0, unknown = null;
    a.breakdown.forEach(function (b) {
      if (!(b.label in parts)) unknown = b.label;
      parts[b.label] = (parts[b.label] || 0) + b.delta;
      partSum += b.delta;
    });
    return {
      rec: {
        score: a.score, parts: parts, topix: topixChange,
        sessionStarted: a.sessionStarted,
        partSumOk: Math.abs(partSum - a.score) < 1e-9,
        unknown: unknown,
      },
    };
  };

  // 売り方: today の kBuy 本目の始値で買い、+2.0% と −0.75% のどちらに先に届いたか
  var simulate = function (today, kBuy, dayClose) {
    if (kBuy >= today.length) return null;
    var entry = today[kBuy].o;
    if (!isNum(entry) || entry <= 0) return null;
    var up = entry * (1 + TAKE), dn = entry * (1 - STOP);
    var lastClose = null;
    for (var k = kBuy; k < today.length; k++) {
      var b = today[k];
      if (b.c != null) lastClose = b.c;
      if (b.h == null || b.l == null) continue;
      var hitUp = b.h >= up - 1e-9, hitDn = b.l <= dn + 1e-9;
      if (hitUp && hitDn) return { res: "amb", pnl: null, entry: entry };
      if (hitUp) return { res: "win", pnl: TAKE, entry: entry };
      if (hitDn) return { res: "loss", pnl: -STOP, entry: entry };
    }
    var byDaily = isNum(dayClose) && dayClose > 0 && Math.abs(dayClose / lastClose - 1) <= CLOSE_GAP_MAX;
    var exit = byDaily ? dayClose : lastClose;
    return { res: "close", pnl: exit / entry - 1, entry: entry, byDaily: byDaily, dailyBad: isNum(dayClose) && dayClose > 0 && !byDaily };
  };

  var skipDay = { noTodayBars: 0, badTodayBars: 0, noPrevBars: 0, fewBars: 0, noPrevClose: 0, splitSuspect: 0 };
  var skipPoint = { noTopix: 0 };
  var splitDates = new Map(); // 分割・併合の疑いで外した銘柄日の、値段が飛んだ日 → 銘柄日数
  var stockDaysUsed = 0, calls = 0;
  var pointRecs = 0;
  var samples = []; // 比べられた判定時点（銘柄日・t）
  var noPrevPoint = 0;
  var notBuyable = { now: 0, lag: 0 };
  var closeByDaily = { now: 0, closeAll: 0, lag: 0, closeAllLag: 0 };
  var leakPool = [];
  var sessionMismatch = 0, sumMismatch = 0, unknownLabels = new Set();
  var calcStart = RealDate.now();

  evalDays.forEach(function (ed, edi) {
    var date = ed.date, t = ed.t;
    var tpxBars = tpxDay.get(date);
    var tpxPrev = tpxDaily.get(d1Days[t - 1]);
    ed.cands.forEach(function (code) {
      var byDate = bars15.get(code);
      var today = byDate.get(date);
      if (!today) { skipDay.noTodayBars++; return; }
      // その日の足が 9:00〜15:15 の26本そろっていること（判定時点の位置を時刻で決めるため）
      var okTimes = today.length === BAR_COUNT && today.every(function (b, k) { return b.min === BAR_FIRST + k * STEP_MIN; });
      if (!okTimes) { skipDay.badTodayBars++; return; }
      if (!byDate.has(d1Days[t - 1])) { skipDay.noPrevBars++; return; }
      var src = { o: [], h: [], l: [], c: [], v: [], dates: [] };
      for (var k = PRIOR_DAYS; k >= 1; k--) {
        var pdDate = d1Days[t - k];
        var rows = byDate.get(pdDate);
        if (!rows) continue;
        rows.forEach(function (b) { src.o.push(b.o); src.h.push(b.h); src.l.push(b.l); src.c.push(b.c); src.v.push(b.v); src.dates.push(pdDate); });
      }
      var priorLen = src.c.length;
      if (priorLen + 1 < MIN_BARS) { skipDay.fewBars++; return; }
      var pPrev = daily[t - 1].get(code);
      var prevDailyClose = pPrev && isNum(pPrev.close) && pPrev.close > 0 ? pPrev.close : null;
      if (prevDailyClose == null) { skipDay.noPrevClose++; return; }
      // 分割・併合の疑い（前の29取引日の日足の終値の前日比と、当日の寄り（9:00 の足の始値）の前日比）
      var suspect = null;
      for (var k2 = PRIOR_DAYS - 1; k2 >= 1 && !suspect; k2--) {
        var a0 = daily[t - k2 - 1].get(code), a1 = daily[t - k2].get(code);
        if (a0 && a1 && isNum(a0.close) && isNum(a1.close) && a0.close > 0) {
          var rr = a1.close / a0.close;
          if (rr < SPLIT_LO || rr > SPLIT_HI) suspect = d1Days[t - k2];
        }
      }
      if (!suspect && isNum(today[0].o)) {
        var ro = today[0].o / prevDailyClose;
        if (ro < SPLIT_LO || ro > SPLIT_HI) suspect = date + "（当日の寄り）";
      }
      if (suspect) { skipDay.splitSuspect++; splitDates.set(suspect, (splitDates.get(suspect) || 0) + 1); return; }
      stockDaysUsed++;
      today.forEach(function (b) { src.o.push(b.o); src.h.push(b.h); src.l.push(b.l); src.c.push(b.c); src.v.push(b.v); src.dates.push(date); });
      var dTodayRow = daily[t].get(code);
      var dayClose = dTodayRow && isNum(dTodayRow.close) ? dTodayRow.close : null;

      var prevRec = null, prevT = null;
      T_LIST.forEach(function (tMin) {
        var kT = (tMin - BAR_FIRST) / STEP_MIN; // t に始まる足の位置（当日の何本目か）
        var end = priorLen + kT;                // 開始時刻が t より前の足まで
        calls++;
        var r = evalPoint(code, src, end, date, tMin, prevDailyClose, tpxBars, tpxPrev);
        if (r.skip) { skipPoint[r.skip]++; prevRec = null; return; }
        var rec = r.rec;
        pointRecs++;
        if (!rec.sessionStarted) sessionMismatch++;
        if (!rec.partSumOk) sumMismatch++;
        if (rec.unknown) unknownLabels.add(rec.unknown);
        if (prevRec && prevT === tMin - STEP_MIN) {
          var s = {
            day: edi, half: ed.half, code: code, t: tMin,
            score: rec.score, prevScore: prevRec.score, parts: rec.parts, prevParts: prevRec.parts,
            out: {},
          };
          METHODS.forEach(function (mt) {
            var o = simulate(today, kT + mt.lag, dayClose);
            if (!o) { notBuyable[mt.key]++; return; }
            s.out[mt.key] = o;
          });
          samples.push(s);
          leakPool.push({ code: code, src: src, end: end, date: date, tMin: tMin, t: t, prevDailyClose: prevDailyClose, rec: rec });
        } else {
          noPrevPoint++;
        }
        prevRec = rec;
        prevT = tMin;
      });
    });
    if ((edi + 1) % 5 === 0) console.log("  計算 " + (edi + 1) + "/" + evalDays.length + "日（analyzeStock " + int(calls) + "回・" + ((RealDate.now() - calcStart) / 1000).toFixed(0) + "秒）");
  });
  var calcSec = (RealDate.now() - calcStart) / 1000;
  console.log("analyzeStock " + int(calls) + "回・" + calcSec.toFixed(0) + "秒 / 比べられた判定時点 " + int(samples.length) + "件");
  if (unknownLabels.size) throw new Error("PART_LABELS に無い部品: " + Array.from(unknownLabels).join(", "));
  if (sumMismatch) throw new Error("部品の点数の合計がスコアと一致しない判定時点がある: " + sumMismatch);
  if (sessionMismatch) throw new Error("寄り付き後扱いにならなかった判定時点がある: " + sessionMismatch);

  // ---------- 先読み検査 ----------
  // 抜き取った判定時点について、t 以降に始まる15分足（その銘柄・1306.T）と、当日以降の日足（その銘柄・1306.T）を
  // でたらめな値に書き換えてから計算し直し、総合スコアと各項目の点数が変わらないことを確かめる
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
    var s0 = lp.src;
    var src2 = { o: scramble(s0.o, lp.end), h: scramble(s0.h, lp.end), l: scramble(s0.l, lp.end), c: scramble(s0.c, lp.end), v: scramble(s0.v, lp.end), dates: s0.dates };
    var tpx2 = tpxDay.get(lp.date).map(function (b) { return b.min < lp.tMin ? b : { min: b.min, close: b.close == null ? null : b.close * (0.5 + rnd()) }; });
    // 当日以降の日足を書き換えた写し（前日終値は書き換えない日から取り直す）
    var dailyCopy = daily.map(function (m, j) {
      if (j < lp.t) return m;
      var row = m.get(lp.code);
      var row2 = row ? Object.assign({}, row, { close: isNum(row.close) ? row.close * (0.5 + rnd()) : row.close }) : row;
      return { get: function (c) { return c === lp.code ? row2 : m.get(c); } };
    });
    var tpxDaily2 = new Map(tpxDaily);
    tpxDaily2.forEach(function (v, d) { if (d >= lp.date && isNum(v)) tpxDaily2.set(d, v * (0.5 + rnd())); });
    var pPrev2 = dailyCopy[lp.t - 1].get(lp.code);
    var r2 = evalPoint(lp.code, src2, lp.end, lp.date, lp.tMin, pPrev2.close, tpx2, tpxDaily2.get(d1Days[lp.t - 1]));
    var a0 = lp.rec, a1 = r2.rec;
    var same = !!a1 && a0.score === a1.score && a0.topix === a1.topix &&
      PART_LABELS.every(function (lb) { return a0.parts[lb] === a1.parts[lb]; });
    if (!same) leakDiff++;
    leakChecked++;
  }
  console.log("先読み検査 " + leakChecked + "件（結果が変わった " + leakDiff + "件）");
  if (leakDiff) throw new Error("t より後のデータを書き換えると点数が変わる判定時点がある: " + leakDiff);

  // ---------- 集計 ----------

  var tickerSet = new Set(samples.map(function (s) { return s.code; }));
  var partInfo = PART_LABELS.map(function (lb) {
    var alwaysZero = samples.every(function (s) { return s.parts[lb] === 0 && s.prevParts[lb] === 0; });
    return { label: lb, alwaysZero: alwaysZero };
  });
  var ITEMS = [{ key: "score", label: "総合スコア", now: function (s) { return s.score; }, prev: function (s) { return s.prevScore; } }];
  partInfo.forEach(function (p) {
    if (p.alwaysZero) return;
    ITEMS.push({ key: "part:" + p.label, label: p.label, now: function (s) { return s.parts[p.label]; }, prev: function (s) { return s.prevParts[p.label]; } });
  });
  var groupOf = function (item, s) {
    var d = item.now(s) - item.prev(s);
    return d > DELTA_EPS ? "up" : (d < -DELTA_EPS ? "down" : "flat");
  };
  var inGroup = function (g, gk) { return gk === "notUp" ? g !== "up" : g === gk; };

  var report = {};
  METHODS.forEach(function (mt) {
    var ms = samples.filter(function (s) { return s.out[mt.key]; });
    var toX = function (s) { var o = s.out[mt.key]; return { res: o.res, pnl: o.pnl, day: s.day }; };
    var halfSets = [0, 1].map(function (h) { return ms.filter(function (s) { return s.half === h; }); });
    var base = outcomeStats(ms.map(toX));
    var baseHalf = halfSets.map(function (hs) { return outcomeStats(hs.map(toX)); });
    var amb = ms.filter(function (s) { return s.out[mt.key].res === "amb"; }).length;
    var closeN = 0, closeDaily = 0, closeBad = 0, maxAbs = 0;
    ms.forEach(function (s) {
      var o = s.out[mt.key];
      if (o.res === "close") { closeN++; if (o.byDaily) closeDaily++; if (o.dailyBad) closeBad++; }
      if (isNum(o.pnl) && Math.abs(o.pnl) > maxAbs) maxAbs = Math.abs(o.pnl);
    });
    // 時点ごとの基準
    var baseByT = {};
    T_LIST.forEach(function (tMin) { baseByT[tMin] = outcomeStats(ms.filter(function (s) { return s.t === tMin; }).map(toX)); });
    var decided = ms.filter(function (s) { return s.out[mt.key].res !== "amb"; });
    var wins = decided.filter(function (s) { return s.out[mt.key].res === "win"; });

    var items = ITEMS.map(function (item) {
      var gOf = new Map();
      ms.forEach(function (s) { gOf.set(s, groupOf(item, s)); });
      var groups = {};
      GROUPS.forEach(function (g) {
        var list = ms.filter(function (s) { return inGroup(gOf.get(s), g.key); });
        groups[g.key] = {
          all: outcomeStats(list.map(toX)),
          half: [0, 1].map(function (h) { return outcomeStats(list.filter(function (s) { return s.half === h; }).map(toX)); }),
        };
      });
      // 時点をそろえた基準（参考）: 「上がった」組の時点の内訳どおりに、各時点の全件の成績を重みづけしたもの
      var upList = decided.filter(function (s) { return gOf.get(s) === "up"; });
      var tmW = 0, tmRate = 0, tmAvg = 0;
      upList.forEach(function (s) { var b = baseByT[s.t]; if (b.n) { tmW++; tmRate += b.rate; tmAvg += b.avg; } });
      // リフト: 先に +2.0% に届いた場面のうち「上がった」の割合 ÷ 判定できた全件のうち「上がった」の割合
      var upAll = upList.length / decided.length;
      var upWin = wins.filter(function (s) { return gOf.get(s) === "up"; }).length / wins.length;
      // 参考: 同じ銘柄・同じ項目は1日の最初に「上がった」になった1回だけ
      var firstSeen = new Set(), firstList = [];
      ms.forEach(function (s) {
        if (gOf.get(s) !== "up") return;
        var key = s.day + "|" + s.code;
        if (firstSeen.has(key)) return;
        firstSeen.add(key);
        firstList.push(s);
      });
      var g = groups;
      var diff = g.up.all.rate - g.notUp.all.rate;
      var diffHalf = [0, 1].map(function (h) { return g.up.half[h].rate - g.notUp.half[h].rate; });
      var c1 = isNum(diff) && diff >= PASS_DIFF;
      var c2 = isNum(diffHalf[0]) && isNum(diffHalf[1]) && diffHalf[0] > 0 && diffHalf[1] > 0;
      var c3 = isNum(g.up.all.avg) && g.up.all.avg > base.avg;
      return {
        item: item, groups: groups,
        diff: diff, diffHalf: diffHalf,
        dayDiff: g.up.all.dayRate - g.notUp.all.dayRate,
        c1: c1, c2: c2, c3: c3, pass: c1 && c2 && c3,
        tmRate: tmW ? tmRate / tmW : NaN, tmAvg: tmW ? tmAvg / tmW : NaN,
        upAll: upAll, upWin: upWin, lift: upAll > 0 ? upWin / upAll : NaN,
        first: outcomeStats(firstList.map(toX)),
      };
    });
    report[mt.key] = { method: mt, n: ms.length, base: base, baseHalf: baseHalf, amb: amb, closeN: closeN, closeDaily: closeDaily, closeBad: closeBad, maxAbs: maxAbs, baseByT: baseByT, items: items };
  });
  var elapsedMin = (RealDate.now() - startedAt) / 60000;

  // ---------- レポート ----------

  var L = [];
  var passNames = function (mk) { return report[mk].items.filter(function (r) { return r.pass; }).map(function (r) { return r.item.label; }); };
  var pNow = passNames("now"), pLag = passNames("lag");
  var sameResult = pNow.join("|") === pLag.join("|");
  var nItems = ITEMS.length;
  var firstHalf = evalDays.slice(0, half), secondHalf = evalDays.slice(half);

  L.push("# 上がり始める前にどの項目の点数が上がっているか 検証結果");
  L.push("");
  L.push("## 結論");
  L.push("");
  L.push("- **合格した項目: すぐ買う場合 " + (pNow.length ? pNow.map(function (x) { return "「" + x + "」"; }).join("・") : "なし") + "／15分遅れて買う場合 " + (pLag.length ? pLag.map(function (x) { return "「" + x + "」"; }).join("・") : "なし") + "**（比べた " + nItems + "項目のうち）");
  L.push("- すぐ買う場合と15分遅れの場合で、合格した項目は" + (sameResult ? "**変わらなかった**" : "**変わった**") +
    (sameResult ? "" : "（すぐ買うだけで合格: " + (pNow.filter(function (x) { return pLag.indexOf(x) < 0; }).join("・") || "なし") + "／15分遅れだけで合格: " + (pLag.filter(function (x) { return pNow.indexOf(x) < 0; }).join("・") || "なし") + "）"));
  L.push("- ここでの**先着率**は、買ったあと +2.0% と −0.75% のうち +2.0% に先に届いた割合（判定不能を除いた件数が分母）。**1回平均損益**は、1回買うごとの損益（+2.0%・−0.75%・大引けの損益のいずれか）の平均。**基準**は、同じ買い方で、対象の全判定時点をすべて買った場合の成績");
  METHODS.forEach(function (mt) {
    var rp = report[mt.key];
    var best = rp.items.filter(function (r) { return isNum(r.diff) && r.groups.up.all.n; }).sort(function (a, b) { return b.diff - a.diff; })[0];
    var sc = rp.items.filter(function (r) { return r.item.key === "score"; })[0];
    L.push("- " + mt.label + ": 全件を買った場合（基準）の先着率は " + pct1(rp.base.rate) + "・1回平均損益は " + pct3(rp.base.avg) + "。総合スコアが前の時点より上がった場面は先着率 " + pct1(sc.groups.up.all.rate) + "（上がらなかった場面との差 " + pt1(sc.diff) + "）・1回平均損益 " + pct3(sc.groups.up.all.avg) + "。差が最も大きかった項目は「" + best.item.label + "」の " + pt1(best.diff) + "（前半 " + pt1(best.diffHalf[0]) + "・後半 " + pt1(best.diffHalf[1]) + "、1回平均損益 " + pct3(best.groups.up.all.avg) + "）");
  });
  // 合格した項目の「下がった」組（点数が動いた場面全般が良いだけではないかの確認）と、1日の最初の「上がった」だけの値
  var passed = [];
  METHODS.forEach(function (mt) {
    report[mt.key].items.forEach(function (r) { if (r.pass) passed.push({ mt: mt, r: r }); });
  });
  if (passed.length) {
    var downAsGood = passed.filter(function (x) { return x.r.groups.down.all.rate >= x.r.groups.up.all.rate; });
    L.push("- ただし合格した項目は" + (downAsGood.length === passed.length ? "すべて" : "、" + passed.length + "件中 " + downAsGood.length + "件で") + "、点数が**下がった**場面の先着率も上がった場面と同じか高い（" +
      passed.map(function (x) { return x.mt.label + "の「" + x.r.item.label + "」 上がった " + pct1(x.r.groups.up.all.rate) + "・下がった " + pct1(x.r.groups.down.all.rate); }).join("、") +
      "）。差が出ているのは「点数が上がったか」ではなく「点数が動いたか」で、これらの項目の点数が動く場面は値動きが大きく +2.0% に届きやすい場面だった、と読むのが自然。上がり始める前の予兆とは言いにくい");
    L.push("- 同じ銘柄を1日に何度も数える偏りを除くため、1日の最初の「上がった」だけを数えると（9章）、上がらなかった組との先着率の差は" +
      passed.map(function (x) { return x.mt.label + "の「" + x.r.item.label + "」 " + pt1(x.r.first.rate - x.r.groups.notUp.all.rate); }).join("、") + " になる");
    var gains = passed.map(function (x) { return x.r.groups.up.all.avg - report[x.mt.key].base.avg; });
    var upAvgs = passed.map(function (x) { return x.r.groups.up.all.avg; });
    var minAvg = Math.min.apply(null, upAvgs), maxAvg = Math.max.apply(null, upAvgs);
    L.push("- 合格した項目の「上がった」組の1回平均損益は " + pct3(minAvg) + " 〜 " + pct3(maxAvg) + "（基準より " + pct3(Math.min.apply(null, gains)) + " 〜 " + pct3(Math.max.apply(null, gains)) + " 高い）。手数料は引いていないため、往復0.1%前後の手数料を引くと " + pct3(minAvg - 0.001) + " 〜 " + pct3(maxAvg - 0.001) + " になる");
  }
  L.push("- " + nItems + "項目 × 2つの買い方を並べて比べているため、本当は効果が無くても偶然良く見える項目が出やすい。合格した項目があっても、別の期間で確かめ直すまでは売買の判断に使わないこと");
  L.push("");

  L.push("## 0. 前提");
  L.push("");
  L.push("- 生成: `SIGNAL_RISE_DATA=<daytrade-data のディレクトリ> node scripts/signal-rise-check.mjs`（実行日 " + runDate + "、所要 " + elapsedMin.toFixed(1) + "分、うち analyzeStock の計算 " + (calcSec / 60).toFixed(1) + "分）");
  L.push("- **使ったデータ**:");
  L.push("  - 日本株の15分足・日足: daytrade-data リポジトリの `data/15m`・`data/1d`" + (dataRev ? "（commit " + dataRev + "）" : "") + "。リポジトリの外の一時フォルダに読み取り専用で取得して読んだ。15分足 " + m15Days.length + "日（" + m15Days[0] + " 〜 " + m15Days[m15Days.length - 1] + "）、日足 " + d1Days.length + "日（" + d1Days[0] + " 〜 " + d1Days[d1Days.length - 1] + "）・" + int(codeList.length) + "銘柄");
  L.push("  - TOPIX の代わり: TOPIX 連動ETF（" + TOPIX_PROXY + "）。daytrade-data には入っていないため Yahoo Finance から取得した（15分足 interval=15m・range=60d で " + tpxDays.length + "日分 " + tpxDays[0] + " 〜 " + tpxDays[tpxDays.length - 1] + "、前日終値は日足 range=6mo）。取得時刻 " + (tpx15.fetchedAt || "-"));
  L.push("- **期間と判定に使えた日数: " + evalDays.length + "日**（" + evalDays[0].date + " 〜 " + evalDays[evalDays.length - 1].date + "）。15分足の最初の " + (m15Days.length - warmDays.length) + "日は、計算の助走（その日の前の" + PRIOR_DAYS + "取引日の15分足。thirty-min-check.mjs と同じ本数）が揃わないため判定に使っていない。" + (noTopixDays.length ? "助走が揃っても " + TOPIX_PROXY + " の15分足が無い日 " + noTopixDays.length + "日（" + noTopixDays.join("、") + "）も外した" : "助走が揃った日はすべて " + TOPIX_PROXY + " の15分足があった"));
  L.push("- 前半・後半: 判定に使えた日を日付順に半分に分けた。前半 " + firstHalf.length + "日（" + firstHalf[0].date + " 〜 " + firstHalf[firstHalf.length - 1].date + "）、後半 " + secondHalf.length + "日（" + secondHalf[0].date + " 〜 " + secondHalf[secondHalf.length - 1].date + "）");
  L.push("- **対象銘柄数: " + tickerSet.size + "銘柄**。銘柄の決め方は `scripts/thirty-min-check.mjs`（PR #101）と同じで、日ごとに、前日の確定値で出来高上位" + NORMAL_VOL_TOP + "と、値上がり率上位" + CHANGE_TOP + "（出来高が全銘柄の中央値の" + VOL_MULT + "倍以上のもの）を重複なしで並べたもの。前日の出来高・値上がり率は daytrade-data の日足（`volume`・`adjclose`）で求めた。候補 " + int(candStockDays) + "銘柄日（1日平均 " + (candStockDays / evalDays.length).toFixed(1) + "銘柄）・" + targetSet.size + "銘柄、うち計算に使えた銘柄日 " + int(stockDaysUsed));
  L.push("- **判定不能の件数**（買った足から後の同じ15分足の中で +2.0% と −0.75% の両方に届き、どちらが先か分からないもの。集計から外した）: すぐ買う " + int(report.now.amb) + "件／15分遅れ " + int(report.lag.amb) + "件");
  L.push("- **比べた項目の数: " + nItems + "項目**（総合スコアと breakdown の部品 " + (nItems - 1) + "個。常に0点だった部品 " + partInfo.filter(function (p) { return p.alwaysZero; }).map(function (p) { return p.label; }).join("・") + " は外した。自動スキャンと同じく VIX と過去の的中率を渡していないため）。項目が多いため、本当は効果が無くても偶然良く見える項目が出やすい");
  L.push("- 手数料は引いていない");
  L.push("");
  L.push("言葉の意味:");
  L.push("");
  L.push("- 判定時点 t: 各営業日の 9:30 から 14:45 までの15分ごとの時刻（昼休みの 11:45・12:00・12:15 を含む22時点）。t より前に終わった15分足（開始時刻が t より前の足）だけを使い、時計を t に固定して `analyzeStock()` を計算する");
  L.push("- 上がった／変わらない／下がった: その項目の点数が、同じ日の t の15分前の時点より大きいか・同じか・小さいか。9:30 は15分前（9:15）が判定時点ではないため比べる相手が無く、対象から外した（9:30 の点数は 9:45 の比べる相手としてだけ使う）。昼休みの 11:45〜12:15 も点数は計算し、次の時点の比べる相手にした（この間は新しい足が無いため、12:00〜12:30 はほとんどが「変わらない」になる）");
  L.push("- すぐ買う: t に始まる15分足の始値で買う。15分遅れ: t の15分後に始まる15分足の始値で買う。どちらも使うシグナルは t の時点のもの。買う足に値段が無い（昼休み・約定なし）判定時点は、その買い方では数えない");
  L.push("- 売り方: 買った足から後の15分足の高値と安値で、買値の +2.0% と −0.75% のどちらに先に届いたかを見る。どちらにも届かなければ大引けで手じまう（その日の日足の終値。無ければ15分足の最後の終値）");
  L.push("- **先着率**: 判定不能を除いた件数のうち、+2.0% に先に届いた割合");
  L.push("- **1回平均損益**: 1回買うごとの損益の平均。+2.0% に先に届けば +2.0%、−0.75% に先に届けば −0.75%、どちらにも届かなければ大引けの値段 ÷ 買値 − 1");
  L.push("- **基準**: 同じ買い方で、対象の全判定時点を（項目で絞らずに）すべて買った場合の成績。項目で選んだ組がこれより良くなければ、その項目で選ぶ意味は無い");
  L.push("- 日ごとの平均: 日ごとに先着率・1回平均損益を出してから、日数で平均した値。件数の多い日に引っぱられにくい");
  L.push("- **リフト**: 先に +2.0% に届いた場面のうち、その項目が t で「上がった」だった割合 ÷ 判定できた全件のうち「上がった」だった割合。1 より大きいほど、値上がりの前にその項目が普段より多く上がっていたことを表す（例: 1.5 なら普段の1.5倍）");
  L.push("");
  L.push("合格ライン（買い方ごとに判定）:");
  L.push("");
  L.push("1. 「上がった」組の先着率が「上がらなかった」組より " + (PASS_DIFF * 100) + "ポイント以上高い");
  L.push("2. 期間の前半・後半の両方で、「上がった」組の先着率が「上がらなかった」組より高い（1 と同じ向き）");
  L.push("3. 「上がった」組の1回平均損益が基準（全件）を上回る");
  L.push("");

  L.push("## 1. 実装前確認の結果");
  L.push("");
  L.push("1. analyzeStock の読み込みと先読みの確認: `scripts/thirty-min-check.mjs` は `src/lib/analyze.js` の `analyzeStock` を import し、`api/stock.js` が返す形の payload を組み立てて `api/_scan.js` の `toPriceData()`・`normalizeStock()` を通し、`analyzeStock(stock, pd, null, {})` で呼んでいる。`Date` を差し替えて判定時点に固定し、判定時点より後の15分足・TOPIX・当日以降の日足をでたらめな値に書き換えて計算し直し、結果が変わらないことを抜き取りで確かめている（leakCheck）。今回も同じ仕組みを写して使った（元のファイルは変更していない）。" + int(leakChecked) + "件を抜き取り、t 以降に始まる15分足（その銘柄と " + TOPIX_PROXY + "）と当日以降の日足を書き換えて計算し直したところ、総合スコア・各項目の点数・TOPIX 前日比が変わった判定時点は " + leakDiff + "件");
  L.push("2. 対象銘柄: thirty-min-check.mjs と同じ決め方にできた（前日の出来高上位" + NORMAL_VOL_TOP + "＋値上がり率上位" + CHANGE_TOP + "）。thirty-min-check.mjs は実行時の JPX 銘柄一覧と Yahoo の日足で候補を作るが、今回は daytrade-data の日足（JPX 一覧の内国株式 " + int(codeList.length) + "銘柄）で作った。判定に使えた " + evalDays.length + "日で、延べ " + targetSet.size + "銘柄が候補になった（1日平均 " + (candStockDays / evalDays.length).toFixed(1) + "銘柄）");
  L.push("3. daytrade-data の15分足: リポジトリの外の一時フォルダに読み取り専用で取得して使えた（" + m15Days.length + "日分）。**今回は daytrade-data を使った**（Yahoo の15分足は取り直していない）");
  L.push("4. " + TOPIX_PROXY + " の15分足: daytrade-data には入っていない（JPX 一覧の内国株式だけを保存しているため、ETF は無い）。このため同じ取得元では用意できず、Yahoo から取得した。Yahoo の15分足は直近60営業日分（" + tpxDays[0] + " 〜 " + tpxDays[tpxDays.length - 1] + "）しか返らないが、判定に使う日（助走が揃う " + warmDays[0] + " 以降）はすべてこの中に入るため、判定に使える日数は減らなかった。daytrade-data も Yahoo の15分足を保存したものなので、値の作り方は同じ");
  L.push("5. 判定に使える日数: 15分足 " + m15Days.length + "日から助走 " + PRIOR_DAYS + "日を差し引いて " + warmDays.length + "日、そのうち " + TOPIX_PROXY + " の15分足もある日が " + evalDays.length + "日（" + MIN_DAYS + "日以上）");
  L.push("6. 呼び出し回数と実行時間: 1日あたり約 " + Math.round(candStockDays / evalDays.length) + "銘柄 × " + T_LIST.length + "時点 × " + evalDays.length + "日で、見積もりは約 " + int(Math.round(candStockDays * T_LIST.length / 1000) * 1000) + "回。事前に1回の計算を測ると約1.2ミリ秒だったため、計算そのものは数分で終わる見込みだった。実際は " + int(calls) + "回・" + (calcSec / 60).toFixed(1) + "分（全体 " + elapsedMin.toFixed(1) + "分）");
  L.push("");
  L.push("そのほかの確認: 全判定時点で寄り付き後扱いになった（`sessionStarted` が false だった件数 " + sessionMismatch + "）。部品の点数の合計はすべて総合スコアと一致した（不一致 " + sumMismatch + "件）");
  L.push("");

  L.push("## 2. 件数と除外");
  L.push("");
  L.push("銘柄日ごと除外したもの（候補 " + int(candStockDays) + "銘柄日のうち " + int(candStockDays - stockDaysUsed) + "銘柄日）:");
  L.push("");
  L.push("| 理由 | 銘柄日 |");
  L.push("| --- | ---: |");
  L.push("| その日の15分足が無い | " + skipDay.noTodayBars + " |");
  L.push("| その日の15分足が 9:00〜15:15 の26本そろっていない | " + skipDay.badTodayBars + " |");
  L.push("| 前営業日の15分足が無い | " + skipDay.noPrevBars + " |");
  L.push("| 渡す15分足が" + MIN_BARS + "本未満（thirty-min-check.mjs と同じ条件） | " + skipDay.fewBars + " |");
  L.push("| 前日終値（日足）が無い | " + skipDay.noPrevClose + " |");
  L.push("| 分割・併合の疑い（前の" + PRIOR_DAYS + "取引日の日足の終値か当日の寄りが、前日の" + SPLIT_LO + "倍未満か" + SPLIT_HI + "倍超） | " + skipDay.splitSuspect + " |");
  L.push("");
  var splitList = Array.from(splitDates.entries()).sort(function (a, b) { return b[1] - a[1] || (a[0] < b[0] ? -1 : 1); });
  L.push("分割・併合の疑いで外した銘柄日の、値段が飛んだ日の内訳: " + (splitList.length ? splitList.map(function (x) { return x[0] + " " + x[1] + "銘柄日"; }).join("、") : "なし") + "。" +
    (splitDates.has("2026-09-28") ? "daytrade-data の日足では 2026-09-28 に終値が前日の半分以下になった銘柄がまとまってあり（10月1日付の株式分割と見られる）、その後の日はその銘柄の助走に分割前の値段が残るため外れる" : ""));
  L.push("");
  L.push("判定時点の件数:");
  L.push("");
  L.push("| 区分 | 件数 |");
  L.push("| --- | ---: |");
  L.push("| 点数を計算した判定時点（" + int(stockDaysUsed) + "銘柄日 × " + T_LIST.length + "時点） | " + int(pointRecs) + " |");
  L.push("| 除外: TOPIX の値が無い（t までに " + TOPIX_PROXY + " の当日の足が無い） | " + int(skipPoint.noTopix) + " |");
  L.push("| 除外: 比べる前の時点が無い（9:30） | " + int(noPrevPoint) + " |");
  L.push("| **比べられた判定時点** | **" + int(samples.length) + "** |");
  METHODS.forEach(function (mt) {
    var rp = report[mt.key];
    L.push("| " + mt.label + ": 買う足に値段が無い（昼休み・約定なし） | " + int(notBuyable[mt.key]) + " |");
    L.push("| " + mt.label + ": 買えた件数 | " + int(rp.n) + " |");
    L.push("| " + mt.label + ": うち判定不能 | " + int(rp.amb) + " |");
    L.push("| " + mt.label + ": **集計に使った件数** | **" + int(rp.base.n) + "** |");
  });
  L.push("");
  METHODS.forEach(function (mt) {
    var rp = report[mt.key];
    L.push("- " + mt.label + ": どちらにも届かず大引けで手じまった " + int(rp.closeN) + "件のうち、日足の終値を使った " + int(rp.closeDaily) + "件（残りは15分足の最後の終値。うち日足の終値が15分足の最後の終値から" + pct1(CLOSE_GAP_MAX).replace(".0", "") + "超離れていて使わなかった " + int(rp.closeBad) + "件）。1回の損益の絶対値の最大は " + pct3(rp.maxAbs).replace("+", ""));
  });
  L.push("");

  L.push("## 3. 基準（全件を買った場合）");
  L.push("");
  L.push("| 買い方 | 件数 | 先着率 | 1回平均損益 | 先着率（日ごとの平均） | 1回平均損益（日ごとの平均） | 前半の先着率 | 後半の先着率 | 前半の1回平均損益 | 後半の1回平均損益 |");
  L.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  METHODS.forEach(function (mt) {
    var b = report[mt.key].base, bh = report[mt.key].baseHalf;
    L.push("| " + mt.label + " | " + int(b.n) + " | " + pct1(b.rate) + " | " + pct3(b.avg) + " | " + pct1(b.dayRate) + " | " + pct3(b.dayAvg) + " | " + pct1(bh[0].rate) + " | " + pct1(bh[1].rate) + " | " + pct3(bh[0].avg) + " | " + pct3(bh[1].avg) + " |");
  });
  L.push("");
  L.push("時点ごとの基準（t は判定時点。各欄は「先着率 / 1回平均損益 / 件数」）:");
  L.push("");
  L.push("| t | " + METHODS.map(function (mt) { return mt.label; }).join(" | ") + " |");
  L.push("| --- | " + METHODS.map(function () { return "---"; }).join(" | ") + " |");
  T_LIST.forEach(function (tMin) {
    if (tMin === T_FIRST) return;
    L.push("| " + hm(tMin) + " | " + METHODS.map(function (mt) {
      var b = report[mt.key].baseByT[tMin];
      return b.n ? pct1(b.rate) + " / " + pct3(b.avg) + " / " + int(b.n) : "-";
    }).join(" | ") + " |");
  });
  L.push("");

  var mark = function (v) { return v ? "○" : "×"; };
  METHODS.forEach(function (mt, mi) {
    var rp = report[mt.key];
    L.push("## " + (4 + mi) + ". 合否の一覧（" + mt.label + "）");
    L.push("");
    L.push(mt.desc + "。基準: 先着率 " + pct1(rp.base.rate) + "・1回平均損益 " + pct3(rp.base.avg) + "（" + int(rp.base.n) + "件）。");
    L.push("");
    L.push("| 項目 | 上がった件数 | 上がった 先着率 | 上がらなかった 先着率 | 差（合格ライン1） | 前半の差 | 後半の差 | 上がった 1回平均損益 | 基準との差（合格ライン3） | 1 | 2 | 3 | 合否 |");
    L.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: | :---: | :---: | :---: |");
    rp.items.forEach(function (r) {
      var u = r.groups.up.all, nu = r.groups.notUp.all;
      L.push("| " + r.item.label + " | " + int(u.n) + " | " + pct1(u.rate) + " | " + pct1(nu.rate) + " | " + pt1(r.diff) + " | " + pt1(r.diffHalf[0]) + " | " + pt1(r.diffHalf[1]) + " | " + pct3(u.avg) + " | " + pct3(u.avg - rp.base.avg) + " | " + mark(r.c1) + " | " + mark(r.c2) + " | " + mark(r.c3) + " | " + (r.pass ? "**合格**" : "不合格") + " |");
    });
    L.push("");
  });

  METHODS.forEach(function (mt, mi) {
    var rp = report[mt.key];
    L.push("## " + (6 + mi) + ". 項目ごと・組ごとの成績（" + mt.label + "）");
    L.push("");
    L.push("各欄は全期間。「日ごと」は日ごとに出してから平均した値。基準: 先着率 " + pct1(rp.base.rate) + "（日ごと " + pct1(rp.base.dayRate) + "）・1回平均損益 " + pct3(rp.base.avg) + "（日ごと " + pct3(rp.base.dayAvg) + "）。");
    L.push("");
    L.push("| 項目 | 組 | 件数 | 判定不能 | 先着率 | 先着率（日ごと） | 1回平均損益 | 1回平均損益（日ごと） | 前半 先着率 | 後半 先着率 | 前半 1回平均損益 | 後半 1回平均損益 |");
    L.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    rp.items.forEach(function (r) {
      GROUPS.forEach(function (g, gi) {
        var x = r.groups[g.key];
        L.push("| " + (gi === 0 ? r.item.label : "") + " | " + g.label + " | " + int(x.all.n) + " | " + int(x.all.amb) + " | " + pct1(x.all.rate) + " | " + pct1(x.all.dayRate) + " | " + pct3(x.all.avg) + " | " + pct3(x.all.dayAvg) + " | " + pct1(x.half[0].rate) + " | " + pct1(x.half[1].rate) + " | " + pct3(x.half[0].avg) + " | " + pct3(x.half[1].avg) + " |");
      });
    });
    L.push("");
    L.push("参考: 時点をそろえた基準（「上がった」組と同じ時点の内訳で全件の成績を平均したもの。「上がった」が特定の時間帯に偏る影響を除いて見るため。合否には使わない）");
    L.push("");
    L.push("| 項目 | 上がった 先着率 | 時点をそろえた基準 先着率 | 上がった 1回平均損益 | 時点をそろえた基準 1回平均損益 | 先着率の差（日ごとの平均どうし） |");
    L.push("| --- | ---: | ---: | ---: | ---: | ---: |");
    rp.items.forEach(function (r) {
      var u = r.groups.up.all;
      L.push("| " + r.item.label + " | " + pct1(u.rate) + " | " + pct1(r.tmRate) + " | " + pct3(u.avg) + " | " + pct3(r.tmAvg) + " | " + pt1(r.dayDiff) + " |");
    });
    L.push("");
  });

  L.push("## 8. リフト（逆向きの見方）");
  L.push("");
  L.push("先に +2.0% に届いた場面のうち、その項目が t で「上がった」だった割合を、判定できた全件のうち「上がった」だった割合と比べた。リフト＝前者 ÷ 後者。1 なら普段どおり、1 より大きいほど値上がりの前によく上がっていた。");
  L.push("");
  L.push("| 項目 | " + METHODS.map(function (mt) { return mt.label + " 全件で上がった割合 | " + mt.label + " +2.0%先着で上がった割合 | " + mt.label + " リフト"; }).join(" | ") + " |");
  L.push("| --- | " + METHODS.map(function () { return "---: | ---: | ---:"; }).join(" | ") + " |");
  ITEMS.forEach(function (item, ii) {
    L.push("| " + item.label + " | " + METHODS.map(function (mt) {
      var r = report[mt.key].items[ii];
      return pct1(r.upAll) + " | " + pct1(r.upWin) + " | " + num2(r.lift);
    }).join(" | ") + " |");
  });
  L.push("");

  L.push("## 9. 参考: 1日の最初の「上がった」だけを数えた場合");
  L.push("");
  L.push("同じ銘柄・同じ項目について、その日に最初に「上がった」になった判定時点だけを数えた（同じ銘柄を1日に何度も数える偏りの確認用。合否には使わない）。買い方ごとに、その買い方で買える判定時点のうち最初のもの。");
  L.push("");
  L.push("| 項目 | " + METHODS.map(function (mt) { return mt.label + " 件数 | " + mt.label + " 先着率 | " + mt.label + " 1回平均損益 | " + mt.label + " 上がらなかった組との先着率の差"; }).join(" | ") + " |");
  L.push("| --- | " + METHODS.map(function () { return "---: | ---: | ---: | ---:"; }).join(" | ") + " |");
  ITEMS.forEach(function (item, ii) {
    L.push("| " + item.label + " | " + METHODS.map(function (mt) {
      var r = report[mt.key].items[ii];
      return int(r.first.n) + " | " + pct1(r.first.rate) + " | " + pct3(r.first.avg) + " | " + pt1(r.first.rate - r.groups.notUp.all.rate);
    }).join(" | ") + " |");
  });
  L.push("");

  L.push("## 10. 注意点");
  L.push("");
  L.push("- **週初以外の日の 9:00 の足の欠け（既知の問題）**: daytrade-data の15分足は、週初（その週の最初の取引日）以外の日は 9:00 の足に寄り5分（9:00〜9:04）が入っておらず、前日終値の混入や、その日に付いていない高値・安値が見られる（daytrade-data の `docs/edge-book.md`）。判定時点は 9:30 以降で、買う足も 9:45 以降だが、当日の VWAP・当日の高値と安値・寄り付きレンジ・ギャップなど、当日の 9:00 の足を使う項目の点数と、助走に含まれる過去の日の 9:00 の足を通じて、9:30 以降の計算にも少し影響しうる");
  L.push("- 同じ日の判定時点は相場全体の上げ下げを共有しているため互いに独立ではなく、同じ銘柄も1日に何度も数えている。日ごとの平均（6・7章）と、1日の最初の「上がった」だけの集計（9章）を合わせて見ること");
  L.push("- " + nItems + "項目 × 2つの買い方を比べているため、偶然良く見える項目が出やすい。期間も " + evalDays.length + "日と短い");
  L.push("- 15分足の高値・安値だけで判定しているため、同じ足の中の順番は分からない（判定不能として外した）。買値は15分足の始値で、実際に買える値段（売り気配）とは呼値1つぶんずれることがある");
  L.push("- daytrade-data の15分足には 15:30 開始の足（大引けの1点）が入っていないため、大引けでの値動きは +2.0% と −0.75% の判定に入らず、手じまいの値段（日足の終値）にだけ反映される");
  L.push("- TOPIX は連動ETF（" + TOPIX_PROXY + "）の値で代用した。本番の立花証券の TOPIX 前日比とは場中の値の取り方が違う可能性がある");
  L.push("- daytrade-data の値段は保存した時点の値で固定されており、後から株式分割などがあっても直らない。分割・併合が疑われる銘柄日は外したが（2章）、比が小さい分割は見逃している可能性がある");
  L.push("- 銘柄群は前日の出来高・値上がり率の上位で、売買が活発な銘柄に偏っている。全銘柄に当てはまるとは限らない");
  L.push("");

  var outPath = fileURLToPath(new URL("../docs/signal-rise-result.md", import.meta.url));
  writeFileSync(outPath, L.join("\n") + "\n");
  console.log("\n→ " + outPath + "（" + elapsedMin.toFixed(1) + "分）");
};

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
