export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey = process.env.JQUANTS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "JQUANTS_API_KEY not set" });

  try {
    const url = "https://api.jquants.com/v2/equities/master";
    const r = await fetch(url, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error("J-Quants master: " + r.status);
    const json = await r.json();

    // デバッグ: キー一覧と最初の1件を返す
    const keys = Object.keys(json);
    const firstItem = json[keys[0]]?.[0] || null;
    return res.status(200).json({ keys, firstItem });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
