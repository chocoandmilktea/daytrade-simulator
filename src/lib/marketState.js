// ── 銘柄の「今の状態」の計算（フロント／サーバー共通）──────────────────────
// 状態は4つ: 注意（caution）／すでに上昇（extended）／大きな動きなし（calm）／データ不足（noData）。
// 手動スキャン（src/App.js）と自動スキャン（api/_scan.js）の両方から同じ計算を呼ぶ。
// analyze.js と同じく localStorage / window / document を参照しない素のJavaScript。
//
// 定義は daytrade-data PR #48（scripts/verdict3-check.mjs・docs/verdict3-result.md）の
// 場中版の5部品に合わせてある。部品の点数の付け方（pts）・ATR・荒さ・連続上昇の数え方も同じ。
//   ・場中版（使う値の時刻が、その日の15:30より前）… 過去の値は前日までの日足で計算する
//   ・引け後版（それ以外）… 過去の値はその日の日足を含めて計算する
// 注意の「荒い」は PR #48 では「その日の母集団の上位20%」だが、アプリでは全銘柄の順位を
// 出せないため、固定の境目 ROUGH_TH（3.0%）以上とする（依頼で決めた値）。
//
// 入力:
//   stock … {ticker, market}
//   pd    … 株価データ。pd.daily（api/stock.js が返す日足3か月分）・pd.marketTime（Yahoo の
//           regularMarketTime。Unix秒）・pd.currentPrice・pd.officialPrevClose を読む
//   tq    … 立花の値（/quotes の応答を toTachibanaQuoteSet で変換したもの）。呼ばなかった・失敗なら null

import { JP_HOLIDAYS } from "./analyze.js";

export var ROUGH_TH = 0.03;       // 注意「荒い」: 直近20日の騰落率の標準偏差がこれ以上
export var MIN_TURNOVER = 1e8;    // 注意「売買代金が少ない」: 直前の取引日の 終値 × 出来高 がこれ未満
export var DROP_TH = -0.05;       // 注意「大きく下がった」: 前日終値→今の値段 の騰落率がこれ以下
export var EXTENDED_SCORE = 60;   // 上がりきり度がこれ以上なら「すでに上昇」
var VOL_DAYS = 20, MA_P = 25, ATR_P = 14, STREAK_MAX = 5;
// 過去の日足（直前の取引日まで）に要る本数。PR #48 の「日足が27本に満たない銘柄は入れない」と同じ
export var MIN_DAILY_BARS = 27;
var CLOSE_TIME = "15:30";         // この時刻より前の値なら場中版
export var TACHIBANA_QUOTES_MAX = 300; // tachibana-server の /quotes が1回で受け付ける銘柄数の上限

export var MARKET_STATE_LABELS = { caution: "注意", extended: "すでに上昇", calm: "大きな動きなし", noData: "データ不足" };

// 上がりきり度の5部品（各0〜20点。lo 以下で0点、hi 以上で20点、その間は直線）。PR #48 の PARTS.intra と同じ
var PARTS = [
  { key: "change", lo: 0, hi: 0.05 },     // 前日終値→今の値段 の騰落率
  { key: "fromOpen", lo: 0, hi: 0.03 },   // 当日始値→今の値段 の騰落率
  { key: "liftAtr", lo: 0, hi: 1.0 },     // （今の値段 − 当日安値）÷ ATR（14日）
  { key: "maGap", lo: 0, hi: 0.10 },      // 25日移動平均からの離れ具合
  { key: "upStreak", lo: 0, hi: STREAK_MAX } // 連続で上がった日数（5日で頭打ち。1日4点）
];
function pts(x, p) {
  if (!(x > p.lo)) return 0;
  if (x >= p.hi) return 20;
  return (x - p.lo) / (p.hi - p.lo) * 20;
}

function isNum(v) { return typeof v === "number" && isFinite(v); }
function isPos(v) { return isNum(v) && v > 0; }
function pad2(n) { return (n < 10 ? "0" : "") + n; }
function round(v, d) { if (!isNum(v)) return null; var k = Math.pow(10, d); return Math.round(v * k) / k; }

// Unix ミリ秒 → 日本時間の {date:"YYYY-MM-DD", time:"HH:MM:SS", dow, min}
function jstParts(ms) {
  var j = new Date(ms + 9 * 60 * 60 * 1000);
  return {
    date: j.getUTCFullYear() + "-" + pad2(j.getUTCMonth() + 1) + "-" + pad2(j.getUTCDate()),
    time: pad2(j.getUTCHours()) + ":" + pad2(j.getUTCMinutes()) + ":" + pad2(j.getUTCSeconds()),
    dow: j.getUTCDay(),
    min: j.getUTCHours() * 60 + j.getUTCMinutes()
  };
}

// 立花の /quotes を呼んでよい時間か（日本時間の平日 9:00〜15:30。土日と東証の休場日は呼ばない）
export function isTachibanaQuoteTime(nowMs) {
  var n = jstParts(nowMs == null ? Date.now() : nowMs);
  if (n.dow === 0 || n.dow === 6 || JP_HOLIDAYS[n.date]) return false;
  return n.min >= 9 * 60 && n.min <= 15 * 60 + 30;
}

// /quotes の応答（{fetchedAt, quotes:[{code,price,time,prevClose,open,low}], missing}）を、
// calcMarketState に渡す形 {ok, fetchedAt, quotes:{code: 値}} にする。応答が無い・形が違うなら null
export function toTachibanaQuoteSet(json) {
  if (!json || !Array.isArray(json.quotes) || !json.fetchedAt) return null;
  var map = {};
  json.quotes.forEach(function (q) { if (q && q.code) map[String(q.code).toUpperCase()] = q; });
  return { ok: true, fetchedAt: String(json.fetchedAt), quotes: map };
}

// 立花の1銘柄分の値を {price, prevClose, open, low, date, time} にそろえる。使えなければ null
//   ・4つの値と約定時刻のどれかが null なら使わない（その銘柄は Yahoo で計算する）
//   ・約定時刻（tDPP:T）は「時:分」だけで日付が無いため、問い合わせた日の日付を付ける。
//     ただし問い合わせた時刻より後の約定時刻は、前の取引日の値（休場日・寄り付き前）なので使わない
function tachibanaQuote(tq, code) {
  if (!tq || !tq.ok || !tq.quotes || !tq.fetchedAt) return null;
  var q = tq.quotes[code.toUpperCase()];
  if (!q) return null;
  if (!isPos(q.price) || !isPos(q.prevClose) || !isPos(q.open) || !isPos(q.low)) return null;
  var m = /^(\d{1,2}):(\d{2})/.exec(String(q.time || ""));
  if (!m) return null;
  var date = String(tq.fetchedAt).slice(0, 10), fetchedHm = String(tq.fetchedAt).slice(11, 16);
  var time = pad2(Number(m[1])) + ":" + m[2];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || time > fetchedHm) return null;
  return { price: q.price, prevClose: q.prevClose, open: q.open, low: q.low, date: date, time: time + ":00" };
}

// api/stock.js の日足（{dates, opens, highs, lows, closes, volumes}）を、終値のある行だけの配列にする
function dailyRows(daily) {
  var out = [];
  if (!daily || !daily.dates || !daily.closes) return out;
  for (var i = 0; i < daily.dates.length; i++) {
    var c = daily.closes[i];
    if (!isPos(c) || !daily.dates[i]) continue;
    out.push({
      date: daily.dates[i], c: c,
      o: daily.opens ? daily.opens[i] : null,
      h: daily.highs ? daily.highs[i] : null,
      l: daily.lows ? daily.lows[i] : null,
      v: daily.volumes ? daily.volumes[i] : null
    });
  }
  return out;
}

// Yahoo の値を {price, prevClose, open, low, date, time} にそろえる。使えなければ null
//   ・時刻は regularMarketTime。始値・当日安値はその日の日足の行から取る
//   ・前日終値は公式の前営業日終値を優先し、無ければその日より前の最後の日足の終値
function yahooQuote(pd, rows) {
  if (!pd || !isNum(pd.marketTime) || !isPos(pd.currentPrice)) return null;
  var t = jstParts(pd.marketTime * 1000);
  var today = null, prev = null;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].date === t.date) today = rows[i];
    else if (rows[i].date < t.date) prev = rows[i];
  }
  var prevClose = isPos(pd.officialPrevClose) ? pd.officialPrevClose : (prev ? prev.c : null);
  return {
    price: pd.currentPrice, prevClose: prevClose,
    open: today ? today.o : null, low: today ? today.l : null,
    date: t.date, time: t.time
  };
}

// 過去の日足（最後の行が「直前の取引日」）から、部品と注意に使う値を出す。PR #48 の indicators と同じ計算
function pastStats(rows) {
  var n = rows.length, last = n - 1;
  // 値動きの荒さ: 直近20本の騰落率の標準偏差（n − 1 で割る）
  var s = 0, ss = 0;
  for (var m = last - VOL_DAYS + 1; m <= last; m++) {
    var r = rows[m].c / rows[m - 1].c - 1;
    s += r; ss += r * r;
  }
  var mu = s / VOL_DAYS;
  var vol = Math.sqrt(Math.max(0, (ss - VOL_DAYS * mu * mu) / (VOL_DAYS - 1)));
  // 25日移動平均（終値の単純平均）
  var sm = 0;
  for (var k = last - MA_P + 1; k <= last; k++) sm += rows[k].c;
  var ma25 = sm / MA_P;
  // ATR: 直近14本の真の値幅の単純平均。高値・安値の欠けがあれば出さない
  var st = 0, atr = null, okA = true;
  for (var a = last - ATR_P + 1; a <= last; a++) {
    var hh = rows[a].h, ll = rows[a].l, pc = rows[a - 1].c;
    if (!isNum(hh) || !isNum(ll)) { okA = false; break; }
    st += Math.max(hh - ll, Math.abs(hh - pc), Math.abs(ll - pc));
  }
  if (okA) atr = st / ATR_P;
  // 連続で上がった日数（終値が1つ前の日足の終値より高い日の連続。同じ値は途切れる）
  var streak = 0;
  for (var b = last; b >= 1 && rows[b].c > rows[b - 1].c; b--) streak++;
  // 売買代金: 直前の取引日の 終値 × 出来高
  var turnover = isNum(rows[last].v) ? rows[last].c * rows[last].v : null;
  return { vol: vol, ma25: ma25, atr: atr, streak: streak, turnover: turnover, lastDate: rows[last].date };
}

function noData(reason, base) {
  var o = base || {};
  return {
    state: "noData", label: MARKET_STATE_LABELS.noData, reason: reason,
    cautions: [], score: null, parts: null, checks: null,
    mode: o.mode || null, source: o.source || null, delayed: !!o.delayed, asOf: o.asOf || null
  };
}

// 1銘柄の状態を計算する。米国株は null
export function calcMarketState(stock, pd, tq) {
  var ticker = stock && stock.ticker ? String(stock.ticker) : "";
  if (!/\.T$/.test(ticker) || (stock.market && stock.market !== "JP")) return null;
  var rows = dailyRows(pd && pd.daily);

  // 今日の値: 立花の値がそろっていれば立花、それ以外は Yahoo
  var source = "tachibana";
  var q = tachibanaQuote(tq, ticker.replace(/\.T$/, ""));
  if (!q) { source = "yahoo"; q = yahooQuote(pd, rows); }
  if (!q) return noData("quote", { source: source });

  var mode = q.time.slice(0, 5) < CLOSE_TIME ? "intraday" : "close";
  var base = {
    mode: mode, source: source,
    delayed: mode === "intraday" && source === "yahoo", // 場中に Yahoo の値を使ったときだけ15分遅れ
    asOf: q.date + "T" + q.time + "+09:00"
  };
  if (!isPos(q.price) || !isPos(q.prevClose) || !isPos(q.open) || !isPos(q.low)) return noData("quote", base);

  // 過去の日足: 場中版は前日まで、引け後版はその日を含む（その日の行が無ければ足りない扱い）
  var past = rows.filter(function (r) { return mode === "intraday" ? r.date < q.date : r.date <= q.date; });
  if (mode === "close" && (!past.length || past[past.length - 1].date !== q.date)) return noData("daily", base);
  if (past.length < MIN_DAILY_BARS) return noData("daily", base);
  var ps = pastStats(past);
  if (ps.atr == null) return noData("daily", base);

  // 上がりきり度の5部品
  var lift = q.price - q.low;
  var values = [
    q.price / q.prevClose - 1,
    q.price / q.open - 1,
    ps.atr > 0 ? lift / ps.atr : (lift > 0 ? Infinity : 0), // ATR が 0 なら分子が正で20点、それ以外は0点（PR #48 と同じ）
    q.price / ps.ma25 - 1,
    Math.min(ps.streak, STREAK_MAX)
  ];
  var total = 0;
  var parts = PARTS.map(function (p, i) {
    var point = pts(values[i], p);
    total += point;
    return { key: p.key, value: isFinite(values[i]) ? round(values[i], 4) : null, points: round(point, 2) };
  });

  // 注意の3条件（当たったものをすべて記録する）
  var cautions = [];
  if (ps.vol >= ROUGH_TH) cautions.push("rough");
  if (!(ps.turnover >= MIN_TURNOVER)) cautions.push("lowTurnover");
  if (values[0] <= DROP_TH) cautions.push("bigDrop");

  var state = cautions.length ? "caution" : (total >= EXTENDED_SCORE ? "extended" : "calm");
  return {
    state: state, label: MARKET_STATE_LABELS[state], reason: null,
    cautions: cautions,
    // 合計点は小数第2位で切り捨てる（四捨五入だと 59.996 が 60.00 と表示され、判定と食い違うため）
    score: Math.floor(total * 100) / 100,
    parts: parts,
    checks: { volatility: round(ps.vol, 4), turnover: ps.turnover == null ? null : Math.round(ps.turnover), change: round(values[0], 4), pastDate: ps.lastDate },
    mode: base.mode, source: base.source, delayed: base.delayed, asOf: base.asOf
  };
}
