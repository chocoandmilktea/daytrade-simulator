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
    const stocks = json?.equities || json?.data || [];

    const now = new Date();
    const from = new Date(now);
    from.setMonth(from.getMonth() - 6);
    const to = new Date(now);
    to.setMonth(to.getMonth() + 3);

    const ipos = stocks
      .filter(function(s) {
        if (!s.ListingDate) return false;
        const d = new Date(s.ListingDate);
        return d >= from && d <= to;
      })
      .sort(function(a, b) {
        return new Date(b.ListingDate) - new Date(a.ListingDate);
      })
      .slice(0, 30)
      .map(function(s) {
        return {
          code: String(s.Code || "").replace(/0$/, ""),
          name: s.CompanyNameRFC || s.CompanyName || s.Code,
          listingDate: s.ListingDate,
          market: s.MarketCodeName || s.MarketCode || "─",
          sector: s.Sector33CodeName || s.Sector17CodeName || "─",
        };
      });

    return res.status(200).json({ ipos });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
