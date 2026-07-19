// api/tachibana-watch.js
// フロント（App.js）が「今この銘柄を見ています」とサーバーに伝えるAPI（POST）。
// tachibana-server（Railway/VPS）はこの値をGETで読み取り、購読する銘柄を切り替える。
// GETはRailway専用なので、合言葉(TACHIBANA_RELAY_SECRET)で保護する。

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const WATCH_KEY = 'tachibana:watch';
const WATCH_TTL = 60 * 5; // 5分（誰も更新しなければ自動的に消える）
const RELAY_SECRET = process.env.TACHIBANA_RELAY_SECRET;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Relay-Secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

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

