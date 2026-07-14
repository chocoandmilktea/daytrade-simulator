// api/sync.js
// お気に入り・お気に入りグループ・スコア履歴のデバイス間同期
// TTL: アクセスのたびに90日延長

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const TTL = 60 * 60 * 24 * 90; // 90日（秒）

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const key = 'user:' + userId;

  if (req.method === 'POST') {
    const { favs, scoreHist, groups, groupNames } = req.body;
    await redis.set(key, JSON.stringify({
      favs: favs || [],
      scoreHist: scoreHist || {},
      groups: groups || {},
      groupNames: groupNames || {},
    }), { ex: TTL });
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'GET') {
    const data = await redis.get(key);
    if (!data) {
      return res.status(200).json({ favs: [], scoreHist: {}, groups: {}, groupNames: {} });
    }

    // GETのたびにTTLを90日リセット
    await redis.expire(key, TTL);

    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    return res.status(200).json({
      favs: parsed.favs || [],
      scoreHist: parsed.scoreHist || {},
      groups: parsed.groups || {},
      groupNames: parsed.groupNames || {},
    });
  }

  return res.status(405).json({ error: 'method not allowed' });
}
