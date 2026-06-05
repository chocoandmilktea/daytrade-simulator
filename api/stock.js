export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { ticker, range } = req.query;

  if (!ticker) {
    return res.status(400).json({ error: "ticker is required" });
  }

  const r = range || "2y";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=${r}`;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Yahoo Finance returned ${response.status}`);
    }

    const data = await response.json();

    // PER・PBRをquoteSummaryから取得
    let per = null, pbr = null;
    try {
      const summaryUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=defaultKeyStatistics,summaryDetail`;
      const summaryRes = await fetch(summaryUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(5000),
      });
      if (summaryRes.ok) {
        const summary = await summaryRes.json();
        const detail = summary?.quoteSummary?.result?.[0];
        per = detail?.summaryDetail?.trailingPE?.raw || null;
        pbr = detail?.defaultKeyStatistics?.priceToBook?.raw || null;
      }
    } catch(e) {}

    // chartデータにPER・PBRを付加
    if (data?.chart?.result?.[0]) {
      data.chart.result[0].per = per;
      data.chart.result[0].pbr = pbr;
    }

    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
