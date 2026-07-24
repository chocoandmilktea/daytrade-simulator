// api/_fallbackCache.js
// 立花証券API側が一時的に使えない時（早朝メンテナンス等）に、
// 直前に成功した時のデータをRedisから返すための共通ヘルパー。
//
// ファイル名を "_" で始めているのは、Vercelがこのファイルを
// 個別のAPIエンドポイントとして扱わないようにするため
// （sync.js等から普通のモジュールとしてimportして使う）。

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const SNAPSHOT_TTL = 60 * 60 * 24 * 3; // 3日分保持（連休を挟んでも切れないように）

/**
 * @param {string} key - データの種類を表す文字列（例: 'ranking:volume', 'topix'）
 * @param {() => Promise<any>} fetchFn - 実際に立花証券APIからデータを取る処理
 */
export async function withFallback(key, fetchFn) {
  const snapshotKey = 'snapshot:' + key;

  try {
    const data = await fetchFn();
    // 成功したら「最新の引けデータ」として保存しておく
    await redis.set(snapshotKey, JSON.stringify({ data, savedAt: Date.now() }), { ex: SNAPSHOT_TTL });
    return data;
  } catch (err) {
    const cached = await redis.get(snapshotKey);
    if (cached) {
      const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
      console.warn(`[fallback] ${key}: 取得失敗のため ${new Date(parsed.savedAt).toLocaleString('ja-JP')} 時点のデータを使用`);
      return parsed.data;
    }
    throw err; // フォールバックも無ければ、元のエラーをそのまま返す
  }
}
