// api/intraday.js
// 当日（休場日なら直近の取引日）の株価5分足を返すエンドポイント（カードのミニチャート用）
// J-Quants API (/v2/equities/bars/minute) は「1分足」を返すので、ここで5本ごとに
// まとめて疑似的な「5分足の終値」を作る。
//
// 必要な環境変数（Vercelのプロジェクト設定 > Environment Variables で設定）:
//   JQUANTS_API_KEY = J-Quantsダッシュボードで発行したAPIキー
//
// リクエスト例: /api/intraday?ticker=7203.T
// レスポンス例: { "closes": [2810, 2812, ...], "date": "2026-07-10" }
//   ※ date は実際にデータが取れた日（土日・休場日は自動的に直近の取引日に遡る）

function formatDateCompact(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`; // J-Quantsへのリクエスト用 (YYYYMMDD)
}
function formatDateIso(compact) {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

async function fetchMinuteBars(code, dateCompact, apiKey) {
  const url = `https://api.jquants.com/v2/equities/bars/minute?code=${encodeURIComponent(code)}&date=${dateCompact}`;
  const r = await fetch(url, { headers: { "x-api-key": apiKey } });
  if (!r.ok) return [];
  const json = await r.json();
  return json.data || [];
}

// 土日をスキップしながら日付を遡り、データが取れる最初の日（＝直近の取引日）を探す。
// 祝日・年末年始などで連続で休場になっているケースも考慮し、最大5営業日分試す。
async function findLatestBars(code, apiKey, maxAttempts) {
  var cursor = new Date();
  var attempts = 0;
  while (attempts < maxAttempts) {
    var dow = cursor.getDay(); // 0=日, 6=土
    if (dow !== 0 && dow !== 6) {
      attempts++;
      var dateCompact = formatDateCompact(cursor);
      var bars = await fetchMinuteBars(code, dateCompact, apiKey);
      if (bars.length > 0) return { bars: bars, date: formatDateIso(dateCompact) };
    }
    cursor.setDate(cursor.getDate() - 1);
  }
  return { bars: [], date: null };
}

export default async function handler(req, res) {
  const ticker = req.query.ticker;
  if (!ticker) {
    return res.status(400).json({ error: "ticker is required" });
  }

  // "7203.T" -> "7203"（J-Quantsは末尾の".T"を付けない銘柄コード）
  const code = String(ticker).replace(".T", "");

  try {
    const apiKey = process.env.JQUANTS_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "JQUANTS_API_KEY not set" });
    }

    const found = await findLatestBars(code, apiKey, 5);
    if (!found.date) {
      return res.status(200).json({ closes: [], date: null });
    }

    // 5本（5分）ごとにグループ化し、各グループの最後の終値(C)を5分足の終値とする
    const closes = [];
    for (let i = 0; i < found.bars.length; i += 5) {
      const group = found.bars.slice(i, i + 5);
      const last = group[group.length - 1];
      if (last && typeof last.C === "number") closes.push(last.C);
    }

    // ブラウザ側の短時間キャッシュ用ヘッダー（同一分内の再取得を減らす）
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.status(200).json({ closes: closes, date: found.date });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

