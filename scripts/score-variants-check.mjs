// scripts/score-variants-check.mjs
// スコアの作り方を変えた場合に、各日の上位10銘柄の成績がどう変わるかを8:50と10:00の2時点で試算する。
// 並べ方は次の4通り（部品の点数は analyzeStock の返り値の breakdown から取り出す。analyze.js の変更・中身の複製はしない）。
//   - S0: 今のスコア（analyzeStock の返すスコアそのまま）
//   - S1: 部品の点数の合計から、MOMENTUM_PARTS の9部品と CAP_PARTS（上限抑制・VIXキャップ）を除いたもの（0〜100 への切り詰めなし）
//   - S2: S1 − MOMENTUM_PARTS の9部品の点数の合計
//   - R : スコアを使わず、8:50は前日騰落率、10:00は当日騰落率が低い順
//
// 検証日・候補・データ・コスト・売り方は、8:50が scripts/score-top10-check.mjs（PR #88）、
// 10:00が scripts/score-top10-1000-check.mjs（PR #89）と同じ。候補の再現・データ取得・2026-06-26 の欠けの扱い・
// 時計の差し替え・15分足の切り方・部品ごとの点数の取り出し・売り方の判定は scripts/score-parts-1000-check.mjs（PR #91）から写した
// （既存のスクリプトは処理がすべて main() の中にあり、読み込むと検証全体が走って既存のレポートを書き換えるため import できない）。
// 同じ動きであることは、S0 の上位10の成績を PR #88・#89 のレポートと突き合わせて確かめる（レポートの最後の章）。
// アプリ本体とは無関係の単発検証スクリプト。新しい npm パッケージは使わず、
// 既存の依存関係に含まれる xlsx（SheetJS）・@upstash/redis（api/_scan.js の読み込みに必要）と
// Node 標準の fetch のみを使う。
//
// 実行: node scripts/score-variants-check.mjs
// 出力: docs/score-variants-result.md
//
// 任意: 環境変数 SCORE_VARIANTS_CHECK_CACHE にディレクトリを指定すると、Yahoo の取得結果を
//       そこに JSON で保存し、次回以降はそれを読む（形式は PR #88・#89 の SCORE_TOP10_CHECK_CACHE と同じ）。
//       取得結果はリポジトリの外に置くこと（commit しない）

//       そこに JSON で保存し、次回以降はそれを読む（形式は PR #88・#89 の SCORE_TOP10_CHECK_CACHE と同じ）。
//       取得結果はリポジトリの外に置くこと（commit しない）

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { analyzeStock, currentSessionDate } from "../src/lib/analyze.js";

// ---------- ここから PR #88・#89 と同じ設定 ----------

// api/daily.js と同じ URL 形式・同じ User-Agent
var YAHOO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};
var RANGE = "6mo";
var WAIT_MS = 300; // 1件ごとの待ち時間
var RETRY_WAITS = [5000, 10000, 20000, 40000, 80000]; // 429 のときの待ち時間（再試行ごとに延ばす）
var ERROR_RETRY_WAITS = [3000, 6000]; // 429 以外の一時的な失敗（通信エラー・5xx）の再試行

var INTRADAY_INTERVAL = "15m";
var INTRADAY_RANGE = "60d";
// スコア計算に渡す15分足の長さ。8:50は T当日より前の直近30取引日、
// 場中は T当日を含む直近30取引日（前の29取引日＋T当日の途中まで）
var APP_WINDOW_DAYS = 30;
// スコア計算に渡す15分足が600本以上ある場合だけ計算する
var MIN_BARS = 600;
// 検証する日を決めるための基準銘柄
var REF_TICKER = "7203.T";

// TOPIX: Yahoo に TOPIX の日足があればそれを使い、無ければ TOPIX 連動ETF（1306.T）で代用する
var TOPIX_TICKERS = ["^TOPX", "998405.T"];
var TOPIX_PROXY = "1306.T";

var JPX_PAGE = "https://www.jpx.co.jp/markets/statistics-equities/misc/01.html";
var TARGET_MARKETS = ["プライム（内国株式）", "スタンダード（内国株式）", "グロース（内国株式）"];

// 候補の作り方（api/ranking.js と同じ件数）
var NORMAL_VOL_TOP = 40;
var CHANGE_TOP = 20;
var VOL_MULT = 1.5;

var JP_DAY_MIN_RATIO = 0.5;

var TOP_N = 10;
var TAKE_PROFIT = 0.015; // 利確ライン: 買値 × 1.015
var STOP_LOSS = -0.0075; // 損切りライン: 買値 × 0.9925
var FEE = 0.001; // 往復コスト0.1%
var SL_FIRST_PROB = 2 / 3; // 同じ足で両方に届いた場合に「損切りが先」とみなす確率（PR #88 の按分）

// 10:00評価（PR #89 の本命）。clock: 時計を合わせる時刻 / cut: この時刻より前に始まった15分足までをスコアに使う /
// buy: この時刻に始まる15分足の始値で買う（HH:MM、日本時間）
var EVAL = { clock: "10:00", cut: "10:00", buy: "10:00" };

// ---------- ここまで PR #88・#89 と同じ設定 ----------

// PR #88・#89 の検証日（2026-09-24 実行時の15分足 2026-06-26〜2026-09-24 で選ばれた36日）
var PR88_FIRST_DAY = "2026-07-31";
var PR88_LAST_DAY = "2026-09-24";
var PR88_DAY_COUNT = 36;
// PR #88・#89 の15分足の初日。Yahoo の15分足は直近60日分しか返らないため、2026-09-25 以降はこの日の足が取れない。
// この日を含む窓でスコアを計算していた日（検証日の前半）は、600本の条件を判定するときに
// 「この日の足があれば増えていた本数」を足して、PR #88・#89 と同じ銘柄日を計算対象にする
// （scripts/score-parts-check.mjs と同じ扱い）
var PR88_INTRADAY_START = "2026-06-26";
// 突き合わせ先のレポート（S0 の上位10が PR #88・#89 と一致するかを確かめる）
var PR88_REPORT = "../docs/score-top10-result.md";
var PR89_REPORT = "../docs/score-top10-1000-result.md";

// 部品（analyze.js の breakdown のラベル。analyze.js で積み上がる順。scripts/score-parts-check.mjs と同じ）
var PART_LABELS = [
  "VWAP", "VWAP傾き", "Pivot", "ATR(値幅)", "ATR消化率", "対TOPIX", "トレンド", "EMA整列", "MACD", "RSI",
  "BB", "Stoch", "重複ボーナス", "出来高/OBV", "ギャップ", "当日ブレイク", "寄り付きレンジ", "コンフルエンス",
  "実績反映調整", "上限抑制(下降/デッドクロス/VWAP)", "VIXキャップ",
];
// S1 で除き、S2 で差し引く9部品（PR #90・#91 で「すでに上がった銘柄」に点を与えていた部品）
var MOMENTUM_PARTS = [
  "対TOPIX", "トレンド", "EMA整列", "出来高/OBV", "コンフルエンス", "VWAP", "ギャップ", "当日ブレイク", "寄り付きレンジ",
];
// S1・S2 のどちらにも入れない調整（上限抑制は 0〜100 への切り詰めを含む）
var CAP_PARTS = ["上限抑制(下降/デッドクロス/VWAP)", "VIXキャップ"];
// S1 に残す部品
var REST_PARTS = PART_LABELS.filter(function (lb) { return MOMENTUM_PARTS.indexOf(lb) < 0 && CAP_PARTS.indexOf(lb) < 0; });

var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
var isNum = function (v) { return typeof v === "number" && isFinite(v); };

// ---------- api/stock.js と同じ加工（PR #88・#89 と同じ） ----------

// api/stock.js の toLocalDates と同一の実装（export されていないため写している）。
// 写し間違いが無いことは、実行時に api/stock.js の該当部分と文字列で突き合わせて確認する（checkToLocalDatesCopy）
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

// api/_scan.js を読み込む。読み込み時に Redis.fromEnv() が走り、環境変数が無いと
// @upstash/redis が警告を大量に出す（通信はしない）ため、読み込みの間だけ警告を止める
var loadScanModule = async function () {
  var warn = console.warn;
  console.warn = function () {};
  try {
    return await import("../api/_scan.js");
  } finally {
    console.warn = warn;
  }
};

// ---------- 時計の差し替え（PR #88・#89 と同じ） ----------

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

// 対象日 date（YYYY-MM-DD）の hm（HH:MM、日本時間）の Unix ミリ秒
var jstAt = function (date, hm) { return RealDate.parse(date + "T" + hm + ":00+09:00"); };

// ---------- 取得（PR #88・#89 と同じ） ----------

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

// 日ごとの差の配列から、平均・不偏標準偏差・t値（平均 ÷（標準偏差 ÷ √日数））を出す（PR #89 と同じ）
var tStat = function (d) {
  var mm = d.length ? mean(d) : NaN, ss = sd(d);
  return { n: d.length, avg: mm, sd: ss, t: mm / (ss / Math.sqrt(d.length)) };
};

var pct3 = function (v) { return isNum(v) ? (v * 100).toFixed(3) + "%" : "-"; };
var pct2 = function (v) { return isNum(v) ? (v * 100).toFixed(2) + "%" : "-"; };
var pct1 = function (v) { return isNum(v) ? (v * 100).toFixed(1) + "%" : "-"; };
var num2 = function (v) { return isNum(v) ? v.toFixed(2) : "-"; };

// ---------- 候補の作り方（PR #88・#89 と同じ） ----------

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

// ---------- 売り方の判定（PR #89 と同じ。買値を引数で受け取る。8:50は買値を T当日の日足の始値にすると PR #88 と同じ） ----------

// buy: 買値、dayClose: T当日の日足の終値、bars: 買った足から後の15分足（時刻順）
var judgeExit = function (buy, dayClose, bars) {
  var tp = buy * (1 + TAKE_PROFIT), sl = buy * (1 + STOP_LOSS);
  for (var i = 0; i < bars.length; i++) {
    var hitTp = bars[i].high >= tp, hitSl = bars[i].low <= sl;
    if (hitTp && hitSl) return { kind: "both" };
    if (hitTp) return { kind: "tp" };
    if (hitSl) return { kind: "sl" };
  }
  return { kind: "close", closeRet: dayClose / buy - 1 };
};

// 損益A: 同じ15分足で両方に届いた場合は PR #88 の按分（損切りが先 2/3・利確が先 1/3 の加重平均）。
// tp・sl・cl（決着の仕方の割合）は PR #88・#89 のレポートの行と突き合わせるためにだけ使う
var outcome = function (ex) {
  var tpNet = TAKE_PROFIT - FEE, slNet = STOP_LOSS - FEE;
  if (ex.kind === "tp") return { ret: tpNet, win: 1, tp: 1, sl: 0, cl: 0 };
  if (ex.kind === "sl") return { ret: slNet, win: 0, tp: 0, sl: 1, cl: 0 };
  if (ex.kind === "close") {
    var r = ex.closeRet - FEE;
    return { ret: r, win: r > 0 ? 1 : 0, tp: 0, sl: 0, cl: 1 };
  }
  var pTp = 1 - SL_FIRST_PROB;
  return { ret: pTp * tpNet + SL_FIRST_PROB * slNet, win: pTp, tp: pTp, sl: SL_FIRST_PROB, cl: 0 };
};

// ---------- 本体 ----------

var main = async function () {
  var cacheDir = process.env.SCORE_VARIANTS_CHECK_CACHE || null;
  if (cacheDir) mkdirSync(cacheDir, { recursive: true });

  var datesCopyOk = checkToLocalDatesCopy();
  if (!datesCopyOk) throw new Error("api/stock.js の toLocalDates と写しが一致しない（api/stock.js が変更された可能性）");
  var scan = await loadScanModule();

  // 1. 銘柄一覧
  var jpx = await fetchJpxList();
  console.log("JPX 銘柄一覧: " + jpx.list.length + "銘柄（" + jpx.url + "）");

  // 2. TOPIX
  var topixSource = null, topixRows = null;
  var topixTried = [];
  var topixCandidates = TOPIX_TICKERS.concat([TOPIX_PROXY]);
  for (var ti = 0; ti < topixCandidates.length && !topixRows; ti++) {
    var tr = (await fetchDaily(topixCandidates[ti], cacheDir)).res;
    topixTried.push(topixCandidates[ti] + "（" + (tr.error ? tr.error : "取得成功") + "）");
    if (!tr.error) { topixSource = topixCandidates[ti]; topixRows = tr.data; }
    await sleep(WAIT_MS);
  }
  if (!topixRows) throw new Error("TOPIX の日足が取れない: " + topixTried.join(" / "));

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

  // ---------- 取引日（PR #88・#89 と同じ） ----------

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
  var topixBars = toDayArray(topixRows);

  // TOPIX前日比（%）: T当日の前日の値。8:50・10:00とも同じ値を使う（PR #89 と同じ）
  var topixChangeFor = function (t) {
    var p1 = topixBars[t - 1], p2 = topixBars[t - 2];
    if (!p1 || !p2) return null;
    var c1 = isNum(p1.adj) ? p1.adj : p1.close, c2 = isNum(p2.adj) ? p2.adj : p2.close;
    if (!isNum(c1) || !isNum(c2) || c2 <= 0) return null;
    return (c1 / c2 - 1) * 100;
  };

  // ---------- 検証する日（PR #88・#89 と同じ選び方＋その36日に限る） ----------

  var refGot = (await fetchIntraday(REF_TICKER, cacheDir)).res;
  if (refGot.error) throw new Error(REF_TICKER + " の15分足: " + refGot.error);
  await sleep(WAIT_MS);

  var indexIntraday = function (raw) {
    var dates = toLocalDates(raw.ts, raw.gmtoffset != null ? raw.gmtoffset : 32400);
    var dayList = [], dayStart = {};
    dates.forEach(function (d, i) {
      if (!(d in dayStart)) { dayStart[d] = i; dayList.push(d); }
    });
    return { raw: raw, dates: dates, dayList: dayList, dayStart: dayStart };
  };
  // 8:50: T当日より前の直近 APP_WINDOW_DAYS 取引日分の足の範囲 [from, to)（PR #88・#89 と同じ）
  var windowBefore = function (ix, date) {
    var prevDays = ix.dayList.filter(function (d) { return d < date; });
    if (!prevDays.length) return null;
    var first = prevDays[Math.max(0, prevDays.length - APP_WINDOW_DAYS)];
    var nextDay = ix.dayList.filter(function (d) { return d >= date; })[0];
    return { from: ix.dayStart[first], to: nextDay != null ? ix.dayStart[nextDay] : ix.raw.ts.length, lastDay: prevDays[prevDays.length - 1], days: Math.min(APP_WINDOW_DAYS, prevDays.length) };
  };
  // 場中: T当日より前の直近 APP_WINDOW_DAYS − 1 取引日分と、T当日のうち cutSec より前に始まった足の範囲 [from, to)。
  // todayBars は T当日から含めた足の本数（PR #89 と同じ。days は前の取引日の日数）
  var windowIntraday = function (ix, date, cutSec) {
    var prevDays = ix.dayList.filter(function (d) { return d < date; });
    if (!prevDays.length) return null;
    var first = prevDays[Math.max(0, prevDays.length - (APP_WINDOW_DAYS - 1))];
    var from = ix.dayStart[first];
    var days = Math.min(APP_WINDOW_DAYS - 1, prevDays.length);
    var to = ix.dayStart[date] != null ? ix.dayStart[date] : null;
    if (to == null) {
      var nextDay = ix.dayList.filter(function (d) { return d > date; })[0];
      to = nextDay != null ? ix.dayStart[nextDay] : ix.raw.ts.length;
      return { from: from, to: to, lastPrevDay: prevDays[prevDays.length - 1], todayBars: 0, days: days };
    }
    var ds = to;
    while (to < ix.dates.length && ix.dates[to] === date && ix.raw.ts[to] < cutSec) to++;
    return { from: from, to: to, lastPrevDay: prevDays[prevDays.length - 1], todayBars: to - ds, days: days };
  };
  // PR #88・#89 のときに窓の中にあった PR88_INTRADAY_START の足が、今回の15分足に無い場合、その日の本数
  // （窓の前の取引日1日あたりの本数で見積もる）を返す。今回も足があるか、PR #88・#89 の窓に入らない日なら0。
  // prevBars: 窓のうち前の取引日の足の本数、windowDays: 窓に入る前の取引日の日数（8:50は30、10:00は29）、
  // tradedOnStart: その銘柄が PR88_INTRADAY_START に取引されていたか（日足の終値があるか）。
  // scripts/score-parts-check.mjs の missingStartBars と同じ考え方で、場中の窓（前の29取引日）にも当てはめる
  var t0 = jpDayIndex.get(PR88_INTRADAY_START);
  var missingStartBars = function (ix, prevBars, days, t, windowDays, tradedOnStart) {
    if (t0 == null || !tradedOnStart || ix.dayStart[PR88_INTRADAY_START] != null) return 0;
    if (t - t0 > windowDays) return 0;
    return Math.round(prevBars / days);
  };

  var refIx = indexIntraday(refGot.data);
  var periodStart = refIx.dayList[0], periodEnd = refIx.dayList[refIx.dayList.length - 1];
  // 取れない日の確認: PR #88・#89 の15分足の期間（PR88_INTRADAY_START 〜 PR88_LAST_DAY）の取引日のうち、
  // 今回の15分足に無い日が PR88_INTRADAY_START 以外にあれば、scripts/score-parts-check.mjs と同じ扱いでは足りないため止める
  var lostDays = jpDays.filter(function (d) {
    return d >= PR88_INTRADAY_START && d <= PR88_LAST_DAY && refIx.dayStart[d] == null;
  });
  var lostOther = lostDays.filter(function (d) { return d !== PR88_INTRADAY_START; });
  if (lostOther.length) throw new Error("15分足が取れない日が " + PR88_INTRADAY_START + " 以外にもある: " + lostOther.join(", "));

  var testDays = []; // { t, date }
  jpDays.forEach(function (d) {
    if (d < PR88_FIRST_DAY || d > PR88_LAST_DAY) return;
    var t = jpDayIndex.get(d);
    if (t < 2) return;
    var w = windowBefore(refIx, d);
    if (!w || w.to - w.from + missingStartBars(refIx, w.to - w.from, w.days, t, APP_WINDOW_DAYS, true) < MIN_BARS) return;
    testDays.push({ t: t, date: d });
  });
  console.log("15分足の期間: " + periodStart + " 〜 " + periodEnd + " / 検証日 " + testDays.length + "日");
  if (testDays.length !== PR88_DAY_COUNT) throw new Error("検証日が PR #89 と同じ " + PR88_DAY_COUNT + "日にならない: " + testDays.length + "日");
  var shortDays = function (windowDays) {
    return testDays.filter(function (td) {
      return t0 != null && refIx.dayStart[PR88_INTRADAY_START] == null && td.t - t0 <= windowDays;
    }).map(function (td) { return td.date; });
  };
  var shortWindowDays0850 = shortDays(APP_WINDOW_DAYS);
  var shortWindowDays1000 = shortDays(APP_WINDOW_DAYS - 1);

  // ---------- 日ごとの候補（8:50時点。PR #88・#89 と同じ） ----------

  testDays.forEach(function (td) {
    var t = td.t;
    var pop = [];
    for (var si = 0; si < bars.length; si++) {
      var p1 = bars[si][t - 1], p2 = bars[si][t - 2];
      if (!p1 || !p2 || !isNum(p1.adj) || !isNum(p2.adj) || p2.adj <= 0 || !isNum(p1.volume)) continue;
      pop.push({ idx: si, prevVol: p1.volume, prevRet: p1.adj / p2.adj - 1 });
    }
    var c = buildCandidates(pop, NORMAL_VOL_TOP);
    td.cands = c.all;
    td.byChange = new Set(c.byChange);
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

  // ---------- スコア計算と売買 ----------

  // api/stock.js の fetchJPPayload が返す形に組み立てる（PR #89 と同じ。現在値は渡さず、
  // api/_scan.js の toPriceData が最後の15分足の終値を現在値にする。10:00評価なら9:45開始の足の終値）
  var buildPayload = function (ix, from, to, officialPrevClose, topixChange) {
    var r = ix.raw;
    var sl = function (a) { return a.slice(from, to); };
    var ts = sl(r.ts), open = sl(r.open), high = sl(r.high), low = sl(r.low), close = sl(r.close), volume = sl(r.volume);
    var meta = { gmtoffset: r.gmtoffset };
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
              close: close, high: high, low: low, volume: volume, open: open,
              date: toLocalDates(ts, meta.gmtoffset != null ? meta.gmtoffset : 32400),
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

  // T当日の15分足のうち、startSec 以降に始まる足（時刻順）。15:30 の足は使わない（PR #89 と同じ）
  var hmOf = function (r, i) {
    return new RealDate((r.ts[i] + (r.gmtoffset != null ? r.gmtoffset : 32400)) * 1000).toISOString().slice(11, 16);
  };
  var barsFrom = function (ix, date, startSec) {
    var out = [];
    var ds = ix.dayStart[date];
    if (ds == null) return out;
    var r = ix.raw;
    for (var i = ds; i < ix.dates.length && ix.dates[i] === date; i++) {
      if (r.ts[i] < startSec) continue;
      if (r.close[i] == null) continue;
      if (hmOf(r, i) === "15:30") continue;
      var o = r.open[i] != null ? r.open[i] : r.close[i];
      out.push({
        high: r.high[i] != null ? r.high[i] : Math.max(o, r.close[i]),
        low: r.low[i] != null ? r.low[i] : Math.min(o, r.close[i]),
      });
    }
    return out;
  };
  // hm に始まる15分足の始値（無ければ null。PR #89 と同じ）
  var openAt = function (ix, date, hm) {
    var ds = ix.dayStart[date];
    if (ds == null) return null;
    var sec = jstAt(date, hm) / 1000;
    var r = ix.raw;
    for (var i = ds; i < ix.dates.length && ix.dates[i] === date; i++) {
      if (r.ts[i] === sec) return isNum(r.open[i]) && r.open[i] > 0 ? r.open[i] : null;
    }
    return null;
  };

  // breakdown を部品ごとの点数に直す（breakdown に出てこない部品は0点）。合計がスコアと一致するかも返す
  var unknownLabels = new Set();
  var toParts = function (a) {
    var parts = {};
    PART_LABELS.forEach(function (lb) { parts[lb] = 0; });
    var partSum = 0;
    a.breakdown.forEach(function (b) {
      if (!(b.label in parts)) unknownLabels.add(b.label);
      parts[b.label] = (parts[b.label] || 0) + b.delta;
      partSum += b.delta;
    });
    return { parts: parts, ok: Math.abs(partSum - a.save.score) <= 1e-9 };
  };


  // ---------- スコア計算と売買（8:50は PR #88、10:00は PR #89 と同じ） ----------

  var skip = {
    noIntraday: 0, noPrevBars: 0, fewBars: 0, noOfficialPrev: 0,
    noDaily0850: 0, noDayBars0850: 0,
    noToday: 0, fewBars1000: 0, noDaily1000: 0, noBuyBar: 0, noAfter: 0,
  };
  var clockMismatch0850 = 0, clockMismatch1000 = 0, started0850 = 0, notStarted1000 = 0;
  var scored0850 = 0, scored1000 = 0, sumMismatch = 0;
  var shortScored0850 = 0, shortScored1000 = 0;

  // 部品の点数から S1・S2 を作る（0〜100 への切り詰めはしない）
  var sumParts = function (parts, labels) {
    return labels.reduce(function (s, lb) { return s + parts[lb]; }, 0);
  };
  var variantScores = function (parts) {
    var s1 = sumParts(parts, REST_PARTS);
    return { s1: s1, s2: s1 - sumParts(parts, MOMENTUM_PARTS) };
  };
  // T当日の日足が売買に使えるか（PR #88・#89 と同じ除外条件）
  var dailyOk = function (b) {
    return !!b && isNum(b.open) && isNum(b.high) && isNum(b.low) && isNum(b.close) && b.open > 0 &&
      isNum(b.volume) && b.volume !== 0;
  };

  testDays.forEach(function (td) {
    var t = td.t, date = td.date;
    var topixChange = topixChangeFor(t);
    var clock0850 = jstAt(date, "08:50"), clock1000 = jstAt(date, EVAL.clock);
    if (withClock(clock0850, function () { return currentSessionDate("JP"); }) !== date) clockMismatch0850++;
    if (withClock(clock1000, function () { return currentSessionDate("JP"); }) !== date) clockMismatch1000++;
    td.records = [];

    td.cands.forEach(function (si2, order) {
      var st = stocks[si2];
      // e: 8:50の値、m: 10:00の値
      var rec = { day: date, ticker: st.ticker, order: order, fromChange: td.byChange.has(si2), e: null, m: null };
      td.records.push(rec);
      var ix = intraday[si2];
      if (!ix) { skip.noIntraday++; return; }
      var w = windowBefore(ix, date);
      if (!w || w.lastDay !== jpDays[t - 1]) { skip.noPrevBars++; return; }
      var d0 = t0 != null ? bars[si2][t0] : null;
      var tradedOnStart = !!(d0 && isNum(d0.close));
      var extra0850 = missingStartBars(ix, w.to - w.from, w.days, t, APP_WINDOW_DAYS, tradedOnStart);
      if (w.to - w.from + extra0850 < MIN_BARS) { skip.fewBars++; return; }
      var stock = scan.normalizeStock(st.ticker);
      var score = function (payload, clockMs) {
        var pd = scan.toPriceData(payload);
        return { pd: pd, a: withClock(clockMs, function () { return analyzeStock(stock, pd, null, {}); }) };
      };
      var b = bars[si2][t];
      var c1 = bars[si2][t - 1], c2 = bars[si2][t - 2];

      // 8:50: PR #88 と同じ計算。公式の前日終値は T当日の前々日の日足終値（PR #88 と同じ）
      var prev0850 = c2 && isNum(c2.close) ? c2.close : null;
      if (prev0850 == null) skip.noOfficialPrev++;
      var r0 = score(buildPayload(ix, w.from, w.to, prev0850, topixChange), clock0850);
      if (r0.a.sessionStarted) started0850++;
      scored0850++;
      if (extra0850 > 0) shortScored0850++;
      var p0 = toParts(r0.a);
      if (!p0.ok) sumMismatch++;
      var v0 = variantScores(p0.parts);
      var e = { s0: r0.a.save.score, s1: v0.s1, s2: v0.s2 };
      // 前日騰落率: 前日終値 ÷ 前々日終値 − 1（調整後終値。候補の値上がり率と同じ値）
      e.prev1 = c1 && c2 && isNum(c1.adj) && isNum(c2.adj) && c2.adj > 0 ? c1.adj / c2.adj - 1 : null;
      rec.e = e;
      // 8:50の売買: T当日の日足の始値で買い、T当日の15分足で利確・損切りを判定する（PR #88 と同じ）
      if (!dailyOk(b)) skip.noDaily0850++;
      else {
        var dayBars = barsFrom(ix, date, 0);
        if (!dayBars.length) skip.noDayBars0850++;
        else {
          e.exit = judgeExit(b.open, b.close, dayBars);
          e.retB = b.close / b.open - 1 - FEE;
        }
      }

      // 10:00: PR #89 と同じ計算。公式の前日終値は T当日の前日の日足終値
      var wi = windowIntraday(ix, date, jstAt(date, EVAL.cut) / 1000);
      if (!wi || wi.todayBars === 0) { skip.noToday++; return; }
      var extra1000 = missingStartBars(ix, wi.to - wi.from - wi.todayBars, wi.days, t, APP_WINDOW_DAYS - 1, tradedOnStart);
      if (wi.to - wi.from + extra1000 < MIN_BARS) { skip.fewBars1000++; return; }
      var prevIntra = c1 && isNum(c1.close) ? c1.close : null;
      var r1 = score(buildPayload(ix, wi.from, wi.to, prevIntra, topixChange), clock1000);
      if (!r1.a.sessionStarted) notStarted1000++;
      scored1000++;
      if (extra1000 > 0) shortScored1000++;
      var p1 = toParts(r1.a);
      if (!p1.ok) sumMismatch++;
      var v1 = variantScores(p1.parts);
      var m = { s0: r1.a.save.score, s1: v1.s1, s2: v1.s2 };
      // 当日騰落率: 10:00時点の現在値（9:45開始の足の終値）÷ 前日の日足終値 − 1（scripts/score-parts-1000-check.mjs と同じ）
      var price = r1.pd.currentPrice;
      m.today = isNum(prevIntra) && prevIntra > 0 && isNum(price) ? price / prevIntra - 1 : null;
      rec.m = m;
      // 10:00の売買: PR #89 と同じ除外条件と買値（10:00開始の足の始値）
      if (!dailyOk(b)) { skip.noDaily1000++; return; }
      var buy = openAt(ix, date, EVAL.buy);
      if (buy == null) { skip.noBuyBar++; return; }
      var after = barsFrom(ix, date, jstAt(date, EVAL.buy) / 1000);
      if (!after.length) { skip.noAfter++; return; }
      m.exit = judgeExit(buy, b.close, after);
      m.retB = b.close / buy - 1 - FEE;
    });
  });
  console.log("スコア計算 8:50 " + scored0850 + "件（寄り付き後扱い " + started0850 + "、時計のずれ " + clockMismatch0850 + "日）");
  console.log("スコア計算 10:00 " + scored1000 + "件（寄り付き前扱い " + notStarted1000 + "、時計のずれ " + clockMismatch1000 + "日）、部品の合計≠スコア " + sumMismatch + "件");
  if (unknownLabels.size) throw new Error("PART_LABELS に無い部品: " + Array.from(unknownLabels).join(", "));
  if (sumMismatch) throw new Error("部品の点数の合計がスコアと一致しない銘柄日がある: " + sumMismatch);

  // ---------- 4通りの並べ方 ----------

  // key: 大きい方を上位にする値。R は騰落率が低い方を上位にするため符号を反転する
  var METHODS = [
    { id: "S0", label: "S0（今のスコア）", key: function (x) { return x.s0; } },
    { id: "S1", label: "S1（9部品・上限抑制・VIXキャップを除く）", key: function (x) { return x.s1; } },
    { id: "S2", label: "S2（S1 − 9部品の合計）", key: function (x) { return x.s2; } },
  ];
  var TIMES = [
    {
      id: "0850", title: "8:50", side: "e", rise: "prev1", riseLabel: "前日騰落率",
      methods: METHODS.concat([{ id: "R", label: "R（前日騰落率が低い順）", key: function (x) { return isNum(x.prev1) ? -x.prev1 : null; } }]),
    },
    {
      id: "1000", title: "10:00", side: "m", rise: "today", riseLabel: "当日騰落率",
      methods: METHODS.concat([{ id: "R", label: "R（当日騰落率が低い順）", key: function (x) { return isNum(x.today) ? -x.today : null; } }]),
    },
  ];

  // 並べる対象はその時刻のスコアを計算できた銘柄日（PR #88・#89 と同じ）。
  // 同点は候補リストの並び順で先に来る方を上位とし、上位10はちょうど10銘柄に切る（PR #88 と同じ）。
  // 並べる値が無い銘柄日（R で騰落率を計算できなかった場合）は最下位に置く
  var rankDay = function (td, side, key) {
    var list = td.records.filter(function (r) { return r[side]; });
    var noKey = 0;
    list.sort(function (a, b) {
      var ka = key(a[side]), kb = key(b[side]);
      var na = !isNum(ka), nb = !isNum(kb);
      if (na !== nb) return na ? 1 : -1;
      return (na ? 0 : kb - ka) || a.order - b.order;
    });
    list.forEach(function (r) { if (!isNum(key(r[side]))) noKey++; });
    var top = list.slice(0, TOP_N), rest = list.slice(TOP_N);
    // 10位と同点の銘柄が11位以下にもいたか
    var tie = top.length === TOP_N && rest.length > 0 && isNum(key(top[TOP_N - 1][side])) &&
      key(top[TOP_N - 1][side]) === key(rest[0][side]);
    return { list: list, top: top, rest: rest, tie: tie, noKey: noKey };
  };

  // 売買まで判定できた銘柄日の集計
  var agg = function (recs, side, riseKey) {
    var tr = recs.filter(function (r) { return r[side].exit; });
    if (!tr.length) return { n: 0 };
    var o = tr.map(function (r) { return outcome(r[side].exit); });
    var avgO = function (f) { return o.reduce(function (s, x) { return s + x[f]; }, 0) / tr.length; };
    var rises = tr.map(function (r) { return r[side][riseKey]; }).filter(isNum);
    return {
      n: tr.length,
      avgA: avgO("ret"),
      avgB: mean(tr.map(function (r) { return r[side].retB; })),
      winA: avgO("win"), tp: avgO("tp"), sl: avgO("sl"), cl: avgO("cl"),
      share2B: tr.filter(function (r) { return r.fromChange; }).length / tr.length,
      rise: rises.length ? mean(rises) : NaN,
    };
  };

  var half = Math.floor(testDays.length / 2);
  var PERIODS = [
    { label: "全" + testDays.length + "日", days: testDays },
    { label: "前半" + half + "日", days: testDays.slice(0, half) },
    { label: "後半" + (testDays.length - half) + "日", days: testDays.slice(half) },
  ];
  var periodRange = function (days) { return days[0].date + " 〜 " + days[days.length - 1].date; };

  var results = TIMES.map(function (tm) {
    var all = [];
    testDays.forEach(function (td) { td.records.forEach(function (r) { if (r[tm.side]) all.push(r); }); });
    var byMethod = tm.methods.map(function (mt) {
      var top = [], rest = [], tieDays = 0, noKey = 0;
      var perDay = []; // { date, a, b }（上位10の平均 − 11位以下の平均。どちらかが0件の日は null）
      testDays.forEach(function (td) {
        var rk = rankDay(td, tm.side, mt.key);
        if (rk.tie) tieDays++;
        noKey += rk.noKey;
        rk.top.forEach(function (r) { top.push(r); });
        rk.rest.forEach(function (r) { rest.push(r); });
        var at = agg(rk.top, tm.side, tm.rise), ar = agg(rk.rest, tm.side, tm.rise);
        perDay.push(at.n && ar.n ? { date: td.date, a: at.avgA - ar.avgA, b: at.avgB - ar.avgB } : { date: td.date, a: null, b: null });
      });
      var diffs = PERIODS.map(function (pd) {
        var set = new Set(pd.days.map(function (d) { return d.date; }));
        var ds = perDay.filter(function (x) { return set.has(x.date) && x.a != null; });
        return { a: tStat(ds.map(function (x) { return x.a; })), b: tStat(ds.map(function (x) { return x.b; })) };
      });
      return { method: mt, top: agg(top, tm.side, tm.rise), rest: agg(rest, tm.side, tm.rise), tieDays: tieDays, noKey: noKey, diffs: diffs };
    });
    return { time: tm, all: agg(all, tm.side, tm.rise), allScored: all.length, byMethod: byMethod };
  });

  // ---------- S0 の上位10を PR #88・#89 のレポートと突き合わせる（按分） ----------

  var groupRow = function (label, a) {
    return "| " + label + " | " + a.n + " | " + pct3(a.avgA) + " | " + pct1(a.winA) + " | " + pct1(a.tp) + " | " + pct1(a.sl) + " | " + pct1(a.cl) + " |";
  };
  var DIFF_LABEL = "按分（損切りが先の確率2/3）";
  var diffRow = function (d) {
    return "| " + DIFF_LABEL + " | " + d.n + " | " + pct3(d.avg) + " | " + pct3(d.sd) + " | " + num2(d.t) + " |";
  };
  // レポート text の見出し sec（"## 2." など）の中で、marker の行（null なら見出しの直後）より後にある label の行
  var findRow = function (text, sec, marker, label) {
    var lines = text.split("\n");
    var inSec = false, armed = marker == null;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf("#") === 0) { inSec = lines[i].indexOf(sec) === 0; armed = marker == null; continue; }
      if (!inSec) continue;
      if (marker != null && lines[i].indexOf(marker) === 0) armed = true;
      if (armed && lines[i].indexOf("| " + label + " |") === 0) return lines[i];
    }
    return null;
  };
  var PRORATA_MARKER = "**同じ15分足で両方に届いた場合: 按分";
  var readReport = function (rel) { return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"); };
  var REPRO = [
    {
      time: "0850", pr: "PR #88", file: "docs/score-top10-result.md", text: readReport(PR88_REPORT), groupSec: "## 2.", diffSec: "## 3.",
      labels: { top: "スコア上位10", rest: "11位以下", all: "候補全体" }, expect: { n: 355, avg: "-0.032%" },
    },
    {
      time: "1000", pr: "PR #89", file: "docs/score-top10-1000-result.md", text: readReport(PR89_REPORT), groupSec: "## 3.", diffSec: "### 4-1.",
      labels: { top: "10:00のスコアで上位10", rest: "10:00のスコアで11位以下", all: "候補全体" }, expect: { n: 357, avg: "-0.114%" },
    },
  ];
  var reproResults = REPRO.map(function (rp) {
    var res = results.filter(function (x) { return x.time.id === rp.time; })[0];
    var s0 = res.byMethod[0];
    var checks = [
      { what: "上位10", ours: groupRow(rp.labels.top, s0.top), theirs: findRow(rp.text, rp.groupSec, PRORATA_MARKER, rp.labels.top) },
      { what: "11位以下", ours: groupRow(rp.labels.rest, s0.rest), theirs: findRow(rp.text, rp.groupSec, PRORATA_MARKER, rp.labels.rest) },
      { what: "候補全体", ours: groupRow(rp.labels.all, res.all), theirs: findRow(rp.text, rp.groupSec, PRORATA_MARKER, rp.labels.all) },
      { what: "上位10 − 11位以下（日ごとの差）", ours: diffRow(s0.diffs[0].a), theirs: findRow(rp.text, rp.diffSec, null, DIFF_LABEL) },
    ];
    var headOk = s0.top.n === rp.expect.n && pct3(s0.top.avgA) === rp.expect.avg;
    return { rp: rp, s0: s0, checks: checks, headOk: headOk, allOk: headOk && checks.every(function (c) { return c.ours === c.theirs; }) };
  });

  // ---------- 出力 ----------

  var candTotal = testDays.reduce(function (s, td) { return s + td.cands.length; }, 0);
  var L = [];
  L.push("# スコアの作り方を変えた場合の上位10の成績 検証結果");
  L.push("");
  L.push("- 生成: `node scripts/score-variants-check.mjs`（実行日 " + new RealDate().toISOString().slice(0, 10) + "）");
  L.push("- 検証日・候補・データ・スコアの付け方・売り方: 8:50は `scripts/score-top10-check.mjs`（PR #88）、10:00は `scripts/score-top10-1000-check.mjs`（PR #89）と同じ。処理は `scripts/score-parts-1000-check.mjs`（PR #91）から写した");
  L.push("- 候補: 8:50時点のもの（前日の確定値で、出来高上位" + NORMAL_VOL_TOP + "と、値上がり率上位" + CHANGE_TOP + "（出来高が全銘柄の中央値の" + VOL_MULT + "倍以上のもの）を重複なしで並べたもの）。10:00も同じ候補で、作り直さない");
  L.push("- 銘柄一覧: JPX 東証上場銘柄一覧（" + (jpx.asOf || "日付不明") + " 時点）のうち、プライム・スタンダード・グロースの内国株式 " + jpx.list.length + "銘柄");
  L.push("- 15分足: Yahoo Finance（interval=" + INTRADAY_INTERVAL + "、range=" + INTRADAY_RANGE + "）。今回取得できた期間 " + periodStart + " 〜 " + periodEnd + "（PR #88・#89 は " + PR88_INTRADAY_START + " 〜 " + PR88_LAST_DAY + "）");
  L.push("- スコア: 自動スキャン（`api/_scan.js`）と同じく VIX なし・過去の的中率の統計なし。TOPIX前日比は " + topixSource + (topixSource === TOPIX_PROXY ? "（TOPIX 連動ETF で代用）" : "") + " の日足（調整後終値）で、T当日の前日の値（8:50・10:00とも同じ値）");
  L.push("");
  L.push("損益の定義（どちらも往復コスト0.1%を引いた値）:");
  L.push("");
  L.push("- 8:50の買値: T当日の日足の始値（寄り付き）。売り方の判定は T当日の15分足をすべて使う（PR #88 と同じ）");
  L.push("- 10:00の買値: 10:00開始の15分足の始値。売り方の判定は10:00開始の足から後を使う（PR #89 と同じ）");
  L.push("- 損益A（売り方ルール）: 利確ライン 買値 × 1.015・損切りライン 買値 × 0.9925。時刻順に見て先に届いた方で決着。どちらにも届かなければ T当日の日足の終値で手仕舞い。同じ15分足で両方に届いた場合は PR #88 の按分（損切りが先 2/3・利確が先 1/3 の加重平均）");
  L.push("- 損益B（買値→大引け）: T当日の日足の終値 ÷ 買値 − 1 − 0.1%");
  L.push("- 勝率（損益A）: 損益Aがプラスだった割合。同じ足で両方に届いた件を 1/3 勝ちとして数える（PR #88 と同じ）");
  L.push("- 前日騰落率: 前日終値 ÷ 前々日終値 − 1（Yahoo の日足の調整後終値。候補の値上がり率と同じ値）");
  L.push("- 当日騰落率: 10:00時点の現在値 ÷ 前日終値 − 1（現在値は9:45開始の15分足の終値。前日終値は Yahoo の日足の終値。`scripts/score-parts-1000-check.mjs` と同じ）");
  L.push("- グループ2B: 前日値上がり率上位" + CHANGE_TOP + "から候補入りした銘柄");
  L.push("");

  L.push("## 1. 比べるスコア");
  L.push("");
  L.push("| 名前 | 作り方 |");
  L.push("| --- | --- |");
  L.push("| S0 | `analyzeStock()` の返すスコアそのまま |");
  L.push("| S1 | 部品の点数の合計から、下の9部品と「" + CAP_PARTS.join("」「") + "」を除いたもの。0〜100 への切り詰めはしない |");
  L.push("| S2 | S1 − 下の9部品の点数の合計 |");
  L.push("| R | スコアを使わない。8:50は前日騰落率が低い順、10:00は当日騰落率が低い順 |");
  L.push("");
  L.push("- S1・S2 で除いた9部品: " + MOMENTUM_PARTS.join("、"));
  L.push("- S1・S2 のどちらにも入れない調整: " + CAP_PARTS.join("、") + "（上限抑制は 0〜100 への切り詰めで動いた点を含む）");
  L.push("- S1 に残る部品: " + REST_PARTS.join("、"));
  L.push("- 部品の点数は `analyzeStock()` の返り値の `breakdown`（{label, delta} の配列）から取り出した。項目が出てこない部品は0点。8:50の " + scored0850 + "件・10:00の " + scored1000 + "件のすべてで部品の点数の合計がスコアと一致した（不一致 " + sumMismatch + "件）。`src/lib/analyze.js` の変更・中身の複製はしていない");
  L.push("- 並べる対象: その時刻のスコアを計算できた銘柄日（PR #88・#89 と同じ）。4通りとも同じ対象から上位10を選ぶ");
  L.push("- 同点の扱い: PR #88 と同じ。同点は候補リストの並び順で先に来る方を上位とし、上位10はちょうど10銘柄に切る。R で騰落率を計算できなかった銘柄日は最下位に置く（該当: 8:50 " + results[0].byMethod[3].noKey + "件、10:00 " + results[1].byMethod[3].noKey + "件）");
  L.push("- 成績（件数・損益・勝率・グループ2Bの割合・騰落率の平均）は、上位10のうち売買まで判定できた銘柄日で集計した");
  L.push("");

  L.push("## 2. 検証日数と件数");
  L.push("");
  L.push("| 項目 | 値 |");
  L.push("| --- | ---: |");
  L.push("| 検証日数 | " + testDays.length + "（" + periodRange(testDays) + "） |");
  PERIODS.slice(1).forEach(function (pd) { L.push("| " + pd.label + " | " + periodRange(pd.days) + " |"); });
  L.push("| 候補の銘柄日数 | " + candTotal + " |");
  L.push("| 8:50のスコアを計算できた銘柄日数（8:50の並べる対象） | " + scored0850 + " |");
  L.push("| └ うち8:50の売買まで判定できた | " + results[0].all.n + " |");
  L.push("| 10:00のスコアを計算できた銘柄日数（10:00の並べる対象） | " + scored1000 + " |");
  L.push("| └ うち10:00の売買まで判定できた | " + results[1].all.n + " |");
  L.push("| 日足の取得に失敗した銘柄 | " + failed.length + " |");
  L.push("| 15分足の取得対象の銘柄 | " + targets.length + " |");
  L.push("| 15分足の取得に失敗した銘柄 | " + intradayFailed.length + " |");
  L.push("| スコアを計算しなかった銘柄日: 15分足の取得失敗 | " + skip.noIntraday + " |");
  L.push("| スコアを計算しなかった銘柄日: 前日の15分足が無い | " + skip.noPrevBars + " |");
  L.push("| スコアを計算しなかった銘柄日: 15分足が" + MIN_BARS + "本未満（8:50の範囲で判定） | " + skip.fewBars + " |");
  L.push("| 8:50の売買から除いた銘柄日: T当日の日足の欠け・出来高0 | " + skip.noDaily0850 + " |");
  L.push("| 8:50の売買から除いた銘柄日: T当日の15分足が無い | " + skip.noDayBars0850 + " |");
  L.push("| 10:00のスコアを計算しなかった銘柄日: T当日の足が10:00前に無い | " + skip.noToday + " |");
  L.push("| 10:00のスコアを計算しなかった銘柄日: 15分足が" + MIN_BARS + "本未満（10:00の範囲で判定） | " + skip.fewBars1000 + " |");
  L.push("| 10:00の売買から除いた銘柄日: T当日の日足の欠け・出来高0 | " + skip.noDaily1000 + " |");
  L.push("| 10:00の売買から除いた銘柄日: 10:00開始の15分足が無い・始値が無い | " + skip.noBuyBar + " |");
  L.push("| 10:00の売買から除いた銘柄日: 10:00以降の15分足が無い | " + skip.noAfter + " |");
  L.push("");
  L.push("- 時計の差し替え: 8:50は対象日の 8:50、10:00は対象日の 10:00（日本時間）に `Date.now()` と引数なしの `new Date()` を固定した。`currentSessionDate(\"JP\")` が対象日を返さなかった日: 8:50 " + clockMismatch0850 + "日、10:00 " + clockMismatch1000 + "日。寄り付き後扱いになった8:50の件数 " + started0850 + "、寄り付き前扱いになった10:00の件数 " + notStarted1000);
  L.push("- 15分足の加工: `api/stock.js` の `toLocalDates()` の写しが一字一句同じであることを実行時に確かめた（" + (datesCopyOk ? "一致" : "不一致") + "）。空の足の埋め方（`toPriceData`）と銘柄情報の形（`normalizeStock`）は `api/_scan.js` から import した");
  L.push("- 15分足の欠け: Yahoo の15分足は直近60日分しか返らず、今回は " + PR88_INTRADAY_START + " の足が取れなかった（PR #88・#89 の15分足の期間で取れなかった日: " + (lostDays.length ? lostDays.join("・") : "なし") + "。それ以外に取れない日は無い）。`scripts/score-parts-1000-check.mjs` と同じ扱いで、600本以上の条件を判定するときに「" + PR88_INTRADAY_START + " の足があれば増えていた本数」を足し、PR #88・#89 と同じ " + PR88_DAY_COUNT + "日・同じ銘柄日を対象にした。PR #88・#89 の窓にこの日が入っていた検証日: 8:50 " + shortWindowDays0850.length + "日（" + shortWindowDays0850.join("・") + "）、10:00 " + shortWindowDays1000.length + "日（" + shortWindowDays1000.join("・") + "）。窓が1日分短いまま計算した銘柄日: 8:50 " + shortScored0850 + "件、10:00 " + shortScored1000 + "件");
  L.push("");

  var sec = 3;
  results.forEach(function (res) {
    var tm = res.time;
    L.push("## " + sec + ". " + tm.title + "時点");
    L.push("");
    L.push("### " + sec + "-1. 上位10の成績");
    L.push("");
    L.push("| 並べ方 | 件数 | 損益A 平均 | 損益B 平均 | 勝率（損益A） | グループ2Bの割合 | " + tm.riseLabel + "の平均 |");
    L.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    var row1 = function (label, a) {
      return "| " + label + " | " + a.n + " | " + pct3(a.avgA) + " | " + pct3(a.avgB) + " | " + pct1(a.winA) + " | " + pct1(a.share2B) + " | " + pct2(a.rise) + " |";
    };
    res.byMethod.forEach(function (bm) { L.push(row1(bm.method.label + " 上位10", bm.top)); });
    L.push(row1("候補全体", res.all));
    L.push("");
    L.push("- 上位10に入った銘柄日: 各並べ方とも " + (testDays.length * TOP_N) + "（" + testDays.length + "日 × " + TOP_N + "）のうち売買まで判定できたものが件数");
    L.push("- 候補全体: " + tm.title + "のスコアを計算でき、売買まで判定できた銘柄日");
    L.push("- 10位と同点の銘柄が11位以下にもいた日: " + res.byMethod.map(function (bm) { return bm.method.id + " " + bm.tieDays + "日"; }).join("、") + "（" + testDays.length + "日中）");
    L.push("");
    L.push("### " + sec + "-2. 上位10 − 11位以下（日ごとの差）");
    L.push("");
    L.push("| 並べ方 | 期間 | 日数 | 損益A 差の平均 | 損益A t値 | 損益B 差の平均 | 損益B t値 |");
    L.push("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
    res.byMethod.forEach(function (bm) {
      PERIODS.forEach(function (pd, pi) {
        var d = bm.diffs[pi];
        L.push("| " + bm.method.id + " | " + pd.label + " | " + d.a.n + " | " + pct3(d.a.avg) + " | " + num2(d.a.t) + " | " + pct3(d.b.avg) + " | " + num2(d.b.t) + " |");
      });
    });
    L.push("");
    L.push("- 期間: " + PERIODS.map(function (pd) { return pd.label + " " + periodRange(pd.days); }).join("、"));
    L.push("- 日ごとに「上位10の平均 − 11位以下の平均」を出し（どちらも売買まで判定できた銘柄日の平均）、その平均と t値（平均 ÷（不偏標準偏差 ÷ √日数））を示した。どちらかの群が0件の日は除いた");
    L.push("");
    sec++;
  });

  L.push("## " + sec + ". S0 の上位10と PR #88・#89 のレポートとの一致（按分）");
  L.push("");
  L.push("| 時点 | 突き合わせ先 | 期待値（件数 / 損益A 平均） | 今回（件数 / 損益A 平均） | 件数と平均 | 下表の4行 |");
  L.push("| --- | --- | --- | --- | --- | --- |");
  reproResults.forEach(function (x) {
    var tmTitle = x.rp.time === "0850" ? "8:50" : "10:00";
    L.push("| " + tmTitle + " | " + x.rp.pr + "（`" + x.rp.file + "`） | " + x.rp.expect.n + " / " + x.rp.expect.avg + " | " + x.s0.top.n + " / " + pct3(x.s0.top.avgA) + " | " + (x.headOk ? "一致" : "不一致") + " | " + (x.checks.every(function (c) { return c.ours === c.theirs; }) ? "すべて一致" : "不一致あり") + " |");
  });
  L.push("");
  L.push("行ごとの突き合わせ（今回の値で相手のレポートと同じ形式の行を作り、文字列で比べた。群の行の列は 件数 / 平均損益 / 勝率 / 利確 / 損切り / 大引け手仕舞い、差の行の列は 日数 / 差の平均 / 差の標準偏差 / t値）:");
  L.push("");
  L.push("| 時点 | 項目 | 今回 | 相手のレポート | 結果 |");
  L.push("| --- | --- | --- | --- | --- |");
  var cells = function (row) { return row ? row.split("|").slice(2, -1).map(function (c) { return c.trim(); }).join(" / ") : "（行が見つからない）"; };
  reproResults.forEach(function (x) {
    var tmTitle = x.rp.time === "0850" ? "8:50" : "10:00";
    x.checks.forEach(function (c) {
      L.push("| " + tmTitle + " | " + c.what + " | " + cells(c.ours) + " | " + cells(c.theirs) + " | " + (c.ours === c.theirs ? "一致" : "不一致") + " |");
    });
  });
  L.push("");

  var outPath = fileURLToPath(new URL("../docs/score-variants-result.md", import.meta.url));
  writeFileSync(outPath, L.join("\n") + "\n");
  console.log(L.join("\n"));
  console.log("\n→ " + outPath);
  reproResults.forEach(function (x) {
    x.checks.forEach(function (c) { if (c.ours !== c.theirs) console.log(x.rp.pr + " と一致しない行:\n" + c.ours + "\n  " + x.rp.pr + ": " + c.theirs); });
  });
};

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
