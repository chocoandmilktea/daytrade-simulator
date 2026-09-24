// scripts/score-top10-check.mjs
// 寄り前（8:50）の自動スキャンと同じ条件でアプリのスコア（src/lib/analyze.js の analyzeStock）を計算し、
// 候補銘柄をスコア順に並べたとき、上位10銘柄を寄り付きで買う成績が候補全体より良いかを、
// 直近約60営業日の15分足で検証する。
// 売り方は scripts/hourly-exit-check.mjs（PR #87）と同じく「寄り付きで買い、+1.5%で利益確定、
// -0.75%で損切り、どちらにも届かなければ大引けで売る」。先後の判定は T当日の15分足で行う。
// 銘柄一覧・日足の取得・日本の取引日の判定・候補の作り方（通常版＝グループ2、2B の内訳）は
// scripts/hourly-exit-check.mjs からのコピー（元のファイルは変更しない）。
// スコア計算は src/lib/analyze.js と api/_scan.js をそのまま import して使い、中身は複製しない。
// アプリ本体とは無関係の単発検証スクリプト。新しい npm パッケージは使わず、
// 既存の依存関係に含まれる xlsx（SheetJS）・@upstash/redis（api/_scan.js の読み込みに必要）と
// Node 標準の fetch のみを使う。
//
// 実行: node scripts/score-top10-check.mjs
// 出力: docs/score-top10-result.md
//
// 任意: 環境変数 SCORE_TOP10_CHECK_CACHE にディレクトリを指定すると、Yahoo の取得結果を
//       そこに JSON で保存し、次回以降はそれを読む（再実行時に約3700銘柄を取り直さないため）。
//       日足は <ticker>.json、15分足は <ticker>.15m.json に保存する。
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
// 日足は候補の組み立て（前日・前々日）と売買（T当日の始値・終値）に使うだけなので、15分足の期間を覆えば足りる
var RANGE = "6mo";
var WAIT_MS = 300; // 1件ごとの待ち時間
var RETRY_WAITS = [5000, 10000, 20000, 40000, 80000]; // 429 のときの待ち時間（再試行ごとに延ばす）
var ERROR_RETRY_WAITS = [3000, 6000]; // 429 以外の一時的な失敗（通信エラー・5xx）の再試行

// 15分足: 検証期間は range=60d で得られる全期間
var INTRADAY_INTERVAL = "15m";
var INTRADAY_RANGE = "60d";
// スコア計算に渡す15分足の長さ。api/stock.js と同じ range=30d（実測では直近30取引日分）に合わせ、
// T当日より前の直近30取引日分に切る
var APP_WINDOW_DAYS = 30;
// analyze.js で最も長い参照期間（RECENT_BARS・BB_LOOKBACK_L の520本、1日の本数×20日の440本）を
// 満たすため、スコア計算に渡す15分足が600本以上ある場合だけ計算する
var MIN_BARS = 600;
// 検証する日を決めるための基準銘柄（この銘柄の15分足が T当日より前に600本以上ある日を検証日とする）
var REF_TICKER = "7203.T";

// TOPIX: Yahoo に TOPIX の日足があればそれを使い、無ければ TOPIX 連動ETF（1306.T）で代用する
var TOPIX_TICKERS = ["^TOPX", "998405.T"];
var TOPIX_PROXY = "1306.T";
var VIX_TICKER = "^VIX";

var JPX_PAGE = "https://www.jpx.co.jp/markets/statistics-equities/misc/01.html";
var TARGET_MARKETS = ["プライム（内国株式）", "スタンダード（内国株式）", "グロース（内国株式）"];

// 候補の作り方（api/ranking.js と同じ件数）
var NORMAL_VOL_TOP = 40;
var CHANGE_TOP = 20;
var VOL_MULT = 1.5;

// 日本の取引日の判定: 終値がある銘柄数が、最も多い日の半分以上ある日だけを取引日とする
// （一部の銘柄だけに紛れ込んだ休日の足を取引日として扱わないため）
var JP_DAY_MIN_RATIO = 0.5;

var TOP_N = 10;
var TAKE_PROFIT = 0.015; // 利確ライン: 始値 × 1.015
var STOP_LOSS = -0.0075; // 損切りライン: 始値 × 0.9925
var FEE = 0.001; // 往復手数料（PR #87 と同じ）
var SL_FIRST_PROB = 2 / 3; // 按分版で「同じ足で両方に届いた場合に損切りが先」とみなす確率

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

// 対象日 date（YYYY-MM-DD）の 8:50（日本時間）
var jst0850 = function (date) { return RealDate.parse(date + "T08:50:00+09:00"); };

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

// 15分足は api/stock.js に渡る前の生の形（null を含む配列と timestamp・gmtoffset）のまま残す。
// 空の足の埋め方・日付の付け方は、スコア計算の直前に api/stock.js・api/_scan.js と同じ処理で行う
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

var pct3 = function (v) { return isNum(v) ? (v * 100).toFixed(3) + "%" : "-"; };
var pct1 = function (v) { return isNum(v) ? (v * 100).toFixed(1) + "%" : "-"; };
var num2 = function (v) { return isNum(v) ? v.toFixed(2) : "-"; };

// ---------- 候補の作り方 ----------

// アプリ（api/ranking.js / api/sector.js）と同じく、昇順に並べた出来高の floor(n/2) 番目を中央値とする
var appMedian = function (vols) {
  var s = vols.slice().sort(function (a, b) { return a - b; });
  return s[Math.floor(s.length / 2)] || 0;
};

// pop: [{ idx, prevVol, prevRet }]（前日の値だけを持つ）。volTop 件＋値上がり率上位 CHANGE_TOP 件を重複なしで返す
// 選び方は sector-select-check.mjs の buildCandidates と同じ。グループ2B のために、
// 重複除去前の値上がり率上位（byChange）の内訳もあわせて返す。
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

// ---------- 売り方の判定 ----------

// b: T当日の日足（買値 = 始値、大引け = 終値）、bars: T当日の15分足（時刻順・終値のある足だけ）
// 戻り値: { kind: "tp" 利確 / "sl" 損切り / "both" 同じ足で両方に到達 / "close" どちらにも届かず大引け, closeRet }
var judgeExit = function (b, bars) {
  var tp = b.open * (1 + TAKE_PROFIT), sl = b.open * (1 + STOP_LOSS);
  for (var i = 0; i < bars.length; i++) {
    var hitTp = bars[i].high >= tp, hitSl = bars[i].low <= sl;
    if (hitTp && hitSl) return { kind: "both" };
    if (hitTp) return { kind: "tp" };
    if (hitSl) return { kind: "sl" };
  }
  return { kind: "close", closeRet: b.close / b.open - 1 };
};

// 同じ足で両方に届いた場合の3通りの扱い
var MODES = [
  { key: "tpFirst", label: "利確が先" },
  { key: "slFirst", label: "損切りが先" },
  { key: "prorata", label: "按分（損切りが先の確率2/3）" },
];

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

  // 2. 指数（TOPIX・VIX）
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
  var vixRes = (await fetchDaily(VIX_TICKER, cacheDir)).res;
  if (vixRes.error) throw new Error(VIX_TICKER + ": " + vixRes.error);
  var vixRows = vixRes.data.filter(function (r) { return isNum(r.close); });
  console.log("TOPIX: " + topixSource + " / VIX: " + VIX_TICKER + "（" + vixRows.length + "日）");

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

  // 日本: 終値のある銘柄数が最多日の半分以上ある日
  var jpCount = new Map();
  stocks.forEach(function (st) {
    st.rows.forEach(function (r) { if (isNum(r.close)) jpCount.set(r.date, (jpCount.get(r.date) || 0) + 1); });
  });
  var maxCount = 0;
  jpCount.forEach(function (c) { if (c > maxCount) maxCount = c; });
  var jpDays = Array.from(jpCount.keys()).filter(function (d) { return jpCount.get(d) >= maxCount * JP_DAY_MIN_RATIO; }).sort();
  var jpDayIndex = new Map();
  jpDays.forEach(function (d, j) { jpDayIndex.set(d, j); });

  // 日本株を「取引日の番号 → 足」の配列に並べ直す（取引日でない日付の足は捨てる）
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

  // TOPIX前日比（%）: T当日の前日の値（= 前日の終値 ÷ 前々日の終値 − 1）。
  // 代用の 1306.T は分配金の権利落ちで下がるため、調整後終値があればそちらを使う
  var topixChangeFor = function (t) {
    var p1 = topixBars[t - 1], p2 = topixBars[t - 2];
    if (!p1 || !p2) return null;
    var c1 = isNum(p1.adj) ? p1.adj : p1.close, c2 = isNum(p2.adj) ? p2.adj : p2.close;
    if (!isNum(c1) || !isNum(c2) || c2 <= 0) return null;
    return (c1 / c2 - 1) * 100;
  };
  // VIX: T当日より前の最後の米国営業日の終値
  var vixFor = function (date) {
    var v = null;
    for (var i = 0; i < vixRows.length; i++) {
      if (vixRows[i].date < date) v = vixRows[i];
      else break;
    }
    return v ? { date: v.date, value: v.close } : null;
  };

  // ---------- 検証する日 ----------

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
  // T当日より前の直近 APP_WINDOW_DAYS 取引日分の足の範囲 [from, to)
  var windowBefore = function (ix, date) {
    var prevDays = ix.dayList.filter(function (d) { return d < date; });
    if (!prevDays.length) return null;
    var first = prevDays[Math.max(0, prevDays.length - APP_WINDOW_DAYS)];
    var nextDay = ix.dayList.filter(function (d) { return d >= date; })[0];
    return { from: ix.dayStart[first], to: nextDay != null ? ix.dayStart[nextDay] : ix.raw.ts.length, lastDay: prevDays[prevDays.length - 1] };
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

  // ---------- 日ごとの候補 ----------

  testDays.forEach(function (td) {
    var t = td.t;
    // 母集団: 前日の出来高と、前日・前々日の調整後終値が揃っている銘柄（T当日の値は使わない）
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
  // withClose=true のときは、寄り前の実データにだけ付く「前日15:30の足」（始値・高値・安値・終値＝公式終値、出来高0）を
  // 日足の前日終値で補った版を作る（感度確認用）
  var buildPayload = function (ix, w, officialPrevClose, topixChange, closeBar) {
    var r = ix.raw;
    var sl = function (a) { return a.slice(w.from, w.to); };
    var ts = sl(r.ts), open = sl(r.open), high = sl(r.high), low = sl(r.low), close = sl(r.close), volume = sl(r.volume);
    if (closeBar) {
      ts.push(RealDate.parse(w.lastDay + "T15:30:00+09:00") / 1000);
      open.push(closeBar); high.push(closeBar); low.push(closeBar); close.push(closeBar); volume.push(0);
    }
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

  var skip = { noIntraday: 0, noPrevBars: 0, fewBars: 0, noOfficialPrev: 0, noDaily: 0, noDayBars: 0 };
  var sessionStartedCount = 0, clockMismatch = 0, scored = 0;
  var vixByDay = [];
  var topixByDay = [];

  testDays.forEach(function (td) {
    var t = td.t, date = td.date;
    var topixChange = topixChangeFor(t);
    var vix = vixFor(date);
    topixByDay.push(topixChange);
    vixByDay.push(vix);
    var clockMs = jst0850(date);
    if (withClock(clockMs, function () { return currentSessionDate("JP"); }) !== date) clockMismatch++;
    td.records = [];

    td.cands.forEach(function (si2, order) {
      var st = stocks[si2];
      var rec = { day: date, ticker: st.ticker, order: order, fromChange: td.byChange.has(si2), score: null, scoreVix: null, scoreClose: null };
      var ix = intraday[si2];
      if (!ix) { skip.noIntraday++; td.records.push(rec); return; }
      var w = windowBefore(ix, date);
      // 前日（T当日の1つ前の取引日）の15分足が無い銘柄は、寄り前の実データと形が変わるため計算しない
      if (!w || w.lastDay !== jpDays[t - 1]) { skip.noPrevBars++; td.records.push(rec); return; }
      if (w.to - w.from < MIN_BARS) { skip.fewBars++; td.records.push(rec); return; }
      // 公式の前日終値: 寄り前に Yahoo が返す meta.previousClose と同じく、15分足の最終日（前日）の1つ前の取引日の日足終値
      var pPrev = bars[si2][t - 2];
      var officialPrevClose = pPrev && isNum(pPrev.close) ? pPrev.close : null;
      if (officialPrevClose == null) skip.noOfficialPrev++;
      var stock = scan.normalizeStock(st.ticker);
      var score = function (payload, vixVal) {
        var pd = scan.toPriceData(payload);
        return withClock(clockMs, function () { return analyzeStock(stock, pd, vixVal, {}); });
      };
      var a = score(buildPayload(ix, w, officialPrevClose, topixChange, null), null);
      if (a.sessionStarted) sessionStartedCount++;
      scored++;
      rec.score = a.save.score;
      rec.scoreVix = vix ? score(buildPayload(ix, w, officialPrevClose, topixChange, null), vix.value).save.score : null;
      var p1 = bars[si2][t - 1];
      rec.scoreClose = p1 && isNum(p1.close) ? score(buildPayload(ix, w, officialPrevClose, topixChange, p1.close), null).save.score : null;
      // スコアの上限（下降トレンド35点・デッドクロス30点・両方20点）がかかったか、実際に点数を削ったか
      var hasSig = function (label, val) { return a.signals.some(function (x) { return x.label === label && x.val === val; }); };
      rec.cap35 = hasSig("MACD", "デッドクロス") || hasSig("トレンド", "下降");
      rec.capBound = a.breakdown.some(function (b) { return b.label === "上限抑制(下降/デッドクロス/VWAP)" && b.delta < 0; });

      // 売買: T当日の日足の始値で買い、T当日の15分足で利確・損切りを判定する
      var b = bars[si2][t];
      // PR #86・#87 と同じ除外条件（始値・高値・安値・終値のいずれかが欠けている、または出来高が0）
      if (!b || !isNum(b.open) || !isNum(b.high) || !isNum(b.low) || !isNum(b.close) || b.open <= 0 ||
          !isNum(b.volume) || b.volume === 0) {
        skip.noDaily++;
        td.records.push(rec);
        return;
      }
      var dayBars = [];
      var ds = ix.dayStart[date];
      if (ds != null) {
        for (var i = ds; i < ix.dates.length && ix.dates[i] === date; i++) {
          var r = ix.raw;
          if (r.close[i] == null) continue;
          // 15:30 の足は最新日にだけ付く大引けの足で、過去の日には無いため、日による差が出ないよう使わない
          var hm = new RealDate((r.ts[i] + (r.gmtoffset != null ? r.gmtoffset : 32400)) * 1000).toISOString().slice(11, 16);
          if (hm === "15:30") continue;
          var o = r.open[i] != null ? r.open[i] : r.close[i];
          dayBars.push({
            high: r.high[i] != null ? r.high[i] : Math.max(o, r.close[i]),
            low: r.low[i] != null ? r.low[i] : Math.min(o, r.close[i]),
          });
        }
      }
      if (!dayBars.length) { skip.noDayBars++; td.records.push(rec); return; }
      rec.exit = judgeExit(b, dayBars);
      td.records.push(rec);
    });
  });
  console.log("スコア計算 " + scored + "件（寄り付き後扱いになった件数 " + sessionStartedCount + "、時計のずれ " + clockMismatch + "日）");

  // ---------- 順位付け ----------

  // その日の候補をスコア順に並べる。同点はアプリの🏆スコア順（安定ソート）と同じく候補リストの並び順を保つ。
  // 上位10は並べた先頭10銘柄（10位と同点の11位以下は11位以下に入れる）
  var rankDay = function (td, key) {
    var list = td.records.filter(function (r) { return isNum(r[key]); })
      .sort(function (a, b) { return b[key] - a[key] || a.order - b.order; });
    var top = new Set(list.slice(0, TOP_N));
    var tenth = list.length >= TOP_N ? list[TOP_N - 1][key] : null;
    var tie = { same: 0, below: 0 };
    if (tenth != null) {
      list.forEach(function (r, i) {
        if (r[key] === tenth) { tie.same++; if (i >= TOP_N) tie.below++; }
      });
    }
    return { list: list, top: top, tenth: tenth, tie: tie };
  };

  var agg = function (recs, mode) {
    var tr = recs.filter(function (r) { return r.exit; });
    if (!tr.length) return { n: 0 };
    var o = tr.map(function (r) { return outcome(r.exit, mode); });
    var sum = function (f) { return o.reduce(function (s, x) { return s + x[f]; }, 0); };
    return {
      n: tr.length,
      avg: sum("ret") / tr.length,
      win: sum("win") / tr.length,
      tp: sum("tp") / tr.length,
      sl: sum("sl") / tr.length,
      cl: sum("cl") / tr.length,
      both: tr.filter(function (r) { return r.exit.kind === "both"; }).length / tr.length,
    };
  };

  var analyzeKey = function (key) {
    var groups = {
      top: [], rest: [], all: [], hi: [], mid: [], lo: [], topChange: [], change: [],
    };
    var dayDiffs = {};
    MODES.forEach(function (m) { dayDiffs[m.key] = []; });
    var ties = []; // 日ごとの10位の同点数
    testDays.forEach(function (td) {
      var rk = rankDay(td, key);
      if (rk.tenth != null) ties.push(rk.tie);
      var topRecs = [], restRecs = [];
      rk.list.forEach(function (r) {
        var inTop = rk.top.has(r);
        (inTop ? topRecs : restRecs).push(r);
        groups.all.push(r);
        (inTop ? groups.top : groups.rest).push(r);
        var sc = r[key];
        (sc >= 58 ? groups.hi : sc >= 38 ? groups.mid : groups.lo).push(r);
        if (r.fromChange) {
          groups.change.push(r);
          if (inTop) groups.topChange.push(r);
        }
      });
      MODES.forEach(function (m) {
        var at = agg(topRecs, m.key), ar = agg(restRecs, m.key);
        if (at.n && ar.n) dayDiffs[m.key].push(at.avg - ar.avg);
      });
    });
    var diff = {};
    MODES.forEach(function (m) {
      var d = dayDiffs[m.key];
      var mm = d.length ? mean(d) : NaN, ss = sd(d);
      diff[m.key] = { n: d.length, avg: mm, sd: ss, t: mm / (ss / Math.sqrt(d.length)) };
    });
    return { groups: groups, diff: diff, ties: ties };
  };

  var main0 = analyzeKey("score");
  var withVix = analyzeKey("scoreVix");
  var withClose = analyzeKey("scoreClose");

  // ---------- 出力 ----------

  var GROUP_ROWS = [
    ["top", "スコア上位10"],
    ["rest", "11位以下"],
    ["all", "候補全体"],
    ["hi", "参考: 58点以上"],
    ["mid", "参考: 38〜57点"],
    ["lo", "参考: 37点以下"],
    ["topChange", "参考: 前日値上がり上位から入った候補（2B）のうち上位10"],
    ["change", "参考: 前日値上がり上位から入った候補（2B）全体"],
  ];

  var L = [];
  var groupTable = function (res, rows) {
    MODES.forEach(function (m) {
      L.push("**同じ15分足で両方に届いた場合: " + m.label + "**");
      L.push("");
      L.push("| グループ | 件数 | 手数料込みの平均損益率 | 勝率 | 利確 | 損切り | 大引け手仕舞い |");
      L.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
      rows.forEach(function (g) {
        var a = agg(res.groups[g[0]], m.key);
        L.push("| " + g[1] + " | " + a.n + " | " + pct3(a.avg) + " | " + pct1(a.win) + " | " + pct1(a.tp) + " | " + pct1(a.sl) + " | " + pct1(a.cl) + " |");
      });
      L.push("");
    });
  };
  var diffTable = function (res) {
    L.push("| 同じ足で両方に届いた場合 | 日数 | 日ごとの差の平均 | 差の標準偏差 | t値 |");
    L.push("| --- | ---: | ---: | ---: | ---: |");
    MODES.forEach(function (m) {
      var d = res.diff[m.key];
      L.push("| " + m.label + " | " + d.n + " | " + pct3(d.avg) + " | " + pct3(d.sd) + " | " + num2(d.t) + " |");
    });
    L.push("");
  };
  var scoreDist = function (res, key) {
    var all = res.groups.all;
    var buckets = new Array(11).fill(0);
    all.forEach(function (r) { buckets[Math.min(10, Math.floor(r[key] / 10))]++; });
    L.push("| スコア | 件数 | 割合 |");
    L.push("| --- | ---: | ---: |");
    buckets.forEach(function (c, i) {
      var label = i === 10 ? "100" : (i * 10) + "〜" + (i * 10 + 9);
      L.push("| " + label + " | " + c + " | " + pct1(all.length ? c / all.length : NaN) + " |");
    });
    L.push("");
  };
  var tieTable = function (res) {
    var bySame = {};
    var crossDays = 0;
    res.ties.forEach(function (x) {
      bySame[x.same] = (bySame[x.same] || 0) + 1;
      if (x.below > 0) crossDays++;
    });
    L.push("| 10位と同じ点数の銘柄数（10位を含む） | 日数 |");
    L.push("| ---: | ---: |");
    Object.keys(bySame).map(Number).sort(function (a, b) { return a - b; }).forEach(function (kk) {
      L.push("| " + kk + " | " + bySame[kk] + " |");
    });
    L.push("");
    L.push("- 10位と同点の銘柄が11位以下にもいた日（上位10の切れ目で同点が割れた日）: " + crossDays + "日 / " + res.ties.length + "日");
    L.push("");
  };

  var scoredRecs = main0.groups.all;
  var tradeRecs = scoredRecs.filter(function (r) { return r.exit; });
  var bothShare = tradeRecs.length ? tradeRecs.filter(function (r) { return r.exit.kind === "both"; }).length / tradeRecs.length : NaN;
  var cap35 = scoredRecs.filter(function (r) { return r.cap35; }).length;
  var capBound = scoredRecs.filter(function (r) { return r.capBound; }).length;
  var candTotal = testDays.reduce(function (s, td) { return s + td.cands.length; }, 0);
  var topNotTradable = 0;
  testDays.forEach(function (td) {
    rankDay(td, "score").top.forEach(function (r) { if (!r.exit) topNotTradable++; });
  });
  var topixVals = topixByDay.filter(isNum);
  var vixVals = vixByDay.filter(Boolean).map(function (v) { return v.value; });
  var vixCapDays = { c45: 0, c65: 0, c80: 0, none: 0 };
  vixVals.forEach(function (v) {
    if (v >= 30) vixCapDays.c45++;
    else if (v >= 25) vixCapDays.c65++;
    else if (v >= 20) vixCapDays.c80++;
    else vixCapDays.none++;
  });
  // 上位10の入れ替わり（本来の計算 vs 前日15:30の足を補った版）
  var sameTop = 0, sameTopDays = 0;
  testDays.forEach(function (td) {
    var a = rankDay(td, "score").top, b = rankDay(td, "scoreClose").top;
    var bt = new Set(Array.from(b).map(function (r) { return r.ticker; }));
    var n = 0;
    a.forEach(function (r) { if (bt.has(r.ticker)) n++; });
    sameTop += n;
    sameTopDays++;
  });
  var countReasons = function (list) {
    var o = {};
    list.forEach(function (f) { o[f.error] = (o[f.error] || 0) + 1; });
    return o;
  };

  L.push("# 寄り前スコア上位10銘柄を寄りで買う成績 検証結果");
  L.push("");
  L.push("- 生成: `node scripts/score-top10-check.mjs`（実行日 " + new RealDate().toISOString().slice(0, 10) + "）");
  L.push("- 候補: `scripts/hourly-exit-check.mjs`（PR #87）のグループ2（業種で絞らない通常版）と同じ作り方。前日の確定値で、出来高上位" + NORMAL_VOL_TOP + "と、値上がり率上位" + CHANGE_TOP + "（出来高が全銘柄の中央値の" + VOL_MULT + "倍以上のもの）を重複なしで並べる");
  L.push("- 銘柄一覧: JPX 東証上場銘柄一覧（" + (jpx.asOf || "日付不明") + " 時点）のうち、プライム・スタンダード・グロースの内国株式 " + jpx.list.length + "銘柄");
  L.push("- 15分足: Yahoo Finance（interval=" + INTRADAY_INTERVAL + "、range=" + INTRADAY_RANGE + "）。期間 " + periodStart + " 〜 " + periodEnd + "（日本取引日 " + periodDays.length + "日）");
  L.push("- **検証日数: " + testDays.length + "日**（" + (testDays.length ? testDays[0].date + " 〜 " + testDays[testDays.length - 1].date : "-") + "）。" + REF_TICKER + " の15分足が、スコア計算に渡す範囲（T当日より前の直近" + APP_WINDOW_DAYS + "取引日）で" + MIN_BARS + "本以上ある日");
  L.push("- 候補の銘柄日数: " + candTotal + "（うちスコアを計算できた " + scoredRecs.length + "、そのうち売買まで判定できた " + tradeRecs.length + "）");
  L.push("- TOPIX前日比: **" + topixSource + "**" + (topixSource === TOPIX_PROXY ? "（TOPIX 連動ETF で代用。Yahoo に TOPIX の日足が無かったため: " + topixTried.slice(0, -1).join(" / ") + "）" : "") +
    " の日足（調整後終値）で、T当日の前日の終値 ÷ 前々日の終値 − 1。検証日の値の範囲 " + num2(Math.min.apply(null, topixVals)) + "% 〜 " + num2(Math.max.apply(null, topixVals)) + "%");
  L.push("- VIX（追加の比較のみ）: Yahoo Finance の **" + VIX_TICKER + "** の日足終値のうち、T当日より前の最後の米国営業日の値。検証日の値の範囲 " + num2(Math.min.apply(null, vixVals)) + " 〜 " + num2(Math.max.apply(null, vixVals)) +
    "（上限45点の日 " + vixCapDays.c45 + "・65点の日 " + vixCapDays.c65 + "・80点の日 " + vixCapDays.c80 + "・上限なしの日 " + vixCapDays.none + "）");
  L.push("");
  L.push("売り方: T当日の日足の始値で買い、利確ライン 始値 × 1.015・損切りライン 始値 × 0.9925 とする。T当日の15分足を時刻順に見て、最初に「高値が利確ライン以上」または「安値が損切りライン以下」になった足で決着させる。どちらにも届かなければ T当日の日足の終値で手仕舞う。損益率は往復手数料0.1%（PR #87 と同じ）を引いた値。");
  L.push("");

  L.push("## 1. 実装前確認の結果");
  L.push("");
  L.push("- analyzeStock の読み込み: `src/lib/analyze.js` を変更せずに import できた（ESM の構文を Node が自動判定する。警告 `MODULE_TYPELESS_PACKAGE_JSON` が出るだけ）。ブラウザ専用の機能への依存は無い。空の足の埋め方（`toPriceData`）と銘柄情報の形（`normalizeStock`）も `api/_scan.js` から import してそのまま使った");
  L.push("- 時計の差し替え: スコアに効く現在時刻の参照は `currentSessionDate()`（`jstInfo()` の `Date.now()`）だけ。スクリプト側で `Date.now()` と引数なしの `new Date()` を対象日の 8:50（日本時間）に固定して計算した。全検証日で `currentSessionDate(\"JP\")` が対象日を返し（ずれ " + clockMismatch + "日）、計算した " + scored + "件すべてが寄り付き前扱い（`sessionStarted` が false。寄り付き後扱いになった件数 " + sessionStartedCount + "）になった。`currentSessionLabel()` と記録時刻の `new Date()` は保存用の値にしか使われず、点数には影響しない");
  L.push("- 15分足の加工: `api/stock.js` は Yahoo の配列を加工せずに渡し、日付だけ `toLocalDates()` で付ける。`toLocalDates()` は export されていないため写して使い、実行時に `api/stock.js` の該当部分と一字一句同じであることを確かめた（" + (datesCopyOk ? "一致" : "不一致") + "）。空の足を直前の値で埋める処理と出来高を0にする処理は `api/_scan.js` の `toPriceData()` をそのまま呼んだので、差分は無い。スコア計算に渡す長さは `api/stock.js` と同じ range=30d 相当（T当日より前の直近" + APP_WINDOW_DAYS + "取引日）に切った");
  L.push("- 候補の作り方: `api/ranking.js` の `getJPRanking()`（出来高上位40、値上がり率を前日終値比で出して、出来高が全銘柄の中央値（昇順 floor(n/2) 番目）の1.5倍以上のものの上位20、出来高上位の順→値上がり率上位の順で重複除去）と、既存スクリプトの `buildCandidates()` は一致していた。アプリ側の `src/App.js` の `buildStockUniverse()` は重複除去だけで並べ替えない。違いは母集団（アプリは立花の銘柄マスタのうち業種コード9999以外、こちらは JPX 一覧の内国株式）と、値上がり率に Yahoo の調整後終値を使う点で、既存の検証と同じ近似");
  L.push("- 公式の前日終値: 寄り前の Yahoo の meta には `regularMarketPreviousClose` が無く、`api/stock.js` は `previousClose` を使う。実測（2026-09-25 2:48 日本時間、7203.T）で `previousClose` は15分足の最終日（9/24）の1つ前の取引日（9/18）の終値 3025 だった。このため「公式の前日終値」は、T当日から見て前々取引日の日足終値とした（アプリの前日比＝前日の値動きとなり、TOPIX前日比と同じ日を比べる形になる）");
  L.push("- 現在値: 指示どおり前日の最後の15分足の終値（`toPriceData()` の既定の動き）。ただし寄り前の実データでは、最新日にだけ 15:30 の足（始値＝高値＝安値＝終値＝公式終値、出来高0）が付き、`meta.regularMarketPrice` も公式終値になる（実測）。この足は過去の日の15分足には残らないため、感度確認として日足の前日終値で補った版も計算した（5章）");
  L.push("- アプリのスコア順（`src/App.js` の🏆スコア順）は同点のとき元の並び（候補リストの順）を保つ。このため10位が同点の場合も候補リストの順で先に来る方を上位とし、上位10はちょうど10銘柄に切った");
  L.push("");

  L.push("## 2. グループ別の成績（自動スキャンと同じ条件: VIXなし）");
  L.push("");
  groupTable(main0, GROUP_ROWS);
  L.push("- 件数は銘柄日数。勝率は手数料込みの損益率がプラスだった割合（按分では、同じ足で両方に届いた件を 1/3 勝ちとして数える）");
  L.push("- 利確・損切り・大引け手仕舞いは決着の仕方の割合（按分では、同じ足で両方に届いた件を利確 1/3・損切り 2/3 に分ける）");
  L.push("- スコア帯はその銘柄日の点数で分けた。2B は `hourly-exit-check.mjs` と同じく、前日値上がり率上位20に入った候補（出来高上位40と重複するものも含む）");
  L.push("- 同じ15分足で利確・損切りの両方に届いた件数の割合: " + pct1(bothShare) + "（売買まで判定できた " + tradeRecs.length + "件中）");
  L.push("");

  L.push("## 3. 上位10 − 11位以下（日ごとの差）");
  L.push("");
  diffTable(main0);
  L.push("- 日ごとに「上位10の平均損益率 − 11位以下の平均損益率」を出し、その平均と t値（平均 ÷（標準偏差 ÷ √日数））を示した。標準偏差は不偏標準偏差");
  L.push("");

  L.push("## 4. スコアの分布と同点");
  L.push("");
  scoreDist(main0, "score");
  L.push("- 上限35点以下がかかった銘柄日（MACD デッドクロス・下降トレンドのどちらか）: " + cap35 + "件 / " + scoredRecs.length + "件（" + pct1(scoredRecs.length ? cap35 / scoredRecs.length : NaN) + "）。そのうち上限で実際に点数が削られた銘柄日: " + capBound + "件（" + pct1(scoredRecs.length ? capBound / scoredRecs.length : NaN) + "）");
  L.push("");
  tieTable(main0);

  L.push("## 5. 追加の比較");
  L.push("");
  L.push("### 5-1. VIX による上限だけをかけた版");
  L.push("");
  if (vixCapDays.none === vixVals.length) {
    L.push("検証期間中の VIX はすべて20未満で、analyze.js の VIX 上限（20以上で80点・25以上で65点・30以上で45点）が一度もかからなかった。このため点数・並び順・成績は VIXなしの版と同じになる。");
    L.push("");
  }
  groupTable(withVix, GROUP_ROWS.slice(0, 6));
  diffTable(withVix);
  L.push("#### スコアの分布（VIXあり）");
  L.push("");
  scoreDist(withVix, "scoreVix");
  tieTable(withVix);

  L.push("### 5-2. 感度確認: 前日15:30の足（公式終値）を補った版");
  L.push("");
  L.push("寄り前の実データに付く 15:30 の足を、日足の前日終値で補って計算し直した版。売買の判定は同じで、並び順だけが変わる。上位10の顔ぶれの一致: 1日あたり平均 " + num2(sameTopDays ? sameTop / sameTopDays : NaN) + "銘柄 / 10銘柄。");
  L.push("");
  groupTable(withClose, GROUP_ROWS.slice(0, 3));
  diffTable(withClose);

  L.push("## 6. 除外・失敗の件数");
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
  L.push("| スコアを計算しなかった銘柄日: 15分足が" + MIN_BARS + "本未満（上場が新しい等） | " + skip.fewBars + " |");
  L.push("| スコアは計算したが公式の前日終値が無い（15分足ベースの前日終値で計算） | " + skip.noOfficialPrev + " |");
  L.push("| 売買から除いた銘柄日: T当日の日足の欠け・出来高0 | " + skip.noDaily + " |");
  L.push("| 売買から除いた銘柄日: T当日の15分足が無い | " + skip.noDayBars + " |");
  L.push("| 上位10に入ったが売買から除いた銘柄日 | " + topNotTradable + " |");
  L.push("");
  L.push("- 並び順はスコアを計算できた候補の中で決め、売買から除いた銘柄日も順位には含めている（アプリの寄り前スキャンでも、翌日の売買可否は並び順に関係しないため）");
  L.push("");

  var outPath = fileURLToPath(new URL("../docs/score-top10-result.md", import.meta.url));
  writeFileSync(outPath, L.join("\n"));
  console.log(L.join("\n"));
  console.log("\n→ " + outPath);
};

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
