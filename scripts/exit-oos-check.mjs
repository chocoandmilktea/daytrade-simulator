// scripts/exit-oos-check.mjs
// PR #95（scripts/exit-grid-check.mjs・docs/exit-grid-result.md）で、10:00時点の S1 上位10銘柄を10:00に買う取引について
// 利確 +2.0%・損切り −0.75% が今の売り方（利確 +1.5%・損切り −0.75%）を上回った。その設定は PR #95 の36日
// （2026-07-31〜2026-09-24）の結果を見て選んだものなので、選んだ後の日（2026-09-25 以降）でも上回るかを確かめる。
//
// 銘柄の選び方（S1 上位10）・買値（10:00開始の15分足の始値）・データの取得方法・コスト（往復0.1%）・
// 同じ足で利確と損切りの両方に届いた場合の按分（損切りが先2/3・利確が先1/3）・届かなければ大引け（T当日の日足の終値）で売ることは
// scripts/exit-grid-check.mjs と同じ。処理はそこから写した（元のファイルは処理がすべて main() の中にあり、
// import すると既存のレポート docs/exit-grid-result.md を書き換えるため）。
// exit-grid-check.mjs から変えたのは次の点だけ:
//   - 検証日を PR #95 の36日に固定しない（PR88_DAY_COUNT と、その件数が合わないと止まる処理は使わない）。
//     今取れる15分足で、同じ条件（基準銘柄の8:50の範囲の15分足が600本以上）で選べる日をすべて使う
//   - 2026-06-26 の足の欠けを補う扱い（PR88_INTRADAY_START・missingStartBars）は使わない。今の15分足はその日より後から始まり、
//     その日が窓に入る検証日が無いため（窓に入るのは2026-08-07までの日で、今回の検証日はそれより後になる）
//   - 前半・後半の境目の確認、S0、売り方の総当たりはしない。比べるのは S1 上位10の2つの売り方だけ
//   - 検証日を「新しい日（2026-09-25 以降）」「重なる日（PR #95 の36日のうち今回も検証日に入った日）」「全体」に分けて集計する
// アプリ本体とは無関係の単発検証スクリプト。新しい npm パッケージは使わず、
// 既存の依存関係に含まれる xlsx（SheetJS）・@upstash/redis（api/_scan.js の読み込みに必要）と
// Node 標準の fetch のみを使う。
//
// 実行: node scripts/exit-oos-check.mjs
// 出力: docs/exit-oos-result.md
//
// 任意: 環境変数 EXIT_OOS_CHECK_CACHE にディレクトリを指定すると、Yahoo の取得結果を
//       そこに JSON で保存し、次回以降はそれを読む（形式は scripts/exit-grid-check.mjs のキャッシュと同じ）。
//       取得結果はリポジトリの外に置くこと（commit しない）

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { analyzeStock, currentSessionDate } from "../src/lib/analyze.js";

// ---------- ここから scripts/exit-grid-check.mjs と同じ設定 ----------

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
var FEE = 0.001; // 往復コスト0.1%
var SL_FIRST_PROB = 2 / 3; // 同じ足で両方に届いた場合に「損切りが先」とみなす確率（PR #88 の按分）

// 10:00評価（PR #89 の本命）。clock: 時計を合わせる時刻 / cut: この時刻より前に始まった15分足までをスコアに使う /
// buy: この時刻に始まる15分足の始値で買う（HH:MM、日本時間）
var EVAL = { clock: "10:00", cut: "10:00", buy: "10:00" };

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

// ---------- ここまで scripts/exit-grid-check.mjs と同じ設定 ----------

// 比べる2つの売り方（scripts/exit-grid-check.mjs の A 固定幅の「利確+1.5%・損切り−0.75%」と「利確+2.0%・損切り−0.75%」）
var CURRENT = { key: "cur", label: "今の売り方（利確 +1.5%・損切り −0.75%）", short: "今の売り方", tp: 0.015, sl: -0.0075 };
var CANDIDATE = { key: "cand", label: "比べる売り方（利確 +2.0%・損切り −0.75%）", short: "比べる売り方", tp: 0.02, sl: -0.0075 };
var EXITS = [CURRENT, CANDIDATE];

// PR #95 の36日（2026-09-24 時点の15分足で選ばれた日）。この範囲の今回の検証日を「重なる日」とする
var PR95_FIRST_DAY = "2026-07-31";
var PR95_LAST_DAY = "2026-09-24";
var PR95_DAY_COUNT = 36;
// PR #95 の前半・後半の境目（docs/exit-grid-result.md と同じ）
var PR95_FIRST_HALF_LAST = "2026-08-26";
var PR95_SECOND_HALF_FIRST = "2026-08-27";
// 新しい日（PR #95 で売り方を選んだ後の日）の初日と、止める基準の日数
var NEW_FIRST_DAY = "2026-09-25";
var MIN_NEW_DAYS = 8;
// PR #95 のレポート（比べるときに読むだけ。書き換えない）
var PR95_REPORT = "../docs/exit-grid-result.md";

var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
var isNum = function (v) { return typeof v === "number" && isFinite(v); };

// ---------- api/stock.js と同じ加工（scripts/exit-grid-check.mjs と同じ） ----------

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

// ---------- 時計の差し替え（scripts/exit-grid-check.mjs と同じ） ----------

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

// ---------- 取得（scripts/exit-grid-check.mjs と同じ） ----------

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

// ---------- 統計（scripts/exit-grid-check.mjs と同じ） ----------

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
var pct1 = function (v) { return isNum(v) ? (v * 100).toFixed(1) + "%" : "-"; };
var num2 = function (v) { return isNum(v) ? v.toFixed(2) : "-"; };
// 符号付きの%表記（差の表示用）
var spct3 = function (v) { return isNum(v) ? (v > 0 ? "+" : "") + (v * 100).toFixed(3) + "%" : "-"; };

// ---------- 候補の作り方（scripts/exit-grid-check.mjs と同じ） ----------

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

// ---------- 売り方（scripts/exit-grid-check.mjs の single・closeOut・exitFixed と同じ判定・同じ式） ----------

// 1件の結果。parts は「その件がどう終わったか」の内訳（按分の件は利確1/3・損切り2/3の2つ）。
// ret は内訳の加重平均（按分の件は PR #88 と同じ加重平均）。overlap は同じ足で利確と損切りの両方に届いたか。
// 元のスクリプトとの違いは、内訳に終わり方（how: tp 利確 / sl 損切り / close 大引け）を付けたことだけ
var single = function (ret, how) { return { parts: [{ w: 1, ret: ret, how: how }], ret: ret, overlap: 0 }; };

// どの条件にも届かなければ大引け（T当日の日足の終値）で売る
var closeOut = function (tr) { return single(tr.dayClose / tr.buy - 1 - FEE, "close"); };

// 固定幅。10:00開始の足から時刻順に、高値が利確ライン以上・安値が損切りライン以下になったかを見て、
// 先に届いた方のラインの値段で売る。同じ足で両方に届いたら按分
var exitFixed = function (tr, tpRate, slRate) {
  var tp = tpRate == null ? null : tr.buy * (1 + tpRate), sl = slRate == null ? null : tr.buy * (1 + slRate);
  for (var i = 0; i < tr.bars.length; i++) {
    var hitTp = tp != null && tr.bars[i].high >= tp, hitSl = sl != null && tr.bars[i].low <= sl;
    if (hitTp && hitSl) {
      var tpNet = tpRate - FEE, slNet = slRate - FEE;
      var pTp = 1 - SL_FIRST_PROB;
      return { parts: [{ w: pTp, ret: tpNet, how: "tp" }, { w: SL_FIRST_PROB, ret: slNet, how: "sl" }], ret: pTp * tpNet + SL_FIRST_PROB * slNet, overlap: 1 };
    }
    if (hitTp) return single(tpRate - FEE, "tp");
    if (hitSl) return single(slRate - FEE, "sl");
  }
  return closeOut(tr);
};

// 結果の配列（1件1つ）の集計。按分の件は内訳ごとに重みを付けて勝ち・終わり方を数える（scripts/exit-grid-check.mjs の summarize と同じ数え方）
var summarize = function (res) {
  var n = res.length;
  if (!n) return { n: 0 };
  var winW = 0, overlap = 0, how = { tp: 0, sl: 0, close: 0 };
  res.forEach(function (x) {
    x.parts.forEach(function (p) {
      if (p.ret > 0) winW += p.w;
      how[p.how] += p.w;
    });
    overlap += x.overlap;
  });
  return {
    n: n, avg: mean(res.map(function (x) { return x.ret; })), win: winW / n,
    tp: how.tp / n, sl: how.sl / n, close: how.close / n, overlap: overlap / n,
  };
};

// ---------- PR #95 のレポートから値を読む（読むだけ） ----------

var readPr95 = function () {
  var lines = readFileSync(fileURLToPath(new URL(PR95_REPORT, import.meta.url)), "utf8").split("\n");
  // S1 上位10（1章）の A の行。列: 売り方 | 件数 | 平均損益 | 勝率 | 勝った回の平均 | 負けた回の平均 | 最悪の1回 |
  // 前半の平均 | 後半の平均 | 今との差 全体（t値） | 今との差 前半（t値） | 今との差 後半（t値） | 条件が重なった割合
  var rowOf = function (label) {
    var inSec = false;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf("## ") === 0) inSec = lines[i].indexOf("## 1.") === 0;
      if (inSec && lines[i].indexOf("| " + label + " |") === 0) return lines[i].split("|").map(function (c) { return c.trim(); }).filter(Boolean);
    }
    throw new Error(PR95_REPORT + " に行が見つからない: " + label);
  };
  // 除外があった日の表（実装前確認2）。列: 日付 | 候補 | 10:00のスコアを計算できた | 売買まで判定できた | 内訳
  var days = {};
  var inTable = false;
  lines.forEach(function (ln) {
    if (ln.indexOf("除外があった日") === 0) inTable = true;
    else if (ln.indexOf("### ") === 0) inTable = false;
    var m = inTable && ln.match(/^\| (\d{4}-\d{2}-\d{2}) \| (\d+) \| (\d+) \| (\d+) \| (.*) \|$/);
    if (m) days[m[1]] = { cands: +m[2], scored: +m[3], traded: +m[4], note: m[5] };
  });
  if (!Object.keys(days).length) throw new Error(PR95_REPORT + " に除外があった日の表が見つからない");
  return {
    cur: rowOf("**A 利確+1.5%・損切り−0.75%（今の売り方）**"),
    cand: rowOf("A 利確+2.0%・損切り−0.75%"),
    days: days,
  };
};

// ---------- 本体 ----------

var main = async function () {
  var startedAt = RealDate.now();
  var cacheDir = process.env.EXIT_OOS_CHECK_CACHE || null;
  if (cacheDir) mkdirSync(cacheDir, { recursive: true });
  var fetchedCount = 0, cachedCount = 0;
  var countFetch = function (got) { if (got.fromCache) cachedCount++; else fetchedCount++; return got; };

  var datesCopyOk = checkToLocalDatesCopy();
  if (!datesCopyOk) throw new Error("api/stock.js の toLocalDates と写しが一致しない（api/stock.js が変更された可能性）");
  var pr95 = readPr95();
  var scan = await loadScanModule();

  // ---------- 検証日の見当（日足をすべて取る前に、新しい日が足りるかを基準銘柄の15分足で確かめる） ----------

  var refGot = countFetch(await fetchIntraday(REF_TICKER, cacheDir)).res;
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
  // 8:50: T当日より前の直近 APP_WINDOW_DAYS 取引日分の足の範囲 [from, to)（scripts/exit-grid-check.mjs と同じ）
  var windowBefore = function (ix, date) {
    var prevDays = ix.dayList.filter(function (d) { return d < date; });
    if (!prevDays.length) return null;
    var first = prevDays[Math.max(0, prevDays.length - APP_WINDOW_DAYS)];
    var nextDay = ix.dayList.filter(function (d) { return d >= date; })[0];
    return { from: ix.dayStart[first], to: nextDay != null ? ix.dayStart[nextDay] : ix.raw.ts.length, lastDay: prevDays[prevDays.length - 1], days: Math.min(APP_WINDOW_DAYS, prevDays.length) };
  };
  // 場中: T当日より前の直近 APP_WINDOW_DAYS − 1 取引日分と、T当日のうち cutSec より前に始まった足の範囲 [from, to)。
  // todayBars は T当日から含めた足の本数（scripts/exit-grid-check.mjs と同じ。days は前の取引日の日数）
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

  var refIx = indexIntraday(refGot.data);
  var periodStart = refIx.dayList[0], periodEnd = refIx.dayList[refIx.dayList.length - 1];
  // 基準銘柄の15分足だけで選んだ検証日（取引日は日足から決めるため、ここでは15分足の日を使った見当）
  var roughDays = refIx.dayList.filter(function (d) {
    var w = windowBefore(refIx, d);
    return w && w.to - w.from >= MIN_BARS;
  });
  var roughNew = roughDays.filter(function (d) { return d >= NEW_FIRST_DAY; });
  console.log("15分足の期間: " + periodStart + " 〜 " + periodEnd + " / 検証日の見当 " + roughDays.length + "日（うち " + NEW_FIRST_DAY + " 以降 " + roughNew.length + "日）");
  if (roughNew.length < MIN_NEW_DAYS) throw new Error(NEW_FIRST_DAY + " 以降の検証日が " + MIN_NEW_DAYS + "日未満: " + roughNew.length + "日");

  // 1. 銘柄一覧
  var jpx = await fetchJpxList();
  console.log("JPX 銘柄一覧: " + jpx.list.length + "銘柄（" + jpx.url + "）");

  // 2. TOPIX
  var topixSource = null, topixRows = null;
  var topixTried = [];
  var topixCandidates = TOPIX_TICKERS.concat([TOPIX_PROXY]);
  for (var ti = 0; ti < topixCandidates.length && !topixRows; ti++) {
    var tr = countFetch(await fetchDaily(topixCandidates[ti], cacheDir)).res;
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
    var got = countFetch(await fetchDaily(ticker, cacheDir));
    if (got.res.error) failed.push({ ticker: ticker, error: got.res.error });
    else stocks.push({ ticker: ticker, sector: s.sector, rows: got.res.data });
    if (!got.fromCache) await sleep(WAIT_MS);
    if ((k + 1) % 200 === 0) console.log("  日本株 " + (k + 1) + "/" + jpx.list.length + "（失敗 " + failed.length + "）");
  }
  console.log("日本株 取得成功 " + stocks.length + " / 失敗 " + failed.length);

  // ---------- 取引日（scripts/exit-grid-check.mjs と同じ） ----------

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

  // TOPIX前日比（%）: T当日の前日の値（scripts/exit-grid-check.mjs と同じ）
  var topixChangeFor = function (t) {
    var p1 = topixBars[t - 1], p2 = topixBars[t - 2];
    if (!p1 || !p2) return null;
    var c1 = isNum(p1.adj) ? p1.adj : p1.close, c2 = isNum(p2.adj) ? p2.adj : p2.close;
    if (!isNum(c1) || !isNum(c2) || c2 <= 0) return null;
    return (c1 / c2 - 1) * 100;
  };

  // ---------- 検証する日（scripts/exit-grid-check.mjs と同じ選び方。36日には固定しない） ----------

  // 15分足の期間の取引日のうち、基準銘柄の15分足に無い日があれば、日の選び方が崩れるため止める
  var lostDays = jpDays.filter(function (d) { return d >= periodStart && d <= periodEnd && refIx.dayStart[d] == null; });
  if (lostDays.length) throw new Error("15分足の期間に、基準銘柄の15分足が無い取引日がある: " + lostDays.join(", "));

  var testDays = []; // { t, date }
  jpDays.forEach(function (d) {
    var t = jpDayIndex.get(d);
    if (t < 2) return;
    var w = windowBefore(refIx, d);
    if (!w || w.to - w.from < MIN_BARS) return;
    testDays.push({ t: t, date: d });
  });
  if (!testDays.length) throw new Error("検証日が無い");
  var newDays = testDays.filter(function (td) { return td.date >= NEW_FIRST_DAY; });
  var overlapDays = testDays.filter(function (td) { return td.date >= PR95_FIRST_DAY && td.date <= PR95_LAST_DAY; });
  console.log("検証日 " + testDays.length + "日（" + testDays[0].date + " 〜 " + testDays[testDays.length - 1].date + "）、新しい日 " + newDays.length + "日、重なる日 " + overlapDays.length + "日");
  if (newDays.length < MIN_NEW_DAYS) throw new Error(NEW_FIRST_DAY + " 以降の検証日が " + MIN_NEW_DAYS + "日未満: " + newDays.length + "日");
  // 10:00の窓（前の29取引日）が基準銘柄で29日に満たない検証日（スコアの窓が PR #95 より短い日）
  var shortWindowDays = testDays.filter(function (td) {
    var wi = windowIntraday(refIx, td.date, jstAt(td.date, EVAL.cut) / 1000);
    return !wi || wi.days < APP_WINDOW_DAYS - 1;
  }).map(function (td) { return td.date; });

  // ---------- 日ごとの候補（8:50時点。scripts/exit-grid-check.mjs と同じ） ----------

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
    var hr = countFetch(await fetchIntraday(hTicker, cacheDir));
    if (hr.res.error) intradayFailed.push({ ticker: hTicker, error: hr.res.error });
    else intraday[targets[hi]] = indexIntraday(hr.res.data);
    if (!hr.fromCache) await sleep(WAIT_MS);
    if ((hi + 1) % 100 === 0) console.log("  15分足 " + (hi + 1) + "/" + targets.length + "（失敗 " + intradayFailed.length + "）");
  }
  console.log("15分足 取得成功 " + (targets.length - intradayFailed.length) + " / 失敗 " + intradayFailed.length);

  // ---------- スコア計算と売買（scripts/exit-grid-check.mjs と同じ） ----------

  // api/stock.js の fetchJPPayload が返す形に組み立てる（現在値は渡さず、
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

  // T当日の15分足のうち、startSec 以降に始まる足（時刻順）。15:30 の足は使わない
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
  // hm に始まる15分足の始値（無ければ null）
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

  // T当日の日足が売買の判定に使えるか
  var dailyOk = function (b) {
    return !!b && isNum(b.open) && isNum(b.high) && isNum(b.low) && isNum(b.close) && b.open > 0 &&
      isNum(b.volume) && b.volume !== 0;
  };
  // 部品の点数から S1 を作る（PART_LABELS の順に足す）
  var s1Of = function (parts) {
    var kept = 0;
    PART_LABELS.forEach(function (lb) {
      if (KEPT_PARTS.indexOf(lb) >= 0) kept += parts[lb];
    });
    return kept;
  };

  // 日ごとの除外件数（scripts/exit-grid-check.mjs の SKIP_KEYS と同じ分け方）
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
  var daySkip = {};
  var skipList = [];
  var clockMismatch1000 = 0, notStarted1000 = 0, scored1000 = 0, sumMismatch = 0;

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
      // s1: 10:00のスコアを計算できた場合だけ入る
      var rec = { day: date, ticker: st.ticker, order: order, s1: null, trade: null };
      td.records.push(rec);
      var ix = intraday[si2];
      if (!ix) { dsk.noIntraday++; skipList.push({ key: "noIntraday", date: date, ticker: st.ticker }); return; }
      // 8:50の範囲での判定（元のスクリプトと同じ条件で除く）
      var w = windowBefore(ix, date);
      if (!w || w.lastDay !== jpDays[t - 1]) { dsk.noPrevBars++; return; }
      if (w.to - w.from < MIN_BARS) { dsk.fewBars++; skipList.push({ key: "fewBars", date: date, ticker: st.ticker, bars: w.to - w.from }); return; }
      var stock = scan.normalizeStock(st.ticker);
      var b = bars[si2][t];

      // 10:00: 公式の前日終値は T当日の前日の日足終値
      var wi = windowIntraday(ix, date, jstAt(date, EVAL.cut) / 1000);
      if (!wi || wi.todayBars === 0) { dsk.noToday++; return; }
      if (wi.to - wi.from < MIN_BARS) { dsk.fewBars1000++; return; }
      var pPrev1 = bars[si2][t - 1];
      var prevIntra = pPrev1 && isNum(pPrev1.close) ? pPrev1.close : null;
      var pd = scan.toPriceData(buildPayload(ix, wi.from, wi.to, prevIntra, topixChange));
      var a = withClock(clock1000, function () { return analyzeStock(stock, pd, null, {}); });
      if (!a.sessionStarted) notStarted1000++;
      scored1000++;
      dsk.scored++;
      var p1 = toParts(a);
      if (!p1.ok) sumMismatch++;
      rec.s1 = s1Of(p1.parts);
      // 売買: 除外条件と買値（10:00開始の足の始値）は元のスクリプトと同じ
      if (!dailyOk(b)) { dsk.noDaily++; return; }
      var buy = openAt(ix, date, EVAL.buy);
      if (buy == null) { dsk.noBuyBar++; return; }
      var after = barsFrom(ix, date, jstAt(date, EVAL.buy) / 1000);
      if (!after.length) { dsk.noAfter++; return; }
      rec.trade = { buy: buy, dayClose: b.close, bars: after };
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

  // ---------- S1 上位10（scripts/exit-grid-check.mjs の rankDay と同じ並べ方） ----------

  // 各日の並べ替え。対象は10:00のスコアを計算できた候補。値の高い順、同点は候補の並び順（order）が先のものを上にする
  var rankDay = function (td) {
    var list = td.records.filter(function (r) { return r.s1 != null; });
    list.sort(function (a, b) {
      var ka = a.s1, kb = b.s1;
      var na = !isNum(ka), nb = !isNum(kb);
      if (na || nb) return na === nb ? a.order - b.order : (na ? 1 : -1);
      return kb - ka || a.order - b.order;
    });
    return list.slice(0, TOP_N);
  };

  var trades = []; // { date, ticker, tr, res: { cur, cand } }
  testDays.forEach(function (td) {
    rankDay(td).forEach(function (r) {
      if (!r.trade) return;
      var res = {};
      EXITS.forEach(function (ex) { res[ex.key] = exitFixed(r.trade, ex.tp, ex.sl); });
      trades.push({ date: td.date, ticker: r.ticker, tr: r.trade, res: res });
    });
  });

  // 日ごとの平均損益（売り方ごと）と件数
  var byDay = new Map();
  trades.forEach(function (x) {
    if (!byDay.has(x.date)) byDay.set(x.date, { n: 0, cur: [], cand: [] });
    var d = byDay.get(x.date);
    d.n++;
    EXITS.forEach(function (ex) { d[ex.key].push(x.res[ex.key].ret); });
  });

  // 区分ごとの集計
  var dateSet = function (days) { return new Set(days.map(function (d) { return d.date; })); };
  var rangeOf = function (days) { return days.length ? days[0].date + " 〜 " + days[days.length - 1].date : "-"; };
  var statsFor = function (dates) {
    var out = { days: 0, exits: {} };
    var sub = trades.filter(function (x) { return dates.has(x.date); });
    EXITS.forEach(function (ex) { out.exits[ex.key] = summarize(sub.map(function (x) { return x.res[ex.key]; })); });
    var diffs = [];
    var up = 0, down = 0, tie = 0;
    byDay.forEach(function (d, date) {
      if (!dates.has(date)) return;
      var df = mean(d.cand) - mean(d.cur);
      diffs.push(df);
      if (df > 1e-12) up++; else if (df < -1e-12) down++; else tie++;
    });
    out.days = diffs.length;
    out.diff = tStat(diffs);
    out.up = up; out.down = down; out.tie = tie;
    return out;
  };
  var GROUPS = [
    { key: "new", label: "新しい日（主に見る）", days: newDays },
    { key: "overlap", label: "重なる日", days: overlapDays },
    { key: "all", label: "全体", days: testDays },
  ];
  GROUPS.forEach(function (g) { g.stats = statsFor(dateSet(g.days)); });

  // PR #95 の後半（2026-08-27〜2026-09-24）・前半（2026-07-31〜2026-08-26）のうち今回の検証日に入った日
  var pr95Second = testDays.filter(function (td) { return td.date >= PR95_SECOND_HALF_FIRST && td.date <= PR95_LAST_DAY; });
  var pr95First = testDays.filter(function (td) { return td.date >= PR95_FIRST_DAY && td.date <= PR95_FIRST_HALF_LAST; });
  var secondStats = statsFor(dateSet(pr95Second));
  var firstStats = statsFor(dateSet(pr95First));

  // ---------- 判定（結果を見る前に決めた基準） ----------

  var ng = GROUPS[0].stats;
  var direction = ng.diff.avg > 0 ? "向きは PR #95 と同じ" : ng.diff.avg < 0 ? "向きが逆" : "差が0（向きは決まらない）";
  var clarity = Math.abs(ng.diff.t) >= 2 ? "はっきりしている（t値の絶対値が2以上）" : "はっきりしない（t値の絶対値が2未満）";
  var elapsedMin = (RealDate.now() - startedAt) / 60000;

  // ---------- 出力 ----------

  var runDate = new RealDate(RealDate.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  var L = [];
  L.push("# 利確 +2.0%・損切り −0.75% の選んだ後の日での確認 試算結果");
  L.push("");
  L.push("> `scripts/exit-oos-check.mjs` が生成。手で書き換えないこと。");
  L.push("");
  L.push("- 生成: `node scripts/exit-oos-check.mjs`（実行日 " + runDate + "、日本時間）");
  L.push("- 確かめたこと: PR #95（`docs/exit-grid-result.md`）で、S1 上位10を10:00に買う取引の売り方として、利確 +2.0%・損切り −0.75% が今の売り方（利確 +1.5%・損切り −0.75%）を前半・後半とも上回った。この設定は PR #95 の36日（" + PR95_FIRST_DAY + " 〜 " + PR95_LAST_DAY + "）の結果を見て選んだものなので、選んだ後の日（" + NEW_FIRST_DAY + " 以降）でも上回るかを確かめた");
  L.push("");

  L.push("## 結論");
  L.push("");
  L.push("- **向き: " + direction + "。** 新しい日（" + newDays.length + "日、" + rangeOf(newDays) + "）で、日ごとの差（比べる売り方の平均損益 − 今の売り方の平均損益）の平均は " + spct3(ng.diff.avg) + "。比べる売り方が上回った日は " + ng.up + "日、下回った日は " + ng.down + "日、同じだった日は " + ng.tie + "日");
  L.push("- **はっきりしているか: " + clarity + "。** t値は " + num2(ng.diff.t) + "。" + (Math.abs(ng.diff.t) >= 2 ? "日ごとのばらつきに比べて差が大きく、偶然だけでは出にくい差" : "日数が少なく、日ごとのばらつきに比べて差が小さいため、偶然の範囲と区別できない。事前に決めたとおり、これは不合格ではなく「はっきりしない」という意味"));
  L.push("- 平均損益（新しい日）: 今の売り方 " + pct3(ng.exits.cur.avg) + "（" + ng.exits.cur.n + "件）、比べる売り方 " + pct3(ng.exits.cand.avg) + "（" + ng.exits.cand.n + "件）");
  L.push("");
  L.push("用語:");
  L.push("");
  L.push("- 日ごとの差: 各検証日に、同じ銘柄・同じ買値の取引について「比べる売り方の平均損益 − 今の売り方の平均損益」を出したもの。プラスなら比べる売り方の方がその日は良かった。銘柄の顔ぶれが同じなので、日による相場の良し悪しを打ち消して売り方の違いだけを見られる");
  L.push("- t値: 日ごとの差の平均 ÷（日ごとの差の標準偏差 ÷ √日数）。差の平均が、日ごとのばらつきから見込まれる誤差の何倍あるか。目安として絶対値が2以上なら偶然では出にくい差、2未満なら偶然の範囲と区別できない。日数が少ないほど大きくなりにくい");
  L.push("- 判定の基準（結果を見る前に決めたもの）: 新しい日で日ごとの差の平均がプラスなら「向きは PR #95 と同じ」、マイナスなら「向きが逆」。t値が2に届かなくても「はっきりしない」と書くだけで、不合格とはしない");
  L.push("");

  L.push("## 1. 検証日");
  L.push("");
  L.push("- 15分足（Yahoo、interval=" + INTRADAY_INTERVAL + "、range=" + INTRADAY_RANGE + "）の今回の期間: " + periodStart + " 〜 " + periodEnd);
  L.push("- 検証日の選び方は PR #95 と同じ（取引日のうち、基準銘柄 " + REF_TICKER + " の8:50の範囲（前の" + APP_WINDOW_DAYS + "取引日まで）の15分足が" + MIN_BARS + "本以上ある日）。PR #95 は36日に固定していたが、今回は固定せず選べる日をすべて使った");
  L.push("");
  L.push("| 区分 | 日数 | 期間 | 日付 |");
  L.push("| --- | ---: | --- | --- |");
  GROUPS.forEach(function (g) {
    L.push("| " + g.label + " | " + g.days.length + " | " + rangeOf(g.days) + " | " + g.days.map(function (d) { return d.date.slice(5); }).join("、") + " |");
  });
  L.push("");
  L.push("- 新しい日: " + NEW_FIRST_DAY + " 以降の検証日。重なる日: PR #95 の36日（" + PR95_FIRST_DAY + " 〜 " + PR95_LAST_DAY + "）のうち今回も検証日に入った日（" + overlapDays.length + "日。" + (PR95_DAY_COUNT - overlapDays.length) + "日は15分足の期間から外れたため入らない）");
  L.push("- スコアの窓が PR #95 より短い検証日: " + (shortWindowDays.length ? shortWindowDays.length + "日（" + shortWindowDays.join("、") + "）。15分足が " + periodStart + " から始まるため、10:00のスコアに使う前の取引日が" + (APP_WINDOW_DAYS - 1) + "日に満たない（" + MIN_BARS + "本以上の条件は満たす）。重なる日の前の方だけが当たる" : "無い"));
  L.push("- 日足の取得失敗: " + failed.length + "銘柄。TOPIX: " + topixSource + "（試した順: " + topixTried.join(" / ") + "）");
  L.push("- 15分足の取得対象 " + targets.length + "銘柄のうち取得失敗 " + intradayFailed.length + "銘柄" + (intradayFailed.length ? "（" + intradayFailed.map(function (f) { return f.ticker + ": " + f.error; }).join("、") + "）" : ""));
  L.push("- 10:00のスコアを計算できた銘柄日: " + scored1000 + "件（時計のずれ " + clockMismatch1000 + "日、寄り付き前扱い " + notStarted1000 + "件）");
  L.push("");
  L.push("除外した銘柄日の合計:");
  L.push("");
  L.push("| 理由 | 件数 |");
  L.push("| --- | ---: |");
  SKIP_KEYS.forEach(function (k) { L.push("| " + k.label + " | " + skipTotal[k.key] + " |"); });
  L.push("");

  L.push("## 2. 銘柄の選び方と売り方（PR #95 と同じ）");
  L.push("");
  L.push("- 銘柄: 各日、8:50時点の候補（前日の出来高上位" + NORMAL_VOL_TOP + "と、出来高が中央値の" + VOL_MULT + "倍以上の銘柄の前日比上位" + CHANGE_TOP + "）を10:00時点の S1 で並べた上位" + TOP_N + "。S1 は、今のスコアの部品の点数から9部品（" + EXCLUDED_PARTS.join("、") + "）と上限（" + CAP_PARTS.join("、") + "）を除いた合計");
  L.push("- 買値: 10:00開始の15分足の始値。判定に使う足: 10:00開始の足から15:15開始の足まで（15:30の足は使わない）");
  L.push("- 売り方: 利確ライン 買値 ×（1 + 利確幅）・損切りライン 買値 ×（1 + 損切り幅）。足を時刻順に見て、高値が利確ライン以上・安値が損切りライン以下になったら、先に届いた方のラインの値段で売る。同じ足で両方に届いたら按分（損切りが先 2/3・利確が先 1/3 の加重平均）。どちらにも届かなければ大引け（T当日の日足の終値）で売る");
  L.push("  - " + CURRENT.label);
  L.push("  - " + CANDIDATE.label);
  L.push("- 損益: 売値 ÷ 買値 − 1 − 往復コスト0.1%");
  L.push("- 処理は `scripts/exit-grid-check.mjs` から写した（import すると既存のレポートを書き換えるため）。変えたのは、検証日を36日に固定しないこと、2026-06-26 の足の欠けを補う扱いを使わないこと（今回の検証日の窓にその日は入らない）、比べる売り方を2つに絞ったことだけ");
  L.push("");

  L.push("## 3. 区分ごとの結果");
  L.push("");
  L.push("- 勝率: 損益がプラスだった割合。利確・損切り・大引けの割合: その売り方で終わった件の割合。同じ足で両方に届いた件は、利確 1/3 回・損切り 2/3 回に分けて数える（PR #95 と同じ）");
  L.push("");
  GROUPS.forEach(function (g, gi) {
    var st = g.stats;
    L.push("### 3-" + (gi + 1) + ". " + g.label + "（" + g.days.length + "日、" + rangeOf(g.days) + "）");
    L.push("");
    L.push("| 売り方 | 件数 | 平均損益 | 勝率 | 利確で終わった割合 | 損切りで終わった割合 | 大引けで終わった割合 | 同じ足で両方に届いた割合 |");
    L.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    EXITS.forEach(function (ex) {
      var e = st.exits[ex.key];
      L.push("| " + ex.label + " | " + e.n + " | " + pct3(e.avg) + " | " + pct1(e.win) + " | " + pct1(e.tp) + " | " + pct1(e.sl) + " | " + pct1(e.close) + " | " + pct1(e.overlap) + " |");
    });
    L.push("");
    L.push("| 日ごとの差の平均 | 日ごとの差の標準偏差 | t値 | 比べる売り方が上回った日 | 下回った日 | 同じだった日 |");
    L.push("| ---: | ---: | ---: | ---: | ---: | ---: |");
    L.push("| " + spct3(st.diff.avg) + " | " + pct3(st.diff.sd) + " | " + num2(st.diff.t) + " | " + st.up + " / " + st.days + "日 | " + st.down + "日 | " + st.tie + "日 |");
    L.push("");
  });

  L.push("## 4. 新しい日の日ごとの一覧");
  L.push("");
  L.push("| 日付 | 件数 | 今の売り方の平均 | 比べる売り方の平均 | 差 |");
  L.push("| --- | ---: | ---: | ---: | ---: |");
  newDays.forEach(function (td) {
    var d = byDay.get(td.date);
    if (!d) { L.push("| " + td.date + " | 0 | - | - | - |"); return; }
    var mc = mean(d.cur), mk = mean(d.cand);
    L.push("| " + td.date + " | " + d.n + " | " + pct3(mc) + " | " + pct3(mk) + " | " + spct3(mk - mc) + " |");
  });
  L.push("");
  L.push("- 件数: その日の S1 上位10のうち売買まで判定できた件数（10:00開始の足が無いなどで除いた分は数えない）");
  L.push("");

  L.push("## 5. PR #95 とのずれ");
  L.push("");
  L.push("PR #95 のレポートには日ごとの損益が載っていないため、同じ日の値の比べ方は次の2つとした。");
  L.push("");
  L.push("**(1) PR #95 の後半・前半と同じ日での平均損益**（PR #95 の値は `docs/exit-grid-result.md` の1章（S1 上位10）の行から読んだ）");
  L.push("");
  L.push("| 範囲 | 日数（今回 / PR #95） | 今の売り方の平均（今回 / PR #95） | 比べる売り方の平均（今回 / PR #95） | 日ごとの差の平均とt値（今回 / PR #95） |");
  L.push("| --- | --- | --- | --- | --- |");
  var cellD = function (d) { return spct3(d.avg) + "（" + num2(d.t) + "）"; };
  L.push("| 後半 " + PR95_SECOND_HALF_FIRST + " 〜 " + PR95_LAST_DAY + " | " + secondStats.days + " / 18 | " + pct3(secondStats.exits.cur.avg) + " / " + pr95.cur[8] + " | " + pct3(secondStats.exits.cand.avg) + " / " + pr95.cand[8] + " | " + cellD(secondStats.diff) + " / " + pr95.cand[11] + " |");
  L.push("| 前半 " + PR95_FIRST_DAY + " 〜 " + PR95_FIRST_HALF_LAST + "（今回はこのうち " + rangeOf(pr95First) + " だけ。参考） | " + firstStats.days + " / 18 | " + pct3(firstStats.exits.cur.avg) + " / " + pr95.cur[7] + " | " + pct3(firstStats.exits.cand.avg) + " / " + pr95.cand[7] + " | " + cellD(firstStats.diff) + " / " + pr95.cand[10] + " |");
  L.push("| 全体（重なる日 / PR #95 の36日。参考） | " + GROUPS[1].stats.days + " / " + PR95_DAY_COUNT + " | " + pct3(GROUPS[1].stats.exits.cur.avg) + " / " + pr95.cur[2] + " | " + pct3(GROUPS[1].stats.exits.cand.avg) + " / " + pr95.cand[2] + " | " + cellD(GROUPS[1].stats.diff) + " / " + pr95.cand[9] + " |");
  L.push("");
  var secDiffGap = secondStats.diff.avg * 100 - parseFloat(pr95.cand[11]);
  var secCurGap = secondStats.exits.cur.avg * 100 - parseFloat(pr95.cur[8]);
  var secCandGap = secondStats.exits.cand.avg * 100 - parseFloat(pr95.cand[8]);
  L.push("- 日が揃っている後半で、今回 − PR #95 のずれは、今の売り方の平均 " + (secCurGap >= 0 ? "+" : "") + secCurGap.toFixed(3) + "%、比べる売り方の平均 " + (secCandGap >= 0 ? "+" : "") + secCandGap.toFixed(3) + "%、日ごとの差の平均 " + (secDiffGap >= 0 ? "+" : "") + secDiffGap.toFixed(3) + "%");
  L.push("- 前半と全体は日が揃っていない（PR #95 の前半のうち今回の15分足で取れるのは後ろの " + pr95First.length + "日だけ）ため参考。" + (shortWindowDays.length ? "さらにそのうち " + shortWindowDays.length + "日はスコアの窓が PR #95 より短い（1章）" : ""));
  L.push("");
  L.push("**(2) 重なる日ごとの銘柄日の件数**（PR #95 の値はレポートの「除外があった日」の表から読んだ。表に無い日は PR #95 では除外が無かった日で、候補の数は載っていない）");
  L.push("");
  L.push("| 日付 | 候補（今回 / PR #95） | 10:00のスコアを計算できた（今回 / PR #95） | 売買まで判定できた（今回 / PR #95） | 今回の除外の内訳 |");
  L.push("| --- | --- | --- | --- | --- |");
  var sameCount = 0, diffCount = 0;
  overlapDays.forEach(function (td) {
    var dsk = daySkip[td.date], p = pr95.days[td.date];
    var note = SKIP_KEYS.filter(function (k) { return dsk[k.key]; }).map(function (k) { return k.label + " " + dsk[k.key]; }).join("、") || "除外なし";
    var theirs = p ? [String(p.cands), String(p.scored), String(p.traded)] : ["（除外なし）", "（候補と同じ）", "（候補と同じ）"];
    if (p) {
      if (p.cands === dsk.cands && p.scored === dsk.scored && p.traded === dsk.traded) sameCount++; else diffCount++;
    } else {
      if (dsk.cands === dsk.scored && dsk.scored === dsk.traded) sameCount++; else diffCount++;
    }
    L.push("| " + td.date + " | " + dsk.cands + " / " + theirs[0] + " | " + dsk.scored + " / " + theirs[1] + " | " + dsk.traded + " / " + theirs[2] + " | " + note + " |");
  });
  L.push("");
  L.push("- 件数が PR #95 と同じだった日（PR #95 の表に無い日は、今回も除外が無ければ同じとした）: " + sameCount + "日、違った日: " + diffCount + "日");
  L.push("- 15分足の取得失敗・600本未満で除いた銘柄日（重なる日のみ）: " + (function () {
    var ov = dateSet(overlapDays);
    var list = skipList.filter(function (x) { return ov.has(x.date); });
    if (!list.length) return "無い";
    var by = {};
    list.forEach(function (x) { var kk = x.ticker + "（" + (x.key === "noIntraday" ? "取得失敗" : "600本未満") + "）"; (by[kk] = by[kk] || []).push(x.date.slice(5) + (x.bars != null ? "（" + x.bars + "本）" : "")); });
    return Object.keys(by).map(function (kk) { return kk + " " + by[kk].length + "件: " + by[kk].join("・"); }).join("、");
  })());
  L.push("- PR #95 の0章と同じく、ずれは Yahoo から取り直したデータの違い（取れる15分足の期間が変わったこと、上場から60日を過ぎた銘柄・上場して間もない銘柄の15分足が取れなくなったこと）による。売り方どうしの比較は、同じ日・同じ銘柄・同じ買値の取引で行うため、この基準の中で成り立つ");
  L.push("");

  L.push("## 6. 注意点");
  L.push("");
  L.push("- 新しい日は " + newDays.length + "日しかなく、日ごとの差のばらつきに比べて日数が少ない。t値が2に届かないのはそのためでもあり、向きが合っていても「確かめられた」とまでは言えない");
  L.push("- 新しい日には、PR #95 の結果を見て売り方を選んだ後の日だけを使っているため、選び方による水増しは入らない。重なる日と全体は PR #95 の結果を見て選んだ日を含むため、選び方による水増しが入っている（主に見るのは新しい日）");
  L.push("- 銘柄一覧は今日時点の JPX の一覧を使っている（PR #95 と同じ扱い）。上場廃止になった銘柄は入らず、上場して間もない銘柄は15分足が取れないことがある");
  L.push("- 最後の検証日 " + periodEnd + " は、その日の大引け後（実行日の日本時間）に取得した値を使った");
  L.push("- 15分足の高値・安値だけでは足の中の値動きの順番が分からないため、同じ足で利確と損切りの両方に届いた場合の按分（損切りが先 2/3）は PR #95 の仮定をそのまま使った");
  L.push("- 大引けで売った件は、15:30の足（判定に使わない）の値動きを含む日足の終値で売っているため、損切り幅より悪い損益になることがある（PR #95 と同じ）");
  L.push("");

  var outPath = fileURLToPath(new URL("../docs/exit-oos-result.md", import.meta.url));
  writeFileSync(outPath, L.join("\n") + "\n");
  console.log(L.join("\n"));
  console.log("\n→ " + outPath);
  console.log("取得 " + fetchedCount + "件 / キャッシュから " + cachedCount + "件、実行時間 " + elapsedMin.toFixed(1) + "分");
};

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
