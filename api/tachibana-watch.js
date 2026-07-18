// api/tachibana-watch.js
// フロント（App.js）が「今この銘柄を見ています」とサーバーに伝えるためのAPI。
// tachibana-server（VPS）はこの値を見て、購読する銘柄を切り替える。

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const WATCH_KEY = 'tachibana:watch';
const WATCH_TTL = 60 * 5; // 5分（誰も更新しなければ自動的に消える）

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { ticker } = req.body || {};
  if (!ticker) return res.status(400).json({ error: 'ticker required' });

  await redis.set(WATCH_KEY, JSON.stringify({ ticker, ts: Date.now() }), { ex: WATCH_TTL });
  return res.status(200).json({ ok: true });
}

