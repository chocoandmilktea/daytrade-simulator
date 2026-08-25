// api/premarket.js
// 「今朝の地合い」を1レスポンスで返すエンドポイント（寄り付きギャップ予想の材料）。
// 日経225先物・ドル円・VIX・SOX指数・米国主要指数の前日比%を集め、加重平均して
// marketBias（今朝の想定ギャップ%）を算出する。全銘柄で共通の値なので1回呼べばよい。
//
// リクエスト例:
//   /api/premarket        → { marketBias, indicators, missing, ts, cached }
//
// データ取得元: Yahoo Finance（daily.js / intraday.js と同じ非公式チャートAPI）
//
// ※Phase 2 で立花証券の「寄り前気配」を材料に加える予定のため、
// 　地合いの取得部分は fetchMarketSentiment() に切り出してある。
// 　気配を足すときは fetchMarketSentiment() の中だけを触ればよい構造にしている。

const YAHOO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

// ── 調整可能な定数 ────────────────────────────────────────────────────
// weight = 総合判断でのその指標の重み（取得できたものだけで正規化するため合計1でなくてもよい）
// coef   = その指標が1%動いた時、日本株の寄り付きギャップが何%動くと見るか（感応度）
//          VIXは「上がると株安」なのでマイナス。
// symbols = Yahooのシンボル。先頭から順に試し、取れたものを採用する（予備シンボル対応）
const MARKET_INDICATORS = [
  { key: "nk225f", label: "日経225先物", symbols: ["NIY=F", "NKD=F"], weight: 0.45, coef: 1.00 },
  { key: "sox",    label: "SOX指数",     symbols: ["^SOX", "SOXX"],   weight: 0.15, coef: 0.35 },
  { key: "sp500",  label: "S&P500",      symbols: ["^GSPC"],          weight: 0.12, coef: 0.50 },
  { key: "nasdaq", label: "NASDAQ",      symbols: ["^IXIC"],          weight: 0.10, coef: 0.50 },
  { key: "usdjpy", label: "ドル円",      symbols: ["JPY=X"],          weight: 0.08, coef: 0.30 },
  { key: "vix",    label: "VIX",         symbols: ["^VIX"],           weight: 0.07, coef: -0.05 },
  { key: "dow",    label: "NYダウ",      symbols: ["^DJI"],           weight: 0.03, coef: 0.30 },
];

const MARKET_BIAS_LIMIT = 3;         // marketBiasの上限・下限（±3%を超える想定はしない）
const PREMARKET_TTL = 3 * 60 * 1000; // Vercel側のプロセス内メモリキャッシュ（3分）。対象はYahoo由来の地合いデータ（marketBias / indicators）のみで、立花の /market-price（寄り前気配）はキャッシュしない
const FETCH_TIMEOUT = 8000;          // 1シンボルあたりの取得タイムアウト（ミリ秒）

// ── Yahooから1シンボル分の前日比を取得 ────────────────────────────────
// 日足5日分を取り、「現在値 ÷ 前営業日終値 - 1」で前日比%を出す。
// 先物・米国指数は日本の朝の時点で当日分（＝夜間の値動き）が入っているため、
// これがそのまま「今朝までにどれだけ動いたか」になる。
async function fetchSymbolChange(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const r = await fetch(url, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!r.ok) throw new Error(`${symbol} ${r.status}`);

  const json = await r.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`${symbol}: データなし`);

  const meta = result.meta || {};
  // null（休場日など）を除いた終値だけを並べる
  const closes = (result.indicators?.quote?.[0]?.close || []).filter((v) => v != null && !isNaN(v));
  if (closes.length < 2) throw new Error(`${symbol}: 終値が足りません`);

  // 前営業日終値は「最後から2番目の日足」。最後の日足は当日（形成中）のバーなので使わない
  const prevClose = closes[closes.length - 1 - 1];
  // 現在値はYahoo公式のmeta値を優先（形成中バーの終値より新しいことがある）
  const price = meta.regularMarketPrice != null ? meta.regularMarketPrice : closes[closes.length - 1];
  if (!(prevClose > 0) || !(price > 0)) throw new Error(`${symbol}: 価格が不正`);

  return {
    symbol: symbol,
    price: price,
    prevClose: prevClose,
    changePct: (price / prevClose - 1) * 100,
  };
}

// 予備シンボルを順に試す（^SOXが落ちている時はSOXXで代用する等）
async function fetchIndicator(ind) {
  let lastErr = null;
  for (const symbol of ind.symbols) {
    try {
      const q = await fetchSymbolChange(symbol);
      return {
        key: ind.key,
        label: ind.label,
        symbol: q.symbol,
        price: Math.round(q.price * 100) / 100,
        prevClose: Math.round(q.prevClose * 100) / 100,
        changePct: Math.round(q.changePct * 1000) / 1000,
        weight: ind.weight,
        coef: ind.coef,
        // この指標が想定ギャップに何%寄与しているか（内訳表示用）
        contribution: Math.round(q.changePct * ind.coef * 1000) / 1000,
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(`${ind.key}: 取得失敗`);
}

// ── 想定ギャップ（marketBias）の算出 ──────────────────────────────────
// 取得できた指標だけで加重平均する（重みの合計で割るので、欠けても比率は崩れない）。
function computeMarketBias(indicators) {
  let sumW = 0, sum = 0;
  indicators.forEach((x) => {
    sumW += x.weight;
    sum += x.weight * x.changePct * x.coef;
  });
  if (sumW <= 0) return null;
  const bias = sum / sumW;
  // 極端な値は丸める（寄り前に±3%を超える想定はしない）
  const clamped = Math.max(-MARKET_BIAS_LIMIT, Math.min(MARKET_BIAS_LIMIT, bias));
  return Math.round(clamped * 1000) / 1000;
}

// ── 地合いの取得（Phase 2で立花証券の寄り前気配を足す場所）────────────
// ここだけを差し替えれば材料を追加できるよう、handlerから独立させてある。
// 追加時は indicators に同じ形（key/label/changePct/weight/coef/contribution）で
// 気配ベースの項目を push すれば、marketBiasの計算式はそのまま使える。
async function fetchMarketSentiment() {
  const settled = await Promise.allSettled(MARKET_INDICATORS.map(fetchIndicator));

  const indicators = [];
  const missing = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") indicators.push(s.value);
    else missing.push({ key: MARKET_INDICATORS[i].key, label: MARKET_INDICATORS[i].label, reason: s.reason?.message || "取得失敗" });
  });

  return {
    marketBias: computeMarketBias(indicators),
    indicators: indicators,
    missing: missing,
  };
}

// ── 立花証券の寄り前気配（codes指定時のみ）────────────────────────────
// tachibana-server の /market-price をそのまま中継する。どのカラムが実際に返るかを
// 明朝実測するのが目的なので、戻り値は加工せずそのまま quotes に載せる。
async function fetchQuotes(codes, cols) {
  // 専用の環境変数が無ければ /ranking-data のURLからパスを差し替えて使う
  const apiUrl = process.env.TACHIBANA_MARKET_PRICE_API
    || (process.env.TACHIBANA_RANKING_API || "").replace("/ranking-data", "/market-price");
  if (!apiUrl) throw new Error("TACHIBANA_MARKET_PRICE_API not set");

  const headers = {};
  if (process.env.TACHIBANA_RELAY_SECRET) headers["X-Relay-Secret"] = process.env.TACHIBANA_RELAY_SECRET;

  let url = `${apiUrl}?code=${encodeURIComponent(codes)}`;
  if (cols) url += `&cols=${encodeURIComponent(cols)}`;

  const r = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  const json = await r.json().catch(() => null);
  // 立花側のエラーも握りつぶさず、そのまま呼び出し元に返す
  if (!r.ok) return { error: `market-price ${r.status}`, ...(json || {}) };
  return json;
}

// 3分キャッシュ（サーバーレス関数のインスタンスが生きている間だけ有効）。
// クエリごとに内容が変わるため、codes と cols を含めたキーで分ける。
// quotes（寄り前気配）はキャッシュせず毎回取りに行く。
let cache = {}; // cacheKey -> { data, ts }

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const now = Date.now();
    const codes = req.query?.codes ? String(req.query.codes) : "";
    const cols = req.query?.cols ? String(req.query.cols) : "";
    const cacheKey = `${codes}|${cols}`;

    // codes指定時のみ寄り前気配を取得（キャッシュせず毎回取りに行く）
    let quotes = null;
    if (codes) {
      try {
        quotes = await fetchQuotes(codes, cols);
      } catch (e) {
        quotes = { error: e.message };
      }
      // 気配は秒単位で変わるためCDN・ブラウザにも一切キャッシュさせない
      res.setHeader("Cache-Control", "no-store");
    } else {
      res.setHeader("Cache-Control", "public, max-age=180");
    }

    const hit = cache[cacheKey];
    if (hit && now - hit.ts < PREMARKET_TTL) {
      return res.status(200).json({ ...hit.data, cached: true, ...(codes ? { quotes: quotes } : {}) });
    }

    const sentiment = await fetchMarketSentiment();
    // 1つも取れなかった場合はキャッシュせず、次の呼び出しで取り直す
    if (!sentiment.indicators.length) {
      return res.status(200).json({ marketBias: null, indicators: [], missing: sentiment.missing, ts: now, cached: false, ...(codes ? { quotes: quotes } : {}) });
    }

    const data = { ...sentiment, ts: now };
    cache[cacheKey] = { data: data, ts: now };

    return res.status(200).json({ ...data, cached: false, ...(codes ? { quotes: quotes } : {}) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
