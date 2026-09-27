// scripts/exit-grid-check.mjs
// 10:00時点のスコア上位10銘柄を10:00に買った場合に、どの売り方が最も利益が残るかを比べる。
// 銘柄の選び方（S1 と S0 の上位10）・買値（10:00開始の15分足の始値）・データの取得方法・
// コスト（往復0.1%）・同じ足で利確と損切りの両方に届いた場合の按分（損切りが先2/3）は
// scripts/score-variants-check.mjs（PR #92・#93）と同じ。変えるのは売り方だけ。
//
// 試す売り方（どれも、売れなかった場合は T当日の日足の終値＝大引けで売る）:
//   A: 固定幅。利確 +1.0% / +1.5% / +2.0% / +3.0% / なし × 損切り −0.5% / −0.75% / −1.0% / −1.5% / なし の25通り
//   B: 時刻。11:30（前場最後の足の終値）/ 13:00 / 14:00 / 大引け。利確・損切りなし
//   C: 高値から下がったら売る。買ってからの最高値から −0.5% / −1.0% / −1.5%
//   D: 建値ストップ。損切り −0.75%・利確なし。高値が +1.0% に届いた足の次の足から損切りを買値 +0.1% に引き上げる
//
// 候補の再現・データ取得・2026-06-26 の欠けの扱い・10:00の時計の差し替え・15分足の切り方・
// 部品ごとの点数の取り出し・S1 の作り方・上位10の選び方・買値・現行の売り方（損益A）と大引け保有（損益B）は
// scripts/score-variants-check.mjs から写した（元のファイルは処理がすべて main() の中にあり、
// import すると既存のレポート docs/score-variants-result.md を書き換えるため）。
// 写しが正しいことは、現行の売り方と大引け保有の成績を docs/score-variants-result.md の
// 10:00の表と突き合わせて確かめる（レポートの0章・実装前確認3）。
// 2026-09-27 の実行では Yahoo から取れる15分足が PR #92・#93 の実行時（2026-09-25）から変わっており一致しなかったため、
// その日に取得したデータを新しい基準とした（ずれた理由はレポートの0章に書く）。
// アプリ本体とは無関係の単発検証スクリプト。新しい npm パッケージは使わず、
// 既存の依存関係に含まれる xlsx（SheetJS）・@upstash/redis（api/_scan.js の読み込みに必要）と
// Node 標準の fetch のみを使う。
//
// 実行: node scripts/exit-grid-check.mjs
// 出力: docs/exit-grid-result.md
//
// 任意: 環境変数 EXIT_GRID_CHECK_CACHE にディレクトリを指定すると、Yahoo の取得結果を
//       そこに JSON で保存し、次回以降はそれを読む（形式は PR #88〜#93 のキャッシュと同じ）。
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
// ---------- 売り方 ----------

// 固定幅（A）の設定。v が null のものは「置かない」。表の行（利確）・列（損切り）の並び順でもある
var A_TPS = [
  { v: 0.01, label: "+1.0%" }, { v: 0.015, label: "+1.5%" }, { v: 0.02, label: "+2.0%" }, { v: 0.03, label: "+3.0%" }, { v: null, label: "なし" },
];
var A_SLS = [
  { v: -0.005, label: "−0.5%" }, { v: -0.0075, label: "−0.75%" }, { v: -0.01, label: "−1.0%" }, { v: -0.015, label: "−1.5%" }, { v: null, label: "なし" },
];
// 時刻（B）。その時刻に終わる15分足の終値で売る（11:30 なら 11:15 開始の足＝前場最後の足）。close は大引け（T当日の日足の終値）
var B_TIMES = [
  { hm: "11:30", label: "11:30" }, { hm: "13:00", label: "13:00" }, { hm: "14:00", label: "14:00" }, { hm: "close", label: "大引け" },
];
// 高値から下がったら売る（C）。買ってからの最高値からの下落幅
var C_TRAILS = [
  { v: 0.005, label: "−0.5%" }, { v: 0.01, label: "−1.0%" }, { v: 0.015, label: "−1.5%" },
];
// 建値ストップ（D）。最初の損切り・引き上げの合図（高値がこの上げ幅に届いた足の次の足から）・引き上げ後の損切り（往復コスト分）
var D_SL = -0.0075;
var D_TRIGGER = 0.01;
var D_RAISED = FEE;

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

// hm（HH:MM）の15分前の時刻
var minus15 = function (hm) {
  var m = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)) - 15;
  return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
};

// B: 時刻。hm に終わる足（hm の15分前に始まる足）の終値で売る。その足が無ければ、それより前に始まった
// 最後の足の終値で売り、fallback に数える（買った足より前に遡ることはない）
var exitAtTime = function (tr, hm) {
  if (hm === "close") return closeOut(tr);
  var target = minus15(hm), last = null;
  for (var i = 0; i < tr.bars.length && tr.bars[i].hm <= target; i++) last = tr.bars[i];
  if (!last) {
    var c = closeOut(tr);
    c.fallback = 1;
    return c;
  }
  var r = single(last.close / tr.buy - 1 - FEE);
  r.fallback = last.hm === target ? 0 : 1;
  return r;
};

// 引き上げた損切りラインに届いた足の約定値段。fill が "gap" なら、足の始値がすでにラインより下のときは始値
// （最高値や引き上げの判定は前の足までで行うため、前の足の終わりにはラインを割っていることがある）。
// "line" ならラインの値段（固定幅の損切りと同じ扱い。参考）
var stopFill = function (level, bar, fill) { return fill === "line" ? level : Math.min(level, bar.open); };

// C: 高値から下がったら売る。最高値の初期値は買値。各足で、前の足までの最高値 × (1 − 下落幅) に安値が届いたかを先に判定し、
// 届かなければその足の高値で最高値を更新する（同じ足の高値で最高値を上げてから同じ足の安値で判定しない）
var exitTrail = function (tr, trail, fill) {
  var peak = tr.buy;
  for (var i = 0; i < tr.bars.length; i++) {
    var level = peak * (1 - trail);
    if (tr.bars[i].low <= level) {
      var px = stopFill(level, tr.bars[i], fill);
      var r = single(px / tr.buy - 1 - FEE);
      r.gap = px < level ? 1 : 0;
      return r;
    }
    if (tr.bars[i].high > peak) peak = tr.bars[i].high;
  }
  return closeOut(tr);
};

// D: 建値ストップ。損切り −0.75%・利確なし。高値が +1.0% に届いた足の次の足から、損切りを買値 +0.1% に引き上げる。
// 引き上げ前の損切りは固定幅と同じ扱い（ラインの値段で売る）
var exitBreakeven = function (tr, fill) {
  var sl = tr.buy * (1 + D_SL), raised = false;
  for (var i = 0; i < tr.bars.length; i++) {
    if (tr.bars[i].low <= sl) {
      if (!raised) return single(D_SL - FEE);
      var px = stopFill(sl, tr.bars[i], fill);
      var r = single(px / tr.buy - 1 - FEE);
      r.gap = px < sl ? 1 : 0;
      return r;
    }
    if (!raised && tr.bars[i].high >= tr.buy * (1 + D_TRIGGER)) {
      sl = tr.buy * (1 + D_RAISED);
      raised = true;
    }
  }
  return closeOut(tr);
};

// 試す売り方の一覧。key は一意、group は A〜D
var RULES = [];
A_TPS.forEach(function (tp, ti) {
  A_SLS.forEach(function (sl, si) {
    RULES.push({
      key: "A:" + ti + ":" + si, group: "A", ti: ti, si: si,
      label: "A 利確" + tp.label + "・損切り" + sl.label + (tp.v == null && sl.v == null ? "（= B 大引け）" : ""),
      run: function (tr) { return exitFixed(tr, tp.v, sl.v); },
    });
  });
});
B_TIMES.forEach(function (b, bi) {
  RULES.push({ key: "B:" + bi, group: "B", idx: bi, label: "B " + b.label + "に売る", sameAs: b.hm === "close" ? "A:4:4" : null, run: function (tr) { return exitAtTime(tr, b.hm); } });
});
C_TRAILS.forEach(function (c, ci) {
  RULES.push({ key: "C:" + ci, group: "C", idx: ci, label: "C 最高値から" + c.label, run: function (tr) { return exitTrail(tr, c.v, "gap"); } });
  RULES.push({ key: "Cline:" + ci, group: "Cline", idx: ci, label: "C 最高値から" + c.label + "（ラインの値段で約定・参考）", run: function (tr) { return exitTrail(tr, c.v, "line"); } });
});
RULES.push({ key: "D", group: "D", label: "D 建値ストップ", run: function (tr) { return exitBreakeven(tr, "gap"); } });
RULES.push({ key: "Dline", group: "Dline", label: "D 建値ストップ（ラインの値段で約定・参考）", run: function (tr) { return exitBreakeven(tr, "line"); } });
var CURRENT_KEY = "A:1:1"; // 今の売り方（利確 +1.5%・損切り −0.75%）
var HOLD_KEY = "B:3"; // 大引けまで保有（損益B）
var ruleByKey = {};
RULES.forEach(function (r) { ruleByKey[r.key] = r; });
// 順位表・判定の対象（参考の約定方法と、A の「なし・なし」と同じ B 大引けは除く）
var RANKED = RULES.filter(function (r) { return r.group !== "Cline" && r.group !== "Dline" && !r.sameAs; });

// 同じグループの隣の設定（A は表の上下左右。「なし」は表の端として扱う）
var neighborsOf = function (rule) {
  var out = [];
  if (rule.group === "A") {
    [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(function (d) {
      var ti = rule.ti + d[0], si = rule.si + d[1];
      if (ti >= 0 && ti < A_TPS.length && si >= 0 && si < A_SLS.length) out.push("A:" + ti + ":" + si);
    });
  } else if (rule.group === "B" || rule.group === "C") {
    var len = rule.group === "B" ? B_TIMES.length : C_TRAILS.length;
    [rule.idx - 1, rule.idx + 1].forEach(function (j) { if (j >= 0 && j < len) out.push(rule.group + ":" + j); });
  }
  // B 大引けは A の「なし・なし」と同じ結果なので、その key に置き換える
  return out.map(function (k) { return ruleByKey[k].sameAs || k; });
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
  var cacheDir = process.env.EXIT_GRID_CHECK_CACHE || null;
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
  // PR #92・#93 のレポート（docs/score-variants-result.md の1章）の件数
  var PR92_SKIP = { noIntraday: 18, noPrevBars: 0, fewBars: 4, noToday: 0, fewBars1000: 0, noDaily: 0, noBuyBar: 35, noAfter: 0 };
  // 元のスクリプトを、今回と同じ取得データでリポジトリの外のコピー上で再実行して確かめた日と、その10:00の表の値（レポートの0章に載せる）
  var RERUN_CHECKED = "2026-09-27";
  var RERUN_VALUES = { s1: "354件・今の売り方 0.030%・大引け保有 0.308%", s0: "357件・今の売り方 -0.125%・大引け保有 -0.622%" };
  var daySkip = {};
  // 15分足の取得失敗・600本未満で除いた銘柄日（0章でずれた理由を示すため）
  var skipList = [];
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
      var rec = { day: date, ticker: st.ticker, order: order, at: {} };
      td.records.push(rec);
      var ix = intraday[si2];
      if (!ix) { dsk.noIntraday++; skipList.push({ key: "noIntraday", date: date, ticker: st.ticker }); return; }
      // 8:50の範囲での判定（元のスクリプトは8:50のスコアを計算できなかった銘柄日を10:00でも計算しないため、同じ条件で除く）
      var w = windowBefore(ix, date);
      if (!w || w.lastDay !== jpDays[t - 1]) { dsk.noPrevBars++; return; }
      var d0 = t0 != null ? bars[si2][t0] : null;
      var tradedOnStart = !!(d0 && isNum(d0.close));
      var extra0850 = missingStartBars(ix, w.to - w.from, w.days, t, APP_WINDOW_DAYS, tradedOnStart);
      if (w.to - w.from + extra0850 < MIN_BARS) { dsk.fewBars++; skipList.push({ key: "fewBars", date: date, ticker: st.ticker, bars: w.to - w.from + extra0850 }); return; }
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
  SELECTIONS.forEach(function (sel) {
    sel.trades = [];
    testDays.forEach(function (td) {
      rankDay(td, sel.key).forEach(function (r) {
        if (r.at["1000"].trade) sel.trades.push({ date: td.date, tr: r.at["1000"].trade });
      });
    });
    sel.res = {};
    RULES.forEach(function (rule) {
      sel.res[rule.key] = sel.trades.map(function (x) { return rule.run(x.tr); });
    });
    // 日ごとの平均損益（売り方ごと）
    var dayMeans = function (key) {
      var byDay = new Map();
      sel.trades.forEach(function (x, i) {
        if (!byDay.has(x.date)) byDay.set(x.date, []);
        byDay.get(x.date).push(sel.res[key][i].ret);
      });
      var out = new Map();
      byDay.forEach(function (v, d) { out.set(d, mean(v)); });
      return out;
    };
    var curDay = dayMeans(CURRENT_KEY);
    sel.stats = {};
    RULES.forEach(function (rule) {
      var ruleDay = dayMeans(rule.key);
      var st = {};
      PERIODS.forEach(function (p) {
        var res = sel.res[rule.key].filter(function (x, i) { return p.dates.has(sel.trades[i].date); });
        var diffs = [];
        ruleDay.forEach(function (v, d) { if (p.dates.has(d)) diffs.push(v - curDay.get(d)); });
        st[p.key] = summarize(res);
        st[p.key].diff = tStat(diffs);
      });
      sel.stats[rule.key] = st;
    });
  });

  // ---------- 実装前確認3: 現行の売り方と大引け保有の成績を PR #92・#93 のレポートと突き合わせる ----------

  var VARIANTS_REPORT = "../docs/score-variants-result.md";
  var reportRow10 = function (label) {
    var lines = readFileSync(fileURLToPath(new URL(VARIANTS_REPORT, import.meta.url)), "utf8").split("\n");
    var inSec = false;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf("## ") === 0) inSec = lines[i].indexOf("## 4.") === 0;
      if (inSec && lines[i].indexOf("| " + label + " |") === 0) return lines[i].split("|").map(function (c) { return c.trim(); }).filter(Boolean);
    }
    return null;
  };
  var CHECKS = [
    { sel: "s1", label: "S1 の上位10", expectN: 354, expectA: "0.024%", expectB: "0.294%" },
    { sel: "s0", label: "S0 の上位10", expectN: 357, expectA: "-0.114%", expectB: "-0.600%" },
  ];
  CHECKS.forEach(function (c) {
    var sel = SELECTIONS.filter(function (s) { return s.key === c.sel; })[0];
    var cur = sel.stats[CURRENT_KEY].all, hold = sel.stats[HOLD_KEY].all;
    c.ours = [String(cur.n), pct3(cur.avg), pct3(hold.avg), pct1(cur.win)];
    var row = reportRow10(c.label);
    c.theirs = row ? [row[1], row[2], row[3], row[4]] : null;
    c.expectOk = c.ours[0] === String(c.expectN) && c.ours[1] === c.expectA && c.ours[2] === c.expectB;
    c.rowOk = !!c.theirs && c.ours.join("|") === c.theirs.join("|");
  });

  // ---------- 判定: 前半・後半の両方で今の売り方を上回り、かつ隣の設定も上回っているか ----------

  var judge = function (sel) {
    var st = sel.stats;
    var beatsCur = function (k) { return st[k].first.diff.avg > 0 && st[k].second.diff.avg > 0; };
    var out = { plateau: [], strict: [], noNeighbor: [] };
    RANKED.forEach(function (rule) {
      if (rule.key === CURRENT_KEY || !beatsCur(rule.key)) return;
      var nb = neighborsOf(rule);
      if (!nb.length) { out.noNeighbor.push(rule.key); return; }
      // 参考の読み方: その売り方が、前半・後半の両方で、隣の設定のどれよりも平均損益が高い
      var beatsNb = nb.every(function (k) {
        return st[rule.key].first.diff.avg > st[k].first.diff.avg && st[rule.key].second.diff.avg > st[k].second.diff.avg;
      });
      if (beatsNb) out.strict.push(rule.key);
      // 主とする読み方: 隣の設定もすべて、前半・後半の両方で今の売り方を上回っている
      if (nb.every(beatsCur)) out.plateau.push(rule.key);
    });
    return out;
  };

  // ---------- 出力 ----------

  var cell = function (d) { return spct3(d.avg) + "（" + num2(d.t) + "）"; };
  var statHead = "| 売り方 | 件数 | 平均損益 | 勝率 | 勝った回の平均 | 負けた回の平均 | 最悪の1回 | 前半の平均 | 後半の平均 | 今との差 全体（t値） | 今との差 前半（t値） | 今との差 後半（t値） | 条件が重なった割合 |";
  var statSep = "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";
  var statRow = function (sel, rule, rank) {
    var st = sel.stats[rule.key];
    var name = (rule.key === CURRENT_KEY ? "**" + rule.label + "（今の売り方）**" : rule.label);
    var isCur = rule.key === CURRENT_KEY;
    return "| " + (rank != null ? rank + ". " : "") + name + " | " + st.all.n + " | " + pct3(st.all.avg) + " | " + pct1(st.all.win) + " | " +
      pct3(st.all.winAvg) + " | " + pct3(st.all.lossAvg) + " | " + pct3(st.all.worst) + " | " + pct3(st.first.avg) + " | " + pct3(st.second.avg) + " | " +
      (isCur ? "（基準）" : cell(st.all.diff)) + " | " + (isCur ? "（基準）" : cell(st.first.diff)) + " | " + (isCur ? "（基準）" : cell(st.second.diff)) + " | " + pct1(st.all.overlap) + " |";
  };
  var gridTable = function (L, sel, pkey, title) {
    L.push("**" + title + "**");
    L.push("");
    L.push("| 利確 ＼ 損切り | " + A_SLS.map(function (s) { return s.label; }).join(" | ") + " |");
    L.push("| --- |" + A_SLS.map(function () { return " ---: |"; }).join(""));
    A_TPS.forEach(function (tp, ti) {
      L.push("| " + tp.label + " | " + A_SLS.map(function (s, si) {
        var k = "A:" + ti + ":" + si, v = pct3(sel.stats[k][pkey].avg);
        return k === CURRENT_KEY ? "**" + v + "**" : v;
      }).join(" | ") + " |");
    });
    L.push("");
  };
  var groupRules = function (g) { return RULES.filter(function (r) { return r.group === g; }); };
  var fallbackCount = function (sel, g) { return groupRules(g).reduce(function (s, r) { return s + sel.stats[r.key].all.fallback; }, 0); };
  var gapCount = function (sel, rule) { return sel.stats[rule.key].all.gap; };

  var L = [];
  L.push("# 10:00に買った上位10銘柄の売り方の比較 試算結果");
  L.push("");
  L.push("- 生成: `node scripts/exit-grid-check.mjs`（実行日 " + new RealDate().toISOString().slice(0, 10) + "）");
  L.push("- 銘柄の選び方・買値・データの取得方法・コスト・同じ足で利確と損切りの両方に届いた場合の扱いは `scripts/score-variants-check.mjs`（PR #93。PR #92 と同じ内容）と同じ。変えたのは売り方だけ。ただしデータは今回取得したもので、PR #93 の値とは少しずれる（0章）");
  L.push("- 検証日: " + testDays.length + "日（" + PERIOD_RANGES[0] + "）。" + PERIODS[1].label + "（" + PERIOD_RANGES[1] + "）、" + PERIODS[2].label + "（" + PERIOD_RANGES[2] + "）");
  L.push("- 銘柄: 各日、10:00時点のスコアで並べた上位10（S1 と S0 の2通り）。S1 は、今のスコアの部品の点数から9部品（" + EXCLUDED_PARTS.join("、") + "）と上限（" + CAP_PARTS.join("、") + "）を除いた合計。S0 は今のスコアそのまま");
  L.push("- 買値: 10:00開始の15分足の始値。判定に使う足: 10:00開始の足から15:15開始の足まで（15:30の足は使わない）");
  L.push("- 損益: 売値 ÷ 買値 − 1 − 往復コスト0.1%。どの売り方も、売れなかった場合は大引け（T当日の日足の終値）で売る");
  L.push("");

  // 0章 PR #93 の値とのずれ（今回の基準）
  var byTicker = function (key) {
    var m = new Map();
    skipList.filter(function (x) { return x.key === key; }).forEach(function (x) {
      if (!m.has(x.ticker)) m.set(x.ticker, []);
      m.get(x.ticker).push(x.date + (x.bars != null ? "（" + x.bars + "本）" : ""));
    });
    return Array.from(m.keys()).sort().map(function (tk) { return tk + " " + m.get(tk).length + "件（" + m.get(tk).join("・") + "）"; });
  };
  L.push("## 0. 今回の基準と PR #93 の値とのずれ");
  L.push("");
  L.push("この試算は、" + new RealDate().toISOString().slice(0, 10) + " に Yahoo から取得したデータを基準にしている。今の売り方（利確 +1.5%・損切り −0.75%）と大引け保有の成績は、PR #93（PR #92 と同じ内容。`docs/score-variants-result.md` の4-1の表）の値と次のようにずれた。");
  L.push("");
  L.push("| 上位10 | PR #93 の値（件数・今の売り方・大引け保有・勝率） | 今回（同） |");
  L.push("| --- | --- | --- |");
  CHECKS.forEach(function (c) {
    L.push("| " + c.label.replace(" の上位10", "") + " | " + (c.theirs ? c.theirs.join(" / ") : "見つからない") + " | " + c.ours.join(" / ") + " |");
  });
  L.push("");
  L.push("ずれた理由:");
  L.push("");
  L.push("- 10:00のスコアを計算できた銘柄日が、PR #93 の 2063件から今回 " + scored1000 + "件に減った。減った分だけ、日によって上位10の顔ぶれが入れ替わった（上位10の件数は偶然同じになった）");
  L.push("- 15分足が取れなかった銘柄日（今回 " + skipTotal.noIntraday + "件、PR #93 は " + PR92_SKIP.noIntraday + "件）: " + byTicker("noIntraday").join("、"));
  L.push("  - このうち 603A.T・604A.T の9件が今回増えた分。2銘柄とも 2026-07-29 上場（Yahoo の日足の最初の取引日。" + RERUN_CHECKED + " に確認）で、Yahoo は上場日を起点に15分足を返し、起点が60日より前になると `range=60d` の問い合わせを「60日以内でない」として拒否する（HTTP 422）。PR #93 の実行日（2026-09-25）は上場から58日目で取れていたが、" + RERUN_CHECKED + " は60日目で取れなくなった。593A.T・598A.T は PR #93 のときから同じ理由で取れていない");
  L.push("- 15分足が" + MIN_BARS + "本未満で除いた銘柄日（今回 " + skipTotal.fewBars + "件、PR #93 は " + PR92_SKIP.fewBars + "件）: " + byTicker("fewBars").join("、"));
  L.push("  - このうち 607A.T の 2026-09-07 が今回増えた分（" + MIN_BARS + "本に2本足りない）。PR #93 のときの取得データが残っていないため、前回は" + MIN_BARS + "本以上あった理由は確かめられなかった（Yahoo 側でこの銘柄の足が変わったと推測）");
  L.push("- 元のスクリプト `scripts/score-variants-check.mjs` を、リポジトリの外のコピーで今回と同じ取得データを使って再実行したところ（" + RERUN_CHECKED + "）、S1 上位10は " + RERUN_VALUES.s1 + "、S0 上位10は " + RERUN_VALUES.s0 + " になり、上の「今回」と同じ値だった。ずれはスクリプトの写し方ではなく、データの違いによる");
  L.push("- 売り方どうしの比較は、同じ日・同じ銘柄・同じ買値の取引で行うため、この基準の中で成り立つ");
  L.push("");

  // 実装前確認
  L.push("## 実装前確認の結果");
  L.push("");
  L.push("### 確認1: `scripts/score-variants-check.mjs` にある処理（2026-09-27 時点の main の行番号。※行番号は目安）");
  L.push("");
  L.push("| 処理 | 場所 |");
  L.push("| --- | --- |");
  L.push("| 10:00時点のスコア計算（S0 はここで `analyzeStock()` が返すスコア） | `main()` 内 721〜740行（`windowIntraday`・`buildPayload`・`score`、S0 は738行の `r1.a.save.score`） |");
  L.push("| S1 の作り方 | `variantScores`（651〜658行。`KEPT_PARTS` の部品の合計。`KEPT_PARTS` は107行、除く部品は103・105行） |");
  L.push("| 上位10の選び方（S0・S1 共通） | `rankKey`・`rankDay`（776〜789行）と、その呼び出し（814〜840行） |");
  L.push("| 買値 | `openAt`（610〜619行。10:00開始の15分足の始値）を743行で呼ぶ。時刻は `EVAL.buy`（80行） |");
  L.push("| 損益A（+1.5%利確・−0.75%損切り） | `judgeExit`（334〜343行）と `outcome` の按分（352〜364行）。幅とコストは `TAKE_PROFIT`・`STOP_LOSS`・`FEE`・`SL_FIRST_PROB`（73〜76行）。10:00の呼び出しは747〜750行 |");
  L.push("| 損益B（大引けまで保有） | 751行（`b.close / buy - 1 - FEE`） |");
  L.push("");
  L.push("すべて揃っていた。ただし処理がすべて `main()` の中にあり、import すると検証全体が走って既存のレポートを書き換えるため、必要な部分を `scripts/exit-grid-check.mjs` に写した。");
  L.push("");
  L.push("### 確認2: 36日分の候補と15分足が今も同じ方法で取れるか");
  L.push("");
  L.push("- 15分足（Yahoo、interval=" + INTRADAY_INTERVAL + "、range=" + INTRADAY_RANGE + "）の今回の期間: " + periodStart + " 〜 " + periodEnd + "。PR #93 の実行時（2026-09-25）と同じ期間だった");
  L.push("- 取れなかった取引日: " + (lostDays.length ? lostDays.join("・") : "なし") + "（検証日ではなく、前半の検証日のスコアの窓に入る日。PR #93 と同じく、600本以上の条件を判定するときにその日の足があれば増えていた本数を足す扱い。この日が窓に入る検証日は " + shortWindowDays1000.length + "日、窓が短いままスコアを計算した銘柄日は " + shortScored1000 + "件）");
  L.push("- 検証日: " + testDays.length + "日（PR #93 と同じ " + PR88_DAY_COUNT + "日、" + PR88_FIRST_DAY + " 〜 " + PR88_LAST_DAY + "）。取れなかった検証日は無い");
  L.push("- 日足の取得失敗: " + failed.length + "銘柄。15分足の取得対象 " + targets.length + "銘柄のうち取得失敗 " + intradayFailed.length + "銘柄" + (intradayFailed.length ? "（" + intradayFailed.map(function (f) { return f.ticker + ": " + f.error; }).join("、") + "）" : ""));
  L.push("");
  L.push("除外した銘柄日の合計（PR #93 のレポート1章の件数と比べた）:");
  L.push("");
  L.push("| 理由 | 今回 | PR #93 |");
  L.push("| --- | ---: | ---: |");
  SKIP_KEYS.forEach(function (k) { L.push("| " + k.label + " | " + skipTotal[k.key] + " | " + PR92_SKIP[k.key] + " |"); });
  L.push("");
  var skipDays = testDays.filter(function (td) { return SKIP_KEYS.some(function (k) { return daySkip[td.date][k.key] > 0; }); });
  L.push("除外があった日（日付と件数）:");
  L.push("");
  L.push("| 日付 | 候補 | 10:00のスコアを計算できた | 売買まで判定できた | 内訳 |");
  L.push("| --- | ---: | ---: | ---: | --- |");
  skipDays.forEach(function (td) {
    var d = daySkip[td.date];
    var parts = SKIP_KEYS.filter(function (k) { return d[k.key] > 0; }).map(function (k) { return k.label + " " + d[k.key]; });
    L.push("| " + td.date + " | " + d.cands + " | " + d.scored + " | " + d.traded + " | " + parts.join("、") + " |");
  });
  L.push("");
  L.push("### 確認3: 現行の売り方と大引け保有の成績が PR #93 と一致するか");
  L.push("");
  L.push("`docs/score-variants-result.md`（PR #92。PR #93 のレポートも同じ値）の4-1の表の同じ行と比べた。");
  L.push("");
  L.push("| 上位10 | 期待値（件数・損益A・損益B） | 今回（件数・損益A・損益B・勝率） | レポートの行（同） | 期待値との一致 | 行との一致 |");
  L.push("| --- | --- | --- | --- | --- | --- |");
  CHECKS.forEach(function (c) {
    L.push("| " + c.label.replace(" の上位10", "") + " | " + c.expectN + "件・" + c.expectA + "・" + c.expectB + " | " + c.ours.join(" / ") + " | " + (c.theirs ? c.theirs.join(" / ") : "見つからない") + " | " +
      (c.expectOk ? "一致" : "不一致") + " | " + (c.rowOk ? "一致" : "不一致") + " |");
  });
  L.push("");
  if (CHECKS.some(function (c) { return !c.expectOk || !c.rowOk; })) {
    L.push("一致しなかった。理由と、今回のデータを新しい基準としたことは0章に書いた。");
    L.push("");
  }

  // 定義
  L.push("## 売り方の定義");
  L.push("");
  L.push("| 記号 | 売り方 |");
  L.push("| --- | --- |");
  L.push("| A | 固定幅。利確ライン 買値 ×（1 + 利確幅）・損切りライン 買値 ×（1 + 損切り幅）。10:00開始の足から時刻順に、高値が利確ライン以上・安値が損切りライン以下になったかを見て、先に届いた方のラインの値段で売る。同じ足で両方に届いたら按分（損切りが先 2/3・利確が先 1/3 の加重平均）。今の売り方は 利確 +1.5%・損切り −0.75% |");
  L.push("| B | 時刻。その時刻に終わる15分足の終値で売る（11:30 は11:15開始の足＝前場最後の足、13:00 は12:45開始の足、14:00 は13:45開始の足）。大引けは T当日の日足の終値（損益Bと同じ。A の「利確なし・損切りなし」とも同じ） |");
  L.push("| C | 高値から下がったら売る。最高値の初期値は買値。各足で、前の足までの最高値 ×（1 − 下落幅）に安値が届いたら売り、届かなければその足の高値で最高値を更新する。買ってすぐは買値からの損切りとして働く |");
  L.push("| D | 建値ストップ。損切り −0.75%・利確なし。高値が買値 × 1.01 に届いた足の、次の足から損切りラインを買値 × 1.001 に引き上げる |");
  L.push("");
  L.push("- 勝率: 損益がプラスだった割合。按分の件は、利確で終わった 1/3 回と損切りで終わった 2/3 回に分けて数える（PR #88 と同じ）。勝った回・負けた回の平均と最悪の1回も同じく分けて数える（負けは0以下）");
  L.push("- 今との差: 各日、同じ銘柄について「その売り方の平均損益 − 今の売り方の平均損益」を出し、その日ごとの差の平均と t値（平均 ÷（不偏標準偏差 ÷ √日数））");
  L.push("- 最悪の1回が損切り幅より悪い件がある: 15:15開始の足までに損切りに届かず、大引け（T当日の日足の終値。15:30の足の値動きを含む）で売った件。元のスクリプトと同じく15:30の足は判定に使わないため");
  L.push("- 条件が重なった割合: 同じ足で売りの条件が2つ以上重なった件の割合。A で利確と損切りの両方に届いた場合だけが当たる（B・C・D は売りの条件が1つずつしかないため0）");
  L.push("- C・D の約定値段: 引き上がった損切りライン（C の最高値からのライン、D の引き上げ後のライン）は、前の足までの値で決まるため、足の始値の時点ですでにラインを割っていることがある。その場合は始値で売ったものとした（推測で決めた扱い。ラインの値段で売れたとした場合の数字は参考として各表の下に載せた）。A の損切りと D の引き上げ前の損切りは、元のスクリプトと同じくラインの値段で売る");
  L.push("");

  var chapter = 1;
  SELECTIONS.forEach(function (sel) {
    var n = chapter++;
    L.push("## " + n + ". " + sel.label);
    L.push("");
    L.push("### " + n + "-1. 平均損益が良い順の上位10通り");
    L.push("");
    L.push(statHead);
    L.push(statSep);
    var sorted = RANKED.slice().sort(function (a, b) { return sel.stats[b.key].all.avg - sel.stats[a.key].all.avg; });
    sorted.slice(0, 10).forEach(function (rule, i) { L.push(statRow(sel, rule, i + 1)); });
    var curRank = sorted.map(function (r) { return r.key; }).indexOf(CURRENT_KEY) + 1;
    L.push("");
    L.push("- 比べたのは " + RANKED.length + "通り（A 25・B 3（大引けは A の「なし・なし」と同じため除く）・C 3・D 1）。今の売り方は " + curRank + "位");
    L.push("");
    L.push(statHead);
    L.push(statSep);
    L.push(statRow(sel, ruleByKey[CURRENT_KEY]));
    L.push("");

    L.push("### " + n + "-2. A 固定幅（平均損益。太字が今の売り方）");
    L.push("");
    PERIODS.forEach(function (p, pi) { gridTable(L, sel, p.key, p.label + "（" + PERIOD_RANGES[pi] + "）"); });
    L.push("A の25通りの詳細:");
    L.push("");
    L.push(statHead);
    L.push(statSep);
    groupRules("A").forEach(function (rule) { L.push(statRow(sel, rule)); });
    L.push("");

    L.push("### " + n + "-3. B 時刻で売る");
    L.push("");
    L.push(statHead);
    L.push(statSep);
    groupRules("B").forEach(function (rule) { L.push(statRow(sel, rule)); });
    L.push("");
    L.push("- その時刻に終わる足が無く、それより前の最後の足の終値で売った件: " + fallbackCount(sel, "B") + "件（3つの時刻の合計）");
    L.push("");

    L.push("### " + n + "-4. C 最高値から下がったら売る");
    L.push("");
    L.push(statHead);
    L.push(statSep);
    groupRules("C").forEach(function (rule) { L.push(statRow(sel, rule)); });
    L.push("");
    L.push("参考: 始値がラインを割っていてもラインの値段で売れたとした場合");
    L.push("");
    L.push(statHead);
    L.push(statSep);
    groupRules("Cline").forEach(function (rule) { L.push(statRow(sel, rule)); });
    L.push("");
    L.push("- 始値で売った件（始値がすでにラインを割っていた件）: " + groupRules("C").map(function (r) { return r.label.replace("C ", "") + " " + gapCount(sel, r) + "件"; }).join("、"));
    L.push("");

    L.push("### " + n + "-5. D 建値ストップ");
    L.push("");
    L.push(statHead);
    L.push(statSep);
    L.push(statRow(sel, ruleByKey.D));
    L.push(statRow(sel, ruleByKey.Dline));
    L.push("");
    L.push("- 2行目は参考（引き上げ後のラインを始値が割っていてもラインの値段で売れたとした場合）。始値で売った件: " + gapCount(sel, ruleByKey.D) + "件");
    L.push("");
  });

  // 判定
  L.push("## " + chapter + ". 前半と後半の両方で今の売り方を上回り、かつ隣の設定も上回っている売り方");
  L.push("");
  L.push("「上回る」は、今の売り方との日ごとの差の平均がプラスであること（t値の大きさは問わない）。隣の設定は、A は表の上下左右（「なし」は表の端として扱う）、B は隣の時刻、C は隣の下落幅。D は設定が1つだけなので隣が無い。");
  L.push("「隣の設定も上回っている」は2通りに読めるため両方を出したが、まとめは主の読み方で書く。");
  L.push("");
  L.push("- 主の読み方: 隣の設定もすべて、前半・後半の両方で今の売り方を上回っている（まわりも良い平らな場所。設定が少しずれても今より良い）");
  L.push("- 参考の読み方: その売り方が、前半・後半の両方で、隣の設定のどれよりも平均損益が高い（山の頂上）");
  L.push("");
  var descr = function (sel, k) {
    var st = sel.stats[k];
    return ruleByKey[k].label + "（差 前半 " + cell(st.first.diff) + "・後半 " + cell(st.second.diff) + "、全体の平均損益 " + pct3(st.all.avg) + "）";
  };
  SELECTIONS.forEach(function (sel) {
    var j = judge(sel);
    L.push("**" + sel.label + "**");
    L.push("");
    L.push("- **まとめ（主の読み方）: " + (j.plateau.length ? "当てはまる売り方は次のとおり**" : "当てはまる売り方は無い**"));
    j.plateau.forEach(function (k) { L.push("  - " + descr(sel, k) + "。隣: " + neighborsOf(ruleByKey[k]).map(function (nk) { return ruleByKey[nk].label; }).join("、")); });
    L.push("- 参考の読み方に当てはまる売り方: " + (j.strict.length ? "" : "無い"));
    j.strict.forEach(function (k) { L.push("  - " + descr(sel, k)); });
    L.push("- 前半・後半の両方で今の売り方を上回ったが、隣が無いため判定できない売り方: " + (j.noNeighbor.length ? "" : "無い"));
    j.noNeighbor.forEach(function (k) { L.push("  - " + descr(sel, k)); });
    L.push("");
  });

  L.push("## " + (chapter + 1) + ". 推測で決めた点・分からなかった点");
  L.push("");
  L.push("- 13:00・14:00 に売る値段: 指示は「11:30（前場最後の足の終値）」だけ足の指定があったため、13:00・14:00 も同じく「その時刻に終わる足の終値」（12:45開始・13:45開始の足の終値）とした。その時刻に始まる足の始値とする読み方もある");
  L.push("- C・D で、引き上がったラインを足の始値がすでに割っていた場合の約定値段は始値とした（上の定義を参照）。ラインの値段とした場合も参考に載せた");
  L.push("- C の最高値の初期値は買値とした（買ってすぐは買値からの損切りとして働く）");
  L.push("- D の「高値が +1.0% に届いた」は、足の高値が買値 × 1.01 以上になったこととした。届いた足と同じ足で −0.75% の損切りに届いた場合は、損切りで売ったものとした（引き上げは次の足から）");
  L.push("- 勝った回・負けた回の平均と最悪の1回は、按分の件を利確 1/3 回・損切り 2/3 回に分けて数えた。0ちょうどは負けに入れた");
  L.push("- 判定（" + chapter + "章）で、A の表の「なし」を +3.0%・−1.5% の隣として扱うこと");
  L.push("- 15分足の高値・安値だけでは足の中の値動きの順番が分からないため、A で同じ足で両方に届いた場合の按分（損切りが先 2/3）は元のスクリプトの仮定をそのまま使った。C・D にはこの按分は無い");
  L.push("");

  var outPath = fileURLToPath(new URL("../docs/exit-grid-result.md", import.meta.url));
  writeFileSync(outPath, L.join("\n") + "\n");
  console.log(L.join("\n"));
  console.log("\n→ " + outPath);
  CHECKS.forEach(function (c) {
    if (!c.expectOk || !c.rowOk) console.log(c.label + " が PR #93 と一致しない（0章に理由を書く）: " + c.ours.join(" / ") + "  レポート: " + (c.theirs ? c.theirs.join(" / ") : "見つからない"));
  });
};

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
