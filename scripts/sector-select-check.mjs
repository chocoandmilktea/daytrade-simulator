// scripts/sector-select-check.mjs
// 前夜の米国業種ETFの相対騰落率で日本の業種を絞り、その業種内でアプリのランキングと
// 同じ方式（出来高上位＋出来高フィルター通過後の値上がり率上位）で候補銘柄を選んだ場合に、
// 業種で絞らない場合と比べて寄り付き→大引けの成績がどうなるかを、過去3年分の日足で検証する。
// アプリ本体とは無関係の単発検証スクリプト。新しい npm パッケージは使わず、
// 既存の依存関係に含まれる xlsx（SheetJS）と Node 標準の fetch のみを使う。
//
// 実行: node scripts/sector-select-check.mjs
// 出力: docs/sector-select-result.md
//
// 任意: 環境変数 SECTOR_CHECK_CACHE にディレクトリを指定すると、Yahoo の取得結果を
//       そこに JSON で保存し、次回以降はそれを読む（再実行時に約3700銘柄を取り直さないため）

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";

// api/daily.js と同じ URL 形式・同じ User-Agent
var YAHOO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};
var RANGE = "3y";
var WAIT_MS = 300; // 1件ごとの待ち時間
var RETRY_WAITS = [5000, 10000, 20000, 40000, 80000]; // 429 のときの待ち時間（再試行ごとに延ばす）
var ERROR_RETRY_WAITS = [3000, 6000]; // 429 以外の一時的な失敗（通信エラー・5xx）の再試行

var JPX_PAGE = "https://www.jpx.co.jp/markets/statistics-equities/misc/01.html";
var TARGET_MARKETS = ["プライム（内国株式）", "スタンダード（内国株式）", "グロース（内国株式）"];

// 米国ETF → 日本の17業種区分
var PAIRS = [
  { us: "SMH", jp: "電機・精密" },
  { us: "XLF", jp: "銀行" },
  { us: "XLE", jp: "エネルギー資源" },
  { us: "XLV", jp: "医薬品" },
  { us: "XLI", jp: "機械" },
  { us: "XLB", jp: "素材・化学" },
  { us: "SLX", jp: "鉄鋼・非鉄" },
  { us: "XLU", jp: "電力・ガス" },
  { us: "XLP", jp: "食品" },
  { us: "XLRE", jp: "不動産" },
  { us: "XLC", jp: "情報通信・サービスその他" },
  { us: "XLY", jp: "小売" },
  { us: "IYT", jp: "運輸・物流" },
];
var BENCH = "SPY";

// 候補の作り方（通常版は api/ranking.js、業種版は api/sector.js と同じ件数）
var NORMAL_VOL_TOP = 40;
var SECTOR_VOL_TOP = 50;
var CHANGE_TOP = 20;
var VOL_MULT = 1.5;

// 日本の取引日の判定: 終値がある銘柄数が、最も多い日の半分以上ある日だけを取引日とする
// （一部の銘柄だけに紛れ込んだ休日の足を取引日として扱わないため）
var JP_DAY_MIN_RATIO = 0.5;

var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
var isNum = function (v) { return typeof v === "number" && isFinite(v); };

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
      close: q.close ? q.close[i] : null,
      adj: adj[i] == null ? null : adj[i],
      volume: q.volume ? q.volume[i] : null,
    });
  }
  return rows;
};

// 1銘柄の日足を取得する。戻り値: { rows } または { error }
var fetchDaily = async function (ticker, cacheDir) {
  var cachePath = cacheDir ? join(cacheDir, ticker.replace(/[^A-Za-z0-9._-]/g, "_") + ".json") : null;
  if (cachePath && existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, "utf8"));

  var url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(ticker) + "?interval=1d&range=" + RANGE;
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
    var rows;
    try {
      rows = parseChart(await r.json());
    } catch (e) {
      out = { error: "JSON 解析失敗" };
      break;
    }
    out = rows && rows.length ? { rows: rows } : { error: "データなし" };
  }
  // 429 による失敗はキャッシュしない（再実行時に取り直すため）
  if (cachePath && !(out.error && out.error.indexOf("429") === 0)) writeFileSync(cachePath, JSON.stringify(out));
  return out;
};

// ---------- 統計 ----------

var mean = function (a) { return a.reduce(function (s, v) { return s + v; }, 0) / a.length; };

var median = function (a) {
  var s = a.slice().sort(function (x, y) { return x - y; });
  var n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

var sd = function (a) {
  if (a.length < 2) return NaN;
  var m = mean(a);
  return Math.sqrt(a.reduce(function (s, v) { return s + (v - m) * (v - m); }, 0) / (a.length - 1));
};

var pct3 = function (v) { return isNum(v) ? (v * 100).toFixed(3) + "%" : "-"; };
var num2 = function (v) { return isNum(v) ? v.toFixed(2) : "-"; };

// ---------- 候補の作り方 ----------

// アプリ（api/ranking.js / api/sector.js）と同じく、昇順に並べた出来高の floor(n/2) 番目を中央値とする
var appMedian = function (vols) {
  var s = vols.slice().sort(function (a, b) { return a - b; });
  return s[Math.floor(s.length / 2)] || 0;
};

// pop: [{ idx, prevVol, prevRet }]（前日の値だけを持つ）。volTop 件＋値上がり率上位 CHANGE_TOP 件を重複なしで返す
var buildCandidates = function (pop, volTop) {
  if (!pop.length) return [];
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
  return out;
};

// ---------- 本体 ----------

var main = async function () {
  var cacheDir = process.env.SECTOR_CHECK_CACHE || null;
  if (cacheDir) mkdirSync(cacheDir, { recursive: true });

  // 1. 銘柄一覧
  var jpx = await fetchJpxList();
  console.log("JPX 銘柄一覧: " + jpx.list.length + "銘柄（" + jpx.url + "）");

  // 2. 米国ETF
  var usTickers = [BENCH].concat(PAIRS.map(function (p) { return p.us; }));
  var us = {};
  for (var i = 0; i < usTickers.length; i++) {
    var res = await fetchDaily(usTickers[i], cacheDir);
    if (res.error) throw new Error(usTickers[i] + ": " + res.error);
    us[usTickers[i]] = res.rows;
    await sleep(WAIT_MS);
  }

  // 3. 日本株（直列・1件ごとに待つ）
  var stocks = [];
  var failed = [];
  for (var k = 0; k < jpx.list.length; k++) {
    var s = jpx.list[k];
    var ticker = s.code + ".T";
    var fromCache = cacheDir && existsSync(join(cacheDir, ticker + ".json"));
    var r2 = await fetchDaily(ticker, cacheDir);
    if (r2.error) failed.push({ ticker: ticker, error: r2.error });
    else stocks.push({ ticker: ticker, sector: s.sector, rows: r2.rows });
    if (!fromCache) await sleep(WAIT_MS);
    if ((k + 1) % 200 === 0) console.log("  日本株 " + (k + 1) + "/" + jpx.list.length + "（失敗 " + failed.length + "）");
  }
  console.log("日本株 取得成功 " + stocks.length + " / 失敗 " + failed.length);

  // ---------- 取引日 ----------

  // 米国: 14本の日付の和集合（終値のある日）
  var usSet = new Set();
  usTickers.forEach(function (t) { us[t].forEach(function (r) { if (isNum(r.adj)) usSet.add(r.date); }); });
  var usDays = Array.from(usSet).sort();

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
  var bars = stocks.map(function (st) {
    var arr = new Array(jpDays.length).fill(null);
    st.rows.forEach(function (r) {
      var j = jpDayIndex.get(r.date);
      if (j != null) arr[j] = r;
    });
    return arr;
  });

  // ---------- 米国側の順位 ----------

  var usByDate = {};
  usTickers.forEach(function (t) {
    var m = new Map();
    us[t].forEach(function (r) { m.set(r.date, r); });
    usByDate[t] = m;
  });
  // 騰落率 = 当日調整後終値 ÷ 前の米国取引日の調整後終値 − 1
  var usRet = function (t, k) {
    var cur = usByDate[t].get(usDays[k]), prev = usByDate[t].get(usDays[k - 1]);
    if (!cur || !prev || !isNum(cur.adj) || !isNum(prev.adj) || prev.adj <= 0) return null;
    return cur.adj / prev.adj - 1;
  };

  // 米国の取引日D → 日付がDより後の最初の日本の取引日。
  // 1つの日本の取引日に複数のDが対応する場合は、直前（最も新しい）のDだけを残す
  var usForJp = new Map(); // 日本の取引日の番号 → 米国の取引日の番号
  var jp = 0;
  for (var u = 1; u < usDays.length; u++) {
    while (jp < jpDays.length && jpDays[jp] <= usDays[u]) jp++;
    if (jp >= jpDays.length) break;
    usForJp.set(jp, u);
  }

  // ---------- 日ごとの計算 ----------

  var G = [
    { key: "g1", label: "グループ1（米国上位3組の業種・業種版）", daily: [], cand: [], valid: [], gaps: [], excluded: 0 },
    { key: "g2", label: "グループ2（業種で絞らない・通常版）", daily: [], cand: [], valid: [], gaps: [], excluded: 0 },
    { key: "g3", label: "グループ3（米国下位3組の業種・業種版）", daily: [], cand: [], valid: [], gaps: [], excluded: 0 },
  ];
  var dayRows = []; // { date, g1, g2, g3 }（そのグループの有効銘柄が0ならnull）
  var skip = { noUs: 0, usMissing: 0, noPrev: 0 };
  var sectorHits = {};
  PAIRS.forEach(function (p) { sectorHits[p.jp] = { top: 0, bottom: 0 }; });

  for (var t = 0; t < jpDays.length; t++) {
    // 前日・前々日が必要
    if (t < 2) { skip.noPrev++; continue; }
    if (!usForJp.has(t)) { skip.noUs++; continue; }
    var uk = usForJp.get(t);
    var spy = usRet(BENCH, uk);
    var rels = [];
    PAIRS.forEach(function (p, pi) {
      var e = usRet(p.us, uk);
      if (isNum(e) && isNum(spy)) rels.push({ pi: pi, rel: e - spy });
    });
    if (rels.length !== PAIRS.length) { skip.usMissing++; continue; }
    rels.sort(function (a, b) { return b.rel - a.rel || a.pi - b.pi; });
    var topSectors = rels.slice(0, 3).map(function (x) { return PAIRS[x.pi].jp; });
    var bottomSectors = rels.slice(-3).map(function (x) { return PAIRS[x.pi].jp; });
    topSectors.forEach(function (s) { sectorHits[s].top++; });
    bottomSectors.forEach(function (s) { sectorHits[s].bottom++; });

    // 母集団: 前日の出来高と、前日・前々日の調整後終値が揃っている銘柄（T当日の値は使わない）
    var pop = [];
    for (var si = 0; si < bars.length; si++) {
      var p1 = bars[si][t - 1], p2 = bars[si][t - 2];
      if (!p1 || !p2 || !isNum(p1.adj) || !isNum(p2.adj) || p2.adj <= 0 || !isNum(p1.volume)) continue;
      pop.push({ idx: si, prevVol: p1.volume, prevRet: p1.adj / p2.adj - 1 });
    }
    var inSectors = function (list) {
      return pop.filter(function (p) { return list.indexOf(stocks[p.idx].sector) >= 0; });
    };
    var candLists = [
      buildCandidates(inSectors(topSectors), SECTOR_VOL_TOP),
      buildCandidates(pop, NORMAL_VOL_TOP),
      buildCandidates(inSectors(bottomSectors), SECTOR_VOL_TOP),
    ];

    var row = { date: jpDays[t] };
    candLists.forEach(function (cands, gi) {
      var g = G[gi];
      var rets = [], gaps = [];
      cands.forEach(function (si2) {
        var b = bars[si2][t];
        // 成績: T当日の終値 ÷ T当日の始値 − 1。始値・終値欠け、出来高0は除く
        if (!b || !isNum(b.open) || !isNum(b.close) || b.open <= 0 || !isNum(b.volume) || b.volume === 0) {
          g.excluded++;
          return;
        }
        rets.push(b.close / b.open - 1);
        // 参考: ギャップ（T当日の始値 ÷ 前日の終値 − 1。調整後終値ではない終値を使う）
        var pb = bars[si2][t - 1];
        if (pb && isNum(pb.close) && pb.close > 0) gaps.push(b.open / pb.close - 1);
      });
      g.cand.push(cands.length);
      if (rets.length) {
        g.valid.push(rets.length);
        g.daily.push(mean(rets));
        row[g.key] = mean(rets);
      } else {
        row[g.key] = null;
      }
      if (gaps.length) g.gaps.push(mean(gaps));
    });
    dayRows.push(row);
  }

  // ---------- 集計 ----------

  var groupStats = G.map(function (g) {
    var d = g.daily;
    return {
      label: g.label,
      n: d.length,
      avg: d.length ? mean(d) : NaN,
      med: d.length ? median(d) : NaN,
      win: d.length ? d.filter(function (v) { return v > 0; }).length / d.length : NaN,
      cand: g.cand.length ? mean(g.cand) : NaN,
      valid: g.valid.length ? mean(g.valid) : NaN,
      gap: g.gaps.length ? mean(g.gaps) : NaN,
      excluded: g.excluded,
    };
  });

  var diffStats = function (a, b, label) {
    var diffs = [];
    dayRows.forEach(function (r) {
      if (isNum(r[a]) && isNum(r[b])) diffs.push(r[a] - r[b]);
    });
    var m = diffs.length ? mean(diffs) : NaN;
    var s = sd(diffs);
    return { label: label, n: diffs.length, avg: m, sd: s, t: m / (s / Math.sqrt(diffs.length)) };
  };
  var diffs = [
    diffStats("g1", "g2", "グループ1 − グループ2"),
    diffStats("g3", "g2", "グループ3 − グループ2"),
    diffStats("g1", "g3", "グループ1 − グループ3"),
  ];

  var failReasons = {};
  failed.forEach(function (f) { failReasons[f.error] = (failReasons[f.error] || 0) + 1; });

  // ---------- 出力 ----------

  var L = [];
  L.push("# 米国業種ETFの相対騰落率で日本の業種を絞った候補銘柄の寄り→引け 検証結果");
  L.push("");
  L.push("- 生成: `node scripts/sector-select-check.mjs`（実行日 " + new Date().toISOString().slice(0, 10) + "）");
  L.push("- 銘柄一覧: JPX 東証上場銘柄一覧（" + (jpx.asOf || "日付不明") + " 時点）のうち、プライム・スタンダード・グロースの内国株式 " + jpx.list.length + "銘柄");
  L.push("- 日足: Yahoo Finance（range=" + RANGE + "）");
  L.push("- 米国取引日: " + usDays[0] + " 〜 " + usDays[usDays.length - 1] + "（" + usDays.length + "日）");
  L.push("- 日本取引日: " + jpDays[0] + " 〜 " + jpDays[jpDays.length - 1] + "（" + jpDays.length + "日）");
  L.push("- 検証対象日: " + dayRows.length + "日" + (dayRows.length ? "（" + dayRows[0].date + " 〜 " + dayRows[dayRows.length - 1].date + "）" : ""));
  L.push("");

  L.push("## 1. グループ別の成績（寄り付きで買い、大引けで売る）");
  L.push("");
  L.push("| グループ | 日数 | 日次成績の平均 | 日次成績の中央値 | プラスの日の割合 | 1日あたり候補銘柄数 | 1日あたり計算対象銘柄数 | 参考: ギャップの平均 |");
  L.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  groupStats.forEach(function (s) {
    L.push("| " + s.label + " | " + s.n + " | " + pct3(s.avg) + " | " + pct3(s.med) + " | " + pct3(s.win) + " | " +
      num2(s.cand) + " | " + num2(s.valid) + " | " + pct3(s.gap) + " |");
  });
  L.push("");
  L.push("- 日次成績: その日の候補銘柄の（T当日の終値 ÷ T当日の始値 − 1）の単純平均");
  L.push("- 1日あたり候補銘柄数: 除外前の候補数の平均。計算対象銘柄数: 始値・終値欠け／出来高0を除いた後の数の平均");
  L.push("- ギャップ: T当日の始値 ÷ 前日の終値（調整後終値ではない）− 1。日ごとに候補銘柄の平均を取り、その日次値を平均した値");
  L.push("");

  L.push("## 2. グループ間の日次成績の差");
  L.push("");
  L.push("| 比較 | 日数 | 差の平均 | 差の標準偏差 | 差の平均 ÷（差の標準偏差 ÷ √日数） |");
  L.push("| --- | ---: | ---: | ---: | ---: |");
  diffs.forEach(function (d) {
    L.push("| " + d.label + " | " + d.n + " | " + pct3(d.avg) + " | " + pct3(d.sd) + " | " + num2(d.t) + " |");
  });
  L.push("");
  L.push("- 差は両グループの日次成績がそろっている日だけで計算。標準偏差は不偏標準偏差（n−1 で割る）");
  L.push("");

  L.push("## 3. 除外・失敗の件数");
  L.push("");
  L.push("| 項目 | 件数 |");
  L.push("| --- | ---: |");
  L.push("| 日足の取得に失敗した銘柄 | " + failed.length + " |");
  Object.keys(failReasons).sort().forEach(function (k2) {
    L.push("| └ " + k2 + " | " + failReasons[k2] + " |");
  });
  G.forEach(function (g, gi) {
    L.push("| 計算から除いた銘柄日数（" + g.label + "） | " + groupStats[gi].excluded + " |");
  });
  L.push("| 検証対象外の日本取引日: 前日・前々日が無い（期間の先頭） | " + skip.noPrev + " |");
  L.push("| 検証対象外の日本取引日: 対応する米国取引日が無い | " + skip.noUs + " |");
  L.push("| 検証対象外の日本取引日: 米国ETF 13組＋SPYの騰落率が揃わない | " + skip.usMissing + " |");
  L.push("");
  L.push("- 計算から除いた銘柄日数: 候補に選ばれたが、T当日の始値・終値が欠けている、または出来高が0だった件数");
  L.push("");

  L.push("## 4. 参考: 各業種が上位3組・下位3組に入った日数");
  L.push("");
  L.push("| 米国ETF | 日本の17業種区分 | 上位3組 | 下位3組 |");
  L.push("| --- | --- | ---: | ---: |");
  PAIRS.forEach(function (p) {
    L.push("| " + p.us + " | " + p.jp + " | " + sectorHits[p.jp].top + " | " + sectorHits[p.jp].bottom + " |");
  });
  L.push("");

  var outPath = fileURLToPath(new URL("../docs/sector-select-result.md", import.meta.url));
  writeFileSync(outPath, L.join("\n"));
  console.log(L.join("\n"));
  console.log("\n→ " + outPath);
};

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
