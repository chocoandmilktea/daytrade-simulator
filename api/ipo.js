// api/ipo.js
// J-Quants マスターデータから「コード → 正式名称」の対応表を返す

// サーバーサイドキャッシュ（同一サーバーインスタンス内で24時間再利用）
let _cache = null;
let _cacheTs = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24時間

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey = process.env.JQUANTS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "JQUANTS_API_KEY not set" });

  // キャッシュが有効なら即返す
  if (_cache && Date.now() - _cacheTs < CACHE_TTL) {
    return res.status(200).json({ names: _cache, cached: true });
  }

  try {
    const url = "https://api.jquants.com/v2/equities/master";
    const r = await fetch(url, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error("J-Quants master: " + r.status);

    const json = await r.json();
    const stocks = json?.data || [];

    // { "7203": "トヨタ自動車", ... } の形に変換
    // Codeは末尾に"0"が付く5桁形式（例: "72030"）なので除去して4桁に
    const names = {};
    stocks.forEach(function(s) {
      const raw = String(s.Code || "");
      const code = raw.endsWith("0") ? raw.slice(0, -1) : raw;
      if (code && s.CompanyNameRF) {
        names[code] = s.CompanyNameRF; // 短縮名（例: "トヨタ自動車"）
      }
    });

    // キャッシュ更新
    _cache = names;
    _cacheTs = Date.now();

    return res.status(200).json({
      names: names,
      total: Object.keys(names).length,
      cached: false,
    });
  } catch (e) {
    // キャッシュが古くても返せるなら返す（フォールバック）
    if (_cache) {
      return res.status(200).json({ names: _cache, cached: true, fallback: true });
    }
    return res.status(500).json({ error: e.message });
  }
}
