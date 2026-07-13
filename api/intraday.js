// api/intraday.js
// 当日（休場日なら直近の取引日）の株価分足を返すエンドポイント
// （カードのミニチャート/チャートモーダル用）
//
// データ取得元: Yahoo Finance（非公式チャートAPI）
//   理由: J-Quantsの分足アドオンは「日次更新・16:30頃」にしか発行されないため、
//   取引時間中は前営業日のデータしか取得できなかった。Yahoo Financeは取引時間中
//   でも当日の分足を返す（公称15〜20分程度の遅延はある）。
//   JPだけでなくUS銘柄も同じエンドポイントでそのまま取得できる副次的な利点もある。
//
// リクエスト例: /api/intraday?ticker=7203.T
// レスポンス: { m1:{closes,times}, date }
//   date は実際にデータが取れた日（JST, YYYY-MM-DD）

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
  const closes = result.indicators?.quote?.[0]?.close || [];
  const bars = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    if (closes[i] == null) continue;
    bars.push({ epoch: result.timestamp[i], close: closes[i] });
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
    // まず当日分(range=1d)を試す。休場日等で空なら5日分に広げて直近営業日を拾う。
    let { bars, status } = await fetchYahooChart(ticker, "1d");
    if (status === 429) {
      return res.status(200).json({ m1: { closes: [], times: [] }, date: null, rateLimited: true });
    }
    if (bars.length === 0) {
      const wider = await fetchYahooChart(ticker, "5d");
      if (wider.status === 429) {
        return res.status(200).json({ m1: { closes: [], times: [] }, date: null, rateLimited: true });
      }
      bars = wider.bars;
    }
    if (bars.length === 0) {
      return res.status(200).json({ m1: { closes: [], times: [] }, date: null });
    }

    // JSTに変換した上で、最後（最新）の営業日の分だけに絞る
    const withJst = bars.map((b) => ({ ...toJst(b.epoch), close: b.close }));
    const latestDate = withJst[withJst.length - 1].date;
    const todayBars = withJst.filter((b) => b.date === latestDate);

    // 1分足（チャートモーダル用）：そのまま抽出
    const closes1 = todayBars.map((b) => b.close);
    const times1 = todayBars.map((b) => b.time);

    // ブラウザ側の短時間キャッシュ用ヘッダー（同一分内の再取得を減らす）
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.status(200).json({
      m1: { closes: closes1, times: times1 },
      date: latestDate,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
