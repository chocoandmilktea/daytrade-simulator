// api/ai.js
// Anthropic APIへのサーバーサイドプロキシ（system prompt・web_search対応）
// リクエストで stream:true を指定した場合のみ、AIが書いた文章を書けた端から
// 少しずつ返す（ストリーミング）。指定が無い場合は従来どおり全文まとめて返すので、
// 既存の呼び出し箇所は修正不要。

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const { prompt, system, useWebSearch, stream } = req.body;
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

  if (stream) body.stream = true;

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

    // ── ストリーミング返却 ──────────────────────────────────────────────
    // Anthropicから届くSSE(1行ずつのイベント)を読み取り、本文の増分だけを
    // そのまま素のテキストとしてブラウザへ流す。ツール利用(web_search)の
    // イベントは本文ではないので無視する。
    if (stream) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("X-Accel-Buffering", "no"); // 途中で溜め込まずすぐ流すよう指示

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop(); // 最後の行は途中かもしれないので次回に持ち越す
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const ev = JSON.parse(payload);
            if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
              res.write(ev.delta.text);
            }
          } catch (e) {
            // 壊れた行は読み飛ばす
          }
        }
      }
      return res.end();
    }

    // ── 従来どおり全文まとめて返却 ────────────────────────────────────
    const data = await response.json();
    // contentブロックからtextのみ結合（tool_use・tool_resultは除外）
    const text = (data.content || [])
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("\n") || "";
    return res.status(200).json({ text });
  } catch (e) {
    // ストリーミング開始後は既にヘッダ送信済みなので、途中で終わらせるしかない
    if (res.headersSent) return res.end();
    return res.status(500).json({ error: e.message });
  }
}
