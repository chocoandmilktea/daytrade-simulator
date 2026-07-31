// api/ranking.js
// 日本株のハイブリッドランキング：出来高上位40 + 値上がり率上位20（出来高フィルター付き）
// データ取得元：立花証券API（tachibana-server の /ranking-data 経由）
//
// ※米国株ランキング（Yahoo Financeのスクリーナー）は、米国株を扱わなくなったため削除済み。
// 　VIX・日経平均・NYダウ等の市況指数は api/stock.js 側で取得しているため影響しない。

import { withFallback } from "./_fallbackCache.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const data = await getJPRanking(req);
    return res.status(200).json({ market: "jp", stocks: data });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// ── 共通ユーティリティ ────────────────────────────────────────────────────────
// ※以下、sector.js から再利用するため export しています

// 出来高フィルター：過去平均の1.5倍以上かどうか（平均が取れない場合はtrue）
export function isVolumeAboveAvg(vol, avgVol) {
  if (!avgVol || avgVol <= 0) return true;
  return vol >= avgVol * 1.5;
}

// 重複除去マージ（出来高上位 + 値上がり率上位）
export function mergeHybrid(byVolume, byChange) {
  const seen = {};
  const out = [];
  byVolume.forEach(function(s) {
    if (!seen[s.ticker]) { seen[s.ticker] = true; out.push(s); }
  });
  byChange.forEach(function(s) {
    if (!seen[s.ticker]) { seen[s.ticker] = true; out.push(s); }
  });
  return out;
}

// ── 日本株 ───────────────────────────────────────────────────────────────────

const JP_NAMES_FALLBACK = {
  "7203":"トヨタ自動車","6758":"ソニーグループ","8306":"三菱UFJ",
  "9984":"ソフトバンクG","6861":"キーエンス","7974":"任天堂",
  "8035":"東京エレクトロン","9432":"NTT","4063":"信越化学","6367":"ダイキン工業",
  "9433":"KDDI","7267":"ホンダ","6501":"日立製作所","4519":"中外製薬",
  "3382":"セブン&アイ","8411":"みずほFG","6098":"リクルートHD",
  "4661":"オリエンタルランド","8316":"三井住友FG","6594":"日本電産",
  "4568":"第一三共","7751":"キヤノン","6702":"富士通","8058":"三菱商事",
  "8031":"三井物産","7011":"三菱重工","5108":"ブリヂストン","4452":"花王",
  "6857":"アドバンテスト","9101":"日本郵船",
};

// sector.js から req.headers.host を使って内部fetchするため export
export async function fetchNameMap(req) {
  try {
    const host = req.headers.host || "daytrade-simulator.vercel.app";
    const protocol = host.includes("localhost") ? "http" : "https";
    const r = await fetch(`${protocol}://${host}/api/ipo`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error("ipo api: " + r.status);
    const json = await r.json();
    return json?.names || {};
  } catch (e) {
    return {};
  }
}

// 対象営業日を判定（15:30の取引終了前や土日はひとつ前の営業日にフォールバック）
// ※立花証券のランキング用データは常に最新値を返すため、この戻り値自体は
// fetchDailyBarsWithFallback内部では使わなくなったが、sector.js側の互換のため関数は残す
export function getTargetBusinessDay() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const hhmm = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  const MARKET_CLOSE = 15 * 60 + 30;

  let d = new Date(jst);
  if (hhmm < MARKET_CLOSE || d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() - 1);
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
      d.setUTCDate(d.getUTCDate() - 1);
    }
  }
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// 変化率の算出：立花証券からは前日終値(PrevC)が取れるため、それを優先して使う
// （取れない場合の保険として、当日始値比でも算出できるようにしてある）
export function calcChangeRate(bar) {
  if (bar.PrevC && bar.PrevC > 0) {
    return (bar.C - bar.PrevC) / bar.PrevC;
  }
  const open = bar.O || 0;
  const close = bar.C || 0;
  return open > 0 ? (close - open) / open : 0;
}

// 会社名の優先順位：銘柄名API > 立花証券の銘柄マスタ名 > ハードコード一覧 > コードそのまま
export function mapJPBar(bar, names) {
  const code = String(bar.Code || "");
  const name = names[code] || bar.Name || JP_NAMES_FALLBACK[code] || code;
  return {
    ticker: code + ".T",
    name: name,
    market: "JP",
    tvSymbol: "TSE:" + code,
    volume: bar.Vo || 0,
    avgVolume: bar.AvgVo || 0,
    price: bar.C || 0,
    change: parseFloat((calcChangeRate(bar) * 100).toFixed(2)),
  };
}

// ── 立花証券APIから市場全体の出来高・現在値・名前・業種を取得 ──────────────
// 実際の取得（銘柄マスタ・出来高一括取得・並列バッチ処理）はtachibana-server側
// （webapi.js の /ranking-data）で行っている。ranking.js側はそれを1回呼ぶだけ。
async function fetchTachibanaRankingData() {
  // 立花証券APIが一時的に使えない時（早朝メンテナンス等）は、Redisに保存済みの
  // 直近の成功データ（引け値ベース）を代わりに使う
  return await withFallback("ranking-data", async () => {
    const apiUrl = process.env.TACHIBANA_RANKING_API;
    if (!apiUrl) throw new Error("TACHIBANA_RANKING_API not set");

    const headers = {};
    if (process.env.TACHIBANA_RELAY_SECRET) headers["X-Relay-Secret"] = process.env.TACHIBANA_RELAY_SECRET;

    const res = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error("ranking-data " + res.status);
    const json = await res.json();
    return json.rows || [];
  });
}

// 立花証券の行データ（code/name/sector/price/prevClose/volume）を
// 既存コードが扱ってきたbar形状（Code/Vo/C/PrevC等）に変換する
function toBarShape(row) {
  return {
    Code: row.code,
    Name: row.name,
    Sector: row.sector,
    Vo: row.volume,
    C: row.price,
    PrevC: row.prevClose,
  };
}

// dateStrの引数は既存コード（sector.js）との互換のために残しているが、
// 立花証券のランキング用データは常に最新値のため実質的には未使用
export async function fetchDailyBarsWithFallback(dateStr) {
  const rows = await fetchTachibanaRankingData();
  if (!rows.length) throw new Error("No JP ranking data");
  const bars = rows.map(toBarShape);
  return { bars: bars, dateUsed: dateStr };
}

async function getJPRanking(req) {
  const dateStr = getTargetBusinessDay();

  const [nameMap, barsResult] = await Promise.allSettled([
    fetchNameMap(req),
    fetchDailyBarsWithFallback(dateStr),
  ]);

  const names = nameMap.status === "fulfilled" ? nameMap.value : {};
  if (barsResult.status === "rejected") throw barsResult.reason;
  const bars = barsResult.value.bars;

  if (!bars.length) throw new Error("No JP bar data");

  // 出来高上位40
  const byVolume = bars
    .slice()
    .sort(function(a, b) { return (b.Vo || 0) - (a.Vo || 0); })
    .slice(0, 40)
    .map(function(bar) { return mapJPBar(bar, names); });

  // 値上がり率上位：出来高フィルター通過後20件
  // 立花証券からは銘柄別の平均出来高が取れないため、当日全銘柄の出来高の中央値で代替
  const allVols = bars.map(function(b) { return b.Vo || 0; }).sort(function(a, b) { return a - b; });
  const medianVol = allVols[Math.floor(allVols.length / 2)] || 0;

  const byChange = bars
    .slice()
    .sort(function(a, b) { return calcChangeRate(b) - calcChangeRate(a); })
    .filter(function(bar) {
      const avg = bar.AvgVo || medianVol;
      return isVolumeAboveAvg(bar.Vo || 0, avg);
    })
    .slice(0, 20)
    .map(function(bar) { return mapJPBar(bar, names); });

  return mergeHybrid(byVolume, byChange);
}
