// api/ipo.js
// 立花証券APIから「コード → 正式名称」の対応表を返す
// 実際の取得（銘柄マスタ）はtachibana-server側（webapi.js の /names）で行っている。

// サーバーサイドキャッシュ（同一サーバーインスタンス内で1時間再利用）
// ※tachibana-server側も24時間キャッシュしているため、こちらは短めでも実害は少ない
let _cache = null;
let _cacheTs = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1時間

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // キャッシュが有効なら即返す
  if (_cache && Date.now() - _cacheTs < CACHE_TTL) {
    return res.status(200).json({ names: _cache, cached: true });
  }

  const apiUrl = process.env.TACHIBANA_NAMES_API;
  if (!apiUrl) return res.status(500).json({ error: "TACHIBANA_NAMES_API not set" });

  try {
    const headers = {};
    if (process.env.TACHIBANA_RELAY_SECRET) headers["X-Relay-Secret"] = process.env.TACHIBANA_RELAY_SECRET;

    const r = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error("names api: " + r.status);

    const json = await r.json();
    const names = json.names || {};

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
