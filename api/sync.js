// api/sync.js
// お気に入り・お気に入りグループ・スコア履歴・トレード記録のデバイス間同期
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Relay-Secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { resource } = req.query;
  if (resource === 'tachibana-watch') return handleTachibanaWatch(req, res);
  if (resource === 'tachibana-quote') return handleTachibanaQuote(req, res);

  // ここから下はデバイス間同期処理
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const key = 'user:' + userId;

  if (req.method === 'POST') {
    try {
      const { favs, scoreHist, groups, groupNames, appTrades, personalTrades } = readBody(req);
      await redis.set(key, packForRedis({
        favs: favs || [],
        scoreHist: scoreHist || {},
        groups: groups || {},
        groupNames: groupNames || {},
        appTrades: appTrades || [],
        personalTrades: personalTrades || [],
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
        return res.status(200).json({ found: false, favs: [], scoreHist: {}, groups: {}, groupNames: {}, appTrades: [], personalTrades: [] });
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
      });
    } catch (e) {
      return res.status(500).json({ error: 'load failed: ' + e.message });
    }
  }

  return res.status(405).json({ error: 'method not allowed' });
}
