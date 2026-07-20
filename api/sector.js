// api/sector.js
// AIが「今後上がりそうな業種」をweb_search付きで選定し、その業種内だけで
// ranking.jsと同じ出来高・値上がり率ハイブリッドロジックを適用する（日本株のみ）
//
// 流れ：①AIがセクター選定（鮮度チェック付き）→②J-Quants業種マスタで絞り込み→③ランキング化
// AIの選定結果は24時間キャッシュ。有効なセクターが1つもない場合は通常ランキングにフォールバック

import {
  isVolumeAboveAvg,
  mergeHybrid,
  mapJPBar,
  calcChangeRate,
  getTargetBusinessDay,
  fetchNameMap,
  fetchDailyBarsWithFallback,
} from "./ranking.js";

const CACHE_TTL = 24 * 60 * 60 * 1000; // 24時間
const SOURCE_MAX_AGE_DAYS = 14;        // これより古い根拠情報しかないセクターは除外

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // ユーザーが業種を明示指定した場合（業種一覧選択／前回の業種）はAI選定(web_search)を丸ごとスキップ
    const manualSectors = parseManualSectors(req);
    const sectors = manualSectors || await getPromisingSectors(req);

    if (!sectors.length) {
      const fallback = await getPlainJPRanking(req);
      return res.status(200).json({ market: "jp", mode: "fallback", sectors: [], stocks: fallback });
    }

    const stocks = await getSectorRanking(req, sectors);
    return res.status(200).json({
      market: "jp",
      mode: manualSectors ? "manual" : "sector",
      sectors: sectors.map(function(s) { return { name: s.name, reason: s.reason }; }),
      stocks: stocks,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// クエリ ?sectors=業種名1,業種名2 が指定されていれば、それを直接セクターとして使う（最大3件）
// AIのweb_search選定を通さないため、業種一覧選択・前回の業種再取得の際のトークン消費がゼロになる
function parseManualSectors(req) {
  const raw = req.query.sectors;
  if (!raw) return null;
  const names = String(raw).split(",").map(function(s) { return s.trim(); }).filter(Boolean).slice(0, 3);
  if (!names.length) return null;
  return names.map(function(name) { return { name: name, reason: "ユーザー選択" }; });
}

// ── ①AIによるセクター選定（24時間キャッシュ） ──────────────────────────────

let sectorCache = { ts: 0, sectors: null };

async function getPromisingSectors(req) {
  const now = Date.now();
  if (sectorCache.sectors && now - sectorCache.ts < CACHE_TTL) {
    return sectorCache.sectors;
  }
  const raw = await askAIForSectors(req);
  const fresh = raw.filter(isFreshSource);
  sectorCache = { ts: now, sectors: fresh };
  return fresh;
}

// 根拠情報が新しいかどうか（sourceDateが無い/未来日/14日超過は除外）
function isFreshSource(sector) {
  if (!sector.sourceDate) return false;
  const days = (Date.now() - new Date(sector.sourceDate).getTime()) / 86400000;
  return days >= 0 && days <= SOURCE_MAX_AGE_DAYS;
}

async function askAIForSectors(req) {
  const todayLabel = getJSTDateLabel();
  const prompt =
    `本日は${todayLabel}です。日本株市場で、直近1〜2週間以内のニュース・決算・株価動向を根拠として、` +
    `今後株価が上昇しやすいと考えられる業種を2〜3個挙げてください。\n\n` +
    `【出力形式】必ずJSON形式のみで出力し、前後の説明文やMarkdownコードブロックは不要です。\n` +
    `{"sectors":[{"name":"業種名（東証33業種分類の名称を使うこと）","reason":"理由を1文で","sourceDate":"根拠にした情報の日付(YYYY-MM-DD)"}]}\n\n` +
    `ルール：\n- sourceDateは実際に参照した情報の日付を正確に記載する\n` +
    `- 直近1〜2週間より古い情報しか無い場合はそのセクターを含めない\n- 必ず日本語で回答`;

  const host = req.headers.host || "daytrade-simulator.vercel.app";
  const protocol = host.includes("localhost") ? "http" : "https";
  const r = await fetch(`${protocol}://${host}/api/ai`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: prompt,
      system: "あなたは日本株市場のセクター分析の専門家です。JSONのみ出力してください。",
      useWebSearch: true,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error("ai api: " + r.status);
  const json = await r.json();
  try {
    const clean = (json.text || "").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    return parsed.sectors || [];
  } catch (e) {
    return []; // パース失敗時は「該当なし」として通常ランキングにフォールバック
  }
}

function getJSTDateLabel() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

// ── ②J-Quants業種マスタ（コード→会社名・業種名）。24時間キャッシュ ──────────
// ※ 実際のJ-Quantsレスポンスで確認済み：33業種名はS33Nm（Vercelログで確認: 2026-07-14）

let masterCache = { ts: 0, nameMap: null, sectorMap: null };

async function fetchJQuantsMaster(apiKey, dateStr8) {
  const now = Date.now();
  if (masterCache.nameMap && now - masterCache.ts < CACHE_TTL) {
    return masterCache;
  }
  const url = `https://api.jquants.com/v2/equities/master?date=${dateStr8}`;
  const res = await fetch(url, { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(9000) });
  if (!res.ok) throw new Error("master api: " + res.status);
  const json = await res.json();
  const rows = json?.data || json || [];

  const nameMap = {};
  const sectorMap = {};
  rows.forEach(function(row) {
    const code = String(row.Code || "").replace(/0$/, "");
    if (!code) return;
    if (row.CoName) nameMap[code] = row.CoName;
    if (row.S33Nm) sectorMap[code] = row.S33Nm;
  });

  masterCache = { ts: now, nameMap, sectorMap };
  return masterCache;
}

// ── ③業種内で出来高・値上がり率ハイブリッドランキングを生成 ─────────────────

async function getSectorRanking(req, sectors) {
  const apiKey = process.env.JQUANTS_API_KEY;
  if (!apiKey) throw new Error("JQUANTS_API_KEY not set");

  const dateStr = getTargetBusinessDay();
  const sectorNames = sectors.map(function(s) { return s.name; });

  // 日足は祝日等でその日のデータが空のことがあるため、ranking.js側の
  // 「空なら前営業日へ自動フォールバック」ロジックを共有して使う
  const [names, master, barsResult] = await Promise.all([
    fetchNameMap(req),
    fetchJQuantsMaster(apiKey, dateStr.replace(/-/g, "")),
    fetchDailyBarsWithFallback(apiKey, dateStr),
  ]);

  const bars = barsResult.bars.filter(function(bar) {
    const code = String(bar.Code || "").replace(/0$/, "");
    return sectorNames.includes(master.sectorMap[code]);
  });

  if (!bars.length) return [];

  const byVolume = bars.slice()
    .sort(function(a, b) { return (b.Vo || 0) - (a.Vo || 0); })
    .slice(0, 50)
    .map(function(bar) { return mapJPBar(bar, names, master.nameMap); });

  const allVols = bars.map(function(b) { return b.Vo || 0; }).sort(function(a, b) { return a - b; });
  const medianVol = allVols[Math.floor(allVols.length / 2)] || 0;

  const byChange = bars.slice()
    .sort(function(a, b) { return calcChangeRate(b) - calcChangeRate(a); })
    .filter(function(bar) { return isVolumeAboveAvg(bar.Vo || 0, bar.AvgVo || medianVol); })
    .slice(0, 20)
    .map(function(bar) { return mapJPBar(bar, names, master.nameMap); });

  return mergeHybrid(byVolume, byChange);
}

// ── フォールバック：AIが有効なセクターを返せなかった場合の通常ランキング ─────
// ranking.js の /api/ranking?market=jp をそのまま呼び出す（ロジック二重実装を回避）
async function getPlainJPRanking(req) {
  const host = req.headers.host || "daytrade-simulator.vercel.app";
  const protocol = host.includes("localhost") ? "http" : "https";
  const r = await fetch(`${protocol}://${host}/api/ranking?market=jp`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("ranking api: " + r.status);
  const json = await r.json();
  return json.stocks || [];
}
