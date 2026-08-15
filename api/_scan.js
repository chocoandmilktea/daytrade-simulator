// api/_scan.js
// サーバー側スキャンエンジン（Phase 2）
//   銘柄リスト(Redis) → 株価取得(api/stock.js) → スコア計算(src/lib/analyze.js) → Redis保存
// を「バッチ単位」で実行する。
//
// ファイル名を "_" で始めているのは、Vercelがこのファイルを個別のAPIエンドポイントと
// して扱わないようにするため（Hobbyプランの関数12個制限を消費しない）。
// 外部からの入口は api/sync.js?resource=scan-run。
//
// 【なぜバッチ分割するのか】
// Vercel Hobbyの関数タイムアウトは既定10秒。1銘柄あたりYahoo Finance等への
// 外部アクセスが入るため、150〜200銘柄を1回の呼び出しで処理することはできない。
// offset/limit で少しずつ進め、続きは呼び出し側（Phase 3のスケジューラ）が
// nextOffset を見て繰り返し呼ぶ。
//
// 【セッション（時間帯）判定について・重要】
// Vercelのサーバー時刻はUTCのため、analyze.js の currentSessionLabel() を
// サーバーで呼ぶと必ず誤判定する。そのため保存する session は
// 引数 slot から機械的に決める（SLOT_SESSIONS）。
//
// 【スコアの重み補正について】
// analyzeStock の signalStats（実績反映調整）は localStorage 由来のため
// サーバーからは渡さない＝補正なし（係数1.0）。区別できるよう adjusted:false を記録する。

import { Redis } from "@upstash/redis";
import { gunzipSync } from "zlib";
import { fetchStockPayload } from "./stock.js";
import { analyzeStock } from "../src/lib/analyze.js";

const redis = Redis.fromEnv();

export const UNIVERSE_KEY = "scan:universe";
// 過去に保存できた最大件数（ハイウォーターマーク）。極端に少ないリストで
// 上書きされるのを防ぐ判定に使う。守る対象（scan:universe）自身を基準にすると
// 157→60→25→8 と階段状に転げ落ちるため、必ず別キーで持つ。
export const UNIVERSE_MAX_KEY = "scan:universe:max";
export const UNIVERSE_TTL = 60 * 60 * 24 * 30; // 30日（秒）
export const RESULT_TTL = 60 * 60 * 24 * 30;   // 30日（秒）

// slot（HHMM）→ 時間帯ラベル。サーバー時刻を一切見ないための対応表。
// "時間外" は既存の集計対象セッション(INTRADAY_SESSIONS)には含まれないが、
// 「その日の基準値」として意図的に記録する（フロントの currentSessionLabel() と同じラベル）。
// "0830" は寄り前スキャンの旧slot名。Redisに過去データが残っているため、
// "0850" と同じ扱いで受け付けたままにする（後方互換）。
export const SLOT_SESSIONS = {
  "0830": "時間外",
  "0850": "時間外",
  "0930": "寄り付き",
  "1100": "前場",
  "1300": "後場前半",
  "1500": "後場後半",
};

const WAIT_MS = 300;       // Yahooの429対策：銘柄ごとの待機
const DEFAULT_LIMIT = 5;   // 1バッチあたりの既定件数

export function sessionFromSlot(slot) {
  return SLOT_SESSIONS[String(slot)] || null;
}

// その日・その時間帯の結果を入れるRedisキー（例: scan:2026-08-12:1300）
export function resultKey(date, slot) {
  return "scan:" + date + ":" + slot;
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

// Upstashは値をそのままJSONとして返すことがあるため、文字列/オブジェクトの両方を受ける
function parseMaybeJson(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  if (typeof v !== "string") return null;
  try { return JSON.parse(v); } catch (e) { return null; }
}

// 銘柄リストの1件を analyzeStock が期待する形に整える。
// フロントからは ticker の文字列配列で届くが、将来オブジェクトで送られても壊れないようにしておく。
export function normalizeStock(entry) {
  var ticker = typeof entry === "string" ? entry : (entry && entry.ticker);
  if (!ticker || typeof ticker !== "string") return null;
  var isJP = ticker.endsWith(".T");
  var code = ticker.replace(".T", "");
  var src = (entry && typeof entry === "object") ? entry : {};
  return {
    ticker: ticker,
    name: src.name || code,
    market: src.market || (isJP ? "JP" : "US"),
    tvSymbol: src.tvSymbol || ((isJP ? "TSE:" : "NASDAQ:") + code),
    volume: src.volume || 0,
  };
}

// 日本株（".T"）だけを残すためのふるい
export function isJPEntry(entry) {
  var s = normalizeStock(entry);
  return !!(s && s.ticker.endsWith(".T"));
}

// ── Redis: 銘柄リスト ────────────────────────────────────────────────────
// 新形式 {tickers:[...], source, count, savedAt} と、旧形式（tickerの生配列）の両方に対応する。
// 旧形式は次の手動スキャンが成功するまでRedisに残っているため、後方互換が必要。
export async function loadUniverse() {
  var raw = parseMaybeJson(await redis.get(UNIVERSE_KEY));
  if (raw && !Array.isArray(raw) && Array.isArray(raw.tickers)) return raw.tickers;
  if (!Array.isArray(raw)) return [];
  return raw;
}

// 保存は2段のガードを通ったときだけ行う。拒否した場合は理由を返す（呼び出し側でログに出す）。
export async function saveUniverse(payload) {
  // ガード①：ランキング由来（source:"ranking"）の新形式だけ受け付ける。
  // お気に入りだけのfallbackリストと、旧形式の生配列POSTはここで弾かれる。
  if (!payload || payload.source !== "ranking" || !Array.isArray(payload.tickers)) {
    var got = Array.isArray(payload) ? "生配列" : (payload && typeof payload === "object" ? ("source=" + payload.source + " tickers=" + (Array.isArray(payload.tickers) ? "配列" : typeof payload.tickers)) : String(payload));
    console.warn("[scan-universe] 保存を拒否：source が ranking の新形式ではありません（" + got + "）");
    return { ok: false, reason: "source must be 'ranking' and tickers must be an array (" + got + ")" };
  }
  var count = payload.tickers.length;
  // ガード②：過去の最大件数の半分未満なら弾く（157件のリストが8件で潰されるのを防ぐ）
  var max = Number(await redis.get(UNIVERSE_MAX_KEY));
  if (!isFinite(max) || max < 0) max = 0;
  if (max > 0 && count < max * 0.5) {
    console.warn("[scan-universe] 保存を拒否：件数が過去最大の半分未満です（" + count + "件 / 過去最大 " + max + "件）");
    return { ok: false, reason: "count " + count + " is less than half of max " + max };
  }
  await redis.set(UNIVERSE_KEY, JSON.stringify({
    tickers: payload.tickers, source: "ranking", count: count,
    savedAt: payload.savedAt || Date.now(),
  }), { ex: UNIVERSE_TTL });
  if (count > max) await redis.set(UNIVERSE_MAX_KEY, count, { ex: UNIVERSE_TTL });
  return { ok: true, count: count };
}

// ── サーバー側での銘柄リスト構築 ──────────────────────────────────────────
// 以前はアプリ（App.js）が手動スキャンのたびに無認証でPOSTしていたが、書き込み口を
// 外部に晒したままにしないため、同じ内容をサーバー側で組み立てるようにした。
// 骨格はフロントの buildStockUniverse と同じ：
//   ① 同期済みの last_sectors があれば /api/sector?sectors=… を叩く
//   ② セクター指定が無い／0件だった場合は /api/ranking?market=jp へフォールバック
//   ③ ticker単位の先勝ちで重複除去（件数の絞り込み・並べ替えはしない＝返却順のまま）
//   ④ お気に入り・トレード中（status!=="done"）の銘柄を末尾に追加
//
// 【userIdについて】リクエストからは一切受け取らず、環境変数 SCAN_SYNC_USER_ID の
// 固定値だけを見る。外部から渡されたuserIdで他人の同期データを読ませないため。
export const UNIVERSE_BUILD_KEY = "scan:universe:built"; // 最後に組み立てた "YYYY-MM-DD:slot"
const UNIVERSE_BUILD_TTL = 60 * 60 * 24 * 3; // 3日（秒）。連休を挟んでも判定が効くように
const SYNC_USER_ID = process.env.SCAN_SYNC_USER_ID || "";
// 組み立て全体の時間予算。Vercelの関数上限（10秒）を超えないよう、外部API2本ぶんを
// この中に収める（1本目が長引いた場合は2本目の待ち時間が自動的に削られる）
const BUILD_BUDGET_MS = 8000;
const GZ_PREFIX = "gz:";

// api/sync.js が保存した同期データを読む。展開手順は sync.js の unpackFromRedis と同じ
// （sync.js を import すると循環参照になるため、ここでは同じ処理を持つ）
function unpackSync(data) {
  if (data == null) return null;
  if (typeof data === "object") return data; // Upstashが自動でJSONに戻した場合
  if (typeof data !== "string") return null;
  if (data.startsWith(GZ_PREFIX)) {
    var json = gunzipSync(Buffer.from(data.slice(GZ_PREFIX.length), "base64")).toString("utf8");
    return JSON.parse(json);
  }
  try { return JSON.parse(data); } catch (e) { return null; }
}

// 自分自身のAPIを叩くためのURL。ranking.js / sector.js と同じ組み立て方にしてある
function apiBase(host) {
  var h = host || process.env.VERCEL_URL || "daytrade-simulator.vercel.app";
  var protocol = h.indexOf("localhost") >= 0 ? "http" : "https";
  return protocol + "://" + h;
}

// 残り時間ぶんだけ待つfetch。最低1.5秒は待つ（予算を使い切っていても1回は試す）
async function fetchJsonWithin(url, deadline) {
  var ms = Math.max(1500, deadline - Date.now());
  var res = await fetch(url, { signal: AbortSignal.timeout(ms), cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return await res.json();
}

// 同期された last_sectors を /api/sector に渡せる形に整える（sector.js 側と同じく最大3件）
function normalizeSectors(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(function (s) { return typeof s === "string" ? s.trim() : (s && s.name ? String(s.name).trim() : ""); })
    .filter(Boolean)
    .slice(0, 3);
}

// ランキング結果と同期データから銘柄リスト（tickerの配列）を作る純粋な処理。
// 外部通信を含まないので、そのまま単体で実行して結果を確認できる。
export function composeUniverse(stocks, sync) {
  var seen = {}, tickers = [];
  function push(ticker) {
    if (!ticker || typeof ticker !== "string" || seen[ticker]) return false;
    seen[ticker] = true;
    tickers.push(ticker);
    return true;
  }
  // ①ランキング（先勝ち。並べ替えも件数の絞り込みもしない）
  (stocks || []).forEach(function (s) {
    push(typeof s === "string" ? s : (s && s.ticker));
  });
  var rankingCount = tickers.length;
  // ②お気に入り（universeに未収載のものだけ末尾へ）
  var favAdded = 0;
  ((sync && sync.favs) || []).forEach(function (t) { if (push(t)) favAdded++; });
  // ③トレード中（status!=="done"）。同期タイミングによるズレは許容する
  var tradeAdded = 0;
  ((sync && sync.personalTrades) || []).forEach(function (t) {
    if (!t || t.status === "done") return;
    if (push(t.ticker)) tradeAdded++;
  });
  return { tickers: tickers, rankingCount: rankingCount, favAdded: favAdded, tradeAdded: tradeAdded };
}

// 銘柄リストを組み立ててRedisへ保存する。保存の可否は saveUniverse のガードに委ねる。
export async function buildUniverse(opts) {
  var o = opts || {};
  var deadline = Date.now() + BUILD_BUDGET_MS;
  var base = apiBase(o.host);

  // 同期データ（お気に入り・トレード・前回の業種）。読めなくてもランキングだけで続行する
  var sync = null;
  if (!SYNC_USER_ID) {
    console.warn("[scan-universe] SCAN_SYNC_USER_ID が未設定です。お気に入り・トレード中銘柄は追加されません");
  } else {
    try {
      sync = unpackSync(await redis.get("user:" + SYNC_USER_ID));
    } catch (e) {
      console.warn("[scan-universe] 同期データの読み込みに失敗: " + e.message);
    }
  }

  var sectors = normalizeSectors(sync && sync.lastSectors);
  var stocks = [], origin = "";
  if (sectors.length) {
    try {
      var sectorJson = await fetchJsonWithin(base + "/api/sector?sectors=" + encodeURIComponent(sectors.join(",")), deadline);
      stocks = Array.isArray(sectorJson.stocks) ? sectorJson.stocks : [];
      origin = "sector(" + sectors.join("/") + ")";
    } catch (e) {
      console.warn("[scan-universe] /api/sector 失敗: " + e.message + " — 通常ランキングに切り替えます");
    }
  }
  // 業種指定が無い場合も、指定したが0件だった場合も通常ランキングで代替する
  // （フロントの buildStockUniverse と同じ挙動）
  if (!stocks.length) {
    var rankingJson = await fetchJsonWithin(base + "/api/ranking?market=jp", deadline);
    stocks = Array.isArray(rankingJson.stocks) ? rankingJson.stocks : [];
    origin = sectors.length ? "ranking(業種で取れなかったため代替)" : "ranking";
  }

  var composed = composeUniverse(stocks, sync);
  // source は saveUniverse のガード①に合わせて常に "ranking"（＝ランキング由来）。
  // 業種指定かどうかは origin としてログにだけ残す
  var result = await saveUniverse({
    tickers: composed.tickers, source: "ranking", count: composed.tickers.length, savedAt: Date.now(),
  });
  console.log("[scan-universe] 組み立て " + origin + " ランキング:" + composed.rankingCount +
    "件 +お気に入り" + composed.favAdded + "件 +トレード中" + composed.tradeAdded +
    "件 = " + composed.tickers.length + "件 / 保存:" + (result.ok ? "成功" : "拒否(" + result.reason + ")"));
  return {
    count: composed.tickers.length,
    rankingCount: composed.rankingCount,
    favAdded: composed.favAdded,
    tradeAdded: composed.tradeAdded,
    origin: origin,
    saved: !!result.ok,
    reason: result.ok ? null : result.reason,
  };
}

// ── api/stock.js のレスポンス → analyzeStock に渡す株価データ ─────────────
// 欠損値の埋め方は App.js の fetchYahoo と同じにしてある（同じスコアになるように）。
function fill(arr) {
  var out = (arr || []).slice(), first = null;
  for (var k = 0; k < out.length; k++) { if (out[k] != null) { first = out[k]; break; } }
  for (var j = 0; j < out.length; j++) { if (out[j] == null) out[j] = (j > 0 && out[j - 1] != null) ? out[j - 1] : first; }
  return out;
}
// 出来高のnullは「その時間帯に約定が無かった」という意味なので必ず0で埋める
function fillVol(arr) {
  var out = (arr || []).slice();
  for (var j = 0; j < out.length; j++) if (out[j] == null) out[j] = 0;
  return out;
}

export function toPriceData(payload) {
  var result = payload && payload.chart && payload.chart.result && payload.chart.result[0];
  if (!result) throw new Error("empty response");
  var q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  var meta = result.meta || {};
  var closes = fill(q.close);
  if (!closes.length) throw new Error("no price data");
  return {
    closes: closes,
    highs: fill(q.high),
    lows: fill(q.low),
    volumes: fillVol(q.volume),
    opens: fill(q.open),
    dates: q.date || [],
    currentPrice: meta.regularMarketPrice || closes[closes.length - 1],
    previousClose: meta.chartPreviousClose || 0,
    officialPrevClose: meta.regularMarketPreviousClose != null ? meta.regularMarketPreviousClose : null,
    officialVolume: meta.regularMarketVolume != null ? meta.regularMarketVolume : null,
    real: true,
    per: result.per || null,
    pbr: result.pbr || null,
    analystTarget: result.analystTarget || null,
    earningsDate: result.earningsDate || null,
    exRightsDate: result.exRightsDate || null,
    topixChange: result.topixChange != null ? result.topixChange : null,
  };
}

// ── Redis: スキャン結果の追記保存 ─────────────────────────────────────────
// 同じキー(scan:{date}:{slot})に複数バッチが書き込むため、必ず既存配列を読んで
// マージしてから書き戻す（上書きするとバッチ1回分しか残らない）。
// 同一銘柄が2回入った場合は後から来た方で置き換える。
async function mergeResults(key, rows) {
  var existing = parseMaybeJson(await redis.get(key));
  if (!Array.isArray(existing)) existing = [];
  var index = {};
  existing.forEach(function (r, i) { if (r && r.ticker) index[r.ticker] = i; });
  rows.forEach(function (r) {
    if (index[r.ticker] != null) existing[index[r.ticker]] = r;
    else { index[r.ticker] = existing.length; existing.push(r); }
  });
  await redis.set(key, JSON.stringify(existing), { ex: RESULT_TTL });
  return existing.length;
}

// ── 本体：1バッチ分のスキャン ────────────────────────────────────────────
// date  : "YYYY-MM-DD"（JSTの営業日。呼び出し側＝Railwayが決める）
// slot  : "0850"（旧"0830"も可） / "0930" / "1100" / "1300" / "1500"
// offset: 銘柄リストの何件目から処理するか
// limit : 何件処理するか（既定5件）
export async function runScanBatch(opts) {
  var startedAt = Date.now();
  var o = opts || {};
  var date = o.date;
  var slot = o.slot == null ? "" : String(o.slot);
  var offset = Number(o.offset);
  var limit = Number(o.limit);
  if (!isFinite(offset) || offset < 0) offset = 0;
  if (!isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;

  if (!date) return { error: "date required" };
  var session = sessionFromSlot(slot);
  if (!session) return { error: "unknown slot: " + slot };

  // ── スロットの先頭で銘柄リストを組み直す ────────────────────────────────
  // 組み立て（外部API 2本）とスキャン（5銘柄）を1回の呼び出しに詰めるとVercelの
  // 10秒制限を超えるため、組み立てた回は done:0 / nextOffset:0 で即座に返し、
  // 実際のスキャンは呼び出し側（Railway）が続けて投げる次の1回に任せる。
  if (offset === 0) {
    var mark = date + ":" + slot;
    var lastMark = "";
    try { lastMark = String((await redis.get(UNIVERSE_BUILD_KEY)) || ""); } catch (e) { lastMark = ""; }
    if (lastMark !== mark) {
      // マークは組み立ての前に立てる。関数が時間切れで落ちても同じスロットで
      // 組み立てを繰り返さず、前回のリストでスキャンへ進めるようにするため
      try { await redis.set(UNIVERSE_BUILD_KEY, mark, { ex: UNIVERSE_BUILD_TTL }); } catch (e) { /* 失敗しても続行 */ }
      var built = null;
      try {
        built = await buildUniverse({ host: o.host });
      } catch (e) {
        console.log("[scan] 銘柄リストの組み立てに失敗: " + e.message + " — 前回のリストで続行します");
      }
      var ready = (await loadUniverse()).filter(isJPEntry);
      if (!ready.length) {
        console.log("[scan] 組み立て後も銘柄リストが空のため0件で終了します slot:" + slot + " date:" + date);
        return { error: "universe empty" };
      }
      return {
        done: 0, total: ready.length, nextOffset: 0, requested: 0, failed: [],
        session: session, stored: 0, elapsedMs: Date.now() - startedAt,
        built: built || { saved: false },
      };
    }
  }

  // 自動スキャンは日本時間の日中に走るため、米国株は市場が閉まっていて前日終値しか
  // 取れない。統計を汚すうえに実行時間も無駄になるので、日本株（".T"）だけに絞る。
  var saved = await loadUniverse();
  var universe = saved.filter(isJPEntry);
  // 銘柄リストが無い（または日本株が1件も無い）場合は、固定リストで代替せず0件で終わる。
  // 少数の固定銘柄で「成功したように見える」状態を作ると、リストが届いていないことに
  // 気づけなくなるため。
  if (!universe.length) {
    console.log("[scan] 銘柄リストが空のため0件で終了します（保存件数:" + saved.length +
      " 日本株:0）。ランキング取得（/api/sector・/api/ranking）が通っているか確認してください");
    return { error: "universe empty" };
  }
  // 何件を対象にしているかを1スロットにつき1回だけ残す（件数の食い違いの検出用）
  if (offset === 0) {
    console.log("[scan] 銘柄リスト 保存件数:" + saved.length + " 日本株:" + universe.length +
      " slot:" + slot + " date:" + date);
  }

  var total = universe.length;
  var batch = [];
  universe.slice(offset, offset + limit).forEach(function (entry) {
    var s = normalizeStock(entry);
    if (s) batch.push(s);
  });

  var rows = [];
  var failed = [];
  for (var i = 0; i < batch.length; i++) {
    // Yahooの429対策。1件目の前には入れない（10秒の枠を無駄に消費しないため）
    if (i > 0) await sleep(WAIT_MS);
    var stock = batch[i];
    try {
      var payload = await fetchStockPayload(stock.ticker);
      var pd = toPriceData(payload);
      // signalStats を渡さない＝実績による重み補正なし（係数1.0）。
      // scoreHist / intradayHist も localStorage 由来なのでサーバーでは空のまま。
      var s = analyzeStock(stock, pd, null, {});
      // 鮮度チェック：取得データの最終日付が対象日と違えば stale（祝日・メンテ時間帯の検出用。
      // 除外はしない＝呼び出し側・集計側で判断できるように印だけ付ける）
      var lastDate = pd.dates && pd.dates.length ? pd.dates[pd.dates.length - 1] : null;
      rows.push({
        ticker: stock.ticker,
        score: s.save.score,
        price: s.save.price,
        atr: s.save.atr,
        sigKeys: s.save.sigKeys,
        stale: lastDate !== date,
        session: session,   // slotから機械的に決めた時間帯（サーバー時刻は使わない）
        adjusted: false,    // 実績反映調整（重み補正）なしで計算した点数
      });
    } catch (e) {
      // 1銘柄の失敗で全体を止めない。その銘柄だけスキップして次へ進む
      failed.push(stock.ticker);
      console.log("[scan] " + stock.ticker + " スキップ: " + e.message);
    }
  }

  var stored = 0;
  if (rows.length) {
    try {
      stored = await mergeResults(resultKey(date, slot), rows);
    } catch (e) {
      // 保存に失敗したことは呼び出し側が気づけるようにする（進捗は返す）
      console.log("[scan] Redis保存失敗: " + e.message);
      return {
        done: 0, total: total, nextOffset: (offset + batch.length >= total ? null : offset + batch.length),
        elapsedMs: Date.now() - startedAt, error: "save failed: " + e.message,
      };
    }
  }

  var nextOffset = offset + batch.length;
  // batch が0件（offsetが全体件数を超えている）の場合も終了扱いにする
  if (batch.length === 0 || nextOffset >= total) nextOffset = null;

  return {
    done: rows.length,             // 保存できた件数
    total: total,                  // 銘柄リスト全体の件数
    nextOffset: nextOffset,        // 次に渡すoffset（全件終了ならnull）
    elapsedMs: Date.now() - startedAt,
    requested: batch.length,       // 今回処理を試みた件数
    failed: failed,                // 取得・計算に失敗してスキップした銘柄
    session: session,
    stored: stored,                // マージ後にキーへ入っている総件数
  };
}
