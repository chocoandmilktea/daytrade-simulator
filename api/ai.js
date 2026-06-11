// api/ai.js
// Anthropic APIへのサーバーサイドプロキシ（system prompt・web_search対応）

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const { prompt, system, useWebSearch } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  };

  if (system) body.system = system;

  if (useWebSearch) {
    body.tools = [{ type: "web_search_20250305", name: "web_search" }];
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error("Anthropic API error: " + response.status + " " + err);
    }

    const data = await response.json();
    // contentブロックからtextのみ結合（tool_use・tool_resultは除外）
    const text = (data.content || [])
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("\n") || "";
    console.log("RAW_TEXT:", text);
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
