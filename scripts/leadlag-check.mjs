// scripts/leadlag-check.mjs
// 米国の業種別ETFの値動きが、翌営業日の日本の業種別ETFの値動き
// （寄り付きギャップ・寄り→引け）を予測できるかを、過去3年分の日足で検証する。
// アプリ本体とは無関係の単発検証スクリプト。npm パッケージは使わず Node 標準の fetch のみ。
//
// 実行: node scripts/leadlag-check.mjs
// 出力: docs/leadlag-result.md

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// api/daily.js と同じ URL 形式・同じ User-Agent
var YAHOO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};
var RANGE = "3y";
var FEE = 0.001; // 売買手数料（1回0.1%）
var REL_THRESHOLD = 0.01; // E の絞り込み条件（相対騰落率 +1%以上）

// 米国→日本 の組み合わせ
var PAIRS = [
  { us: "SMH", jp: "1625.T", name: "電機・精密" },
  { us: "XLF", jp: "1631.T", name: "銀行" },
  { us: "XLE", jp: "1618.T", name: "エネルギー資源" },
  { us: "XLV", jp: "1621.T", name: "医薬品" },
  { us: "XLI", jp: "1624.T", name: "機械" },
  { us: "XLB", jp: "1620.T", name: "素材・化学" },
  { us: "SLX", jp: "1623.T", name: "鉄鋼・非鉄" },
  { us: "XLU", jp: "1627.T", name: "電力・ガス" },
  { us: "XLP", jp: "1617.T", name: "食品" },
  { us: "XLRE", jp: "1633.T", name: "不動産" },
  { us: "XLC", jp: "1626.T", name: "情報通信・サービスその他" },
  { us: "XLY", jp: "1630.T", name: "小売" },
  { us: "IYT", jp: "1628.T", name: "運輸・物流" },
];
var BENCH = "SPY";

// ---------- 取得 ----------

var fetchDaily = async function (ticker) {
  var url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(ticker) + "?interval=1d&range=" + RANGE;
  var r = await fetch(url, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(ticker + ": Yahoo " + r.status);
  var json = await r.json();
  var result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result || !result.timestamp) throw new Error(ticker + ": データなし");
  var q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  var rows = [];
  for (var i = 0; i < result.timestamp.length; i++) {
    // 日足の timestamp はその取引日を指す UTC 時刻なので、api/daily.js と同じくそのまま日付を取り出す
    var d = new Date(result.timestamp[i] * 1000);
    var date = d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
    rows.push({
      date: date,
      open: q.open ? q.open[i] : null,
      close: q.close ? q.close[i] : null,
      volume: q.volume ? q.volume[i] : null,
    });
  }
  return rows;
};

// 取引所の営業日一覧（その取引所の全銘柄の日付の和集合）
var tradingDays = function (seriesList) {
  var set = new Set();
  seriesList.forEach(function (rows) { rows.forEach(function (r) { set.add(r.date); }); });
  return Array.from(set).sort();
};

var byDate = function (rows) {
  var m = new Map();
  rows.forEach(function (r) { m.set(r.date, r); });
  return m;
};

var isNum = function (v) { return typeof v === "number" && isFinite(v); };

// ---------- 統計 ----------

var mean = function (a) { return a.reduce(function (s, v) { return s + v; }, 0) / a.length; };

var median = function (a) {
  var s = a.slice().sort(function (x, y) { return x - y; });
  var n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

var corr = function (xs, ys) {
  var n = xs.length;
  if (n < 3) return NaN;
  var mx = mean(xs), my = mean(ys);
  var sxy = 0, sxx = 0, syy = 0;
  for (var i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) * (xs[i] - mx);
    syy += (ys[i] - my) * (ys[i] - my);
  }
  return sxy / Math.sqrt(sxx * syy);
};

// 件数・勝率・平均・中央値・累積
var summarize = function (rets) {
  if (!rets.length) return { n: 0, win: NaN, avg: NaN, med: NaN, cum: NaN };
  var wins = rets.filter(function (r) { return r > 0; }).length;
  var cum = rets.reduce(function (p, r) { return p * (1 + r); }, 1) - 1;
  return { n: rets.length, win: wins / rets.length, avg: mean(rets), med: median(rets), cum: cum };
};

var pct = function (v) { return isNum(v) ? (v * 100).toFixed(2) + "%" : "-"; };
var num = function (v) { return isNum(v) ? v.toFixed(2) : "-"; };

// ---------- 本体 ----------

var main = async function () {
  var tickers = [BENCH].concat(PAIRS.map(function (p) { return p.us; }), PAIRS.map(function (p) { return p.jp; }));
  var data = {};
  // Yahoo に負荷をかけないよう直列で取得
  for (var i = 0; i < tickers.length; i++) {
    data[tickers[i]] = await fetchDaily(tickers[i]);
  }

  var usDays = tradingDays([data[BENCH]].concat(PAIRS.map(function (p) { return data[p.us]; })));
  var jpDays = tradingDays(PAIRS.map(function (p) { return data[p.jp]; }));

  // 米国側: 騰落率（当日終値÷前日終値−1）。前日 = 米国の1つ前の営業日
  var usRet = function (ticker) {
    var m = byDate(data[ticker]);
    var out = new Map();
    for (var k = 1; k < usDays.length; k++) {
      var cur = m.get(usDays[k]), prev = m.get(usDays[k - 1]);
      if (cur && prev && isNum(cur.close) && isNum(prev.close) && prev.close > 0) {
        out.set(usDays[k], cur.close / prev.close - 1);
      }
    }
    return out;
  };

  // 日本側: ギャップ（当日始値÷前日終値−1）と日中騰落率（当日終値÷当日始値−1）
  // 出来高0・始値/終値欠けの日は除外し、件数を数える
  var excluded = {};
  var jpRet = function (ticker) {
    var m = byDate(data[ticker]);
    var out = new Map();
    var ex = 0;
    for (var k = 1; k < jpDays.length; k++) {
      var cur = m.get(jpDays[k]), prev = m.get(jpDays[k - 1]);
      if (!cur || !isNum(cur.open) || !isNum(cur.close) || !isNum(cur.volume) || cur.volume === 0 || cur.open <= 0) {
        ex++;
        continue;
      }
      if (!prev || !isNum(prev.close) || prev.close <= 0) {
        ex++;
        continue;
      }
      out.set(jpDays[k], { gap: cur.open / prev.close - 1, intra: cur.close / cur.open - 1 });
    }
    excluded[ticker] = ex;
    return out;
  };

  var spy = usRet(BENCH);
  var usR = {}, jpR = {};
  PAIRS.forEach(function (p) {
    usR[p.us] = usRet(p.us);
    jpR[p.jp] = jpRet(p.jp);
  });

  // 米国の取引日D → 日付がDより後の最初の日本の取引日（未来は参照しない）
  var nextJpDay = function (d) {
    for (var k = 0; k < jpDays.length; k++) if (jpDays[k] > d) return jpDays[k];
    return null;
  };
  var mapping = [];
  usDays.forEach(function (d) {
    var j = nextJpDay(d);
    if (j && spy.has(d)) mapping.push({ us: d, jp: j });
  });

  // ---------- A. 相関 ----------
  var corrRows = [];
  var allX = [], allGap = [], allIntra = [];
  PAIRS.forEach(function (p) {
    var xs = [], gs = [], is = [];
    mapping.forEach(function (mp) {
      var u = usR[p.us].get(mp.us), j = jpR[p.jp].get(mp.jp);
      if (isNum(u) && j) { xs.push(u); gs.push(j.gap); is.push(j.intra); }
    });
    allX = allX.concat(xs); allGap = allGap.concat(gs); allIntra = allIntra.concat(is);
    corrRows.push({ label: p.us + "→" + p.jp + "（" + p.name + "）", n: xs.length, cGap: corr(xs, gs), cIntra: corr(xs, is) });
  });
  corrRows.push({ label: "全組まとめて", n: allX.length, cGap: corr(allX, allGap), cIntra: corr(allX, allIntra) });

  // ---------- B〜E. 売買の模擬 ----------
  // 日本の1営業日に複数の米国営業日が対応する場合（日本側の連休など）は、
  // 同じ日本の営業日を二重に売買しないよう、その日本営業日の直前の米国営業日だけを使う
  var lastUsForJp = new Map();
  mapping.forEach(function (mp) { lastUsForJp.set(mp.jp, mp.us); });

  var bRets = [], cRets = [], dRets = [], eRets = [];
  var bSkipped = 0, dSkipped = 0;
  var tradeDays = 0;
  Array.from(lastUsForJp.entries()).sort().forEach(function (e) {
    var jpDay = e[0], usDay = e[1];
    var s = spy.get(usDay);
    // 米国13組の相対騰落率（騰落率 − SPYの騰落率）
    var rels = [];
    PAIRS.forEach(function (p) {
      var u = usR[p.us].get(usDay);
      if (isNum(u) && isNum(s)) rels.push({ p: p, rel: u - s });
    });
    if (rels.length !== PAIRS.length) return;
    tradeDays++;
    rels.sort(function (a, b) { return b.rel - a.rel; });
    var top = rels[0], bottom = rels[rels.length - 1];

    // B: 最も高かった組。日本ETFがその日除外対象なら見送り
    var tj = jpR[top.p.jp].get(jpDay);
    if (tj) {
      bRets.push(tj.intra);
      if (top.rel >= REL_THRESHOLD) eRets.push(tj.intra);
      // C: B と同じ日の、13本（除外分を除く）の日中騰落率の平均
      var intras = [];
      PAIRS.forEach(function (p) {
        var j = jpR[p.jp].get(jpDay);
        if (j) intras.push(j.intra);
      });
      cRets.push(mean(intras));
    } else {
      bSkipped++;
    }

    // D: 最も低かった組
    var bj = jpR[bottom.p.jp].get(jpDay);
    if (bj) dRets.push(bj.intra);
    else dSkipped++;
  });

  var B = summarize(bRets), C = summarize(cRets), D = summarize(dRets), E = summarize(eRets);

  // ---------- 出力 ----------
  var L = [];
  L.push("# 米国業種ETF → 翌営業日の日本業種ETF リードラグ検証結果");
  L.push("");
  L.push("- 生成: `node scripts/leadlag-check.mjs`（実行日 " + new Date().toISOString().slice(0, 10) + "）");
  L.push("- データ: Yahoo Finance 日足（range=" + RANGE + "）");
  L.push("- 米国営業日: " + usDays[0] + " 〜 " + usDays[usDays.length - 1] + "（" + usDays.length + "日）");
  L.push("- 日本営業日: " + jpDays[0] + " 〜 " + jpDays[jpDays.length - 1] + "（" + jpDays.length + "日）");
  L.push("- 米国の取引日D → 日付がDより後の最初の日本の取引日を対応させた組: " + mapping.length + "件");
  L.push("- 売買の模擬（B〜E）の対象日: " + tradeDays + "日（日本の1営業日に米国営業日が複数対応する場合は、直前の米国営業日のみを使用）");
  L.push("");

  L.push("## A. 相関係数（米国の騰落率 vs 日本のギャップ／日中騰落率）");
  L.push("");
  L.push("| 組 | 件数 | 米国騰落率×日本ギャップ | 米国騰落率×日本日中騰落率 |");
  L.push("| --- | ---: | ---: | ---: |");
  corrRows.forEach(function (r) {
    L.push("| " + r.label + " | " + r.n + " | " + num(r.cGap) + " | " + num(r.cIntra) + " |");
  });
  L.push("");

  var simRow = function (label, s, withFee) {
    return "| " + label + " | " + s.n + " | " + pct(s.win) + " | " + pct(s.avg) + " | " + pct(s.med) + " | " + pct(s.cum) +
      " | " + (withFee ? pct(s.avg - FEE) : "-") + " |";
  };
  L.push("## B〜F. 売買の模擬（日本ETFを寄り付きで買い、大引けで売る）");
  L.push("");
  L.push("| 条件 | 件数 | 勝率 | 平均騰落率 | 中央値 | 累積騰落率 | F. 平均騰落率−手数料0.10% |");
  L.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  L.push(simRow("B. 米国相対騰落率が最も高い組", B, true));
  L.push(simRow("C. Bと同じ日の13本平均", C, false));
  L.push(simRow("D. 米国相対騰落率が最も低い組", D, true));
  L.push(simRow("E. Bのうち相対騰落率+1.00%以上の日", E, true));
  L.push("");
  L.push("- 勝率は日中騰落率がプラスだった割合。累積騰落率は各回の騰落率を複利で積み上げた値");
  L.push("- C は日ごとに、その日除外されていない日本ETFの日中騰落率を単純平均した値");
  L.push("- 選ばれた日本ETFがその日除外対象（出来高0・始値/終値欠け）だった日は見送り: B " + bSkipped + "日、D " + dSkipped + "日");
  L.push("");

  L.push("## G. 銘柄ごとの除外件数（日本側）");
  L.push("");
  L.push("| 銘柄 | 業種 | 除外件数 |");
  L.push("| --- | --- | ---: |");
  PAIRS.forEach(function (p) {
    L.push("| " + p.jp + " | " + p.name + " | " + excluded[p.jp] + " |");
  });
  L.push("");
  L.push("- 除外条件: 出来高0、始値または終値が欠けている日、前営業日の終値が欠けていてギャップを計算できない日");
  L.push("");

  var outPath = fileURLToPath(new URL("../docs/leadlag-result.md", import.meta.url));
  writeFileSync(outPath, L.join("\n"));
  console.log(L.join("\n"));
  console.log("\n→ " + outPath);
};

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
