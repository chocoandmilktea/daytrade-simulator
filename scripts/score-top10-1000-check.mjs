// scripts/score-top10-1000-check.mjs
// scripts/score-top10-check.mjs（PR #88）は寄り前（8:50）のスコアで上位10を選び寄り付きで買う検証だった。
// こちらは同じ8:50時点の候補のまま、場中の10:00（日本時間）時点の15分足でアプリのスコア
// （src/lib/analyze.js の analyzeStock）を付け直し、上位10銘柄を10:00の株価で買った場合に、
// 候補全体より成績が良いかを検証する。
// 売り方は PR #88 と同じく「+1.5%で利益確定、-0.75%で損切り、どちらにも届かなければ大引けで売る」。
// 買値は評価時刻に始まる15分足の始値（10:00評価なら10:00開始の足の始値）。
// 参考として 9:30・10:30 評価と、15分足の遅れを考慮した10:00評価（9:30開始の足までで切る）も計算する。
//
// scripts/score-top10-check.mjs は処理がすべて main() の中にあり、読み込むと検証全体が走って
// docs/score-top10-result.md を書き換えるため import できない。候補の再現・取得・api/stock.js の
// 日付付けの照合・手数料・売り方の判定は同ファイルからのコピー（元のファイルは変更しない）。
// 同じ動きであることは、8:50の結果（寄り付きで買う版）を計算し直して PR #88 のレポートと
// 突き合わせることで確かめる（出力の8章）。
// スコア計算は src/lib/analyze.js と api/_scan.js をそのまま import して使い、中身は複製しない。
// アプリ本体とは無関係の単発検証スクリプト。新しい npm パッケージは使わず、
// 既存の依存関係に含まれる xlsx（SheetJS）・@upstash/redis（api/_scan.js の読み込みに必要）と
// Node 標準の fetch のみを使う。
//
// 実行: node scripts/score-top10-1000-check.mjs
// 出力: docs/score-top10-1000-result.md
//
// 任意: 環境変数 SCORE_TOP10_CHECK_CACHE にディレクトリを指定すると、Yahoo の取得結果を
//       そこに JSON で保存し、次回以降はそれを読む。保存形式は scripts/score-top10-check.mjs と
//       同じなので、同じディレクトリを指定すれば PR #88 の取得結果をそのまま使える。
//       取得結果はリポジトリの外に置くこと（commit しない）

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { analyzeStock, currentSessionDate } from "../src/lib/analyze.js";

// api/daily.js と同じ URL 形式・同じ User-Agent
var YAHOO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};
var RANGE = "6mo";
var WAIT_MS = 300; // 1件ごとの待ち時間
var RETRY_WAITS = [5000, 10000, 20000, 40000, 80000]; // 429 のときの待ち時間（再試行ごとに延ばす）
var ERROR_RETRY_WAITS = [3000, 6000]; // 429 以外の一時的な失敗（通信エラー・5xx）の再試行

// 15分足: 検証期間は range=60d で得られる全期間
var INTRADAY_INTERVAL = "15m";
var INTRADAY_RANGE = "60d";
// スコア計算に渡す15分足の長さ。api/stock.js と同じ range=30d（PR #88 の実測では直近30取引日分）に合わせる。
// 寄り前（8:50）は T当日より前の直近30取引日、場中は T当日を含む直近30取引日（前の29取引日＋T当日の途中まで）に切る
var APP_WINDOW_DAYS = 30;
// analyze.js で最も長い参照期間（520本）を満たすため、スコア計算に渡す15分足が600本以上ある場合だけ計算する
var MIN_BARS = 600;
// 検証する日を決めるための基準銘柄（PR #88 と同じ条件で検証日を選ぶ）
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

// 日本の取引日の判定: 終値がある銘柄数が、最も多い日の半分以上ある日だけを取引日とする
var JP_DAY_MIN_RATIO = 0.5;

var TOP_N = 10;
var TAKE_PROFIT = 0.015; // 利確ライン: 買値 × 1.015
var STOP_LOSS = -0.0075; // 損切りライン: 買値 × 0.9925
var FEE = 0.001; // 往復手数料（PR #87・#88 と同じ）
var SL_FIRST_PROB = 2 / 3; // 按分版で「同じ足で両方に届いた場合に損切りが先」とみなす確率

// 場中の評価の種類。clock: 時計を合わせる時刻 / cut: この時刻より前に始まった15分足までをスコアに使う /
// buy: この時刻に始まる15分足の始値で買う（HH:MM、日本時間）
var MAIN_KEY = "t1000";
var VARIANTS = [
  { key: "t0930", label: "参考: 9:30評価（9:15開始の足まで）", clock: "09:30", cut: "09:30", buy: "09:30" },
  { key: "t1000", label: "本命: 10:00評価（9:45開始の足まで）", clock: "10:00", cut: "10:00", buy: "10:00" },
  { key: "t1030", label: "参考: 10:30評価（10:15開始の足まで）", clock: "10:30", cut: "10:30", buy: "10:30" },
  { key: "lag1000", label: "遅れを考慮: 10:00評価（9:30開始の足まで）", clock: "10:00", cut: "09:45", buy: "10:00" },
];
var BUY_TIMES = ["09:30", "10:00", "10:30"];

var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
var isNum = function (v) { return typeof v === "number" && isFinite(v); };

// ---------- api/stock.js と同じ加工 ----------

// api/stock.js の toLocalDates と同一の実装（export されていないため写している）。
// 写し間違いが無いことは、実行時に api/stock.js の該当部分と文字列で突き合わせて確認する（checkToLocalDatesCopy）
function toLocalDates(timestamps, gmtoffset) {
  const off = (typeof gmtoffset === "number" ? gmtoffset : 0) * 1000;
  return (timestamps || []).map(function (t) {
    return t == null ? null : new Date(t * 1000 + off).toISOString().slice(0, 10);
  });
}

// api/stock.js の toLocalDates を読み出し、上の写しと一字一句同じかを確かめる
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

// ---------- 時計の差し替え ----------

// analyze.js は Date.now() と new Date()（引数なし）で現在時刻を見ている。
// fn を実行している間だけ、この2つが ms（Unix ミリ秒）を返すようにする。引数付きの new Date(...) は元のまま
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

// ---------- 取得 ----------

// 銘柄一覧: JPX のページから xlsx のリンクを探してダウンロードし、SheetJS で読む
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
    // 日足の timestamp はその取引日を指す UTC 時刻なので、api/daily.js と同じくそのまま日付を取り出す
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

// 15分足は api/stock.js に渡る前の生の形（null を含む配列と timestamp・gmtoffset）のまま残す
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

// Yahoo の chart API を1回分取得する。戻り値: { data } または { error }
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

// キャッシュがあれば読み、無ければ取得して保存する。429 による失敗はキャッシュしない（再実行時に取り直すため）
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

// 日ごとの差の配列から、平均・不偏標準偏差・t値（平均 ÷（標準偏差 ÷ √日数））を出す
var tStat = function (d) {
  var mm = d.length ? mean(d) : NaN, ss = sd(d);
  return { n: d.length, avg: mm, sd: ss, t: mm / (ss / Math.sqrt(d.length)) };
};

var pct3 = function (v) { return isNum(v) ? (v * 100).toFixed(3) + "%" : "-"; };
var pct1 = function (v) { return isNum(v) ? (v * 100).toFixed(1) + "%" : "-"; };
var num2 = function (v) { return isNum(v) ? v.toFixed(2) : "-"; };

// ---------- 候補の作り方（PR #88 と同じ） ----------

// アプリ（api/ranking.js / api/sector.js）と同じく、昇順に並べた出来高の floor(n/2) 番目を中央値とする
var appMedian = function (vols) {
  var s = vols.slice().sort(function (a, b) { return a - b; });
  return s[Math.floor(s.length / 2)] || 0;
};

// pop: [{ idx, prevVol, prevRet }]（前日の値だけを持つ）。volTop 件＋値上がり率上位 CHANGE_TOP 件を重複なしで返す。
// all の並び順は api/ranking.js の mergeHybrid と同じ（出来高上位の順 → 値上がり率上位のうち未収載の順）
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

// ---------- 売り方の判定（PR #88 と同じ。買値だけ引数で受け取る形にした） ----------

// buy: 買値、dayClose: T当日の日足の終値、bars: 買った足から後の15分足（時刻順）
// 戻り値: { kind: "tp" 利確 / "sl" 損切り / "both" 同じ足で両方に到達 / "close" どちらにも届かず大引け, closeRet }
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

// 同じ足で両方に届いた場合の3通りの扱い
var MODES = [
  { key: "tpFirst", label: "利確が先" },
  { key: "slFirst", label: "損切りが先" },
  { key: "prorata", label: "按分（損切りが先の確率2/3）" },
];
var PRORATA = MODES[2];

// 判定結果を、扱いごとの「手数料込みの損益率・勝ちの重み・利確／損切り／大引けの重み」に直す
var outcome = function (ex, mode) {
  var tpNet = TAKE_PROFIT - FEE, slNet = STOP_LOSS - FEE;
  if (ex.kind === "tp") return { ret: tpNet, win: 1, tp: 1, sl: 0, cl: 0 };
  if (ex.kind === "sl") return { ret: slNet, win: 0, tp: 0, sl: 1, cl: 0 };
  if (ex.kind === "close") {
    var r = ex.closeRet - FEE;
    return { ret: r, win: r > 0 ? 1 : 0, tp: 0, sl: 0, cl: 1 };
  }
  // 同じ足で両方に到達
  if (mode === "tpFirst") return { ret: tpNet, win: 1, tp: 1, sl: 0, cl: 0 };
  if (mode === "slFirst") return { ret: slNet, win: 0, tp: 0, sl: 1, cl: 0 };
  var pTp = 1 - SL_FIRST_PROB;
  return { ret: pTp * tpNet + SL_FIRST_PROB * slNet, win: pTp, tp: pTp, sl: SL_FIRST_PROB, cl: 0 };
};

// ---------- 本体 ----------

var main = async function () {
  var cacheDir = process.env.SCORE_TOP10_CHECK_CACHE || null;
  if (cacheDir) mkdirSync(cacheDir, { recursive: true });

  // 実装前確認: api/stock.js の日付の付け方の写しが同一か
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

  // ---------- 取引日 ----------

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

  // TOPIX前日比（%）: T当日の前日の値（= 前日の終値 ÷ 前々日の終値 − 1）。8:50・場中とも同じ値を使う。
  // 代用の 1306.T は分配金の権利落ちで下がるため、調整後終値があればそちらを使う
  var topixChangeFor = function (t) {
    var p1 = topixBars[t - 1], p2 = topixBars[t - 2];
    if (!p1 || !p2) return null;
    var c1 = isNum(p1.adj) ? p1.adj : p1.close, c2 = isNum(p2.adj) ? p2.adj : p2.close;
    if (!isNum(c1) || !isNum(c2) || c2 <= 0) return null;
    return (c1 / c2 - 1) * 100;
  };

  // ---------- 検証する日（PR #88 と同じ選び方） ----------

  var refGot = (await fetchIntraday(REF_TICKER, cacheDir)).res;
  if (refGot.error) throw new Error(REF_TICKER + " の15分足: " + refGot.error);
  await sleep(WAIT_MS);

  // 15分足（生の形）を、api/stock.js と同じ日付の付け方で日付ごとに引けるようにする
  var indexIntraday = function (raw) {
    var dates = toLocalDates(raw.ts, raw.gmtoffset != null ? raw.gmtoffset : 32400);
    var dayList = [], dayStart = {};
    dates.forEach(function (d, i) {
      if (!(d in dayStart)) { dayStart[d] = i; dayList.push(d); }
    });
    return { raw: raw, dates: dates, dayList: dayList, dayStart: dayStart };
  };
  // T当日より前の直近 APP_WINDOW_DAYS 取引日分の足の範囲 [from, to)（PR #88 と同じ）
  var windowBefore = function (ix, date) {
    var prevDays = ix.dayList.filter(function (d) { return d < date; });
    if (!prevDays.length) return null;
    var first = prevDays[Math.max(0, prevDays.length - APP_WINDOW_DAYS)];
    var nextDay = ix.dayList.filter(function (d) { return d >= date; })[0];
    return { from: ix.dayStart[first], to: nextDay != null ? ix.dayStart[nextDay] : ix.raw.ts.length, lastDay: prevDays[prevDays.length - 1] };
  };
  // 場中: T当日より前の直近 APP_WINDOW_DAYS − 1 取引日分と、T当日のうち cutSec より前に始まった足の範囲 [from, to)。
  // todayBars は T当日から含めた足の本数
  var windowIntraday = function (ix, date, cutSec) {
    var prevDays = ix.dayList.filter(function (d) { return d < date; });
    if (!prevDays.length) return null;
    var first = prevDays[Math.max(0, prevDays.length - (APP_WINDOW_DAYS - 1))];
    var from = ix.dayStart[first];
    var to = ix.dayStart[date] != null ? ix.dayStart[date] : null;
    if (to == null) {
      var nextDay = ix.dayList.filter(function (d) { return d > date; })[0];
      to = nextDay != null ? ix.dayStart[nextDay] : ix.raw.ts.length;
      return { from: from, to: to, lastPrevDay: prevDays[prevDays.length - 1], todayBars: 0 };
    }
    var ds = to;
    while (to < ix.dates.length && ix.dates[to] === date && ix.raw.ts[to] < cutSec) to++;
    return { from: from, to: to, lastPrevDay: prevDays[prevDays.length - 1], todayBars: to - ds };
  };

  var refIx = indexIntraday(refGot.data);
  var periodStart = refIx.dayList[0], periodEnd = refIx.dayList[refIx.dayList.length - 1];
  var periodDays = jpDays.filter(function (d) { return d >= periodStart && d <= periodEnd; });
  var testDays = []; // { t, date }
  periodDays.forEach(function (d) {
    var t = jpDayIndex.get(d);
    if (t < 2) return;
    var w = windowBefore(refIx, d);
    if (!w || w.to - w.from < MIN_BARS) return;
    testDays.push({ t: t, date: d });
  });
  console.log("15分足の期間: " + periodStart + " 〜 " + periodEnd + "（日本取引日 " + periodDays.length + "日）/ 検証日 " + testDays.length + "日");

  // ---------- 日ごとの候補（8:50時点。PR #88 と同じ） ----------

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

  // api/stock.js の fetchJPPayload が返す形に組み立てる（配列は加工せずそのまま、日付は toLocalDates）。
  // 現在値（meta.regularMarketPrice）は渡さない＝0。api/_scan.js の toPriceData はこのとき
  // 最後の15分足の終値（空の足は直前の値で埋めた後）を現在値にする。
  // 場中は最後の足＝評価時刻の直前に終わった足（10:00評価なら9:45開始の足）になる
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

  // T当日の15分足のうち、startSec 以降に始まる足（時刻順）。15:30 の足は PR #88 と同じく使わない。
  // 終値の無い足は PR #88 と同じく飛ばし、高値・安値が欠けていれば始値・終値で代用する
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

  var skip = { noIntraday: 0, noPrevBars: 0, fewBars: 0, noOfficialPrev: 0, noDaily: 0, noDayBars: 0 };
  var skipV = {};
  VARIANTS.forEach(function (v) { skipV[v.key] = { fewBars: 0, noToday: 0, notStarted: 0, clockMismatch: 0, scored: 0 }; });
  var skipBuy = {};
  BUY_TIMES.forEach(function (hm) { skipBuy[hm] = { noBar: 0, noAfter: 0 }; });
  var clockMismatch0850 = 0, started0850 = 0, scored0850 = 0;
  var topixByDay = [];

  testDays.forEach(function (td) {
    var t = td.t, date = td.date;
    var topixChange = topixChangeFor(t);
    topixByDay.push(topixChange);
    var clock0850 = jstAt(date, "08:50");
    if (withClock(clock0850, function () { return currentSessionDate("JP"); }) !== date) clockMismatch0850++;
    VARIANTS.forEach(function (v) {
      if (withClock(jstAt(date, v.clock), function () { return currentSessionDate("JP"); }) !== date) skipV[v.key].clockMismatch++;
    });
    td.records = [];

    td.cands.forEach(function (si2, order) {
      var st = stocks[si2];
      var rec = { day: date, ticker: st.ticker, order: order, fromChange: td.byChange.has(si2), s0850: null, s: {}, exitOpen: null, exit: {} };
      var ix = intraday[si2];
      if (!ix) { skip.noIntraday++; td.records.push(rec); return; }
      var w = windowBefore(ix, date);
      // 前日（T当日の1つ前の取引日）の15分足が無い銘柄は計算しない（PR #88 と同じ）
      if (!w || w.lastDay !== jpDays[t - 1]) { skip.noPrevBars++; td.records.push(rec); return; }
      if (w.to - w.from < MIN_BARS) { skip.fewBars++; td.records.push(rec); return; }
      var stock = scan.normalizeStock(st.ticker);
      var score = function (payload, clockMs) {
        var pd = scan.toPriceData(payload);
        return withClock(clockMs, function () { return analyzeStock(stock, pd, null, {}); });
      };

      // 8:50: PR #88 と同じ計算。公式の前日終値は15分足の最終日（前日）の1つ前の取引日の日足終値
      var pPrev2 = bars[si2][t - 2];
      var prev0850 = pPrev2 && isNum(pPrev2.close) ? pPrev2.close : null;
      if (prev0850 == null) skip.noOfficialPrev++;
      var a0 = score(buildPayload(ix, w.from, w.to, prev0850, topixChange), clock0850);
      if (a0.sessionStarted) started0850++;
      scored0850++;
      rec.s0850 = a0.save.score;

      // 場中: 同じ規則（15分足の最終日の1つ前の取引日の終値）を当てはめると、最終日がT当日なので前日の日足終値になる
      var pPrev1 = bars[si2][t - 1];
      var prevIntra = pPrev1 && isNum(pPrev1.close) ? pPrev1.close : null;
      VARIANTS.forEach(function (v) {
        var wi = windowIntraday(ix, date, jstAt(date, v.cut) / 1000);
        var sv = skipV[v.key];
        if (!wi || wi.todayBars === 0) { sv.noToday++; return; }
        if (wi.to - wi.from < MIN_BARS) { sv.fewBars++; return; }
        var a = score(buildPayload(ix, wi.from, wi.to, prevIntra, topixChange), jstAt(date, v.clock));
        if (!a.sessionStarted) sv.notStarted++;
        sv.scored++;
        rec.s[v.key] = a.save.score;
      });

      // 売買: PR #88 と同じ除外条件（T当日の日足の始値・高値・安値・終値のいずれかが欠けている、または出来高が0）
      var b = bars[si2][t];
      if (!b || !isNum(b.open) || !isNum(b.high) || !isNum(b.low) || !isNum(b.close) || b.open <= 0 ||
          !isNum(b.volume) || b.volume === 0) {
        skip.noDaily++;
        td.records.push(rec);
        return;
      }
      // 寄り付きで買う版（PR #88 の再現確認用）
      var dayBars = barsFrom(ix, date, 0);
      if (!dayBars.length) skip.noDayBars++;
      else rec.exitOpen = judgeExit(b.open, b.close, dayBars);
      // 評価時刻に始まる15分足の始値で買う版
      BUY_TIMES.forEach(function (hm) {
        var buy = openAt(ix, date, hm);
        if (buy == null) { skipBuy[hm].noBar++; return; }
        var after = barsFrom(ix, date, jstAt(date, hm) / 1000);
        if (!after.length) { skipBuy[hm].noAfter++; return; }
        rec.exit[hm] = judgeExit(buy, b.close, after);
      });
      td.records.push(rec);
    });
  });
  console.log("スコア計算 8:50 " + scored0850 + "件（寄り付き後扱い " + started0850 + "、時計のずれ " + clockMismatch0850 + "日）");
  VARIANTS.forEach(function (v) {
    var sv = skipV[v.key];
    console.log("スコア計算 " + v.key + " " + sv.scored + "件（寄り付き前扱い " + sv.notStarted + "、時計のずれ " + sv.clockMismatch + "日）");
  });

  // ---------- 順位付け ----------

  // その日の候補をスコア順に並べる。同点はアプリの🏆スコア順（安定ソート）と同じく候補リストの並び順を保つ。
  // 上位10は並べた先頭10銘柄（10位と同点の11位以下は11位以下に入れる）。PR #88 と同じ
  var scoreOf = function (key) {
    return key === "s0850" ? function (r) { return r.s0850; } : function (r) { return r.s[key]; };
  };
  var rankDay = function (td, get) {
    var list = td.records.filter(function (r) { return isNum(get(r)); })
      .sort(function (a, b) { return get(b) - get(a) || a.order - b.order; });
    var top = new Set(list.slice(0, TOP_N));
    var tenth = list.length >= TOP_N ? get(list[TOP_N - 1]) : null;
    var tie = { same: 0, below: 0 };
    if (tenth != null) {
      list.forEach(function (r, i) {
        if (get(r) === tenth) { tie.same++; if (i >= TOP_N) tie.below++; }
      });
    }
    return { list: list, top: top, tenth: tenth, tie: tie };
  };

  // exitOf(r): その銘柄日の判定結果（売買できなかった銘柄日は null）
  var agg = function (recs, exitOf, mode) {
    var tr = recs.filter(function (r) { return exitOf(r); });
    if (!tr.length) return { n: 0 };
    var o = tr.map(function (r) { return outcome(exitOf(r), mode); });
    var sum = function (f) { return o.reduce(function (s, x) { return s + x[f]; }, 0); };
    return {
      n: tr.length,
      avg: sum("ret") / tr.length,
      win: sum("win") / tr.length,
      tp: sum("tp") / tr.length,
      sl: sum("sl") / tr.length,
      cl: sum("cl") / tr.length,
      both: tr.filter(function (r) { return exitOf(r).kind === "both"; }).length / tr.length,
    };
  };

  // key: 並べるスコア、exitOf: 売買の判定。上位10・11位以下・候補全体と、日ごとの「上位10 − 11位以下」を返す
  var analyzeKey = function (key, exitOf) {
    var get = scoreOf(key);
    var groups = { top: [], rest: [], all: [], topChange: [] };
    var dayDiffs = {};
    MODES.forEach(function (m) { dayDiffs[m.key] = []; });
    var ties = [];
    var tops = []; // 日ごとの上位10（testDays と同じ並び）
    testDays.forEach(function (td) {
      var rk = rankDay(td, get);
      tops.push(rk.top);
      if (rk.tenth != null) ties.push(rk.tie);
      var topRecs = [], restRecs = [];
      rk.list.forEach(function (r) {
        var inTop = rk.top.has(r);
        (inTop ? topRecs : restRecs).push(r);
        groups.all.push(r);
        (inTop ? groups.top : groups.rest).push(r);
        if (r.fromChange && inTop) groups.topChange.push(r);
      });
      MODES.forEach(function (m) {
        var at = agg(topRecs, exitOf, m.key), ar = agg(restRecs, exitOf, m.key);
        if (at.n && ar.n) dayDiffs[m.key].push(at.avg - ar.avg);
      });
    });
    var diff = {};
    MODES.forEach(function (m) { diff[m.key] = tStat(dayDiffs[m.key]); });
    return { groups: groups, diff: diff, ties: ties, tops: tops, get: get };
  };

  var exitAt = function (hm) { return function (r) { return r.exit[hm] || null; }; };
  var exitOpen = function (r) { return r.exitOpen; };

  // 本命: 10:00のスコアで並べ、10:00開始の足の始値で買う
  var main0 = analyzeKey(MAIN_KEY, exitAt("10:00"));
  // 8:50のスコアで並べ、10:00開始の足の始値で買う
  var early = analyzeKey("s0850", exitAt("10:00"));
  // PR #88 の再現確認: 8:50のスコアで並べ、寄り付きで買う
  var repro = analyzeKey("s0850", exitOpen);
  // 参考の評価時刻と遅れを考慮した版
  var refRes = VARIANTS.map(function (v) {
    return { v: v, res: analyzeKey(v.key, exitAt(v.buy)) };
  });

  // 日ごとの「10:00上位10 − 8:50上位10」（どちらも10:00開始の足の始値で買う）
  var vsEarly = {};
  MODES.forEach(function (m) {
    var d = [];
    testDays.forEach(function (td, i) {
      var a = agg(Array.from(main0.tops[i]), exitAt("10:00"), m.key);
      var b = agg(Array.from(early.tops[i]), exitAt("10:00"), m.key);
      if (a.n && b.n) d.push(a.avg - b.avg);
    });
    vsEarly[m.key] = tStat(d);
  });

  // 10:00上位10と8:50上位10の重なり
  var overlapSum = 0, topSizeSum = 0, overlapDays = 0;
  var overlapDist = {};
  testDays.forEach(function (td, i) {
    var a = main0.tops[i], b = early.tops[i];
    if (!a.size || !b.size) return;
    var n = 0;
    a.forEach(function (r) { if (b.has(r)) n++; });
    overlapSum += n;
    topSizeSum += a.size;
    overlapDays++;
    overlapDist[n] = (overlapDist[n] || 0) + 1;
  });

  // ---------- 出力 ----------

  var L = [];
  var groupTable = function (rows) {
    MODES.forEach(function (m) {
      L.push("**同じ15分足で両方に届いた場合: " + m.label + "**");
      L.push("");
      L.push("| グループ | 件数 | 手数料込みの平均損益率 | 勝率 | 利確 | 損切り | 大引け手仕舞い |");
      L.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
      rows.forEach(function (g) {
        var a = agg(g[1], g[2], m.key);
        L.push("| " + g[0] + " | " + a.n + " | " + pct3(a.avg) + " | " + pct1(a.win) + " | " + pct1(a.tp) + " | " + pct1(a.sl) + " | " + pct1(a.cl) + " |");
      });
      L.push("");
    });
  };
  var diffTable = function (diff) {
    L.push("| 同じ足で両方に届いた場合 | 日数 | 日ごとの差の平均 | 差の標準偏差 | t値 |");
    L.push("| --- | ---: | ---: | ---: | ---: |");
    MODES.forEach(function (m) {
      var d = diff[m.key];
      L.push("| " + m.label + " | " + d.n + " | " + pct3(d.avg) + " | " + pct3(d.sd) + " | " + num2(d.t) + " |");
    });
    L.push("");
  };
  var tieLine = function (res) {
    var crossDays = res.ties.filter(function (x) { return x.below > 0; }).length;
    return crossDays + "日 / " + res.ties.length + "日";
  };
  var countReasons = function (list) {
    var o = {};
    list.forEach(function (f) { o[f.error] = (o[f.error] || 0) + 1; });
    return o;
  };

  var ex1000 = exitAt("10:00");
  var allTrades = main0.groups.all.filter(ex1000);
  var bothShare = allTrades.length ? allTrades.filter(function (r) { return ex1000(r).kind === "both"; }).length / allTrades.length : NaN;
  var candTotal = testDays.reduce(function (s, td) { return s + td.cands.length; }, 0);
  var topixVals = topixByDay.filter(isNum);
  var top2B = main0.groups.topChange.length, topAll = main0.groups.top.length;
  var top2B0850 = early.groups.topChange.length, topAll0850 = early.groups.top.length;
  var mainSkip = skipV[MAIN_KEY];

  L.push("# 10:00時点のスコア上位10銘柄を10:00に買う成績 検証結果");
  L.push("");
  L.push("- 生成: `node scripts/score-top10-1000-check.mjs`（実行日 " + new RealDate().toISOString().slice(0, 10) + "）");
  L.push("- 候補: `scripts/score-top10-check.mjs`（PR #88）と同じ8:50時点の候補（前日の確定値で、出来高上位" + NORMAL_VOL_TOP + "と、値上がり率上位" + CHANGE_TOP + "（出来高が全銘柄の中央値の" + VOL_MULT + "倍以上のもの）を重複なしで並べる）。10:00時点で候補を作り直すことはしない");
  L.push("- 銘柄一覧: JPX 東証上場銘柄一覧（" + (jpx.asOf || "日付不明") + " 時点）のうち、プライム・スタンダード・グロースの内国株式 " + jpx.list.length + "銘柄");
  L.push("- 15分足: Yahoo Finance（interval=" + INTRADAY_INTERVAL + "、range=" + INTRADAY_RANGE + "）。期間 " + periodStart + " 〜 " + periodEnd + "（日本取引日 " + periodDays.length + "日）");
  L.push("- **検証日数: " + testDays.length + "日**（" + (testDays.length ? testDays[0].date + " 〜 " + testDays[testDays.length - 1].date : "-") + "）。PR #88 と同じ選び方（" + REF_TICKER + " の15分足が、T当日より前の直近" + APP_WINDOW_DAYS + "取引日で" + MIN_BARS + "本以上ある日）");
  L.push("- 候補の銘柄日数: " + candTotal + "（うち10:00のスコアを計算できた " + main0.groups.all.length + "、そのうち10:00の買いまで判定できた " + allTrades.length + "）");
  L.push("- スコア計算に渡した15分足: 8:50評価は PR #88 と同じく T当日より前の直近" + APP_WINDOW_DAYS + "取引日。場中の評価は T当日を含む直近" + APP_WINDOW_DAYS + "取引日（前の" + (APP_WINDOW_DAYS - 1) + "取引日＋T当日のうち評価時刻より前に始まった足）。10:00評価なら T当日の 9:00〜9:45開始の4本まで");
  L.push("- 現在値: 評価時刻の直前に終わった15分足の終値（10:00評価なら9:45開始の足の終値）。公式の前日終値: PR #88 で実測した規則（15分足の最終日の1つ前の取引日の終値）を当てはめ、場中は T当日の前日の日足終値");
  L.push("- TOPIX前日比: **" + topixSource + "**" + (topixSource === TOPIX_PROXY ? "（TOPIX 連動ETF で代用。Yahoo に TOPIX の日足が無かったため: " + topixTried.slice(0, -1).join(" / ") + "）" : "") +
    " の日足（調整後終値）で、T当日の前日の終値 ÷ 前々日の終値 − 1（PR #88 と同じ。場中も同じ値）。検証日の値の範囲 " + num2(Math.min.apply(null, topixVals)) + "% 〜 " + num2(Math.max.apply(null, topixVals)) + "%");
  L.push("- VIX: なし。過去の的中率統計: 空（自動スキャンと同じ条件）");
  L.push("");
  L.push("売り方: 評価時刻に始まる15分足の始値で買い（10:00評価なら10:00開始の足の始値）、利確ライン 買値 × 1.015・損切りライン 買値 × 0.9925 とする。その足から時刻順に見て、最初に「高値が利確ライン以上」または「安値が損切りライン以下」になった足で決着させる。どちらにも届かなければ T当日の日足の終値で手仕舞う。損益率は往復手数料0.1%（PR #87・#88 と同じ）を引いた値。");
  L.push("");

  L.push("## 1. 実装前確認の結果");
  L.push("");
  L.push("- PR #88 のスクリプト: `scripts/score-top10-check.mjs` はリポジトリにある（PR #88 はマージ済み）。ただし処理がすべて `main()` の中にあり、読み込むと検証全体が走って `docs/score-top10-result.md` を書き換えるため import できない。このため候補の再現・データ取得・`toLocalDates()` の照合・手数料・売り方の判定は新しいスクリプトに写した。同じ動きであることは8章で確かめた");
  L.push("- 時計を10:00に差し替えたときの当日の扱い: analyze.js は「15分足の最終日付が `currentSessionDate()` と一致するか」で当日の足があるか（`sessionStarted`）を決め、一致すれば最終日付の足を当日分として VWAP・VWAP傾き・ATR消化率・ギャップ・当日高安ブレイクに使う。`currentSessionDate(\"JP\")` は `Date.now()` を日本時間にした日付なので、時計を対象日の10:00にすれば対象日を返す。全検証日で対象日を返し（ずれ " + mainSkip.clockMismatch + "日）、10:00評価で計算した " + mainSkip.scored + "件のうち寄り付き前扱い（`sessionStarted` が false）になったのは " + mainSkip.notStarted + "件だった");
  L.push("- analyze.js の複製: 不要だった。`src/lib/analyze.js` の `analyzeStock` と `api/_scan.js` の `toPriceData`・`normalizeStock` を import してそのまま呼んだ。時刻に依存する箇所のうち、`currentSessionDate()` 以外（買いプランの「引けまで残りわずか」の判定、`currentSessionLabel()`、記録時刻の `new Date()`）は点数に効かない");
  L.push("- 15分足の加工: `api/stock.js` の `toLocalDates()` の写しが一字一句同じであることを実行時に確かめた（" + (datesCopyOk ? "一致" : "不一致") + "）");
  L.push("");

  L.push("## 2. アプリの場中の再計算の流れとデータの出どころ（コード・コメントから分かる範囲）");
  L.push("");
  L.push("- 定時自動スキャン（`tachibana-server/scanner.js` → `api/_scan.js`）: 実行時刻は 8:50・9:30・11:00・13:00・15:00 で、10:00 の回は無い。各回の最初のバッチで、組み立て済みマーク（日付＋時刻）が変わっていれば `buildUniverse()` がその時点のランキング（`/api/sector` または `/api/ranking`。立花の出来高・値上がりランキング）で**候補を作り直し**、その後に全銘柄のスコアを計算し直す。8:50の候補を持ち越して付け直す動きではない");
  L.push("- 画面のスキャン（`src/App.js`）: 「再スキャン」メニューのうち「おまかせ」「業種コード一覧から選ぶ」は `buildStockUniverse()` でランキングから**候補を作り直す**。「今の銘柄でリロード」（`reloadCurrentUniverse`）は**候補はそのまま**で最新データでスコアだけ計算し直す。銘柄カードの🔄（`rescanOne`）は1銘柄だけ計算し直す。自動で定期的に再計算する仕組みは無い");
  L.push("- 今回の検証は指示どおり「8:50の候補のまま付け直す」方式で、アプリでは「今の銘柄でリロード」を10:00に押した場合に当たる。自動スキャンとは候補の作り方が違う点に注意");
  L.push("- 15分足と現在値の出どころ: スコア計算に使う15分足（`interval=15m&range=30d`）・現在値（`meta.regularMarketPrice`）・公式の前日終値はすべて Yahoo Finance（`api/stock.js` の `fetchJPPayload`）。画面のスキャンも自動スキャンも同じ `/api/stock` を通る。立花のリアルタイム現在値（`p_1_DPP`）は板の表示（`TachibanaBoard`）とトレード記録の価格更新（`refreshTradePrices` → `fetchTachibanaPrice`）にしか使われず、スコアには入らない");
  L.push("- 場中のTOPIX前日比は立花（`/topix`、tachibana-server の `webapi.js` が TOPIX 日足履歴の最後の2本の終値で計算、Vercel 側・サーバー側とも1時間キャッシュ）。場中にこの履歴へ当日の足が入るか（当日の値か前日の値か）はコードからは分からない。今回は指示どおり前日の値で計算した");
  L.push("- Yahoo の遅れ: コード上の記述は「約20分遅れ」（`src/App.js` の `fetchTachibanaPrice` の説明コメントと `refreshTradePrices` のコメント）、「公称15〜20分程度の遅延」（`api/intraday.js` のコメント、アプリ内ヘルプの1分足の説明）。15分足そのものの遅れを実測した記録は既存のドキュメントに無い。遅れが15〜20分なら、10:00に取得した15分足の最後の完成した足は 9:30開始の足（9:45に終わる足）になる。これを「遅れを考慮した版」として6章に載せた");
  L.push("");

  L.push("## 3. 10:00評価のグループ別成績（10:00開始の足の始値で買う）");
  L.push("");
  groupTable([
    ["10:00のスコアで上位10", main0.groups.top, ex1000],
    ["10:00のスコアで11位以下", main0.groups.rest, ex1000],
    ["候補全体", main0.groups.all, ex1000],
    ["8:50のスコアで上位10（買うのは10:00）", early.groups.top, ex1000],
  ]);
  L.push("- 件数は銘柄日数。勝率は手数料込みの損益率がプラスだった割合（按分では、同じ足で両方に届いた件を 1/3 勝ちとして数える）");
  L.push("- 利確・損切り・大引け手仕舞いは決着の仕方の割合（按分では、同じ足で両方に届いた件を利確 1/3・損切り 2/3 に分ける）");
  L.push("- 同点の扱いは PR #88 と同じ（同点は候補リストの並び順で先に来る方を上位とし、上位10はちょうど10銘柄に切る）。10位と同点の銘柄が11位以下にもいた日: 10:00評価 " + tieLine(main0) + "、8:50評価 " + tieLine(early));
  L.push("");

  L.push("## 4. 日ごとの差");
  L.push("");
  L.push("### 4-1. 10:00上位10 − 10:00の11位以下");
  L.push("");
  diffTable(main0.diff);
  L.push("### 4-2. 10:00上位10 − 8:50上位10（どちらも10:00に買う）");
  L.push("");
  diffTable(vsEarly);
  L.push("- 日ごとに2つのグループの平均損益率の差を出し、その平均と t値（平均 ÷（標準偏差 ÷ √日数））を示した。標準偏差は不偏標準偏差。PR #88 と同じく日単位で比べた");
  L.push("");

  L.push("## 5. 上位10の中身");
  L.push("");
  L.push("- 10:00上位10のうち、前日値上がり上位から候補入りした銘柄（グループ2B）: " + top2B + "件 / " + topAll + "件（" + pct1(topAll ? top2B / topAll : NaN) + "）。参考: 8:50上位10では " + top2B0850 + "件 / " + topAll0850 + "件（" + pct1(topAll0850 ? top2B0850 / topAll0850 : NaN) + "）");
  L.push("- 10:00上位10と8:50上位10で同じ銘柄の割合: " + pct1(topSizeSum ? overlapSum / topSizeSum : NaN) + "（" + overlapDays + "日で延べ " + overlapSum + "銘柄 / " + topSizeSum + "銘柄。1日あたり平均 " + num2(overlapDays ? overlapSum / overlapDays : NaN) + "銘柄）");
  L.push("");
  L.push("| 重なった銘柄数 | 日数 |");
  L.push("| ---: | ---: |");
  Object.keys(overlapDist).map(Number).sort(function (a, b) { return a - b; }).forEach(function (kk) {
    L.push("| " + kk + " | " + overlapDist[kk] + " |");
  });
  L.push("");
  L.push("- 同じ15分足で利確・損切りの両方に届いた件数の割合（10:00に買う候補全体）: " + pct1(bothShare) + "（" + allTrades.length + "件中）");
  L.push("- 件数は上位10に入った銘柄日（売買できなかった銘柄日も含む）");
  L.push("");

  L.push("## 6. 参考: 評価時刻と遅れを考慮した版（按分のみ）");
  L.push("");
  L.push("それぞれの評価時刻で時計を合わせ、その時刻に終わる足までで切ってスコアを付け、その時刻に始まる足の始値で買った場合の「上位10 − 11位以下」。遅れを考慮した版は、時計は10:00・15分足は9:30開始の足（9:45に終わる足）まで・買うのは10:00開始の足の始値。");
  L.push("");
  L.push("| 評価 | 上位10の件数 | 上位10の平均 | 11位以下の件数 | 11位以下の平均 | 日数 | 日ごとの差の平均 | 差の標準偏差 | t値 |");
  L.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  refRes.forEach(function (x) {
    var ex = exitAt(x.v.buy);
    var at = agg(x.res.groups.top, ex, PRORATA.key), ar = agg(x.res.groups.rest, ex, PRORATA.key);
    var d = x.res.diff[PRORATA.key];
    L.push("| " + x.v.label + " | " + at.n + " | " + pct3(at.avg) + " | " + ar.n + " | " + pct3(ar.avg) + " | " + d.n + " | " + pct3(d.avg) + " | " + pct3(d.sd) + " | " + num2(d.t) + " |");
  });
  L.push("");
  L.push("| 評価 | スコアを計算できた銘柄日 | 寄り付き前扱い | T当日の足が評価時刻前に無い | 15分足が" + MIN_BARS + "本未満 |");
  L.push("| --- | ---: | ---: | ---: | ---: |");
  VARIANTS.forEach(function (v) {
    var sv = skipV[v.key];
    L.push("| " + v.label + " | " + sv.scored + " | " + sv.notStarted + " | " + sv.noToday + " | " + sv.fewBars + " |");
  });
  L.push("");

  L.push("## 7. 除外・失敗の件数");
  L.push("");
  L.push("| 項目 | 件数 |");
  L.push("| --- | ---: |");
  L.push("| 日足の取得に失敗した銘柄 | " + failed.length + " |");
  var fr = countReasons(failed);
  Object.keys(fr).sort().forEach(function (k2) { L.push("| └ " + k2 + " | " + fr[k2] + " |"); });
  L.push("| 15分足の取得対象の銘柄 | " + targets.length + " |");
  L.push("| 15分足の取得に失敗した銘柄 | " + intradayFailed.length + " |");
  var ifr = countReasons(intradayFailed);
  Object.keys(ifr).sort().forEach(function (k2) { L.push("| └ " + k2 + " | " + ifr[k2] + " |"); });
  L.push("| スコアを計算しなかった銘柄日: 15分足の取得失敗 | " + skip.noIntraday + " |");
  L.push("| スコアを計算しなかった銘柄日: 前日の15分足が無い | " + skip.noPrevBars + " |");
  L.push("| スコアを計算しなかった銘柄日: 15分足が" + MIN_BARS + "本未満（8:50の範囲で判定） | " + skip.fewBars + " |");
  L.push("| 売買から除いた銘柄日: T当日の日足の欠け・出来高0 | " + skip.noDaily + " |");
  BUY_TIMES.forEach(function (hm) {
    L.push("| 売買から除いた銘柄日（" + hm + "に買う版）: " + hm + "開始の15分足が無い・始値が無い | " + skipBuy[hm].noBar + " |");
    L.push("| 売買から除いた銘柄日（" + hm + "に買う版）: " + hm + "以降の15分足が無い | " + skipBuy[hm].noAfter + " |");
  });
  L.push("| 売買から除いた銘柄日（寄り付きで買う版）: T当日の15分足が無い | " + skip.noDayBars + " |");
  L.push("");
  L.push("- 並び順はスコアを計算できた候補の中で決め、売買から除いた銘柄日も順位には含めている（PR #88 と同じ）");
  L.push("");

  L.push("## 8. PR #88 との一致の確認（8:50のスコアで並べ、寄り付きで買う版）");
  L.push("");
  L.push("写した処理が PR #88 と同じ動きかを確かめるため、PR #88 の本表（2章・3章）と同じ条件で計算し直した。`docs/score-top10-result.md` の数値と突き合わせる。");
  L.push("");
  L.push("- スコア計算 " + scored0850 + "件（寄り付き後扱い " + started0850 + "、時計のずれ " + clockMismatch0850 + "日）。公式の前日終値が無かった銘柄日 " + skip.noOfficialPrev);
  L.push("");
  groupTable([
    ["スコア上位10", repro.groups.top, exitOpen],
    ["11位以下", repro.groups.rest, exitOpen],
    ["候補全体", repro.groups.all, exitOpen],
  ]);
  diffTable(repro.diff);

  var outPath = fileURLToPath(new URL("../docs/score-top10-1000-result.md", import.meta.url));
  writeFileSync(outPath, L.join("\n"));
  console.log(L.join("\n"));
  console.log("\n→ " + outPath);
};

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
