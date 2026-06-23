// calc/score.js
// スキャルピング・デイトレ特化スコア計算（日足ベース）
// BBグラフ: 15分足データがあれば優先使用（過去2日間）、なければ日足60本にフォールバック

// ── 指標計算ユーティリティ ───────────────────────────────────────────────────

function calcSMA(arr, p) {
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    if (i < p - 1) { out.push(null); continue; }
    var s = 0;
    for (var j = i - p + 1; j <= i; j++) s += arr[j];
    out.push(s / p);
  }
  return out;
}

function calcRSI(arr, p) {
  p = p || 14;
  var out = [];
  for (var x = 0; x < p; x++) out.push(null);
  var ag = 0, al = 0;
  for (var i = 1; i <= p; i++) {
    var d = arr[i] - arr[i - 1];
    if (d >= 0) ag += d; else al -= d;
  }
  ag /= p; al /= p;
  out.push(100 - 100 / (1 + ag / (al || 1e-9)));
  for (var j = p + 1; j < arr.length; j++) {
    var diff = arr[j] - arr[j - 1];
    ag = (ag * (p - 1) + Math.max(diff, 0)) / p;
    al = (al * (p - 1) + Math.max(-diff, 0)) / p;
    out.push(100 - 100 / (1 + ag / (al || 1e-9)));
  }
  return out;
}

function calcBB(arr, p, k) {
  p = p || 20; k = k || 2;
  return arr.map(function (_, i) {
    if (i < p - 1) return null;
    var sl = arr.slice(i - p + 1, i + 1);
    var m = sl.reduce(function (a, b) { return a + b; }, 0) / p;
    var sd = Math.sqrt(sl.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / p);
    return { upper: m + k * sd, mid: m, lower: m - k * sd };
  });
}

// ── モメンタム計算（線形回帰の傾き） ──────────────────────────────────────────
function calcMomentum(closes, n) {
  n = n || 5;
  if (closes.length < n) return 0;
  var sl = closes.slice(-n);
  var sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (var i = 0; i < n; i++) {
    sumX += i; sumY += sl[i];
    sumXY += i * sl[i]; sumX2 += i * i;
  }
  var denom = n * sumX2 - sumX * sumX;
  return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
}

// ── 出来高急増率 ─────────────────────────────────────────────────────────────
function calcVolumeSurge(volumes) {
  if (!volumes || volumes.length < 2) return 0;
  var recent = volumes.slice(-21, -1);
  if (recent.length === 0) return 0;
  var avg = recent.reduce(function (a, b) { return a + b; }, 0) / recent.length;
  var cur = volumes[volumes.length - 1];
  return avg > 0 ? cur / avg : 0;
}

// ── ATR計算 ──────────────────────────────────────────────────────────────────
function calcATR(closes, highs, lows, p) {
  p = p || 14;
  var len = Math.min(p, closes.length - 1);
  var sum = 0;
  for (var i = closes.length - len; i < closes.length; i++) {
    var h = highs[i] || closes[i], l = lows[i] || closes[i], pc = closes[i - 1];
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return len > 0 ? sum / len : closes[closes.length - 1] * 0.02;
}

// ── メインスコア計算 ─────────────────────────────────────────────────────────
// input:
//   stock   : { ticker, name, market, tvSymbol }
//   pd      : { closes, highs, lows, volumes, currentPrice, previousClose, real,
//               minuteCloses, minuteHighs, minuteLows, minuteVolumes }
// output:
//   銘柄スコアオブジェクト
export function analyzeStock(stock, pd) {
  var closes = pd.closes.slice();
  var highs = pd.highs ? pd.highs.slice() : closes.slice();
  var lows = pd.lows ? pd.lows.slice() : closes.slice();
  var volumes = pd.volumes ? pd.volumes.slice() : [];
  var n = closes.length - 1;
  if (n < 1) return null;

  var price = pd.currentPrice || closes[n];
  var prevClose = pd.previousClose || closes[n - 1] || price;
  var change = prevClose ? ((price - prevClose) / prevClose * 100).toFixed(2) : "0.00";
  var isJP = stock.market === "JP";
  var dispPrice = isJP ? "¥" + Math.round(price).toLocaleString() : "$" + price.toFixed(2);

  // ── 52週レンジ（日足ベース） ────────────────────────────────────────────────
  var yearData = closes.slice(-252);
  var high52 = yearData.length > 0 ? Math.max.apply(null, yearData) : price;
  var low52 = yearData.length > 0 ? Math.min.apply(null, yearData) : price;
  var range52 = high52 - low52 || 1;
  var position52 = (price - low52) / range52 * 100;
  var fromHigh = high52 > 0 ? (price - high52) / high52 * 100 : 0;
  var fromLow = low52 > 0 ? (price - low52) / low52 * 100 : 0;

  // ── 指標計算（日足ベース） ──────────────────────────────────────────────────
  var rsiArr = calcRSI(closes, 14);
  var rsiVal = rsiArr[n] || 50;
  var bbArr = calcBB(closes, 20, 2);
  var bbVal = bbArr[n];
  var momentum = calcMomentum(closes, 5);
  var momentumPlus = momentum > 0;
  var surge = calcVolumeSurge(volumes);
  var ma5 = calcSMA(closes, 5);
  var ma25 = calcSMA(closes, 25);

  var sc = 0;
  var signals = [];

  // ── [1] 価格モメンタム（35点） ───────────────────────────────────────────────
  if (momentumPlus) {
    sc += 35;
    signals.push({ label: "モメンタム", val: "上昇方向", state: 1 });
  } else {
    sc += 0;
    signals.push({ label: "モメンタム", val: "下降方向", state: -1 });
  }

  // ── [2] BB（30点） ───────────────────────────────────────────────────────────
  if (bbVal) {
    var bbRange = bbVal.upper - bbVal.lower || 1;
    var bbPos = (price - bbVal.lower) / bbRange;
    if (price <= bbVal.lower) {
      sc += 30;
      signals.push({ label: "BB", val: "下限以下→反発", state: 1 });
    } else if (bbPos < 0.2) {
      sc += 22;
      signals.push({ label: "BB", val: "下位20%以内", state: 1 });
    } else if (price >= bbVal.upper) {
      sc -= 15;
      signals.push({ label: "BB", val: "上限→過熱", state: -1 });
    } else if (bbPos >= 0.8) {
      sc += 3;
      signals.push({ label: "BB", val: "上位80%以上", state: 0 });
    } else {
      sc += 10;
      signals.push({ label: "BB", val: "バンド内（中立）", state: 0 });
    }
  }

  // ── [3] 出来高急増（20点） ───────────────────────────────────────────────────
  var surgeLabel = surge > 0 ? surge.toFixed(1) + "倍" : "─";
  if (surge >= 2.0) {
    sc += 20;
    signals.push({ label: "出来高", val: surgeLabel + "（急増）", state: 1 });
  } else if (surge >= 1.5) {
    sc += 10;
    signals.push({ label: "出来高", val: surgeLabel + "（増加）", state: 1 });
  } else {
    sc += 0;
    signals.push({ label: "出来高", val: surge > 0 ? surgeLabel : "データなし", state: 0 });
  }

  // ── [4] RSI（15点） ──────────────────────────────────────────────────────────
  var rsiLabel = "RSI(" + rsiVal.toFixed(1) + ")";
  if (rsiVal <= 30) {
    sc += 15;
    signals.push({ label: rsiLabel, val: "売られすぎ", state: 1 });
  } else if (rsiVal <= 40) {
    sc += 10;
    signals.push({ label: rsiLabel, val: "やや売られ", state: 1 });
  } else if (rsiVal <= 60) {
    sc += 5;
    signals.push({ label: rsiLabel, val: "中立", state: 0 });
  } else if (rsiVal <= 70) {
    sc += 2;
    signals.push({ label: rsiLabel, val: "やや強め", state: 0 });
  } else {
    sc -= 10;
    signals.push({ label: rsiLabel, val: "買われすぎ", state: -1 });
  }

  // ── スコア範囲クリップ（0〜100） ─────────────────────────────────────────────
  sc = Math.min(100, Math.max(0, sc));

  // ── BUY判定 ──────────────────────────────────────────────────────────────────
  var timing;
  if (sc >= 65 && momentumPlus && surge >= 1.5) {
    timing = "BUY";
  } else if (sc >= 50 && !(!momentumPlus)) {
    timing = "WATCH";
  } else if (!momentumPlus) {
    timing = "SKIP";
  } else if (sc <= 49) {
    timing = "SKIP";
  } else {
    timing = "WATCH";
  }

  // ── ATR・サポート ────────────────────────────────────────────────────────────
  var atr = calcATR(closes, highs, lows, 14);
  var atrIsJP = isJP;
  var atrRound = function (v) { return atrIsJP ? Math.round(v) : parseFloat(v.toFixed(2)); };
  var atrUpper = atrRound(price + atr);
  var atrLower = atrRound(price - atr);

  var support = null;
  if (lows.length >= 20) {
    var validLows = lows.filter(function (v) { return v != null && v > 0 && isFinite(v); });
    var s1v = validLows.length >= 20 ? Math.min.apply(null, validLows.slice(-20)) : null;
    var s2v = validLows.length >= 1 ? Math.min.apply(null, validLows.slice(-60)) : null;
    if (s1v !== null && s2v !== null) {
      support = {
        s1: atrRound(s1v),
        s2: atrRound(s2v),
        atrFloor: atrRound(price - atr * 1.5)
      };
    }
  }

  // ── BBグラフ用データ ─────────────────────────────────────────────────────────
  // 15分足データがあれば優先使用（過去2日間・約52本）
  // なければ日足60本にフォールバック
  var hasMinute = pd.minuteCloses && pd.minuteCloses.length >= 20;
  var gCloses = hasMinute ? pd.minuteCloses : closes.slice(-60);

  var graphCloses = gCloses;
  var graphBB     = calcBB(gCloses, 20, 2);
  var graphMA5    = calcSMA(gCloses, 5);
  var graphMA25   = calcSMA(gCloses, 25);
  var graphIsMinute = hasMinute; // BBグラフのデータ種別フラグ

  return {
    // 基本情報
    ticker: stock.ticker,
    tvSymbol: stock.tvSymbol,
    name: stock.name,
    market: stock.market,
    // 価格
    price: dispPrice,
    rawPrice: price,
    change: change,
    real: pd.real,
    dataWarn: pd.dataWarn || null,
    // スコア
    score: sc,
    timing: timing,
    signals: signals,
    // モメンタム
    momentumPlus: momentumPlus,
    surge: surge,
    // 52週
    high52: high52,
    low52: low52,
    fromHigh: fromHigh,
    fromLow: fromLow,
    position52: position52,
    // ATR
    atr: atrRound(atr),
    atrUpper: atrUpper,
    atrLower: atrLower,
    support: support,
    // BBグラフ用データ
    graphCloses:   graphCloses,
    graphBB:       graphBB,
    graphMA5:      graphMA5,
    graphMA25:     graphMA25,
    graphIsMinute: graphIsMinute, // trueなら15分足、falseなら日足
    // 閲覧用URL
    yahooUrl: isJP
      ? "https://finance.yahoo.co.jp/quote/" + stock.ticker
      : "https://finance.yahoo.com/quote/" + stock.ticker,
  };
}
