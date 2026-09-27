// scripts/overheat-overlap-check.mjs
// 10:00時点のスコア上位10（S1 と S0）に「前日に大きく上がった銘柄」がどれくらい混ざっていたか、
// 混ざっていた銘柄の成績が悪かったかを調べる。アプリに「上がり過ぎ注意」の目印を付ける価値があるかの判断材料。
//
// 「上がり過ぎ」の定義は scripts/exit-rule-check.mjs・scripts/hourly-exit-check.mjs のグループ2B と同じ:
// 母集団（前日の出来高と前日・前々日の調整後終値が揃っている銘柄）のうち、前日出来高が中央値の1.5倍以上の銘柄を
// 前日騰落率（前日の調整後終値 ÷ 前々日の調整後終値 − 1）の高い順に並べた上位20（CHANGE_TOP）。
// これは候補の作り方（buildCandidates）の byChange そのものなので、S1・S0 の上位10の銘柄が
// その日の byChange に入っていたかで判定する。何%以上という固定の線は無い（順位で決まる）。
//
// 期間（2026-07-31〜09-24 の36日、前半18日・後半18日）・銘柄の選び方（10:00時点の S1・S0 の上位10）・
// 買値（10:00開始の15分足の始値）・データの取得方法・コスト（往復0.1%）・按分（損切りが先2/3）・
// 売り方（利確 +1.5%・損切り −0.75%、届かなければ大引け）は scripts/exit-grid-check.mjs（PR #95）と同じ。
// 処理は exit-grid-check.mjs から写した（元のファイルは処理がすべて main() の中にあり、import すると
// 既存のレポート docs/exit-grid-result.md を書き換えるため）。写しが正しいことは、今の売り方と大引け保有の成績を
// docs/exit-grid-result.md の0章の「今回」の列と突き合わせて確かめる。
// アプリ本体とは無関係の単発検証スクリプト。新しい npm パッケージは使わない。
//
// 実行: node scripts/overheat-overlap-check.mjs
// 出力: docs/overheat-overlap-result.md
//
// 任意: 環境変数 OVERHEAT_CHECK_CACHE にディレクトリを指定すると、Yahoo の取得結果を
//       そこに JSON で保存し、次回以降はそれを読む（形式は exit-grid-check.mjs のキャッシュと同じ）。
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
var TAKE_PROFIT = 0.015; // 今の売り方の利確ライン: 買値 × 1.015
var STOP_LOSS = -0.0075; // 今の売り方の損切りライン: 買値 × 0.9925
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

// 部品（analyze.js の breakdown のラベル。analyze.js で積み上がる順。scripts/score-parts-check.mjs と同じ）
var PART_LABELS = [
  "VWAP", "VWAP傾き", "Pivot", "ATR(値幅)", "ATR消化率", "対TOPIX", "トレンド", "EMA整列", "MACD", "RSI",
  "BB", "Stoch", "重複ボーナス", "出来高/OBV", "ギャップ", "当日ブレイク", "寄り付きレンジ", "コンフルエンス",
  "実績反映調整", "上限抑制(下降/デッドクロス/VWAP)", "VIXキャップ",
];
// S1 で除く9部品（PR #90・#91 で「すでに上がった銘柄」に点を与える側に出た部品）
var EXCLUDED_PARTS = ["対TOPIX", "トレンド", "EMA整列", "出来高/OBV", "コンフルエンス", "VWAP", "ギャップ", "当日ブレイク", "寄り付きレンジ"];
// S1 で除く、部品の合計にかかる上限（0〜100への切り詰めを含む）
var CAP_PARTS = ["上限抑制(下降/デッドクロス/VWAP)", "VIXキャップ"];
// S1 に残る部品
var KEPT_PARTS = PART_LABELS.filter(function (lb) { return EXCLUDED_PARTS.indexOf(lb) < 0 && CAP_PARTS.indexOf(lb) < 0; });

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
// ---------- 売り方（今の売り方だけ。scripts/exit-grid-check.mjs の exitFixed と同じ） ----------

// 前半・後半の境目（前半の最終日）。PR #92・#93 のレポートの前半18日・後半18日と同じ
var FIRST_HALF_LAST = "2026-08-26";
var SECOND_HALF_FIRST = "2026-08-27";

// 1件の結果。parts は「その件がどう終わったか」の内訳（按分の件は利確1/3・損切り2/3の2つ）。
// ret は内訳の加重平均（按分の件は PR #88 と同じ加重平均）。overlap は同じ足で売りの条件が2つ以上重なったか
var single = function (ret) { return { parts: [{ w: 1, ret: ret }], ret: ret, overlap: 0 }; };

// どの条件にも届かなければ大引け（T当日の日足の終値）で売る（損益Bと同じ式）
var closeOut = function (tr) { return single(tr.dayClose / tr.buy - 1 - FEE); };

// A: 固定幅。scripts/score-variants-check.mjs の judgeExit・outcome（按分）と同じ判定・同じ式で、
// 利確・損切りの幅を引数にしたもの。null の側は判定しない
var exitFixed = function (tr, tpRate, slRate) {
  var tp = tpRate == null ? null : tr.buy * (1 + tpRate), sl = slRate == null ? null : tr.buy * (1 + slRate);
  for (var i = 0; i < tr.bars.length; i++) {
    var hitTp = tp != null && tr.bars[i].high >= tp, hitSl = sl != null && tr.bars[i].low <= sl;
    if (hitTp && hitSl) {
      var tpNet = tpRate - FEE, slNet = slRate - FEE;
      var pTp = 1 - SL_FIRST_PROB;
      return { parts: [{ w: pTp, ret: tpNet }, { w: SL_FIRST_PROB, ret: slNet }], ret: pTp * tpNet + SL_FIRST_PROB * slNet, overlap: 1 };
    }
    if (hitTp) return single(tpRate - FEE);
    if (hitSl) return single(slRate - FEE);
  }
  return closeOut(tr);
};

// 結果の配列（1件1つ）の集計。按分の件は内訳ごとに重みを付けて勝ち・負け・最悪を数える
var summarize = function (res) {
  var n = res.length;
  if (!n) return { n: 0 };
  var winW = 0, winSum = 0, lossW = 0, lossSum = 0, worst = Infinity, overlap = 0, fallback = 0, gap = 0;
  res.forEach(function (x) {
    x.parts.forEach(function (p) {
      if (p.ret > 0) { winW += p.w; winSum += p.w * p.ret; } else { lossW += p.w; lossSum += p.w * p.ret; }
      if (p.ret < worst) worst = p.ret;
    });
    overlap += x.overlap;
    fallback += x.fallback || 0;
    gap += x.gap || 0;
  });
  return {
    n: n, avg: mean(res.map(function (x) { return x.ret; })), win: winW / n,
    winAvg: winW ? winSum / winW : NaN, lossAvg: lossW ? lossSum / lossW : NaN, worst: worst,
    overlap: overlap / n, fallback: fallback, gap: gap,
  };
};

// 符号付きの%表記（差の表示用）
var spct3 = function (v) { return isNum(v) ? (v > 0 ? "+" : "") + (v * 100).toFixed(3) + "%" : "-"; };

// ---------- 本体 ----------

var main = async function () {
  var cacheDir = process.env.OVERHEAT_CHECK_CACHE || null;
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
    // 上がり過ぎの判定用: 各銘柄の前日騰落率（2B と同じ調整後終値の比）と、2B の中での順位（1〜20）
    td.prevRet = new Map();
    pop.forEach(function (p) { td.prevRet.set(p.idx, p.prevRet); });
    td.changeRank = new Map();
    c.byChange.forEach(function (idx, i) { td.changeRank.set(idx, i + 1); });
    // その日の2Bに入った最も低い前日騰落率（20位の値。2Bが20件に満たない日は最後の銘柄の値）
    td.changeFloor = c.byChange.length ? td.prevRet.get(c.byChange[c.byChange.length - 1]) : null;
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

  // T当日の15分足のうち、startSec 以降に始まる足（時刻順）。15:30 の足は使わない（PR #89 と同じ）。
  // 足の選び方と高値・安値の補い方は元のまま。時刻の売り方・高値からの下落・建値ストップのため、
  // 開始時刻（hm）・始値・終値も返す
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
        hm: hmOf(r, i),
        open: o,
        high: r.high[i] != null ? r.high[i] : Math.max(o, r.close[i]),
        low: r.low[i] != null ? r.low[i] : Math.min(o, r.close[i]),
        close: r.close[i],
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

  // T当日の日足が売買の判定に使えるか（PR #88・#89 と同じ除外条件）
  var dailyOk = function (b) {
    return !!b && isNum(b.open) && isNum(b.high) && isNum(b.low) && isNum(b.close) && b.open > 0 &&
      isNum(b.volume) && b.volume !== 0;
  };
  // 部品の点数から S1 を作る（scripts/score-variants-check.mjs の variantScores と同じく PART_LABELS の順に足す）
  var s1Of = function (parts) {
    var kept = 0;
    PART_LABELS.forEach(function (lb) {
      if (KEPT_PARTS.indexOf(lb) >= 0) kept += parts[lb];
    });
    return kept;
  };

  // 日ごとの除外件数（実装前確認2のため。元のスクリプトの skip・skipTrade["1000"] と同じ分け方）
  var SKIP_KEYS = [
    { key: "noIntraday", label: "15分足の取得失敗" },
    { key: "noPrevBars", label: "前日の15分足が無い" },
    { key: "fewBars", label: "15分足が" + MIN_BARS + "本未満（8:50の範囲で判定）" },
    { key: "noToday", label: "T当日の足が10:00前に無い" },
    { key: "fewBars1000", label: "15分足が" + MIN_BARS + "本未満（10:00の範囲で判定）" },
    { key: "noDaily", label: "売買から除外: T当日の日足の欠け・出来高0" },
    { key: "noBuyBar", label: "売買から除外: 10:00開始の15分足が無い・始値が無い" },
    { key: "noAfter", label: "売買から除外: 10:00以降の15分足が無い" },
  ];
  // PR #95 のレポート（docs/exit-grid-result.md の確認2の「今回」の列）の件数と、10:00のスコアを計算できた銘柄日の数
  var EXIT_GRID_SKIP = { noIntraday: 27, noPrevBars: 0, fewBars: 5, noToday: 0, fewBars1000: 0, noDaily: 0, noBuyBar: 34, noAfter: 0 };
  var EXIT_GRID_SCORED = 2053;
  var daySkip = {};
  var clockMismatch1000 = 0, notStarted1000 = 0, scored1000 = 0, sumMismatch = 0, shortScored1000 = 0;

  testDays.forEach(function (td) {
    var t = td.t, date = td.date;
    var topixChange = topixChangeFor(t);
    var clock1000 = jstAt(date, EVAL.clock);
    if (withClock(clock1000, function () { return currentSessionDate("JP"); }) !== date) clockMismatch1000++;
    td.records = [];
    var dsk = daySkip[date] = { cands: td.cands.length, scored: 0, traded: 0 };
    SKIP_KEYS.forEach(function (k) { dsk[k.key] = 0; });

    td.cands.forEach(function (si2, order) {
      var st = stocks[si2];
      // at["1000"]: 10:00のスコアを計算できた場合だけ入る（元のスクリプトと同じ形）
      // overheat: その日の2B（byChange）に入っていたか。prevRetRaw は調整前の終値で計算した前日騰落率（参考の突き合わせ用）
      var q1 = bars[si2][t - 1], q2 = bars[si2][t - 2];
      var rec = {
        day: date, ticker: st.ticker, order: order, at: {},
        overheat: td.byChange.has(si2), changeRank: td.changeRank.get(si2) || null, prevRet: td.prevRet.get(si2),
        prevRetRaw: q1 && q2 && isNum(q1.close) && isNum(q2.close) && q2.close > 0 ? q1.close / q2.close - 1 : null,
      };
      td.records.push(rec);
      var ix = intraday[si2];
      if (!ix) { dsk.noIntraday++; return; }
      // 8:50の範囲での判定（元のスクリプトは8:50のスコアを計算できなかった銘柄日を10:00でも計算しないため、同じ条件で除く）
      var w = windowBefore(ix, date);
      if (!w || w.lastDay !== jpDays[t - 1]) { dsk.noPrevBars++; return; }
      var d0 = t0 != null ? bars[si2][t0] : null;
      var tradedOnStart = !!(d0 && isNum(d0.close));
      var extra0850 = missingStartBars(ix, w.to - w.from, w.days, t, APP_WINDOW_DAYS, tradedOnStart);
      if (w.to - w.from + extra0850 < MIN_BARS) { dsk.fewBars++; return; }
      var stock = scan.normalizeStock(st.ticker);
      var b = bars[si2][t];

      // 10:00: PR #89・#91・#92 と同じ計算。公式の前日終値は T当日の前日の日足終値
      var wi = windowIntraday(ix, date, jstAt(date, EVAL.cut) / 1000);
      if (!wi || wi.todayBars === 0) { dsk.noToday++; return; }
      var extra1000 = missingStartBars(ix, wi.to - wi.from - wi.todayBars, wi.days, t, APP_WINDOW_DAYS - 1, tradedOnStart);
      if (wi.to - wi.from + extra1000 < MIN_BARS) { dsk.fewBars1000++; return; }
      var pPrev1 = bars[si2][t - 1];
      var prevIntra = pPrev1 && isNum(pPrev1.close) ? pPrev1.close : null;
      var pd = scan.toPriceData(buildPayload(ix, wi.from, wi.to, prevIntra, topixChange));
      var a = withClock(clock1000, function () { return analyzeStock(stock, pd, null, {}); });
      if (!a.sessionStarted) notStarted1000++;
      scored1000++;
      dsk.scored++;
      if (extra1000 > 0) shortScored1000++;
      var p1 = toParts(a);
      if (!p1.ok) sumMismatch++;
      var m = rec.at["1000"] = { s0: a.save.score, s1: s1Of(p1.parts) };
      // 売買: PR #89・#91・#92 と同じ除外条件と買値（10:00開始の足の始値）
      if (!dailyOk(b)) { dsk.noDaily++; return; }
      var buy = openAt(ix, date, EVAL.buy);
      if (buy == null) { dsk.noBuyBar++; return; }
      var after = barsFrom(ix, date, jstAt(date, EVAL.buy) / 1000);
      if (!after.length) { dsk.noAfter++; return; }
      m.trade = { buy: buy, dayClose: b.close, bars: after };
      dsk.traded++;
    });
  });
  console.log("スコア計算 10:00 " + scored1000 + "件（寄り付き前扱い " + notStarted1000 + "、時計のずれ " + clockMismatch1000 + "日）、部品の合計≠スコア " + sumMismatch + "件");
  if (unknownLabels.size) throw new Error("PART_LABELS に無い部品: " + Array.from(unknownLabels).join(", "));
  if (sumMismatch) throw new Error("部品の点数の合計がスコアと一致しない銘柄日がある: " + sumMismatch);

  var skipTotal = {};
  SKIP_KEYS.forEach(function (k) {
    skipTotal[k.key] = testDays.reduce(function (s, td) { return s + daySkip[td.date][k.key]; }, 0);
  });

  // ---------- 上位10（scripts/score-variants-check.mjs の rankKey・rankDay と同じ並べ方） ----------

  // 各日の並べ替え。対象は10:00のスコアを計算できた候補。値の高い順、同点は候補の並び順（order）が先のものを上にする
  var rankDay = function (td, method) {
    var list = td.records.filter(function (r) { return r.at["1000"]; });
    list.sort(function (a, b) {
      var ka = a.at["1000"][method], kb = b.at["1000"][method];
      var na = !isNum(ka), nb = !isNum(kb);
      if (na || nb) return na === nb ? a.order - b.order : (na ? 1 : -1);
      return kb - ka || a.order - b.order;
    });
    return list.slice(0, TOP_N);
  };

  var half = Math.ceil(testDays.length / 2);
  if (testDays[half - 1].date !== FIRST_HALF_LAST || testDays[half].date !== SECOND_HALF_FIRST) {
    throw new Error("前半・後半の境目が " + FIRST_HALF_LAST + " / " + SECOND_HALF_FIRST + " にならない: " + testDays[half - 1].date + " / " + testDays[half].date);
  }
  var PERIODS = [
    { key: "all", label: "全" + testDays.length + "日", dates: new Set(testDays.map(function (d) { return d.date; })) },
    { key: "first", label: "前半" + half + "日", dates: new Set(testDays.slice(0, half).map(function (d) { return d.date; })) },
    { key: "second", label: "後半" + (testDays.length - half) + "日", dates: new Set(testDays.slice(half).map(function (d) { return d.date; })) },
  ];
  var rangeOf = function (days) { return days[0].date + " 〜 " + days[days.length - 1].date; };
  var PERIOD_RANGES = [rangeOf(testDays), rangeOf(testDays.slice(0, half)), rangeOf(testDays.slice(half))];

  var SELECTIONS = [
    { key: "s1", label: "S1 上位10" },
    { key: "s0", label: "S0 上位10" },
  ];

  // ---------- 上位10に上がり過ぎ（2B）が混ざったか、と成績 ----------

  // 前日騰落率の区分（下限以上・上限未満）
  var BUCKETS = [
    { label: "0%未満", lo: -Infinity, hi: 0 },
    { label: "0〜3%", lo: 0, hi: 0.03 },
    { label: "3〜5%", lo: 0.03, hi: 0.05 },
    { label: "5〜10%", lo: 0.05, hi: 0.10 },
    { label: "10%以上", lo: 0.10, hi: Infinity },
  ];
  var bucketOf = function (v) {
    for (var i = 0; i < BUCKETS.length; i++) if (v >= BUCKETS[i].lo && v < BUCKETS[i].hi) return i;
    return -1;
  };
  // 判断の目安: S1 上位10のうち当てはまった件数がこれ未満なら目印は見送り候補（上位10の枠 36日 × 10 の5%）
  var SLOT_TOTAL = testDays.length * TOP_N;
  var JUDGE_MIN = Math.ceil(SLOT_TOTAL * 0.05);

  SELECTIONS.forEach(function (sel) {
    sel.days = [];
    sel.top = []; // 上位10のすべて（売買できなかった銘柄日も含む）
    sel.trades = []; // 上位10のうち売買まで判定できた件
    testDays.forEach(function (td) {
      var top = rankDay(td, sel.key);
      sel.days.push({ date: td.date, n: top.length, hit: top.filter(function (r) { return r.overheat; }).length, floor: td.changeFloor });
      top.forEach(function (r, i) {
        var x = { date: td.date, rank: i + 1, rec: r };
        sel.top.push(x);
        var trd = r.at["1000"].trade;
        if (!trd) return;
        x.res = exitFixed(trd, TAKE_PROFIT, STOP_LOSS);
        x.hold = closeOut(trd);
        sel.trades.push(x);
      });
    });
  });

  // 1回ごとの損益の平均・勝率に、1回ごとの損益で出した t値（平均 ÷（不偏標準偏差 ÷ √件数））を加える
  var groupStat = function (list) {
    var s = summarize(list.map(function (x) { return x.res; }));
    if (!s.n) return s;
    var rets = list.map(function (x) { return x.res.ret; });
    s.sd = sd(rets);
    s.t = s.avg / (s.sd / Math.sqrt(s.n));
    return s;
  };
  // 2群の平均の差と、その t値（ウェルチ。分散が等しいとは仮定しない）
  var welch = function (a, b) {
    if (!a.n || !b.n || a.n < 2 || b.n < 2) return { diff: a.n && b.n ? a.avg - b.avg : NaN, t: NaN };
    return { diff: a.avg - b.avg, t: (a.avg - b.avg) / Math.sqrt(a.sd * a.sd / a.n + b.sd * b.sd / b.n) };
  };
  SELECTIONS.forEach(function (sel) {
    sel.stats = {};
    PERIODS.forEach(function (p) {
      var inP = sel.trades.filter(function (x) { return p.dates.has(x.date); });
      var hit = groupStat(inP.filter(function (x) { return x.rec.overheat; }));
      var rest = groupStat(inP.filter(function (x) { return !x.rec.overheat; }));
      sel.stats[p.key] = { all: groupStat(inP), hit: hit, rest: rest, diff: welch(hit, rest) };
    });
    sel.hitTotal = sel.top.filter(function (x) { return x.rec.overheat; }).length;
    sel.hitTraded = sel.trades.filter(function (x) { return x.rec.overheat; }).length;
  });

  // ---------- 写しの確認: 今の売り方と大引け保有の成績を PR #95 のレポートと突き合わせる ----------

  var EXIT_GRID_REPORT = "../docs/exit-grid-result.md";
  // docs/exit-grid-result.md の0章の表の「今回」の列（件数 / 今の売り方 / 大引け保有 / 勝率）
  var exitGridRow = function (label) {
    var lines = readFileSync(fileURLToPath(new URL(EXIT_GRID_REPORT, import.meta.url)), "utf8").split("\n");
    var inSec = false;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf("## ") === 0) inSec = lines[i].indexOf("## 0.") === 0;
      if (inSec && lines[i].indexOf("| " + label + " |") === 0) {
        var cells = lines[i].split("|").map(function (c) { return c.trim(); }).filter(Boolean);
        return cells[2] || null;
      }
    }
    return null;
  };
  var CHECKS = SELECTIONS.map(function (sel) {
    var all = sel.stats.all.all;
    var holdAvg = mean(sel.trades.map(function (x) { return x.hold.ret; }));
    var ours = [String(all.n), pct3(all.avg), pct3(holdAvg), pct1(all.win)].join(" / ");
    var theirs = exitGridRow(sel.key.toUpperCase());
    return { label: sel.key.toUpperCase(), ours: ours, theirs: theirs, ok: ours === theirs };
  });

  // 参考: 調整前の終値で計算した前日騰落率だと、区分が変わる上位10の銘柄日
  var rawDiff = [];
  SELECTIONS.forEach(function (sel) {
    sel.top.forEach(function (x) {
      var r = x.rec;
      if (isNum(r.prevRetRaw) && bucketOf(r.prevRetRaw) !== bucketOf(r.prevRet)) {
        rawDiff.push(sel.key.toUpperCase() + " " + x.date + " " + r.ticker + "（調整後 " + pct2(r.prevRet) + "・調整前 " + pct2(r.prevRetRaw) + "）");
      }
    });
  });

  // ---------- 出力 ----------

  var s1 = SELECTIONS[0], s0 = SELECTIONS[1];
  var share = function (sel) { return pct1(sel.hitTotal / SLOT_TOTAL); };
  var statCells = function (s) {
    if (!s.n) return "0 | - | - | -";
    return s.n + " | " + pct3(s.avg) + " | " + pct1(s.win) + " | " + num2(s.t);
  };
  var diffLine = function (sel, pkey) {
    var st = sel.stats[pkey];
    return "当てはまった − 当てはまらなかった " + spct3(st.diff.diff) + "（t値 " + num2(st.diff.t) + "）";
  };

  var L = [];
  L.push("# 10:00時点の上位10に混ざった「前日に大きく上がった銘柄」の件数と成績 試算結果");
  L.push("");

  // 結論（3行）
  var verdict = s1.hitTotal < JUDGE_MIN
    ? "判断の目安（" + JUDGE_MIN + "件未満）に当たるため、目印は見送り候補"
    : "判断の目安（" + JUDGE_MIN + "件以上）に当たるため、成績の差を見て判断する";
  var dirWord = function (sel, pkey) {
    var st = sel.stats[pkey];
    if (!st.hit.n || !st.rest.n) return "比べられない";
    return st.diff.diff < 0 ? "悪い" : "良い";
  };
  L.push("## 結論");
  L.push("");
  L.push("1. S1 上位10（" + SLOT_TOTAL + "枠）に前日値上がり上位（2B）の銘柄が混ざったのは " + s1.hitTotal + "件（" + share(s1) + "）。" + verdict + "。");
  L.push("2. S1 で当てはまった銘柄の成績は当てはまらなかった銘柄より" + dirWord(s1, "all") + "（1回あたり " + spct3(s1.stats.all.diff.diff) + "、t値 " + num2(s1.stats.all.diff.t) + "。前半は" + dirWord(s1, "first") + "・後半は" + dirWord(s1, "second") + "）。");
  L.push("3. 参考の S0 上位10では " + s0.hitTotal + "件（" + share(s0) + "）が当てはまり、成績は当てはまらなかった銘柄より" + dirWord(s0, "all") + "（1回あたり " + spct3(s0.stats.all.diff.diff) + "、t値 " + num2(s0.stats.all.diff.t) + "）。");
  L.push("");

  L.push("## 条件");
  L.push("");
  L.push("- 生成: `node scripts/overheat-overlap-check.mjs`（実行日 " + new RealDate().toISOString().slice(0, 10) + "）");
  L.push("- 期間・銘柄の選び方・買値・データの取得方法・コスト・按分・売り方は `scripts/exit-grid-check.mjs`（PR #95）と同じ");
  L.push("- 検証日: " + testDays.length + "日（" + PERIOD_RANGES[0] + "）。" + PERIODS[1].label + "（" + PERIOD_RANGES[1] + "）、" + PERIODS[2].label + "（" + PERIOD_RANGES[2] + "）");
  L.push("- 銘柄: 各日、10:00時点のスコアで並べた上位10（S1 と S0）。S1 は今のスコアの部品から9部品（" + EXCLUDED_PARTS.join("、") + "）と上限（" + CAP_PARTS.join("、") + "）を除いた合計。S0 は今のスコアそのまま");
  L.push("- 売買: 10:00開始の15分足の始値で買い、利確 +1.5%・損切り −0.75%（同じ足で両方に届いたら損切りが先 2/3 の按分）、どちらにも届かなければ大引け（T当日の日足の終値）で売る。損益 = 売値 ÷ 買値 − 1 − 往復コスト0.1%");
  L.push("- **上がり過ぎ（当てはまる）の定義**: その日の候補づくりの「前日値上がり率上位20」（`scripts/exit-rule-check.mjs`・`scripts/hourly-exit-check.mjs` のグループ2B と同じ）に入っていた銘柄。母集団（東証プライム・スタンダード・グロースの内国株のうち、前日の出来高と前日・前々日の調整後終値が揃っている銘柄）から、前日出来高が母集団の中央値の1.5倍以上の銘柄だけを残し、前日騰落率（前日の調整後終値 ÷ 前々日の調整後終値 − 1）の高い順に20銘柄。何%以上という固定の線は無く、順位で決まる（その日の20位の値は2章の表に載せた）");
  L.push("- 勝率: 損益がプラスだった割合。按分の件は利確 1/3 回・損切り 2/3 回に分けて数える（PR #95 と同じ）");
  L.push("- t値: 1回ごとの損益の平均 ÷（不偏標準偏差 ÷ √件数）。0と比べてどれだけはっきりしているかの目安。差の t値は、当てはまった銘柄と当てはまらなかった銘柄の平均の差を、それぞれの分散と件数から出した値（ウェルチの t値）。同じ日の銘柄どうしは値動きが似るため、どちらも実際よりはっきり出やすい");
  L.push("");

  L.push("## 1. 写しの確認と除外");
  L.push("");
  L.push("今の売り方と大引け保有の成績を、PR #95 のレポート（`docs/exit-grid-result.md` の0章の「今回」の列）と比べた。");
  L.push("");
  L.push("| 上位10 | PR #95（件数 / 今の売り方 / 大引け保有 / 勝率） | 今回（同） | 一致 |");
  L.push("| --- | --- | --- | --- |");
  CHECKS.forEach(function (c) { L.push("| " + c.label + " | " + (c.theirs || "見つからない") + " | " + c.ours + " | " + (c.ok ? "一致" : "不一致") + " |"); });
  L.push("");
  L.push("- 10:00のスコアを計算できた銘柄日: 今回 " + scored1000 + "件（PR #95 は " + EXIT_GRID_SCORED + "件）");
  L.push("- 15分足（Yahoo、interval=" + INTRADAY_INTERVAL + "、range=" + INTRADAY_RANGE + "）の今回の期間: " + periodStart + " 〜 " + periodEnd + "。取れなかった取引日: " + (lostDays.length ? lostDays.join("・") : "なし") + "（PR #95 と同じ扱い。この日が窓に入る検証日は " + shortWindowDays1000.length + "日、窓が短いままスコアを計算した銘柄日は " + shortScored1000 + "件）");
  L.push("- 日足の取得失敗: " + failed.length + "銘柄。15分足の取得対象 " + targets.length + "銘柄のうち取得失敗 " + intradayFailed.length + "銘柄" + (intradayFailed.length ? "（" + intradayFailed.map(function (f) { return f.ticker + ": " + f.error; }).join("、") + "）" : ""));
  L.push("");
  L.push("| 除外の理由 | 今回 | PR #95 |");
  L.push("| --- | ---: | ---: |");
  SKIP_KEYS.forEach(function (k) { L.push("| " + k.label + " | " + skipTotal[k.key] + " | " + EXIT_GRID_SKIP[k.key] + " |"); });
  L.push("");
  L.push("- 上位10は、10:00のスコアを計算できた候補から選ぶ。そのうち売買から除外された銘柄日（上の表の「売買から除外」）は、件数（2章・3章）には数え、成績（4章）には入らない");
  L.push("");

  L.push("## 2. 各日の上位10のうち当てはまった銘柄数");
  L.push("");
  L.push("| 日付 | 前後 | 2Bの20位の前日騰落率 | S1 上位10で当てはまった数 | S0 上位10で当てはまった数 |");
  L.push("| --- | --- | ---: | ---: | ---: |");
  testDays.forEach(function (td, i) {
    var a = s1.days[i], b = s0.days[i];
    L.push("| " + td.date + " | " + (i < half ? "前半" : "後半") + " | " + pct2(td.changeFloor) + " | " + a.hit + (a.n !== TOP_N ? "（上位" + a.n + "）" : "") + " | " + b.hit + (b.n !== TOP_N ? "（上位" + b.n + "）" : "") + " |");
  });
  L.push("");
  L.push("| 上位10 | 36日合計の件数 | 割合（" + SLOT_TOTAL + "枠のうち） | 前半 | 後半 | 当てはまった日数 | うち売買まで判定できた件数 |");
  L.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  SELECTIONS.forEach(function (sel) {
    var sumDays = function (from, to) { return sel.days.slice(from, to).reduce(function (s, d) { return s + d.hit; }, 0); };
    L.push("| " + sel.label + " | " + sel.hitTotal + " | " + share(sel) + " | " + sumDays(0, half) + " | " + sumDays(half, testDays.length) + " | " +
      sel.days.filter(function (d) { return d.hit > 0; }).length + " | " + sel.hitTraded + " |");
  });
  L.push("");
  L.push("**判断の目安**: S1 上位10で当てはまった件数が合計" + JUDGE_MIN + "件（" + SLOT_TOTAL + "枠の5%）未満なら目印は見送り候補、" + JUDGE_MIN + "件以上なら成績の差（4章）を見て判断する。今回の S1 は " + s1.hitTotal + "件で、" + (s1.hitTotal < JUDGE_MIN ? "見送り候補" : "成績の差を見て判断する側") + "。");
  L.push("");

  L.push("## 3. 上位10の前日騰落率の分布");
  L.push("");
  L.push("前日騰落率は2Bと同じく調整後終値で計算した値。区分は下限を含み上限を含まない（例: 3〜5% は 3%以上5%未満）。成績は売買まで判定できた件だけで出した。");
  L.push("");
  SELECTIONS.forEach(function (sel) {
    L.push("**" + sel.label + "**");
    L.push("");
    L.push("| 前日騰落率 | 件数 | 割合 | うち当てはまった（2B） | 売買まで判定できた件数 | 1回あたり平均損益 | 勝率 |");
    L.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    BUCKETS.forEach(function (bk, bi) {
      var inB = sel.top.filter(function (x) { return bucketOf(x.rec.prevRet) === bi; });
      var tr = groupStat(inB.filter(function (x) { return x.res; }));
      L.push("| " + bk.label + " | " + inB.length + " | " + pct1(inB.length / sel.top.length) + " | " + inB.filter(function (x) { return x.rec.overheat; }).length + " | " +
        (tr.n || 0) + " | " + (tr.n ? pct3(tr.avg) : "-") + " | " + (tr.n ? pct1(tr.win) : "-") + " |");
    });
    L.push("| 合計 | " + sel.top.length + " | 100.0% | " + sel.hitTotal + " | " + sel.trades.length + " | " + pct3(sel.stats.all.all.avg) + " | " + pct1(sel.stats.all.all.win) + " |");
    L.push("");
  });
  L.push("- 前日騰落率が大きくても、前日出来高が中央値の1.5倍に届かない銘柄や、その日の上位20に入らなかった銘柄は「当てはまる」に入らない。逆に2Bの20位の値が低い日は、数%の上昇でも当てはまる");
  L.push("- 参考: 調整前の終値で計算すると区分が変わる上位10の銘柄日: " + (rawDiff.length ? rawDiff.length + "件（" + rawDiff.join("、") + "）" : "無い"));
  L.push("");

  L.push("## 4. 当てはまった銘柄と当てはまらなかった銘柄の成績");
  L.push("");
  SELECTIONS.forEach(function (sel) {
    L.push("**" + sel.label + "**");
    L.push("");
    L.push("| 期間 | 区分 | 件数 | 1回あたり平均損益 | 勝率 | t値 |");
    L.push("| --- | --- | ---: | ---: | ---: | ---: |");
    PERIODS.forEach(function (p, pi) {
      var st = sel.stats[p.key];
      var pl = p.label + "（" + PERIOD_RANGES[pi] + "）";
      L.push("| " + pl + " | 当てはまった | " + statCells(st.hit) + " |");
      L.push("| " + pl + " | 当てはまらなかった | " + statCells(st.rest) + " |");
      L.push("| " + pl + " | 全体 | " + statCells(st.all) + " |");
    });
    L.push("");
    PERIODS.forEach(function (p) { L.push("- " + p.label + ": " + diffLine(sel, p.key)); });
    L.push("");
  });

  L.push("## 5. 当てはまった銘柄の一覧");
  L.push("");
  SELECTIONS.forEach(function (sel) {
    L.push("**" + sel.label + "**");
    L.push("");
    var hits = sel.top.filter(function (x) { return x.rec.overheat; });
    if (!hits.length) { L.push("当てはまった銘柄は無い。"); L.push(""); return; }
    L.push("| 日付 | 銘柄 | 上位10の順位 | 2Bの順位 | 前日騰落率 | 損益 |");
    L.push("| --- | --- | ---: | ---: | ---: | ---: |");
    hits.forEach(function (x) {
      L.push("| " + x.date + " | " + x.rec.ticker + " | " + x.rank + " | " + x.rec.changeRank + " | " + pct2(x.rec.prevRet) + " | " + (x.res ? pct3(x.res.ret) : "売買から除外") + " |");
    });
    L.push("");
  });

  L.push("## 6. 推測で決めた点・分からなかった点");
  L.push("");
  L.push("- 「前日に大きく上がった銘柄」は2Bの定義（順位で決まる上位20）をそのまま使った。「何%以上」という線で切った場合の見え方は3章の分布で代わりに示した");
  L.push("- 前日騰落率は2Bと同じく調整後終値で計算した（指示の「前日終値 ÷ 前々日終値 − 1」の終値を調整後終値と読んだ）。調整前の終値との違いは3章の最後に載せた");
  L.push("- 件数と割合は上位10の枠（" + testDays.length + "日 × " + TOP_N + " = " + SLOT_TOTAL + "枠）を分母にした。上位10に入ったが売買から除外された銘柄日も件数には数え、成績には入れない");
  L.push("- t値は1回ごとの損益で出した。PR #95 のような日ごとの差の t値は、当てはまった銘柄が無い日が多く日ごとに並べられないため使っていない");
  L.push("");

  var outPath = fileURLToPath(new URL("../docs/overheat-overlap-result.md", import.meta.url));
  writeFileSync(outPath, L.join("\n") + "\n");
  console.log(L.join("\n"));
  console.log("\n→ " + outPath);
  CHECKS.forEach(function (c) {
    if (!c.ok) console.log(c.label + " が PR #95 と一致しない: " + c.ours + "  レポート: " + (c.theirs || "見つからない"));
  });
};

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
