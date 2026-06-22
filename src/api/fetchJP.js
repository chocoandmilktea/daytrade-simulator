// api/fetchJP.js（Vercel Serverless Function）
// J-Quants 日足データ取得
// 将来の分足対応: ENABLE_MINUTE=true にするだけで切替可能な設計

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { code } = req.query;
  if (!code) return res.status(400).json({ error: "code is required" });

  const apiKey = process.env.JQUANTS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "JQUANTS_API_KEY not set" });

  // 将来の分足切替ポイント: true にするだけで分足を優先取得
  const ENABLE_MINUTE = false;

  try {
    if (ENABLE_MINUTE) {
      // 将来実装: 分足取得 → 失敗時に日足フォールバック
      const minuteData = await fetchMinute(code, apiKey);
      if (minuteData) return res.status(200).json(minuteData);
      // フォールバック（下の日足処理に続く）
    }

    const dailyData = await fetchDaily(code, apiKey);
    return res.status(200).json(dailyData);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── 日足取得 ─────────────────────────────────────────────────────────────────
async function fetchDaily(code, apiKey) {
  // J-Quants: codeは4桁（末尾0なし）
  const cleanCode = code.replace(/\.T$/, "").replace(/0$/, "");

  // 過去1年分（約252営業日）
  const toDate = getTodayJST();
  const fromDate = getDateBefore(365);

  const url = `https://api.jquants.com/v2/equities/bars/daily` +
    `?code=${cleanCode}&from=${fromDate}&to=${toDate}`;

  const res = await fetch(url, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error("J-Quants daily: " + res.status + " " + txt);
  }

  const json = await res.json();
  const bars = (json.data || []).filter(function (b) {
    return b.C != null && b.C > 0;
  });

  if (!bars.length) throw new Error("no daily data for " + cleanCode);

  // bars は日付昇順で返ってくる前提（降順の場合は reverse）
  const closes = bars.map(function (b) { return b.C || 0; });
  const highs = bars.map(function (b) { return b.H || b.C || 0; });
  const lows = bars.map(function (b) { return b.L || b.C || 0; });
  const volumes = bars.map(function (b) { return b.Vo || 0; });
  const last = bars[bars.length - 1];
  const prev = bars.length >= 2 ? bars[bars.length - 2] : null;

  return {
    code: cleanCode,
    closes: closes,
    highs: highs,
    lows: lows,
    volumes: volumes,
    currentPrice: last.C,
    previousClose: prev ? prev.C : last.O || last.C,
    real: true,
    dataType: "daily",
    dataWarn: null, // 日足のため警告なし（分足ならば "⚠️ 日足データ"）
  };
}

// ── 将来実装: 分足取得 ────────────────────────────────────────────────────────
async function fetchMinute(code, apiKey) {
  try {
    const cleanCode = code.replace(/\.T$/, "").replace(/0$/, "");
    const date = getTodayJST();
    const url = `https://api.jquants.com/v2/equities/bars/minute` +
      `?code=${cleanCode}&date=${date}`;

    const res = await fetch(url, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(10000),
    });

    // 403/402 → アドオン未契約 → フォールバック
    if (res.status === 403 || res.status === 402) return null;
    if (!res.ok) return null;

    const json = await res.json();
    const bars = (json.data || []).filter(function (b) { return b.C != null && b.C > 0; });
    if (!bars.length) return null;

    const closes = bars.map(function (b) { return b.C; });
    const highs = bars.map(function (b) { return b.H || b.C; });
    const lows = bars.map(function (b) { return b.L || b.C; });
    const volumes = bars.map(function (b) { return b.Vo || 0; });
    const last = bars[bars.length - 1];

    return {
      code: cleanCode,
      closes: closes,
      highs: highs,
      lows: lows,
      volumes: volumes,
      currentPrice: last.C,
      previousClose: bars[0].O || bars[0].C,
      real: true,
      dataType: "minute",
      dataWarn: null,
    };
  } catch (e) {
    return null; // 取得失敗 → 日足フォールバック
  }
}

// ── 日付ユーティリティ ────────────────────────────────────────────────────────
function getTodayJST() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

function getDateBefore(days) {
  const now = new Date();
  now.setDate(now.getDate() - days);
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}
