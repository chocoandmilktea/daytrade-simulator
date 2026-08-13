// api/sync.js
// お気に入り・お気に入りグループ・スコア履歴・トレード記録・予測ログのデバイス間同期
// TTL: アクセスのたびに90日延長
//
// resource=tachibana-watch / tachibana-quote のときは、立花証券リアルタイム連携用の
// 中継処理を行う。Vercel Hobbyプランのサーバーレス関数は12個までという制限があるため、
// 専用ファイルを新規に増やさず、このファイルに同居させている。
//
// 【データ圧縮について】
// スコア履歴は銘柄が増えるほど大きくなり、そのまま扱うと
//   ・アプリ → Vercel の送信サイズ
//   ・Vercel → Redis の1リクエストあたりのサイズ（1MB）
// の両方で頭打ちになる。そこで、
//   ・受信時: アプリから {gz:"..."} で送られてきたら展開してから読む
//   ・保存時: 常にgzip圧縮して "gz:" 付きの文字列としてRedisへ保存
//   ・取得時: "gz:" で始まっていれば展開する（付いていない過去のデータもそのまま読める）
// という形にして、実データの10〜20分の1程度で保存・送信できるようにしている。

import { Redis } from '@upstash/redis';
import { gzipSync, gunzipSync } from 'zlib';

const redis = Redis.fromEnv();
const TTL = 60 * 60 * 24 * 90; // 90日（秒）

const WATCH_KEY = 'tachibana:watch';
const WATCH_TTL = 60 * 5;
const RELAY_SECRET = process.env.TACHIBANA_RELAY_SECRET;

const GZ_PREFIX = 'gz:';

const SCAN_DEFAULT_LIMIT = 5; // scan-run の limit 既定値（1バッチあたりの銘柄数）

// アプリから届いたリクエストボディを、圧縮の有無にかかわらず素のオブジェクトにして返す
function readBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return {}; }
  }
  if (!body || typeof body !== 'object') return {};
  if (typeof body.gz === 'string') {
    const json = gunzipSync(Buffer.from(body.gz, 'base64')).toString('utf8');
    return JSON.parse(json);
  }
  return body;
}

// Redisへ保存する文字列を作る（常にgzip圧縮する）
function packForRedis(obj) {
  return GZ_PREFIX + gzipSync(Buffer.from(JSON.stringify(obj), 'utf8')).toString('base64');
}

// Redisから読んだ値をオブジェクトに戻す（圧縮前に保存された過去データにも対応）
function unpackFromRedis(data) {
  if (data == null) return null;
  if (typeof data === 'object') return data; // Upstashが自動でJSONに戻した場合
  if (typeof data !== 'string') return null;
  if (data.startsWith(GZ_PREFIX)) {
    const json = gunzipSync(Buffer.from(data.slice(GZ_PREFIX.length), 'base64')).toString('utf8');
    return JSON.parse(json);
  }
  try { return JSON.parse(data); } catch (e) { return null; }
}

async function handleTachibanaWatch(req, res) {
  if (req.method === 'POST') {
    const { ticker } = req.body || {};
    if (!ticker) return res.status(400).json({ error: 'ticker required' });
    await redis.set(WATCH_KEY, JSON.stringify({ ticker, ts: Date.now() }), { ex: WATCH_TTL });
    return res.status(200).json({ ok: true });
  }
  if (req.method === 'GET') {
    if (RELAY_SECRET && req.headers['x-relay-secret'] !== RELAY_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const data = await redis.get(WATCH_KEY);
    if (!data) return res.status(200).json({ found: false });
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    return res.status(200).json({ found: true, ...parsed });
  }
  return res.status(405).json({ error: 'method not allowed' });
}

// 休場中でも直近の板情報を表示できるよう、長期保存用スナップショットを別途持たせる
const QUOTE_SNAPSHOT_TTL = 60 * 60 * 24 * 3; // 3日（連休を挟んでも切れないように）

async function handleTachibanaQuote(req, res) {
  if (req.method === 'POST') {
    if (RELAY_SECRET && req.headers['x-relay-secret'] !== RELAY_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const { ticker, fields, updatedAt } = req.body || {};
    if (!ticker) return res.status(400).json({ error: 'ticker required' });
    const payload = JSON.stringify({ ticker, fields, updatedAt: updatedAt || Date.now() });
    await redis.set('tachibana:quote:' + ticker, payload, { ex: 30 });
    await redis.set('tachibana:quote:last:' + ticker, payload, { ex: QUOTE_SNAPSHOT_TTL });
    return res.status(200).json({ ok: true });
  }
  if (req.method === 'GET') {
    const { ticker } = req.query;
    if (!ticker) return res.status(400).json({ error: 'ticker required' });
    const live = await redis.get('tachibana:quote:' + ticker);
    if (live) {
      const parsed = typeof live === 'string' ? JSON.parse(live) : live;
      return res.status(200).json({ found: true, stale: false, ...parsed });
    }
    // ライブ値が無い＝立花証券が閉まっている時間帯。直近の成功データを代わりに返す
    const snapshot = await redis.get('tachibana:quote:last:' + ticker);
    if (!snapshot) return res.status(200).json({ found: false });
    const parsed = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
    return res.status(200).json({ found: true, stale: true, ...parsed });
  }
  return res.status(405).json({ error: 'method not allowed' });
}

// ── 寄り前ログ（tachibana-server の premarketLogger.js から届く） ─────────
// 8:31〜9:06の気配推移を、1回の記録セッション
// （{ date, codes, cols, startedAt, finishedAt, count, records }）ごとに
// POSTで受け取り、日付キーの配列へ追記していく。30日保存。
// 立花の戻り値をそのまま貯めたものなので、キー名の変換・整形は一切しない。
const PREMARKET_LOG_PREFIX = 'premarket:log:';
const PREMARKET_LOG_TTL = 60 * 60 * 24 * 30; // 30日（秒）

// JSTの当日（YYYY-MM-DD）。VercelはUTCで動くため、+9時間してから日付部分を取る
function jstDateString() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function isDateString(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// 保存済みの日付を新しい順に返す
async function listPremarketDates() {
  const keys = await redis.keys(PREMARKET_LOG_PREFIX + '*');
  return (keys || [])
    .map(function (k) { return String(k).slice(PREMARKET_LOG_PREFIX.length); })
    .sort()
    .reverse();
}

async function handlePremarketLog(req, res) {
  if (req.method === 'POST') {
    if (!RELAY_SECRET || req.headers['x-relay-secret'] !== RELAY_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      const body = readBody(req);
      // 送信側が付けてきた日付を優先し、無ければサーバー側のJST当日にする
      const date = isDateString(body.date) ? body.date : jstDateString();
      const key = PREMARKET_LOG_PREFIX + date;

      // 既存の配列を読み、無ければ（過去の別形式だった場合も含め）空配列から始める
      const stored = unpackFromRedis(await redis.get(key));
      const list = Array.isArray(stored) ? stored : [];

      // 送られてきたボディを丸ごと追記する（同じ日に複数回POSTされても上書きしない）
      list.push(body);
      await redis.set(key, packForRedis(list), { ex: PREMARKET_LOG_TTL });

      // count は「その日に何セッション貯まっているか」を返す
      return res.status(200).json({ ok: true, count: list.length });
    } catch (e) {
      return res.status(500).json({ error: 'save failed: ' + e.message });
    }
  }

  if (req.method === 'GET') {
    try {
      const { date } = req.query;

      // date=list → 保存済みの日付一覧だけを返す
      if (date === 'list') {
        const dates = await listPremarketDates();
        return res.status(200).json({ dates: dates });
      }

      // date未指定なら本日（JST）の分を返す
      const target = date || jstDateString();
      if (!isDateString(target)) return res.status(400).json({ error: 'invalid date' });

      const raw = await redis.get(PREMARKET_LOG_PREFIX + target);
      const parsed = unpackFromRedis(raw);
      if (!parsed) return res.status(200).json({ found: false, date: target });
      return res.status(200).json({ found: true, date: target, data: parsed });
    } catch (e) {
      return res.status(500).json({ error: 'load failed: ' + e.message });
    }
  }

  return res.status(405).json({ error: 'method not allowed' });
}

// ── サーバー側スキャン（Phase 2）の窓口 ──────────────────────────────────
// 実処理は api/_scan.js。ここは受け口だけ。立花中継と同じく、Vercel Hobbyの
// 関数12個制限を消費しないよう sync.js に相乗りさせている。
//
// _scan.js は api/stock.js（xlsx読み込みを含む）と src/lib/analyze.js を読み込むため、
// ファイル先頭で静的importすると、スキャンと無関係な呼び出し（デバイス間同期・
// 立花中継。60秒おきに叩かれる）のコールドスタートまで重くなる。
// そのため scan-* が呼ばれた時だけ動的importで読み込む。

// ① 銘柄リストの保存・取得（POST: 配列を保存 / GET: 現在のリストを返す）
async function handleScanUniverse(req, res) {
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'invalid json' }); }
    }
    // ボディはそのまま _scan.js へ渡す（ガード判定は _scan.js に集約）。
    // 拒否された場合もHTTP 200で reason を返す（フロント側でログに出すため）
    try {
      const { saveUniverse } = await import('./_scan.js');
      const result = await saveUniverse(body);
      // 何件で上書きしたかを残す（自動スキャンの件数が想定と合わないときの突き合わせ用）
      if (result.ok) console.log('[scan-universe] 銘柄リストを保存しました。件数:', result.count);
      else console.warn('[scan-universe] 銘柄リストを保存しませんでした:', result.reason);
      return res.status(200).json(result);
    } catch (e) {
      return res.status(500).json({ error: 'save failed: ' + e.message });
    }
  }
  if (req.method === 'GET') {
    try {
      const { loadUniverse } = await import('./_scan.js');
      const list = await loadUniverse();
      return res.status(200).json({ count: list.length, universe: list });
    } catch (e) {
      return res.status(500).json({ error: 'load failed: ' + e.message });
    }
  }
  return res.status(405).json({ error: 'method not allowed' });
}

// ② スキャンの実行（Phase 3のスケジューラ＝Railwayから叩かれる）
// 外部から自由に実行されると外部APIへの負荷になるため、立花中継と同じ
// X-Relay-Secret による認証を必須にする
async function handleScanRun(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (!RELAY_SECRET || req.headers['x-relay-secret'] !== RELAY_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'invalid json' }); }
  }
  body = body || {};
  try {
    const { runScanBatch } = await import('./_scan.js');
    const result = await runScanBatch({
      date: body.date,
      slot: body.slot,
      offset: body.offset,
      limit: body.limit != null ? body.limit : SCAN_DEFAULT_LIMIT,
    });
    // universe未登録・slot不正などは処理不能なので400で返す（呼び出し側が止められるように）
    if (result.error && result.done == null) return res.status(400).json(result);
    // 取得はできたがRedis保存に失敗した場合は500（呼び出し側がリトライを判断できるように）
    if (result.error) return res.status(500).json(result);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: 'scan failed: ' + e.message });
  }
}

// ③ 保存された結果の確認（動作確認用。フロントへの取り込みはPhase 4）
async function handleScanResult(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });
  try {
    const { resultKey, SLOT_SESSIONS } = await import('./_scan.js');
    const slots = Object.keys(SLOT_SESSIONS);
    const values = await redis.mget(...slots.map(function (slot) { return resultKey(date, slot); }));
    const out = {};
    let totalCount = 0;
    slots.forEach(function (slot, i) {
      let v = values[i];
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
      if (Array.isArray(v)) { out[slot] = v; totalCount += v.length; }
    });
    return res.status(200).json({ date: date, totalCount: totalCount, slots: out });
  } catch (e) {
    return res.status(500).json({ error: 'load failed: ' + e.message });
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Relay-Secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { resource } = req.query;
  if (resource === 'tachibana-watch') return handleTachibanaWatch(req, res);
  if (resource === 'tachibana-quote') return handleTachibanaQuote(req, res);
  if (resource === 'premarket-log') return handlePremarketLog(req, res);
  if (resource === 'scan-universe') return handleScanUniverse(req, res);
  if (resource === 'scan-run') return handleScanRun(req, res);
  if (resource === 'scan-result') return handleScanResult(req, res);

  // ここから下はデバイス間同期処理
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const key = 'user:' + userId;

  if (req.method === 'POST') {
    try {
      const { favs, scoreHist, groups, groupNames, appTrades, personalTrades, forecasts } = readBody(req);
      await redis.set(key, packForRedis({
        favs: favs || [],
        scoreHist: scoreHist || {},
        groups: groups || {},
        groupNames: groupNames || {},
        appTrades: appTrades || [],
        personalTrades: personalTrades || [],
        forecasts: forecasts || [],
      }), { ex: TTL });
      return res.status(200).json({ ok: true });
    } catch (e) {
      // 展開・保存に失敗した場合は、アプリ側が気づけるようエラーを返す（黙って失敗させない）
      return res.status(500).json({ error: 'save failed: ' + e.message });
    }
  }

  if (req.method === 'GET') {
    try {
      const data = await redis.get(key);
      const parsed = unpackFromRedis(data);
      if (!parsed) {
        return res.status(200).json({ found: false, favs: [], scoreHist: {}, groups: {}, groupNames: {}, appTrades: [], personalTrades: [], forecasts: [] });
      }
      await redis.expire(key, TTL);
      return res.status(200).json({
        found: true,
        favs: parsed.favs || [],
        scoreHist: parsed.scoreHist || {},
        groups: parsed.groups || {},
        groupNames: parsed.groupNames || {},
        appTrades: parsed.appTrades || [],
        personalTrades: parsed.personalTrades || [],
        forecasts: parsed.forecasts || [],
      });
    } catch (e) {
      return res.status(500).json({ error: 'load failed: ' + e.message });
    }
  }

  return res.status(405).json({ error: 'method not allowed' });
}
