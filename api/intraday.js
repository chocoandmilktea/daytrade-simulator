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
  if (!r.ok) {
    let bodyText = "";
    try { bodyText = (await r.text()).slice(0, 200); } catch (e) {}
    return { bars: [], status: r.status, body: bodyText };
  }
  const json = await r.json();
  return { bars: json.data || [], status: r.status, body: "" };
}

// 土日をスキップしながら日付を遡り、データが取れる最初の日（＝直近の取引日）を探す。
// 祝日・年末年始などで連続で休場になっているケースも考慮し、最大5営業日分試す。
// うまく見つからなかった場合のために、各試行のHTTPステータスもattemptsとして残す（原因調査用）。
// 土日をスキップしながら日付を遡り、データが取れる最初の日（＝直近の取引日）を探す。
// 祝日・年末年始などで連続で休場になっているケースも考慮し、最大3営業日分試す。
// 重要：429（アクセスしすぎ）が返ってきた場合は「その日はデータが無かった」と誤解して
// 前の日を連続で試すと雪だるま式に悪化するため、即座に諦めて呼び出し元に伝える。
//
// 注意：ここでの試行間隔(INTERNAL_RETRY_INTERVAL)は、呼び出し元(App.js)のキュー間隔とは
// 別枠でJ-Quantsにアクセスすることになる。間隔が短すぎると、1銘柄のフォールバック探索
// だけで短時間にリクエストが集中し、全体のレート制限(60件/分)を瞬間的に超える原因になる
// ため、他の待機と同程度の間隔を空けている。
const INTERNAL_RETRY_INTERVAL = 1000; // 300ms→1000msに拡大（バースト対策）

async function findLatestBars(code, apiKey, maxAttempts) {
  var cursor = new Date();
  var attempts = 0;
  var log = [];
  while (attempts < maxAttempts) {
    var dow = cursor.getDay(); // 0=日, 6=土
    if (dow !== 0 && dow !== 6) {
      if (attempts > 0) await new Promise((r) => setTimeout(r, INTERNAL_RETRY_INTERVAL)); // 連続アクセス防止
      attempts++;
      var dateCompact = formatDateCompact(cursor);
      var r = await fetchMinuteBars(code, dateCompact, apiKey);
      log.push({ date: formatDateIso(dateCompact), status: r.status, body: r.body });
      if (r.status === 429) {
        return { bars: [], date: null, log: log, rateLimited: true };
      }
      if (r.bars.length > 0) return { bars: r.bars, date: formatDateIso(dateCompact), log: log };
    }
    cursor.setDate(cursor.getDate() - 1);
  }
  return { bars: [], date: null, log: log };
}

export default async function handler(req, res) {
  // 別ドメイン（アプリ本体）からのfetchを許可するCORSヘッダー
  // これが無いと、ブラウザのアドレスバーで直接開いた時は見えるのに
  // アプリのJavaScriptからのfetchだけが黙って失敗する（今回のバグの原因）
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

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

    const found = await findLatestBars(code, apiKey, 3);
    if (!found.date) {
      // データが1件も見つからなかった場合は、原因調査用に各試行の結果を含めて返す
      return res.status(200).json({ m5: { closes: [], times: [] }, m1: { closes: [], times: [] }, date: null, debug: found.log, rateLimited: !!found.rateLimited });
    }

    // 時計の5分刻み（09:00, 09:05, 09:10...）でグループ化し、各グループの最後の終値(C)を
    // 5分足として使う。実際の取引開始時刻から機械的に5本ずつ数える方式だと、銘柄ごとに
    // 最初の約定時刻がズレて半端な時刻になってしまうため、時計基準に揃える。
    const closes = [];
    const times = [];
    let curBucket = null;
    let curLast = null;
    function flushBucket() {
      if (curBucket !== null && curLast && typeof curLast.C === "number") {
        closes.push(curLast.C);
        times.push(curBucket);
      }
    }
    for (const bar of found.bars) {
      const t = bar.Time || "";
      const parts = t.split(":");
      if (parts.length < 2) continue;
      const hh = parts[0].padStart(2, "0");
      const mm = Math.floor(Number(parts[1]) / 5) * 5;
      const bucketKey = hh + ":" + String(mm).padStart(2, "0");
      if (bucketKey !== curBucket) {
        flushBucket();
        curBucket = bucketKey;
      }
      curLast = bar;
    }
    flushBucket();

    // 1分足（チャートモーダル用）：時刻とC(終値)をそのまま抽出。
    // 5分足の集計と同じ1回のJ-Quantsアクセス結果を使い回すので、追加リクエストは発生しない。
    const closes1 = [];
    const times1 = [];
    for (const bar of found.bars) {
      if (typeof bar.C !== "number") continue;
      const t = bar.Time || "";
      const parts = t.split(":");
      if (parts.length < 2) continue;
      times1.push(parts[0].padStart(2, "0") + ":" + parts[1].padStart(2, "0"));
      closes1.push(bar.C);
    }

    // ブラウザ側の短時間キャッシュ用ヘッダー（同一分内の再取得を減らす）
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.status(200).json({
      m5: { closes: closes, times: times },
      m1: { closes: closes1, times: times1 },
      date: found.date,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
