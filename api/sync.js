import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  if (req.method === 'POST') {
    const { favs, portfolio } = req.body;
    await redis.set('user:' + userId, JSON.stringify({ favs: favs || [], portfolio: portfolio || [] }), { ex: 60 * 60 * 24 * 90 });
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'GET') {
    const data = await redis.get('user:' + userId);
    if (!data) return res.status(200).json({ favs: [], portfolio: [] });
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    return res.status(200).json(parsed);
  }

  return res.status(405).json({ error: 'method not allowed' });
}
