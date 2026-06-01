export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  var url = process.env.KV_REST_API_URL;
  var token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return res.status(500).json({ error: "KV not configured" });

  var userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });

  var key = "user:" + userId;

  // GET: データ取得
  if (req.method === "GET") {
    try {
      var getRes = await fetch(url + "/get/" + key, {
        headers: { Authorization: "Bearer " + token }
      });
      var json = await getRes.json();
      if (!json.result) return res.status(200).json({ favs: [], portfolio: [] });
      var data = JSON.parse(json.result);
      return res.status(200).json(data);
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST: データ保存
  if (req.method === "POST") {
    try {
      var body = req.body;
      if (!body || !Array.isArray(body.favs) || !Array.isArray(body.portfolio)) {
        return res.status(400).json({ error: "invalid data" });
      }
      var setRes = await fetch(url + "/set/" + key, {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ value: JSON.stringify({ favs: body.favs, portfolio: body.portfolio }) })
      });
      var setJson = await setRes.json();
      return res.status(200).json({ ok: true });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "method not allowed" });
}
