// api/weekly.js
// 25週線・75週線（週足の単純移動平均）を返すエンドポイント（チャートモーダルの基準線用）
// J-Quantsの日足データ(/v2/equities/bars/daily)を取得し、週足終値に集計してから
// 移動平均を計算する。株式分割・併合をまたぐケースがあるため、終値は調整済み
// 終値(AdjC)を使用する（未調整のCだと分割前後で不連続になりMAが歪むため）。
// 週足MAは1日の中でほぼ動かないため、サーバー側で24時間キャッシュする。
//
// 必要な環境変数: JQUANTS_API_KEY
// リクエスト例: /api/weekly?ticker=7203.T
// レスポンス例: { "ma25": 2650.4, "ma75": 2480.1, "weeks": 92 }
//   ※ 上場から日が浅く必要な週数に満たない場合は、該当するMAをnullで返す

var CACHE = {}, TTL = 24 * 60 * 60 * 1000; // 24時間

function formatDateCompact(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

// 日足バー配列(Date昇順)から、週（月曜始まり）ごとの最終営業日の終値を抽出する
function toWeeklyCloses(dailyBars) {
  const weekly = [];
  let curKey = null, lastClose = null;
  for (const bar of dailyBars) {
    const d = new Date(bar.Date + "T00:00:00Z");
    const dow = d.getUTCDay() || 7; // 月=1 ... 日=7
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - dow + 1);
    const weekKey = monday.toISOString().slice(0, 10);
    if (weekKey !== curKey) {
      if (curKey !== null) weekly.push(lastClose);
      curKey = weekKey;
    }
    lastClose = bar.AdjC != null ? bar.AdjC : bar.C;
  }
  if (curKey !== null) weekly.push(lastClose);
  return weekly;
}

function sma(arr, n) {
  if (arr.length < n) return null;
  const slice = arr.slice(arr.length - n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const ticker = req.query.ticker;
  if (!ticker) {
    return res.status(400).json({ error: "ticker is required" });
  }
  const code = String(ticker).replace(".T", "");

  const now = Date.now();
  if (CACHE[code] && now - CACHE[code].ts < TTL) {
    return res.status(200).json(CACHE[code].data);
  }

  try {
    const apiKey = process.env.JQUANTS_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "JQUANTS_API_KEY not set" });
    }

    const today = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 600); // 約85週分、休場日込みで余裕を持たせる

    const url = `https://api.jquants.com/v2/equities/bars/daily?code=${code}&from=${formatDateCompact(from)}&to=${formatDateCompact(today)}`;
    const r = await fetch(url, { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(9000) });
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`J-Quants ${r.status}: ${errText}`);
    }
    const json = await r.json();
    const bars = (json.data || []).slice().sort(function(a, b) { return a.Date < b.Date ? -1 : 1; });
    if (bars.length === 0) throw new Error("no daily data");

    const weeklyCloses = toWeeklyCloses(bars);
    const data = { ma25: sma(weeklyCloses, 25), ma75: sma(weeklyCloses, 75), weeks: weeklyCloses.length };

    CACHE[code] = { ts: now, data: data };
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
