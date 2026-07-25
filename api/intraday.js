// api/intraday.js
// 直近5営業日分の株価1分足を返すエンドポイント
// （詳細パネルの5分足ローソクチャート用。直近2時間を初期表示し、過去分はスクロールで確認する想定）
//
// データ取得元: Yahoo Finance（非公式チャートAPI）
//   理由: J-Quantsの分足アドオンは「日次更新・16:30頃」にしか発行されないため、
//   取引時間中は前営業日のデータしか取得できなかった。Yahoo Financeは取引時間中
//   でも当日の分足を返す（公称15〜20分程度の遅延はある）。
//   JPだけでなくUS銘柄も同じエンドポイントでそのまま取得できる副次的な利点もある。
//
// リクエスト例: /api/intraday?ticker=7203.T
// レスポンス: { m1:{opens,highs,lows,closes,times,volumes,dates}, date }
//   date は最新営業日（JST, YYYY-MM-DD）。datesは各1分足がどの日のものかを示す配列（同じ長さ）。

const YAHOO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

async function fetchYahooChart(ticker, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=${range}`;
  const r = await fetch(url, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(9000) });
  if (!r.ok) return { bars: [], status: r.status };
  const json = await r.json();
  const result = json?.chart?.result?.[0];
  if (!result || !result.timestamp) return { bars: [], status: r.status };
  const quote = result.indicators?.quote?.[0] || {};
  const closes = quote.close || [];
  const opens = quote.open || [];
  const highs = quote.high || [];
  const lows = quote.low || [];
  const volumes = quote.volume || [];
  const bars = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    if (closes[i] == null) continue;
    // open/high/low が欠けている場合はcloseで代用（ローソク足が細い実体・ヒゲなしになる）
    const close = closes[i];
    const open = opens[i] != null ? opens[i] : close;
    const high = highs[i] != null ? highs[i] : Math.max(open, close);
    const low = lows[i] != null ? lows[i] : Math.min(open, close);
    const volume = volumes[i] != null ? volumes[i] : 0;
    bars.push({ epoch: result.timestamp[i], open, high, low, close, volume });
  }
  return { bars, status: r.status };
}

// epoch秒 -> JSTでの{date, time}に変換
function toJst(epochSeconds) {
  const d = new Date(epochSeconds * 1000 + 9 * 60 * 60 * 1000); // JSTへシフト
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return { date: `${y}-${m}-${day}`, time: `${hh}:${mm}` };
}

export default async function handler(req, res) {
  // 別ドメイン（アプリ本体）からのfetchを許可するCORSヘッダー
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const ticker = req.query.ticker;
  if (!ticker) {
    return res.status(400).json({ error: "ticker is required" });
  }

  try {
    // 直近5営業日分の1分足をまとめて取得する（以前は当日分のみで、5日分は
    // 休場日フォールバック時にしか使っていなかった。詳細パネルのスクロール
    // チャート化に合わせて、常に5日分を返すようにした）。
    let { bars, status } = await fetchYahooChart(ticker, "5d");
    if (status === 429) {
      return res.status(200).json({ m1: { opens: [], highs: [], lows: [], closes: [], times: [], volumes: [], dates: [] }, date: null, rateLimited: true });
    }
    if (bars.length === 0) {
      return res.status(200).json({ m1: { opens: [], highs: [], lows: [], closes: [], times: [], volumes: [], dates: [] }, date: null });
    }

    // JSTに変換。以前は最新営業日だけに絞っていたが、5日分すべてをそのまま返す
    const withJst = bars.map((b) => ({ ...toJst(b.epoch), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
    const latestDate = withJst[withJst.length - 1].date;

    // 1分足（チャートモーダル用・ローソク足描画用にOHLC＋出来高＋日付）
    const opens1 = withJst.map((b) => b.open);
    const highs1 = withJst.map((b) => b.high);
    const lows1 = withJst.map((b) => b.low);
    const closes1 = withJst.map((b) => b.close);
    const times1 = withJst.map((b) => b.time);
    const volumes1 = withJst.map((b) => b.volume);
    const dates1 = withJst.map((b) => b.date); // 各足がどの日のものかをフロント側で表示するため

    // ブラウザ側の短時間キャッシュ用ヘッダー（同一分内の再取得を減らす）
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.status(200).json({
      m1: { opens: opens1, highs: highs1, lows: lows1, closes: closes1, times: times1, volumes: volumes1, dates: dates1 },
      date: latestDate,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
