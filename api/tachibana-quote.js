// api/tachibana-quote.js
// tachibana-server（Railway/VPS）が最新の株価・板情報を書き込むAPI（POST、合言葉で保護）。
// フロント（App.js）はGETでポーリングして最新値を受け取る（保護なし、既存APIと同じ扱い）。

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const RELAY_SECRET = process.env.TACHIBANA_RELAY_SECRET;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Relay-Secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

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

