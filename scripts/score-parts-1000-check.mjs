// scripts/score-parts-1000-check.mjs
// scripts/score-parts-check.mjs（8:50時点の部品分解）と同じ分析を、場中の10:00（日本時間）時点で行う。
// 10:00時点で付け直したアプリのスコア（src/lib/analyze.js の analyzeStock）を、加点項目（以下、部品）ごとの
// 点数に分解し、次の3点を調べる。
//   - どの部品が成績に効いているか
//   - どの部品が「すでに値上がりした銘柄」に点を与えているか（場中に加わる部品を含む）
//   - 部品同士が同じ情報を重ねて数えていないか
// あわせて、各部品の点数が8:50と10:00でどれだけ変わるかを数える。
// 部品ごとの点数は analyzeStock の返り値の breakdown（{label, delta} の配列。delta の合計がスコア）から取り出す。
// analyze.js の変更・中身の複製はしない。
//
// 検証日・候補（8:50時点の候補のまま）・評価時刻（10:00）・15分足の切り方（9:45開始の足まで）・現在値・
// 買値（10:00開始の足の始値）は scripts/score-top10-1000-check.mjs（PR #89）と同じ。
// PR #89 と scripts/score-parts-check.mjs のスクリプトは処理がすべて main() の中にあり、読み込むと検証全体が走って
// 既存のレポートを書き換えるため import できない。このため候補の再現・データ取得・時計の差し替え・
// 売り方の判定・場中の15分足の切り方は両スクリプトから写した（元のファイルは変更しない）。
// 同じ動きであることは、10:00のスコア上位10などの成績を PR #89 のレポートと突き合わせて確かめる（レポート9章）。
// アプリ本体とは無関係の単発検証スクリプト。新しい npm パッケージは使わず、
// 既存の依存関係に含まれる xlsx（SheetJS）・@upstash/redis（api/_scan.js の読み込みに必要）と
// Node 標準の fetch のみを使う。
//
// 実行: node scripts/score-parts-1000-check.mjs
// 出力: docs/score-parts-1000-result.md
//
// 任意: 環境変数 SCORE_PARTS_1000_CHECK_CACHE にディレクトリを指定すると、Yahoo の取得結果を
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
var PR89_REPORT = "../docs/score-top10-1000-result.md";

// 部品（analyze.js の breakdown のラベル。analyze.js で積み上がる順。scripts/score-parts-check.mjs と同じ）
var PART_LABELS = [
  "VWAP", "VWAP傾き", "Pivot", "ATR(値幅)", "ATR消化率", "対TOPIX", "トレンド", "EMA整列", "MACD", "RSI",
  "BB", "Stoch", "重複ボーナス", "出来高/OBV", "ギャップ", "当日ブレイク", "寄り付きレンジ", "コンフルエンス",
  "実績反映調整", "上限抑制(下降/デッドクロス/VWAP)", "VIXキャップ",
];
// 部品の一覧（src/lib/analyze.js の analyzeStock を読んで書き起こしたもの。条件と点数は scripts/score-parts-check.mjs と同じ。
// 補足は10:00時点の当日の足の本数（9:00〜9:45開始の4本）に合わせて書いた）
var PART_CATALOG = [
  ["VWAP", "当日分の VWAP と現在値の位置。上に1%以内 / 1%超上 / 下に1%以内 / 1%超下", "+15 / +8 / +10 / -8", "当日の足が無いと VWAP を計算しない"],
  ["VWAP傾き", "当日の VWAP の4本前比。+0.15%以上（現在値が VWAP の上なら +6、下なら +2）/ -0.15%以下（上なら -4、下なら -2）/ それ以外", "+6 / +2 / -4 / -2 / 0", "当日の足が5本以上必要（10:00評価で渡す当日の足は4本）"],
  ["Pivot", "前日の高値・安値・終値から出したピボットと現在値の位置。R1超 / PP超R1以下 / S1以上PP以下 / S1未満", "-3 / +5 / +3 / -4", ""],
  ["ATR(値幅)", "15分足の ATR(14) ÷ 現在値。0.15%以上 / 0.08%以上 / それ未満", "+10 / +5 / -5", ""],
  ["ATR消化率", "当日の値幅 ÷ 日足 ATR(14)。130%以上 / 90%以上 / それ未満", "-8 / -4 / 0", "当日の足が必要"],
  ["対TOPIX", "前日比 − TOPIX 前日比。+1.5以上 / +0.5以上 / -1.5以下 / -0.5以下 / それ以外", "+6 / +3 / -6 / -3 / 0", "10:00評価の前日比は、前日の日足終値から10:00時点の現在値まで。TOPIX 前日比は PR #89 と同じく前日の値"],
  ["トレンド", "EMA5 と EMA13 の上下（上 +8、下 -6、同じ +2）。上のとき5本ごと・15本ごとに間引いた足でも上なら各 +5、下のとき同じく下なら各 -3", "+18 / +13 / +8 / +2 / -6 / -9 / -12", ""],
  ["EMA整列", "EMA5 > EMA20 > EMA60 / EMA5 < EMA20 < EMA60 / それ以外", "+8 / -6 / 0", ""],
  ["MACD", "ヒストグラムが負→正に変わった / 正 / 正→負に変わった / 負", "+4 / +2 / -4 / -2", ""],
  ["RSI", "RSI(14)。30未満 / 40未満 / 50未満 / 60未満 / 70未満 / 70以上", "+8 / +6 / +4 / +2 / +1 / -3", ""],
  ["BB", "位置（下限以下 +8、下から20%未満 +5、上限以上 -6、上から20%以内 +1、それ以外 +3）＋収束（帯幅 ÷ 直近の平均帯幅が0.7以下 +7、0.85以下 +4）", "-6 〜 +15", ""],
  ["Stoch", "ストキャスティクス(14)。20未満 / 35未満 / 80超 / 65超 / それ以外", "+6 / +4 / -4 / +2 / +3", ""],
  ["重複ボーナス", "RSI 40未満・BB 下限付近（下限以下か下から20%未満）・Stoch 35未満のうち3つ / 2つが当てはまる", "+4 / +2 / 0", ""],
  ["出来高/OBV", "OBV（直近1日分の15分足の終値位置の平均。0.8以上 +7、0.6以上 +4、0.2以下 -6、0.4以下 -3）＋出来高（直近5日合計 ÷ その前の平均。2.0倍以上で終値位置0.6以上 +8・0.4以下 -8・それ以外 +2、1.5倍以上 +3、0.8倍未満 -2）", "-14 〜 +15", ""],
  ["ギャップ", "当日始値と前日終値の差（±1.5%以上）と、その後の維持・埋め", "+5 / -3 / -5 / +3 / 0", "当日の足が必要"],
  ["当日ブレイク", "現在値が当日のそれまでの高値・安値を更新したか（出来高増を伴えば ±8、伴わなければ ±4）", "+8 / +4 / -4 / -8 / 0", "当日の足が2本以上必要"],
  ["寄り付きレンジ", "寄り付き2本の高安を現在値が上抜け / 下抜け", "+8 / -8 / 0", "当日の足が3本以上必要"],
  ["コンフルエンス", "VWAP・VWAP傾き・EMA整列・トレンド・出来高・当日ブレイク・寄り付きレンジ・ギャップの8つのうち、上向きがいくつ（6以上 / 4以上 / 3）、下向きがいくつ（6以上 / 4以上 / 3）", "+15 / +8 / +4 / -15 / -8 / -4 / 0", "当日の足を使う5つ（VWAP・VWAP傾き・当日ブレイク・寄り付きレンジ・ギャップ）は、当日の足が無いか本数が足りないと判定されない"],
  ["実績反映調整", "過去の的中率による各部品の点数の補正", "補正値", "自動スキャンは的中率の統計を渡さない（空）ため補正されない"],
  ["上限抑制(下降/デッドクロス/VWAP)", "スコアの上限（MACD デッドクロスと下降トレンドの両方 20、デッドクロス 30、下降トレンド 35、VWAP 乖離と出来高低調など 35〜55）で削られた点（負）と、0〜100 への切り詰めで動いた点（合計が0未満のときに0へ戻した分は正）", "上限で削った分は負、0未満を0に戻した分は正", "VWAP 乖離による上限は当日の足が無いとかからない"],
  ["VIXキャップ", "VIX 20以上で80点、25以上で65点、30以上で45点を上限とする", "0 以下", "自動スキャンは VIX を渡さない（null）"],
];

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

// ピアソンの相関係数。どちらかが一定なら NaN
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

var pct3 = function (v) { return isNum(v) ? (v * 100).toFixed(3) + "%" : "-"; };
var pct2 = function (v) { return isNum(v) ? (v * 100).toFixed(2) + "%" : "-"; };
var pct1 = function (v) { return isNum(v) ? (v * 100).toFixed(1) + "%" : "-"; };
var num2 = function (v) { return isNum(v) ? v.toFixed(2) : "-"; };
var num3 = function (v) { return isNum(v) ? v.toFixed(3) : "-"; };
var signed = function (v) { return v > 0 ? "+" + v : String(v); };

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

// ---------- 売り方の判定（PR #89 と同じ。買値を引数で受け取る） ----------

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

// PR #88・#89 の3通りの扱い（損益Aは按分だけを使う。ほかの2つは PR #89 との突き合わせにだけ使う）
var MODES = [
  { key: "tpFirst", label: "利確が先" },
  { key: "slFirst", label: "損切りが先" },
  { key: "prorata", label: "按分（損切りが先の確率2/3）" },
];

var outcome = function (ex, mode) {
  var tpNet = TAKE_PROFIT - FEE, slNet = STOP_LOSS - FEE;
  if (ex.kind === "tp") return { ret: tpNet, win: 1, tp: 1, sl: 0, cl: 0 };
  if (ex.kind === "sl") return { ret: slNet, win: 0, tp: 0, sl: 1, cl: 0 };
  if (ex.kind === "close") {
    var r = ex.closeRet - FEE;
    return { ret: r, win: r > 0 ? 1 : 0, tp: 0, sl: 0, cl: 1 };
  }
  if (mode === "tpFirst") return { ret: tpNet, win: 1, tp: 1, sl: 0, cl: 0 };
  if (mode === "slFirst") return { ret: slNet, win: 0, tp: 0, sl: 1, cl: 0 };
  var pTp = 1 - SL_FIRST_PROB;
  return { ret: pTp * tpNet + SL_FIRST_PROB * slNet, win: pTp, tp: pTp, sl: SL_FIRST_PROB, cl: 0 };
};

// ---------- 本体 ----------

var main = async function () {
  var cacheDir = process.env.SCORE_PARTS_1000_CHECK_CACHE || null;
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

  var skip = { noIntraday: 0, noPrevBars: 0, fewBars: 0, noOfficialPrev: 0, noToday: 0, fewBars1000: 0, noDaily: 0, noBuyBar: 0, noAfter: 0 };
  var clockMismatch0850 = 0, clockMismatch1000 = 0, started0850 = 0, notStarted1000 = 0;
  var scored0850 = 0, scored1000 = 0, sumMismatch = 0;
  var shortScored0850 = 0, shortScored1000 = 0;

  testDays.forEach(function (td) {
    var t = td.t, date = td.date;
    var topixChange = topixChangeFor(t);
    var clock0850 = jstAt(date, "08:50"), clock1000 = jstAt(date, EVAL.clock);
    if (withClock(clock0850, function () { return currentSessionDate("JP"); }) !== date) clockMismatch0850++;
    if (withClock(clock1000, function () { return currentSessionDate("JP"); }) !== date) clockMismatch1000++;
    td.records = [];

    td.cands.forEach(function (si2, order) {
      var st = stocks[si2];
      var rec = { day: date, ticker: st.ticker, order: order, fromChange: td.byChange.has(si2), s0850: null, score: null };
      var ix = intraday[si2];
      if (!ix) { skip.noIntraday++; td.records.push(rec); return; }
      var w = windowBefore(ix, date);
      if (!w || w.lastDay !== jpDays[t - 1]) { skip.noPrevBars++; td.records.push(rec); return; }
      var d0 = t0 != null ? bars[si2][t0] : null;
      var tradedOnStart = !!(d0 && isNum(d0.close));
      var extra0850 = missingStartBars(ix, w.to - w.from, w.days, t, APP_WINDOW_DAYS, tradedOnStart);
      if (w.to - w.from + extra0850 < MIN_BARS) { skip.fewBars++; td.records.push(rec); return; }
      var stock = scan.normalizeStock(st.ticker);
      var score = function (payload, clockMs) {
        var pd = scan.toPriceData(payload);
        return { pd: pd, a: withClock(clockMs, function () { return analyzeStock(stock, pd, null, {}); }) };
      };

      // 8:50: PR #88 と同じ計算（部品の点数を8:50との差の集計に使う）
      var pPrev2 = bars[si2][t - 2];
      var prev0850 = pPrev2 && isNum(pPrev2.close) ? pPrev2.close : null;
      if (prev0850 == null) skip.noOfficialPrev++;
      var r0 = score(buildPayload(ix, w.from, w.to, prev0850, topixChange), clock0850);
      if (r0.a.sessionStarted) started0850++;
      scored0850++;
      if (extra0850 > 0) shortScored0850++;
      rec.s0850 = r0.a.save.score;
      var p0 = toParts(r0.a);
      if (!p0.ok) sumMismatch++;
      rec.parts0850 = p0.parts;

      // 10:00: PR #89 と同じ計算。公式の前日終値は T当日の前日の日足終値
      var wi = windowIntraday(ix, date, jstAt(date, EVAL.cut) / 1000);
      if (!wi || wi.todayBars === 0) { skip.noToday++; td.records.push(rec); return; }
      var extra1000 = missingStartBars(ix, wi.to - wi.from - wi.todayBars, wi.days, t, APP_WINDOW_DAYS - 1, tradedOnStart);
      if (wi.to - wi.from + extra1000 < MIN_BARS) { skip.fewBars1000++; td.records.push(rec); return; }
      var pPrev1 = bars[si2][t - 1];
      var prevIntra = pPrev1 && isNum(pPrev1.close) ? pPrev1.close : null;
      var r1 = score(buildPayload(ix, wi.from, wi.to, prevIntra, topixChange), clock1000);
      if (!r1.a.sessionStarted) notStarted1000++;
      scored1000++;
      if (extra1000 > 0) shortScored1000++;
      rec.score = r1.a.save.score;
      var p1 = toParts(r1.a);
      if (!p1.ok) sumMismatch++;
      rec.parts = p1.parts;
      rec.price = r1.pd.currentPrice;

      // すでに上がった度合い
      // 前日・5日: 調整後終値（scripts/score-parts-check.mjs と同じ）
      var c1 = bars[si2][t - 1], c2 = bars[si2][t - 2], c6 = t >= 6 ? bars[si2][t - 6] : null;
      rec.prev1 = c1 && c2 && isNum(c1.adj) && isNum(c2.adj) && c2.adj > 0 ? c1.adj / c2.adj - 1 : null;
      rec.prev5 = c1 && c6 && isNum(c1.adj) && isNum(c6.adj) && c6.adj > 0 ? c1.adj / c6.adj - 1 : null;
      // 当日: 前日の日足終値（スコア計算に渡した公式の前日終値と同じ値）→ 10:00時点の現在値
      rec.today = isNum(prevIntra) && prevIntra > 0 && isNum(rec.price) ? rec.price / prevIntra - 1 : null;

      // 売買: PR #89 と同じ除外条件と買値（10:00開始の足の始値）
      var b = bars[si2][t];
      if (!b || !isNum(b.open) || !isNum(b.high) || !isNum(b.low) || !isNum(b.close) || b.open <= 0 ||
          !isNum(b.volume) || b.volume === 0) {
        skip.noDaily++;
        td.records.push(rec);
        return;
      }
      // 寄り後: T当日の日足の始値（寄り付き）→ 10:00時点の現在値
      rec.afterOpen = isNum(rec.price) ? rec.price / b.open - 1 : null;
      var buy = openAt(ix, date, EVAL.buy);
      if (buy == null) { skip.noBuyBar++; td.records.push(rec); return; }
      var after = barsFrom(ix, date, jstAt(date, EVAL.buy) / 1000);
      if (!after.length) { skip.noAfter++; td.records.push(rec); return; }
      rec.exit = judgeExit(buy, b.close, after);
      var oa = outcome(rec.exit, "prorata");
      rec.retA = oa.ret;
      rec.winA = oa.win;
      rec.retB = b.close / buy - 1 - FEE;
      td.records.push(rec);
    });
  });
  console.log("スコア計算 8:50 " + scored0850 + "件（寄り付き後扱い " + started0850 + "、時計のずれ " + clockMismatch0850 + "日）");
  console.log("スコア計算 10:00 " + scored1000 + "件（寄り付き前扱い " + notStarted1000 + "、時計のずれ " + clockMismatch1000 + "日）、部品の合計≠スコア " + sumMismatch + "件");
  if (unknownLabels.size) throw new Error("PART_LABELS に無い部品: " + Array.from(unknownLabels).join(", "));
  if (sumMismatch) throw new Error("部品の点数の合計がスコアと一致しない銘柄日がある: " + sumMismatch);

  // ---------- PR #89 との突き合わせ（PR #89 の3章・4章と同じ集計） ----------

  var rankDay = function (td, get) {
    var list = td.records.filter(function (r) { return isNum(get(r)); })
      .sort(function (a, b) { return get(b) - get(a) || a.order - b.order; });
    return { list: list, top: new Set(list.slice(0, TOP_N)) };
  };
  var agg = function (recs, mode) {
    var tr = recs.filter(function (r) { return r.exit; });
    if (!tr.length) return { n: 0 };
    var o = tr.map(function (r) { return outcome(r.exit, mode); });
    var sum = function (f) { return o.reduce(function (s, x) { return s + x[f]; }, 0); };
    return { n: tr.length, avg: sum("ret") / tr.length, win: sum("win") / tr.length, tp: sum("tp") / tr.length, sl: sum("sl") / tr.length, cl: sum("cl") / tr.length };
  };
  var get1000 = function (r) { return r.score; };
  var get0850 = function (r) { return r.s0850; };
  var groups = { top: [], rest: [], all: [], top0850: [] };
  var dayDiff = {}, dayDiffEarly = {};
  MODES.forEach(function (m) { dayDiff[m.key] = []; dayDiffEarly[m.key] = []; });
  testDays.forEach(function (td) {
    var rk = rankDay(td, get1000);
    var rk0 = rankDay(td, get0850);
    var topRecs = [], restRecs = [];
    rk.list.forEach(function (r) {
      var inTop = rk.top.has(r);
      (inTop ? topRecs : restRecs).push(r);
      groups.all.push(r);
      (inTop ? groups.top : groups.rest).push(r);
    });
    var top0 = Array.from(rk0.top);
    top0.forEach(function (r) { groups.top0850.push(r); });
    MODES.forEach(function (m) {
      var at = agg(topRecs, m.key), ar = agg(restRecs, m.key), a0 = agg(top0, m.key);
      if (at.n && ar.n) dayDiff[m.key].push(at.avg - ar.avg);
      if (at.n && a0.n) dayDiffEarly[m.key].push(at.avg - a0.avg);
    });
  });
  var GROUP_ROWS = [
    ["top", "10:00のスコアで上位10"],
    ["rest", "10:00のスコアで11位以下"],
    ["all", "候補全体"],
    ["top0850", "8:50のスコアで上位10（買うのは10:00）"],
  ];
  var reproGroupRows = []; // { modeIdx, row }
  MODES.forEach(function (m, mi) {
    GROUP_ROWS.forEach(function (g) {
      var a = agg(groups[g[0]], m.key);
      reproGroupRows.push({ modeIdx: mi, label: g[1], row: "| " + g[1] + " | " + a.n + " | " + pct3(a.avg) + " | " + pct1(a.win) + " | " + pct1(a.tp) + " | " + pct1(a.sl) + " | " + pct1(a.cl) + " |" });
    });
  });
  var diffRows = function (dd) {
    return MODES.map(function (m) {
      var d = tStat(dd[m.key]);
      return "| " + m.label + " | " + d.n + " | " + pct3(d.avg) + " | " + pct3(d.sd) + " | " + num2(d.t) + " |";
    });
  };
  var reproDiffRows = diffRows(dayDiff);
  var reproEarlyRows = diffRows(dayDiffEarly);

  var pr89Text = readFileSync(fileURLToPath(new URL(PR89_REPORT, import.meta.url)), "utf8");
  var pr89Lines = pr89Text.split("\n");
  // PR #89 のレポートの3章の、modeIdx 番目の表の label の行
  var pr89GroupRow = function (label, modeIdx) {
    var seen = -1, inSec3 = false;
    for (var i = 0; i < pr89Lines.length; i++) {
      if (pr89Lines[i].indexOf("## ") === 0) inSec3 = pr89Lines[i].indexOf("## 3.") === 0;
      if (!inSec3) continue;
      if (pr89Lines[i].indexOf("**同じ15分足で両方に届いた場合: ") === 0) seen++;
      if (seen === modeIdx && pr89Lines[i].indexOf("| " + label + " |") === 0) return pr89Lines[i];
    }
    return null;
  };
  // PR #89 のレポートの見出し sec の直後の表の、label の行
  var pr89DiffRow = function (sec, label) {
    var inSec = false;
    for (var i = 0; i < pr89Lines.length; i++) {
      if (pr89Lines[i].indexOf("#") === 0) inSec = pr89Lines[i].indexOf(sec) === 0;
      if (inSec && pr89Lines[i].indexOf("| " + label + " |") === 0) return pr89Lines[i];
    }
    return null;
  };
  var reproChecks = [];
  reproGroupRows.forEach(function (x) { reproChecks.push({ ours: x.row, theirs: pr89GroupRow(x.label, x.modeIdx) }); });
  reproDiffRows.forEach(function (row, i) { reproChecks.push({ ours: row, theirs: pr89DiffRow("### 4-1.", MODES[i].label) }); });
  reproEarlyRows.forEach(function (row, i) { reproChecks.push({ ours: row, theirs: pr89DiffRow("### 4-2.", MODES[i].label) }); });
  var reproMissing = reproChecks.filter(function (x) { return x.ours !== x.theirs; });
  // 10:00上位10の平均損益（按分）が PR #89 と一致するか
  var mainTopRow = reproGroupRows.filter(function (x) { return x.modeIdx === 2 && x.label === GROUP_ROWS[0][1]; })[0];
  var mainTopOk = mainTopRow.row === pr89GroupRow(mainTopRow.label, 2);

  // ---------- 分析用の母集団: 10:00のスコアを計算でき、10:00の買いまで判定できた銘柄日 ----------

  var recs = [];
  testDays.forEach(function (td) { td.records.forEach(function (r) { if (isNum(r.score) && r.exit) recs.push(r); }); });
  var candTotal = testDays.reduce(function (s, td) { return s + td.cands.length; }, 0);
  var N = recs.length;

  var partInfo = PART_LABELS.map(function (lb) {
    var vals = recs.map(function (r) { return r.parts[lb]; });
    var vals0 = recs.map(function (r) { return r.parts0850[lb]; });
    var alwaysZero = vals.every(function (v) { return v === 0; });
    var alwaysZero0850 = vals0.every(function (v) { return v === 0; });
    var hasPos = vals.some(function (v) { return v > 0; });
    return { label: lb, alwaysZero: alwaysZero, alwaysZero0850: alwaysZero0850, hasPos: hasPos };
  });
  var activeParts = partInfo.filter(function (p) { return !p.alwaysZero; });

  // 1. スコア帯（5等分。scripts/score-parts-check.mjs と同じ同点の扱い）
  var sortedScores = recs.map(function (r) { return r.score; }).sort(function (a, b) { return a - b; });
  var lowerCount = new Map(), eqCount = new Map();
  sortedScores.forEach(function (sc, i) {
    if (!lowerCount.has(sc)) lowerCount.set(sc, i);
    eqCount.set(sc, (eqCount.get(sc) || 0) + 1);
  });
  var bandOf = function (sc) {
    var mid = lowerCount.get(sc) + eqCount.get(sc) / 2;
    return Math.min(4, Math.floor(mid / N * 5));
  };
  var bands = [[], [], [], [], []];
  recs.forEach(function (r) { bands[bandOf(r.score)].push(r); });

  var avgOf = function (list, f) {
    var v = list.map(function (r) { return r[f]; }).filter(isNum);
    return v.length ? mean(v) : NaN;
  };
  var winB = function (list) { return list.length ? list.filter(function (r) { return r.retB > 0; }).length / list.length : NaN; };
  var share2B = function (list) { return list.length ? list.filter(function (r) { return r.fromChange; }).length / list.length : NaN; };

  // 2. 部品ごとの効き目（scripts/score-parts-check.mjs と同じ）
  var dayDiffStats = function (isOn) {
    var dA = [], dB = [];
    testDays.forEach(function (td) {
      var day = td.records.filter(function (r) { return isNum(r.score) && r.exit; });
      var on = day.filter(isOn), off = day.filter(function (r) { return !isOn(r); });
      if (!on.length || !off.length) return;
      dA.push(avgOf(on, "retA") - avgOf(off, "retA"));
      dB.push(avgOf(on, "retB") - avgOf(off, "retB"));
    });
    var st = function (d) {
      var m = d.length ? mean(d) : NaN, s = sd(d);
      return { n: d.length, avg: m, t: m / (s / Math.sqrt(d.length)) };
    };
    return { a: st(dA), b: st(dB) };
  };

  // 3. すでに上がった度合い
  var RISE = [
    { key: "prev1", label: "前日騰落率" },
    { key: "prev5", label: "5日騰落率" },
    { key: "today", label: "当日騰落率" },
    { key: "afterOpen", label: "寄り後騰落率" },
  ];

  // ---------- 出力 ----------

  var L = [];
  L.push("# 10:00時点のスコアの部品ごとの分解 検証結果");
  L.push("");
  L.push("- 生成: `node scripts/score-parts-1000-check.mjs`（実行日 " + new RealDate().toISOString().slice(0, 10) + "）");
  L.push("- 検証日・候補・評価時刻（10:00）・15分足の切り方（T当日は 9:45開始の足まで）・現在値（9:45開始の足の終値）・買値（10:00開始の足の始値）: `scripts/score-top10-1000-check.mjs`（PR #89）と同じ。候補は8:50時点のもの（前日の確定値で、出来高上位" + NORMAL_VOL_TOP + "と、値上がり率上位" + CHANGE_TOP + "（出来高が全銘柄の中央値の" + VOL_MULT + "倍以上のもの）を重複なしで並べたもの）で、10:00に作り直さない");
  L.push("- 集計の作り: `scripts/score-parts-check.mjs`（8:50時点の部品分解）と同じ");
  L.push("- 銘柄一覧: JPX 東証上場銘柄一覧（" + (jpx.asOf || "日付不明") + " 時点）のうち、プライム・スタンダード・グロースの内国株式 " + jpx.list.length + "銘柄");
  L.push("- 15分足: Yahoo Finance（interval=" + INTRADAY_INTERVAL + "、range=" + INTRADAY_RANGE + "）。今回取得できた期間 " + periodStart + " 〜 " + periodEnd + "（PR #89 は 2026-06-26 〜 2026-09-24）");
  L.push("- **検証日数: " + testDays.length + "日**（" + testDays[0].date + " 〜 " + testDays[testDays.length - 1].date + "）");
  L.push("- 候補の銘柄日数: " + candTotal + "（うち10:00のスコアを計算できた " + scored1000 + "、そのうち10:00の買いまで判定できた " + N + "）。**4〜7章の集計は、10:00の買いまで判定できた " + N + "件が対象**");
  L.push("- スコア: 自動スキャン（`api/_scan.js`）と同じく VIX なし・過去の的中率の統計なし。TOPIX前日比は " + topixSource + (topixSource === TOPIX_PROXY ? "（TOPIX 連動ETF で代用）" : "") + " の日足（調整後終値）で、T当日の前日の値（PR #89 と同じ。10:00も同じ値）");
  L.push("");
  L.push("損益の定義（どちらも往復コスト0.1%を引いた値）:");
  L.push("");
  L.push("- 損益A（売り方ルール）: 10:00開始の15分足の始値で買い、利確ライン 買値 × 1.015・損切りライン 買値 × 0.9925。10:00開始の足から時刻順に見て、先に届いた方で決着。どちらにも届かなければ T当日の日足の終値で手仕舞い。同じ15分足で両方に届いた場合は PR #88 の按分（損切りが先 2/3・利確が先 1/3 の加重平均）");
  L.push("- 損益B（10:00→大引け）: T当日の日足の終値 ÷ 10:00開始の15分足の始値 − 1 − 0.1%");
  L.push("- 勝率: 損益がプラスだった割合。損益Aでは同じ足で両方に届いた件を 1/3 勝ちとして数える（PR #88 と同じ）");
  L.push("");
  L.push("すでに上がった度合い:");
  L.push("");
  L.push("- 前日騰落率: 前日終値 ÷ 前々日終値 − 1（Yahoo の日足の調整後終値。`scripts/score-parts-check.mjs` と同じ）");
  L.push("- 5日騰落率: 前日終値 ÷ 6営業日前の終値 − 1（同上）");
  L.push("- 当日騰落率: 10:00時点の現在値 ÷ 前日終値 − 1（前日終値は Yahoo の日足の終値。スコア計算に渡した前日終値と同じ値）");
  L.push("- 寄り後騰落率: 10:00時点の現在値 ÷ T当日の寄り付き − 1（寄り付きは Yahoo の日足の始値）");
  L.push("- 10:00時点の現在値: スコア計算で使った現在値（9:45開始の15分足の終値。空の足は `toPriceData` が直前の値で埋める）");
  L.push("");

  // 1章 実装前確認
  L.push("## 1. 実装前確認の結果");
  L.push("");
  L.push("- `scripts/score-parts-check.mjs`: リポジトリにある");
  L.push("- PR #89 の検証スクリプト: `scripts/score-top10-1000-check.mjs` がリポジトリにある");
  L.push("- 共通部分: 2つのスクリプトとも処理がすべて `main()` の中にあり、読み込むと検証全体が走って既存のレポートを書き換えるため import できない。このため候補の再現・データ取得・時計の差し替え・場中の15分足の切り方・売り方の判定を新しいスクリプトに写した。同じ動きであるかは9章で PR #89 のレポートと突き合わせた");
  L.push("- 10:00時点の部品ごとの点数: 8:50と同じく `analyzeStock()` の返り値の `breakdown` から取り出せた。`src/lib/analyze.js` の変更・中身の複製は不要だった。10:00の " + scored1000 + "件・8:50の " + scored0850 + "件のすべてで部品の点数の合計がスコアと一致した（不一致 " + sumMismatch + "件）。「実績反映調整」「上限抑制」「VIXキャップ」は点数が0のときは項目ごと出てこないため、0点として扱った");
  L.push("- 時計の差し替え: 10:00評価は PR #89 と同じく `Date.now()` と引数なしの `new Date()` を対象日の 10:00（日本時間）に固定した。全検証日で `currentSessionDate(\"JP\")` が対象日を返し（ずれ " + clockMismatch1000 + "日）、10:00で計算した " + scored1000 + "件のうち寄り付き前扱いになった件数は " + notStarted1000 + "。8:50（5章の比較用）は対象日の 8:50 に固定し（ずれ " + clockMismatch0850 + "日）、寄り付き後扱いになった件数は " + started0850);
  L.push("- 15分足の加工: `api/stock.js` の `toLocalDates()` の写しが一字一句同じであることを実行時に確かめた（" + (datesCopyOk ? "一致" : "不一致") + "）。空の足の埋め方（`toPriceData`）と銘柄情報の形（`normalizeStock`）は `api/_scan.js` から import した");
  L.push("- データの違い: Yahoo の15分足は直近60日分しか返らず、今回の実行時点では PR #89 の初日 " + PR88_INTRADAY_START + " の15分足が取れなかった（取れなかった日: " + (lostDays.length ? lostDays.join("・") : "なし") + "。それ以外に取れない日は無い）。`scripts/score-parts-check.mjs` と同じ扱いで、600本以上の条件を判定するときに「" + PR88_INTRADAY_START + " の足があれば増えていた本数」（窓の前の取引日1日あたりの本数。その銘柄の日足が " + PR88_INTRADAY_START + " にある場合だけ）を足し、PR #89 と同じ " + PR88_DAY_COUNT + "日・同じ銘柄日を対象にした。PR #89 の窓にこの日が入っていた検証日は、8:50（前の30取引日）で " + shortWindowDays0850.length + "日（" + shortWindowDays0850.join("・") + "）、10:00（前の29取引日＋当日）で " + shortWindowDays1000.length + "日（" + shortWindowDays1000.join("・") + "）。これらの日はスコア計算に渡す15分足が PR #89 より1日分短い（窓が短いまま計算した銘柄日: 8:50 " + shortScored0850 + "件、10:00 " + shortScored1000 + "件）");
  L.push("- 同じ動きであることの確認: 10:00上位10の平均損益（按分）が PR #89 のレポートと" + (mainTopOk ? "**一致した**" : "**一致しなかった**") + "（9章）");
  L.push("");

  // 2章 検証日数と件数
  L.push("## 2. 検証日数と件数");
  L.push("");
  L.push("| 項目 | 値 |");
  L.push("| --- | ---: |");
  L.push("| 検証日数 | " + testDays.length + " |");
  L.push("| 候補の銘柄日数 | " + candTotal + " |");
  L.push("| 8:50のスコアを計算できた銘柄日数 | " + scored0850 + " |");
  L.push("| 10:00のスコアを計算できた銘柄日数 | " + scored1000 + " |");
  L.push("| 10:00の買いまで判定できた銘柄日数（集計の対象） | " + N + " |");
  L.push("| └ うちグループ2B（前日値上がり率上位20から入った候補） | " + recs.filter(function (r) { return r.fromChange; }).length + " |");
  RISE.forEach(function (x) {
    L.push("| └ うち" + x.label + "を計算できた | " + recs.filter(function (r) { return isNum(r[x.key]); }).length + " |");
  });
  L.push("| 日足の取得に失敗した銘柄 | " + failed.length + " |");
  L.push("| 15分足の取得対象の銘柄 | " + targets.length + " |");
  L.push("| 15分足の取得に失敗した銘柄 | " + intradayFailed.length + " |");
  L.push("| スコアを計算しなかった銘柄日: 15分足の取得失敗 | " + skip.noIntraday + " |");
  L.push("| スコアを計算しなかった銘柄日: 前日の15分足が無い | " + skip.noPrevBars + " |");
  L.push("| スコアを計算しなかった銘柄日: 15分足が" + MIN_BARS + "本未満（8:50の範囲で判定） | " + skip.fewBars + " |");
  L.push("| 10:00のスコアを計算しなかった銘柄日: T当日の足が10:00前に無い | " + skip.noToday + " |");
  L.push("| 10:00のスコアを計算しなかった銘柄日: 15分足が" + MIN_BARS + "本未満（10:00の範囲で判定） | " + skip.fewBars1000 + " |");
  L.push("| 売買から除いた銘柄日: T当日の日足の欠け・出来高0 | " + skip.noDaily + " |");
  L.push("| 売買から除いた銘柄日: 10:00開始の15分足が無い・始値が無い | " + skip.noBuyBar + " |");
  L.push("| 売買から除いた銘柄日: 10:00以降の15分足が無い | " + skip.noAfter + " |");
  L.push("");

  // 3章 部品の一覧
  L.push("## 3. 部品の一覧");
  L.push("");
  L.push("`src/lib/analyze.js` の `analyzeStock()` を読んで書き起こした（条件と点数は `docs/score-parts-result.md` と同じ）。部品名は `breakdown` のラベル。「常に0点」は、今回の " + N + "件で点数が一度も0以外にならなかった部品。");
  L.push("");
  L.push("| 部品 | 加点・減点の条件 | 取り得る点数 | 8:50に常に0点 | 10:00に常に0点 | 補足 |");
  L.push("| --- | --- | --- | --- | --- | --- |");
  PART_CATALOG.forEach(function (c) {
    var p = partInfo.filter(function (x) { return x.label === c[0]; })[0];
    L.push("| " + c[0] + " | " + c[1] + " | " + c[2] + " | " + (p.alwaysZero0850 ? "常に0" : "-") + " | " + (p.alwaysZero ? "常に0" : "-") + " | " + (c[3] || "-") + " |");
  });
  L.push("");
  L.push("- 10:00に常に0点の部品: " + (partInfo.filter(function (p) { return p.alwaysZero; }).map(function (p) { return p.label; }).join("、") || "なし"));
  L.push("");

  // 4章 スコア帯
  L.push("## 4. 集計1: スコア帯ごとの成績（10:00の合計スコアで5等分）");
  L.push("");
  L.push("| 帯 | 件数 | スコアの範囲 | 損益A 平均 | 損益B 平均 | 勝率（損益A） | 勝率（損益B） | グループ2Bの割合 | 前日騰落率の平均 | 当日騰落率の平均 | 寄り後騰落率の平均 |");
  L.push("| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  var bandRow = function (name, list, range) {
    return "| " + name + " | " + list.length + " | " + range + " | " +
      pct3(avgOf(list, "retA")) + " | " + pct3(avgOf(list, "retB")) + " | " + pct1(avgOf(list, "winA")) + " | " + pct1(winB(list)) + " | " +
      pct1(share2B(list)) + " | " + pct2(avgOf(list, "prev1")) + " | " + pct2(avgOf(list, "today")) + " | " + pct2(avgOf(list, "afterOpen")) + " |";
  };
  bands.forEach(function (list, i) {
    var scs = list.map(function (r) { return r.score; });
    var range = list.length ? Math.min.apply(null, scs) + "〜" + Math.max.apply(null, scs) : "-";
    L.push(bandRow((i + 1) + (i === 0 ? "（低）" : i === 4 ? "（高）" : ""), list, range));
  });
  L.push(bandRow("全体", recs, sortedScores[0] + "〜" + sortedScores[N - 1]));
  L.push("");
  L.push("- 同点の扱い: 同じスコアの銘柄日は必ず同じ帯に入れた。全件をスコアの低い順に並べ、各スコアの銘柄日が並ぶ区間の中央の位置 ÷ 全件数 × 5 の整数部分で帯を決めた。このため各帯の件数は全件数の1/5ちょうどにはならない（`scripts/score-parts-check.mjs` と同じ）");
  L.push("- 全検証日をまとめて5等分した（日ごとには分けていない）");
  L.push("");

  // 5章 部品ごとの効き目
  L.push("## 5. 集計2: 部品ごとの効き目（10:00の点数）");
  L.push("");
  L.push("### 5-1. 日ごとの差（加点あり − 加点なし）");
  L.push("");
  L.push("| 部品 | 比べた2群 | 日数 | 損益A 差の平均 | 損益A t値 | 損益B 差の平均 | 損益B t値 |");
  L.push("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
  partInfo.forEach(function (p) {
    if (p.alwaysZero) { L.push("| " + p.label + " | 常に0 | | | | | |"); return; }
    var isOn = p.hasPos
      ? function (r) { return r.parts[p.label] > 0; }
      : function (r) { return r.parts[p.label] < 0; };
    var st = dayDiffStats(isOn);
    L.push("| " + p.label + " | " + (p.hasPos ? "加点あり − 加点なし" : "減点あり − 減点なし") + " | " + st.a.n + " | " + pct3(st.a.avg) + " | " + num2(st.a.t) + " | " + pct3(st.b.avg) + " | " + num2(st.b.t) + " |");
  });
  L.push("");
  L.push("- 加点あり: その部品の点数が0より大きい。加点なし: 0以下（0点と減点を含む）");
  if (partInfo.some(function (p) { return !p.alwaysZero && !p.hasPos; })) L.push("- 加点が一度も無い部品（点数が0以下しか取らない部品）は、減点あり（0未満）と減点なし（0）で同じ計算をした");
  L.push("- 日ごとに2群の平均の差を出し、その平均と t値（平均 ÷（不偏標準偏差 ÷ √日数））を示した。片方の群が0件の日は除いた");
  L.push("");
  L.push("### 5-2. 点数ごとの件数と平均");
  L.push("");
  partInfo.forEach(function (p) {
    L.push("#### " + p.label);
    L.push("");
    if (p.alwaysZero) { L.push("常に0"); L.push(""); return; }
    var byVal = new Map();
    recs.forEach(function (r) {
      var v = r.parts[p.label];
      if (!byVal.has(v)) byVal.set(v, []);
      byVal.get(v).push(r);
    });
    var on = recs.filter(function (r) { return p.hasPos ? r.parts[p.label] > 0 : r.parts[p.label] < 0; });
    var off = recs.filter(function (r) { return p.hasPos ? !(r.parts[p.label] > 0) : !(r.parts[p.label] < 0); });
    L.push("| 点数 | 件数 | 損益A 平均 | 損益B 平均 |");
    L.push("| --- | ---: | ---: | ---: |");
    Array.from(byVal.keys()).sort(function (a, b) { return b - a; }).forEach(function (v) {
      var list = byVal.get(v);
      L.push("| " + signed(v) + " | " + list.length + " | " + pct3(avgOf(list, "retA")) + " | " + pct3(avgOf(list, "retB")) + " |");
    });
    L.push("| " + (p.hasPos ? "加点あり（計）" : "減点あり（計）") + " | " + on.length + " | " + pct3(avgOf(on, "retA")) + " | " + pct3(avgOf(on, "retB")) + " |");
    L.push("| " + (p.hasPos ? "加点なし（計）" : "減点なし（計）") + " | " + off.length + " | " + pct3(avgOf(off, "retA")) + " | " + pct3(avgOf(off, "retB")) + " |");
    L.push("");
  });

  // 6章 相関
  var corrWith = function (getX, f) {
    var xs = [], ys = [];
    recs.forEach(function (r) {
      if (!isNum(r[f])) return;
      xs.push(getX(r)); ys.push(r[f]);
    });
    return { r: corr(xs, ys), n: xs.length };
  };
  L.push("## 6. 集計3: 部品の点数・合計スコアと、すでに上がった度合いの相関（10:00の点数）");
  L.push("");
  L.push("| 部品 | " + RISE.map(function (x) { return x.label + "との相関"; }).join(" | ") + " |");
  L.push("| --- |" + RISE.map(function () { return " ---: |"; }).join(""));
  partInfo.forEach(function (p) {
    if (p.alwaysZero) { L.push("| " + p.label + " |" + RISE.map(function () { return " 常に0 |"; }).join("")); return; }
    var g = function (r) { return r.parts[p.label]; };
    L.push("| " + p.label + " |" + RISE.map(function (x) { return " " + num3(corrWith(g, x.key).r) + " |"; }).join(""));
  });
  var gs = function (r) { return r.score; };
  var scoreCorr = RISE.map(function (x) { return corrWith(gs, x.key); });
  L.push("| **合計スコア** |" + scoreCorr.map(function (c) { return " " + num3(c.r) + " |"; }).join(""));
  L.push("");
  L.push("- ピアソンの相関係数。計算に使った件数: " + RISE.map(function (x, i) { return x.label + " " + scoreCorr[i].n + "件"; }).join("、") + "（騰落率を計算できなかった銘柄日を除く）");
  L.push("");

  L.push("## 7. 集計4: 部品同士の相関（10:00の点数）");
  L.push("");
  L.push("常に0点の部品を除いた " + activeParts.length + "部品。ピアソンの相関係数（" + N + "件）。列の番号は行の番号と同じ部品。");
  L.push("");
  var head = "| 部品 |";
  var sep = "| --- |";
  activeParts.forEach(function (p, i) { head += " " + (i + 1) + " |"; sep += " ---: |"; });
  L.push(head);
  L.push(sep);
  var cm = activeParts.map(function (p) {
    return activeParts.map(function (q) {
      return corr(recs.map(function (r) { return r.parts[p.label]; }), recs.map(function (r) { return r.parts[q.label]; }));
    });
  });
  activeParts.forEach(function (p, i) {
    var row = "| " + (i + 1) + ". " + p.label + " |";
    activeParts.forEach(function (q, j) { row += " " + (i === j ? "1" : num2(cm[i][j])) + " |"; });
    L.push(row);
  });
  L.push("");
  L.push("### 相関係数の絶対値が0.5以上の組");
  L.push("");
  var strong = [];
  for (var ii = 0; ii < activeParts.length; ii++) {
    for (var jj = ii + 1; jj < activeParts.length; jj++) {
      if (Math.abs(cm[ii][jj]) >= 0.5) strong.push({ a: activeParts[ii].label, b: activeParts[jj].label, r: cm[ii][jj] });
    }
  }
  strong.sort(function (x, y) { return Math.abs(y.r) - Math.abs(x.r); });
  if (!strong.length) {
    L.push("該当なし");
  } else {
    L.push("| 部品 | 部品 | 相関係数 |");
    L.push("| --- | --- | ---: |");
    strong.forEach(function (x) { L.push("| " + x.a + " | " + x.b + " | " + num3(x.r) + " |"); });
  }
  L.push("");

  // 8章 集計5（8:50との差）
  L.push("## 8. 集計5: 8:50との差");
  L.push("");
  L.push("対象は4〜7章と同じ " + N + "件。同じ銘柄日の8:50の点数と10:00の点数を比べ、値が違った件数を数えた。印（★）は、8:50では " + N + "件すべてで0点で、10:00では0以外の点が入った件がある部品。");
  L.push("");
  L.push("| 部品 | 印 | 点数が変わった件数 | 割合 | 8:50に0以外だった件数 | 10:00に0以外だった件数 |");
  L.push("| --- | --- | ---: | ---: | ---: | ---: |");
  var nonZero = function (get) { return recs.filter(function (r) { return get(r) !== 0; }).length; };
  partInfo.forEach(function (p) {
    var changed = recs.filter(function (r) { return r.parts[p.label] !== r.parts0850[p.label]; }).length;
    var mark = p.alwaysZero0850 && !p.alwaysZero ? "★" : "";
    L.push("| " + p.label + " | " + mark + " | " + changed + " | " + pct1(N ? changed / N : NaN) + " | " +
      nonZero(function (r) { return r.parts0850[p.label]; }) + " | " + nonZero(function (r) { return r.parts[p.label]; }) + " |");
  });
  var changedScore = recs.filter(function (r) { return r.score !== r.s0850; }).length;
  L.push("| **合計スコア** | | " + changedScore + " | " + pct1(N ? changedScore / N : NaN) + " | | |");
  L.push("");
  L.push("- ★の部品: " + (partInfo.filter(function (p) { return p.alwaysZero0850 && !p.alwaysZero; }).map(function (p) { return p.label; }).join("、") || "なし"));
  L.push("- 8:50の点数は `scripts/score-parts-check.mjs` と同じ計算（時計 8:50、T当日より前の直近30取引日の15分足、前日終値は15分足の最終日の1つ前の取引日の日足終値）");
  L.push("");

  // 9章 PR #89 との突き合わせ
  L.push("## 9. PR #89 との突き合わせ");
  L.push("");
  L.push("写した処理が PR #89 と同じ動きかを確かめるため、PR #89 の3章（10:00評価のグループ別成績）と4章（日ごとの差）と同じ集計をして、`docs/score-top10-1000-result.md` の同じ表の同じ行と突き合わせた。");
  L.push("");
  L.push("- 10:00上位10の平均損益（按分）: " + (mainTopOk ? "**一致**" : "**不一致**"));
  L.push("- 全体: " + (reproMissing.length === 0
    ? "**一致**（" + reproChecks.length + "行すべてが PR #89 のレポートの対応する行と同じ）"
    : "**不一致**（" + reproMissing.length + "行 / " + reproChecks.length + "行が PR #89 のレポートの対応する行と違う）"));
  L.push("");
  L.push("| 同じ足で両方に届いた場合 | グループ | 今回（件数・平均損益率・勝率・利確・損切り・大引け） | PR #89 のレポート |");
  L.push("| --- | --- | --- | --- |");
  var cellsOf = function (row) { return row ? row.split("|").map(function (c) { return c.trim(); }).filter(Boolean) : null; };
  reproGroupRows.forEach(function (x) {
    var pr = pr89GroupRow(x.label, x.modeIdx);
    var prCells = cellsOf(pr);
    L.push("| " + MODES[x.modeIdx].label + " | " + x.label + " | " + cellsOf(x.row).slice(1).join(" / ") + " | " + (prCells ? prCells.slice(1).join(" / ") : "見つからない") + (pr === x.row ? "（一致）" : "") + " |");
  });
  L.push("");
  L.push("| 比べた2群 | 同じ足で両方に届いた場合 | 今回（日数・日ごとの差の平均・標準偏差・t値） | PR #89 のレポート |");
  L.push("| --- | --- | --- | --- |");
  [["### 4-1.", "10:00上位10 − 10:00の11位以下", reproDiffRows], ["### 4-2.", "10:00上位10 − 8:50上位10", reproEarlyRows]].forEach(function (g) {
    g[2].forEach(function (row, i) {
      var pr = pr89DiffRow(g[0], MODES[i].label);
      var prCells = cellsOf(pr);
      L.push("| " + g[1] + " | " + MODES[i].label + " | " + cellsOf(row).slice(1).join(" / ") + " | " + (prCells ? prCells.slice(1).join(" / ") : "見つからない") + (pr === row ? "（一致）" : "") + " |");
    });
  });
  L.push("");

  var outPath = fileURLToPath(new URL("../docs/score-parts-1000-result.md", import.meta.url));
  writeFileSync(outPath, L.join("\n") + "\n");
  console.log(L.join("\n"));
  console.log("\n→ " + outPath);
  if (reproMissing.length) console.log("PR #89 と一致しない行:\n" + reproMissing.map(function (x) { return x.ours + "\n  PR #89: " + x.theirs; }).join("\n"));
};

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
