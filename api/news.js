// api/news.js
// TDnet（適時開示）とYahooファイナンスの見出しを取得し、AIで5カテゴリに要約する
// ※Web検索は使わず、ここで取得した実データのみをAIに渡す

import * as cheerio from "cheerio";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  try {
    const [tdnet, yahoo] = await Promise.all([fetchTdnet(), fetchYahooNews()]);
    const sourceText = buildSourceText(tdnet, yahoo);
    const text = await summarizeWithAI(apiKey, sourceText);
    // ── デバッグ用（確認できたら削除） ──
    const debug = {
      tdnetCount: tdnet.length,
      yahooCount: yahoo.length,
      tdnetSample: tdnet.slice(0, 5),
      yahooSample: yahoo.slice(0, 5),
    };
    return res.status(200).json({ text, debug });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── TDnet: 当日の適時開示一覧 ───────────────────────────────
async function fetchTdnet() {
  const url = `https://www.release.tdnet.info/inbs/I_list_001_${getJSTDateStr()}.html`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    const $ = cheerio.load(await r.text());
    const items = [];
    $("#main-body-box tr").each(function () {
      const company = $(this).find(".kjName").text().trim();
      const title = $(this).find(".kjTitle").text().trim();
      if (company && title) items.push(`${company}: ${title}`);
    });
    return items.slice(0, 30);
  } catch (e) {
    return [];
  }
}

// ── Yahooファイナンス: ニュース見出し ─────────────────────────
async function fetchYahooNews() {
  const urls = [
    "https://finance.yahoo.co.jp/news",
    "https://finance.yahoo.co.jp/news/stocks",
    "https://finance.yahoo.co.jp/news/world",
  ];
  const lists = await Promise.all(urls.map(fetchYahooPage));
  return lists.flat().slice(0, 30);
}

async function fetchYahooPage(url) {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return [];
    const $ = cheerio.load(await r.text());
    const titles = [];
    $("a").each(function () {
      const t = $(this).text().trim();
      // Yahooのニュース見出しは末尾が「M/D配信元」形式（例: 7/7時事通信）
      if (t.length >= 10 && t.length <= 80 && /\d{1,2}\/\d{1,2}[^\d/]{2,10}$/.test(t)) {
        titles.push(t);
      }
    });
    return [...new Set(titles)];
  } catch (e) {
    return [];
  }
}

function getJSTDateStr() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

// ── 取得データをテキスト化 ─────────────────────────────────
function buildSourceText(tdnet, yahoo) {
  const tdnetText = tdnet.length ? tdnet.map((t) => "- [TDnet] " + t).join("\n") : "（本日の開示なし）";
  const yahooText = yahoo.length ? yahoo.map((t) => "- [Yahoo] " + t).join("\n") : "（取得なし）";
  return `■TDnet適時開示\n${tdnetText}\n\n■Yahooファイナンス見出し\n${yahooText}`;
}

// ── AI要約（Web検索なし、与えたデータのみ使用） ─────────────
async function summarizeWithAI(apiKey, sourceText) {
  const prompt =
    "以下は本日のTDnet適時開示とYahooファイナンスの見出し一覧です。この中から重要なものを選び、" +
    "5カテゴリに分類して日本語でわかりやすく要約してください。\n\n" +
    sourceText +
    "\n\n対象カテゴリ：🏦 金融政策 / 📈 決算・業績 / 🌍 経済指標 / ⚡ 相場急変 / 🏭 セクター動向\n\n" +
    "【出力形式】必ずJSON形式のみで出力し、前後の説明文やMarkdownコードブロックは不要です。\n" +
    '{"金融政策":[{"headline":"見出し","summary":"2〜3文の平易な説明","impact":"投資家への影響を一言"}],"決算・業績":[...],"経済指標":[...],"相場急変":[...],"セクター動向":[...]}\n\n' +
    "ルール：\n- 各カテゴリに1〜3件。該当なしは空配列[]\n- 専門用語は平易な言葉に言い換える\n- impactは株価への影響を一言で\n- 与えられたデータに無い情報は書かない\n- 必ず日本語で回答";

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4000,
      system:
        "あなたは個人投資家向けの株式ニュース解説者です。与えられたデータのみをもとに、難しい言葉を使わずわかりやすく解説してください。JSONのみ出力してください。",
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) throw new Error("Anthropic API error: " + response.status + " " + (await response.text()));
  const data = await response.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n") || "";
}
