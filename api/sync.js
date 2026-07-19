// api/sync.js
// お気に入り・お気に入りグループ・スコア履歴・トレード記録のデバイス間同期
// TTL: アクセスのたびに90日延長
//
// resource=tachibana-watch / tachibana-quote のときは、立花証券リアルタイム連携用の
// 中継処理を行う。Vercel Hobbyプランのサーバーレス関数は12個までという制限があるため、
// 専用ファイルを新規に増やさず、このファイルに同居させている。

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const TTL = 60 * 60 * 24 * 90; // 90日（秒）

const WATCH_KEY = 'tachibana:watch';
const WATCH_TTL = 60 * 5;
const RELAY_SECRET = process.env.TACHIBANA_RELAY_SECRET;

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

async function handleTachibanaQuote(req, res) {
  if (req.method === 'POST') {
    if (RELAY_SECRET && req.headers['x-relay-secret'] !== RELAY_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const { ticker, fields, updatedAt } = req.body || {};
    if (!ticker) return res.status(400).json({ error: 'ticker required' });
    await redis.set(
      'tachibana:quote:' + ticker,
      JSON.stringify({ ticker, fields, updatedAt: updatedAt || Date.now() }),
      { ex: 30 }
    );
    return res.status(200).json({ ok: true });
  }
  if (req.method === 'GET') {
    const { ticker } = req.query;
    if (!ticker) return res.status(400).json({ error: 'ticker required' });
    const data = await redis.get('tachibana:quote:' + ticker);
    if (!data) return res.status(200).json({ found: false });
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    return res.status(200).json({ found: true, ...parsed });
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

  // ここから下は既存のデバイス間同期処理（変更なし）
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const key = 'user:' + userId;

  if (req.method === 'POST') {
    const { favs, scoreHist, groups, groupNames, appTrades, personalTrades } = req.body;
    await redis.set(key, JSON.stringify({
      favs: favs || [],
      scoreHist: scoreHist || {},
      groups: groups || {},
      groupNames: groupNames || {},
      appTrades: appTrades || [],
      personalTrades: personalTrades || [],
    }), { ex: TTL });
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'GET') {
    const data = await redis.get(key);
    if (!data) {
      return res.status(200).json({ found: false, favs: [], scoreHist: {}, groups: {}, groupNames: {}, appTrades: [], personalTrades: [] });
    }
    await redis.expire(key, TTL);
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    return res.status(200).json({
      found: true,
      favs: parsed.favs || [],
      scoreHist: parsed.scoreHist || {},
      groups: parsed.groups || {},
      groupNames: parsed.groupNames || {},
      appTrades: parsed.appTrades || [],
      personalTrades: parsed.personalTrades || [],
    });
  }

  return res.status(405).json({ error: 'method not allowed' });
}
