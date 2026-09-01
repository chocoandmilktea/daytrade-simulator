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

// TACHIBANA_RELAY_SECRET による認証。未設定時は常に拒否（フェイルクローズ）
function isAuthed(req) {
  return !!RELAY_SECRET && req.headers['x-relay-secret'] === RELAY_SECRET;
}

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
    if (!isAuthed(req)) return res.status(401).json({ error: 'unauthorized' });
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
    if (!isAuthed(req)) return res.status(401).json({ error: 'unauthorized' });
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
// 8:45〜9:06の気配推移を、1回の記録セッション
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
    if (!isAuthed(req)) return res.status(401).json({ error: 'unauthorized' });
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

// ── 寄り前ログの集計（読み取り専用） ────────────────────────────────────
// premarket-log で貯めた生ログを「日付 × 銘柄」で1行にまとめて返す。
// 参照するキーは premarket-log と同じ premarket:log:<日付> のみで、
// 保存もTTLの延長も一切しない（生ログは検証用にそのまま残す）。
//
// 生ログの入れ子は次の3階層になっている:
//   セッション { startedAt, finishedAt, records } → records[] { ts, raw } → raw[] { sIssueCode, ... }
// エラー時のレコードは raw を持たず { ts, error } なので、集計対象から自然に外れる。

// 立花の戻り値は文字列。空文字・数値化できない値は null として扱う
function toNum(v) {
  if (v == null) return null;
  var s = String(v).trim();
  if (s === '') return null;
  var n = Number(s);
  return isFinite(n) ? n : null;
}

function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }

// 1日ぶんのセッション配列を、銘柄ごとの1行にまとめる
function summarizePremarketDate(date, sessions) {
  // まず銘柄コードごとに { ts, row } を集める
  var byCode = {};
  // エラーは銘柄単位ではなく取得単位で起きるため、その日のセッション全体で数える
  var errorCount = 0;
  sessions.forEach(function (session) {
    if (!session || !Array.isArray(session.records)) return;
    session.records.forEach(function (rec) {
      if (!rec) return;
      if (!Array.isArray(rec.raw)) { // エラーレコードには raw が無い（{ ts, error }）
        errorCount++;
        return;
      }
      rec.raw.forEach(function (row) {
        if (!row) return;
        var code = String(row.sIssueCode == null ? '' : row.sIssueCode).trim();
        if (!code) return;
        if (!byCode[code]) byCode[code] = [];
        byCode[code].push({ ts: toNum(rec.ts), row: row });
      });
    });
  });

  return Object.keys(byCode).sort().map(function (code) {
    // 同じ日に複数セッションが貯まっている場合に備え、取得時刻の昇順に並べ直す
    var list = byCode[code].slice().sort(function (a, b) {
      return (a.ts == null ? 0 : a.ts) - (b.ts == null ? 0 : b.ts);
    });

    var ratios = [];
    var open = null;
    var prevClose = null;

    list.forEach(function (item) {
      var ask = toNum(item.row.pAAV); // 売気配数量
      var bid = toNum(item.row.pABV); // 買気配数量
      // 寄り成立後のレコードは気配が空文字になるため、両方に値がある時だけ使う。
      // 片側が0の買い一色・売り一色はギャップ予想で最も重要な局面なので、
      // 合計が0でない限り除外せず、0% / 100% として記録する
      if (ask != null && bid != null && ask + bid > 0) {
        ratios.push(bid / (ask + bid) * 100);
      }
      // 始値・前日終値は「取得できた最後の非空値」を採用する
      // （始値は寄りが付くまで空なので、上書きしていくと最終的に確定値が残る）
      var o = toNum(item.row.pDOP);
      if (o != null) open = o;
      var p = toNum(item.row.pPRP);
      if (p != null) prevClose = p;
    });

    // 有効レコードが0件なら買い比率は全て null にする
    var first = null, last = null, min = null, max = null, avg = null;
    if (ratios.length > 0) {
      var sum = 0, lo = ratios[0], hi = ratios[0];
      ratios.forEach(function (r) {
        sum += r;
        if (r < lo) lo = r;
        if (r > hi) hi = r;
      });
      first = round1(ratios[0]);
      last = round1(ratios[ratios.length - 1]);
      min = round1(lo);
      max = round1(hi);
      avg = round1(sum / ratios.length);
    }

    // 前日終値が0だと割り算が壊れるため、その場合も null にする
    var gapPct = null;
    if (open != null && prevClose != null && prevClose !== 0) {
      gapPct = round2((open - prevClose) / prevClose * 100);
    }

    return {
      date: date,
      code: code,
      quoteCount: list.length, // その銘柄のrawが取れたレコード数
      validCount: ratios.length, // うち買い比率の計算に使えた件数
      errorCount: errorCount, // その日のセッション全体でrawを持たなかったレコード数
      // その銘柄が実際に取れた最初と最後の時刻（epochミリ秒）
      startedAt: list.length ? list[0].ts : null,
      finishedAt: list.length ? list[list.length - 1].ts : null,
      buyRatioFirst: first,
      buyRatioLast: last,
      buyRatioMin: min,
      buyRatioMax: max,
      buyRatioAvg: avg,
      open: open,
      prevClose: prevClose,
      gapPct: gapPct,
    };
  });
}

async function handlePremarketSummary(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
  // date未指定だと保存済みの全日分（最大30日）を展開してしまい、40銘柄規模では
  // 応答が数十MBに達してVercelの上限・実行時間を圧迫する。Redisを触る前に弾く
  if (!req.query.date) return res.status(400).json({ error: 'date required' });
  try {
    var date = req.query.date;
    if (!isDateString(date)) return res.status(400).json({ error: 'invalid date' });
    var dates = [date];
    if (dates.length === 0) return res.status(200).json({ count: 0, rows: [] });

    var values = await redis.mget(...dates.map(function (d) { return PREMARKET_LOG_PREFIX + d; }));
    var rows = [];
    dates.forEach(function (d, i) {
      var parsed = unpackFromRedis(values[i]);
      if (!Array.isArray(parsed)) return; // 未保存の日付は飛ばす
      rows = rows.concat(summarizePremarketDate(d, parsed));
    });
    return res.status(200).json({ count: rows.length, rows: rows });
  } catch (e) {
    return res.status(500).json({ error: 'load failed: ' + e.message });
  }
}

// ── 寄り前気配の較正モード（mode=calib・読み取り専用） ──────────────────
// 「買い比率が何%のとき、実際のギャップ（寄り値と前日終値の差）が何%になるか」の
// 変換係数を求めるための集計。行の作成は summarizePremarketDate をそのまま使う
// （買い比率・gapPct の算出をここで書き直すと mode未指定の明細と数字が食い違うため）。
// 生ログは1日あたり展開後で数MBあるため、1日読むごとに集計値だけ残して生データは捨てる。
// 保存・TTL延長は一切しない（redis.get のみ）。

var CALIB_MAX_DAYS = 10; // 範囲の上限日数。これを超えるとVercelの実行時間とメモリを圧迫する
var CALIB_VARIANTS = ['first', 'last', 'min', 'max', 'avg']; // 買い比率の5変種

function round3(n) { return Math.round(n * 1000) / 1000; }
// null をそのまま通す丸め（相関が計算できなかった場合に例外を投げないため）
function r3(n) { return n == null ? null : round3(n); }

// 変種名 → summarizePremarketDate の戻り値のキー名（first → buyRatioFirst）
function buyRatioKey(variant) {
  return 'buyRatio' + variant.charAt(0).toUpperCase() + variant.slice(1);
}

// from から to まで1日ずつのYYYY-MM-DD配列。UTCで進めるのでタイムゾーンの影響を受けない
function calibDateRange(from, to) {
  var out = [];
  var cur = Date.parse(from + 'T00:00:00Z');
  var end = Date.parse(to + 'T00:00:00Z');
  while (cur <= end) {
    out.push(new Date(cur).toISOString().slice(0, 10));
    cur += 86400000;
    if (out.length > 400) break; // 想定外の入力で無限ループしないための保険
  }
  return out;
}

// 相関・単回帰の積算器。行そのものは保持せず合計だけを持ち回る（メモリ節約）
function newCalibAcc() {
  return {
    n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0,
    dirN: 0, dirHit: 0, // 買い比率50超の行数と、そのうち gapPct>0 だった行数
    rankSum: 0, rankWeight: 0, // 日内順位相関の行数重み付き合計
  };
}

function calibAccAdd(acc, x, y) {
  acc.n++;
  acc.sx += x; acc.sy += y;
  acc.sxx += x * x; acc.syy += y * y; acc.sxy += x * y;
  if (x > 50) { acc.dirN++; if (y > 0) acc.dirHit++; }
}

// ピアソンの相関係数。件数2未満・分散0のときは例外を投げず null を返す
function pearsonFromSums(n, sx, sy, sxx, syy, sxy) {
  if (n < 2) return null;
  var vx = sxx - sx * sx / n;
  var vy = syy - sy * sy / n;
  if (!(vx > 0) || !(vy > 0)) return null;
  var d = Math.sqrt(vx * vy);
  if (!(d > 0)) return null;
  return (sxy - sx * sy / n) / d;
}

// 配列2本から相関係数を出す（日内順位相関・日別相関で使う）
function pearsonOf(xs, ys) {
  var n = xs.length;
  var sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (var i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i];
    sxx += xs[i] * xs[i]; syy += ys[i] * ys[i]; sxy += xs[i] * ys[i];
  }
  return pearsonFromSums(n, sx, sy, sxx, syy, sxy);
}

// 昇順の順位（1始まり）に直す。同値には平均順位を与える
function rankArray(values) {
  var idx = values.map(function (v, i) { return i; });
  idx.sort(function (a, b) { return values[a] - values[b]; });
  var ranks = new Array(values.length);
  var i = 0;
  while (i < idx.length) {
    var j = i;
    while (j + 1 < idx.length && values[idx[j + 1]] === values[idx[i]]) j++;
    var avg = (i + j) / 2 + 1; // 同値の平均順位
    for (var k = i; k <= j; k++) ranks[idx[k]] = avg;
    i = j + 1;
  }
  return ranks;
}

async function handlePremarketCalib(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
  var from = req.query.from;
  var to = req.query.to;
  // Redisを触る前に入力を弾く（範囲が広いほど展開コストが跳ね上がるため）
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  if (!isDateString(from) || !isDateString(to)) return res.status(400).json({ error: 'invalid date' });
  if (from > to) return res.status(400).json({ error: 'from must not be after to' });
  var dates = calibDateRange(from, to);
  if (dates.length > CALIB_MAX_DAYS) return res.status(400).json({ error: 'range too wide (max 10 days)' });

  try {
    var accs = {};
    CALIB_VARIANTS.forEach(function (v) { accs[v] = newCalibAcc(); });
    var daily = []; // どの日が外れ値かを目視するための日別内訳
    var used = []; // 実際に読めた日付
    var totalRows = 0, noGap = 0, noRatio = 0;

    for (var di = 0; di < dates.length; di++) {
      var d = dates[di];
      var parsed = unpackFromRedis(await redis.get(PREMARKET_LOG_PREFIX + d));
      if (!Array.isArray(parsed)) continue; // 未保存の日付はスキップ（エラーにしない）
      var rows = summarizePremarketDate(d, parsed);
      parsed = null; // 生ログはここで捨てる（全日分を同時にメモリへ載せない）
      used.push(d);
      totalRows += rows.length;

      rows.forEach(function (row) {
        // 除外理由は独立に数える（両方nullの行は両方に計上される）
        if (row.gapPct == null) noGap++;
        // 買い比率5変種は validCount=0 のとき同時にnullになるため avg で代表させる
        if (row.buyRatioAvg == null) noRatio++;
      });

      CALIB_VARIANTS.forEach(function (v) {
        var key = buyRatioKey(v);
        var acc = accs[v];
        var xs = [], ys = [];
        rows.forEach(function (row) {
          var ratio = row[key];
          if (ratio == null || row.gapPct == null) return; // どちらか欠けた行は対象外
          calibAccAdd(acc, ratio, row.gapPct);
          xs.push(ratio); ys.push(row.gapPct);
        });
        // 日内順位相関: 各日の中だけで順位に直す（日をまたいで順位を混ぜない）
        if (xs.length >= 2) {
          var rr = pearsonOf(rankArray(xs), rankArray(ys));
          if (rr != null) { acc.rankSum += rr * xs.length; acc.rankWeight += xs.length; }
        }
        if (v === 'avg') {
          var sumX = 0, sumY = 0;
          for (var i = 0; i < xs.length; i++) { sumX += xs[i]; sumY += ys[i]; }
          daily.push({
            date: d,
            n: xs.length,
            buyRatioAvgMean: xs.length ? round3(sumX / xs.length) : null,
            gapPctMean: xs.length ? round3(sumY / xs.length) : null,
            r: r3(pearsonOf(xs, ys)),
          });
        }
      });
      rows = null; // 明細もここで捨てる
    }

    var ratios = {};
    CALIB_VARIANTS.forEach(function (v) {
      var a = accs[v];
      // gapPct = slope × (買い比率 − 50) + intercept
      // 傾きは平行移動で変わらないので、切片だけ50中心にずらして求める
      var slope = null, intercept = null;
      if (a.n >= 2) {
        var vx = a.sxx - a.sx * a.sx / a.n;
        if (vx > 0) {
          slope = (a.sxy - a.sx * a.sy / a.n) / vx;
          intercept = a.sy / a.n - slope * (a.sx / a.n - 50);
        }
      }
      ratios[v] = {
        n: a.n,
        r: r3(pearsonFromSums(a.n, a.sx, a.sy, a.sxx, a.syy, a.sxy)),
        rRank: a.rankWeight > 0 ? round3(a.rankSum / a.rankWeight) : null,
        slope: r3(slope),
        intercept: r3(intercept),
        dirRate: a.dirN > 0 ? round3(a.dirHit / a.dirN) : null,
      };
    });

    return res.status(200).json({
      mode: 'calib',
      from: from,
      to: to,
      dates: used,
      ratios: ratios,
      daily: daily,
      excluded: { noGap: noGap, noRatio: noRatio, totalRows: totalRows },
    });
  } catch (e) {
    return res.status(500).json({ error: 'load failed: ' + e.message });
  }
}

// ── 寄り前気配の収集カバレッジ（mode=coverage・読み取り専用） ──────────────
// 「収集対象だったのに集計に1行も現れなかった銘柄」「始値が取れなかった銘柄」
// 「買い比率が取れなかった銘柄」をコード一覧で返す調査用モード。
// 寄り予想をサーバー側へ移すにあたり、答え合わせに使う始値をいつ取るべきかを
// 判断するための材料であって、アプリからは呼ばない。
// 行の作成は summarizePremarketDate をそのまま使う（欠測の判定基準をここで
// 書き直すと mode未指定の明細と食い違うため）。
// 対象は単一日のみ。保存・TTL延長は一切しない（redis.get のみ）。

var COVERAGE_MAX_CODES = 200; // 1リストあたりの表示上限。超えた分は切って truncated を立てる

// 立花の戻り値（sIssueCode）とセッションの codes を突き合わせるための正規化。
// 278A のような英字入りコードで大文字小文字が食い違ったときに
// 別銘柄として数えてしまわないよう、大文字に寄せてから比較する
function normalizeCoverageCode(v) {
  return String(v == null ? '' : v).trim().toUpperCase();
}

// コード一覧を昇順に並べ、上限で切って { count, truncated, codes } に整える。
// count は切る前の実件数（切り捨てで総数が分からなくなると調査に使えないため）
function coverageList(codes) {
  var sorted = codes.slice().sort();
  return {
    count: sorted.length,
    truncated: sorted.length > COVERAGE_MAX_CODES,
    codes: sorted.slice(0, COVERAGE_MAX_CODES),
  };
}

async function handlePremarketCoverage(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
  var date = req.query.date;
  // Redisを触る前に入力を弾く（生ログは1日ぶんでも展開後は数MBあるため）
  if (!date) return res.status(400).json({ error: 'date required' });
  if (!isDateString(date)) return res.status(400).json({ error: 'invalid date' });

  try {
    var parsed = unpackFromRedis(await redis.get(PREMARKET_LOG_PREFIX + date));
    // 未保存の日付はエラーにせず found:false で返す（休日・収集前を区別するため）
    if (!Array.isArray(parsed)) {
      return res.status(200).json({
        mode: 'coverage',
        date: date,
        found: false,
        sessionCount: 0,
        sessionsWithCodes: 0,
        target: coverageList([]),
        missing: coverageList([]),
        noOpen: coverageList([]),
        noBuyRatio: coverageList([]),
        appearedCount: 0,
      });
    }

    // 収集対象はセッションの codes フィールドから取る。同じ日に複数セッションが
    // 貯まっている場合は和集合にする（途中で対象銘柄が入れ替わっても取りこぼさない）
    var targetSeen = {};
    var sessionsWithCodes = 0;
    parsed.forEach(function (session) {
      if (!session || !Array.isArray(session.codes)) return; // codes を持たない古い形式は無視
      sessionsWithCodes++;
      session.codes.forEach(function (c) {
        var code = normalizeCoverageCode(c);
        if (code) targetSeen[code] = true;
      });
    });
    var sessionCount = parsed.length;

    var rows = summarizePremarketDate(date, parsed);
    parsed = null; // 生ログはここで捨てる（明細と同時にメモリへ載せない）

    var appeared = {};
    var noOpen = [];
    var noBuyRatio = [];
    rows.forEach(function (row) {
      var code = normalizeCoverageCode(row.code);
      if (!code) return;
      appeared[code] = true;
      // 始値: 収集中ずっと空文字だった銘柄は open が null のまま残る
      if (row.open == null) noOpen.push(code);
      // 買い比率: 売気配・買気配の数量が最後まで揃わないと5変種すべて null になるため avg で代表させる
      if (row.buyRatioAvg == null) noBuyRatio.push(code);
    });
    rows = null;

    // 集計に1行も現れなかった＝raw の中に一度も sIssueCode が出てこなかった銘柄。
    // 始値・買い比率の欠測は「現れた銘柄の中での欠測」なので、この一覧とは重複しない
    var missing = Object.keys(targetSeen).filter(function (code) { return !appeared[code]; });

    return res.status(200).json({
      mode: 'coverage',
      date: date,
      found: true,
      sessionCount: sessionCount, // その日に貯まっているセッション数
      sessionsWithCodes: sessionsWithCodes, // うち codes を持っていたセッション数
      target: coverageList(Object.keys(targetSeen)),
      missing: coverageList(missing),
      noOpen: coverageList(noOpen),
      noBuyRatio: coverageList(noBuyRatio),
      appearedCount: Object.keys(appeared).length,
    });
  } catch (e) {
    return res.status(500).json({ error: 'load failed: ' + e.message });
  }
}

// ── 寄り前気配ベースの予想（premarket-prediction） ──────────────────────
// これまで src/App.js（ブラウザ）でしか作れなかった src="quote" の予想を、
// サーバー側でも作れるようにするための受け口。8:45〜9:06 に端末でタブを開いて
// いなくても予想と答え合わせが残るようにするのが目的。
// 行の作成は summarizePremarketDate をそのまま使う（買い比率・gapPct の算出を
// ここで書き直すと mode=calib・mode=coverage の数字と食い違うため）。
// 生ログ premarket:log:<日付> は redis.get で読むだけ。書き込み・TTL延長はしない。
var PREMARKET_PRED_PREFIX = 'premarket:pred:';
var PREMARKET_PRED_TTL = 60 * 60 * 24 * 30; // 30日（秒）。生ログと同じ長さに揃える

// 較正係数（買い比率 → 予想ギャップ の変換係数）は運用しながら調整するため
// 環境変数から読む。未設定・数値化できない値は src/App.js と同じ既定値に落とす
function envNum(name, fallback) {
  var n = toNum(process.env[name]);
  return n == null ? fallback : n;
}

// 以下の定数名・値は src/App.js の同名の定数と一致させている。
// 移植元を変更したときは必ず両方を直すこと（片方だけだと予想が食い違う）
var PM_Q_SRC = 'quote';                             // 予想の出どころ名
var PM_Q_SLOPE = envNum('PM_Q_SLOPE', 0.058);       // 買い比率1ptあたりの予想ギャップ%
var PM_Q_INTERCEPT = envNum('PM_Q_INTERCEPT', -0.105); // 買い比率50%（拮抗）のときの予想ギャップ%
var PM_Q_EXP_LIMIT = 3;              // 予想ギャップの絶対値の上限%（買い一色などで暴走させない）
var PM_Q_CONF_BASE = 45;             // 確信度の基準値(%)
var PM_Q_CONF_ONESIDE = 12;          // 買い比率が片側に偏り続けた場合の加点
var PM_Q_CONF_RANGE_PENALTY = 15;    // 買い比率の振れ幅100ptあたりの減点
var PM_Q_CONF_MIN = 25;              // 確信度の下限(%)
var PM_Q_CONF_MAX = 60;              // 確信度の上限(%)

// 気配サマリー1行から予想ギャップ%と確信度を出す。
// src/App.js の pmPredictGapByQuote をそのまま移植したもので、計算内容は同一。
// 戻り値: { expectedGapPct, confidence, reasons[], ... } / 判断材料が足りなければ null
function predictGapByQuote(row) {
  if (!row || row.buyRatioLast == null) return null;
  if (row.validCount == null) return null; // validCount が入っていない行は予想を出さない

  var last = row.buyRatioLast, lo = row.buyRatioMin, hi = row.buyRatioMax;
  // 予想ギャップ ＝ 傾き×(買い比率-50) ＋ 切片。上限で丸めて暴走を止める
  var exp = PM_Q_SLOPE * (last - 50) + PM_Q_INTERCEPT;
  if (exp > PM_Q_EXP_LIMIT) exp = PM_Q_EXP_LIMIT;
  if (exp < -PM_Q_EXP_LIMIT) exp = -PM_Q_EXP_LIMIT;
  exp = Math.round(exp * 100) / 100;

  // 確信度：朝じゅう片側に張り付いていた銘柄は上げ、行ったり来たりした銘柄は下げる
  var conf = PM_Q_CONF_BASE;
  if (exp > 0 && lo != null && lo >= 50) conf += PM_Q_CONF_ONESIDE;
  if (exp < 0 && hi != null && hi <= 50) conf += PM_Q_CONF_ONESIDE;
  if (lo != null && hi != null) conf -= (hi - lo) / 100 * PM_Q_CONF_RANGE_PENALTY;
  conf = Math.max(PM_Q_CONF_MIN, Math.min(PM_Q_CONF_MAX, Math.round(conf)));

  // 説明用。保存はしないが、移植元と同じ出力になることを保つためそのまま残す
  var reasons = [];
  reasons.push({
    label: '買い比率',
    val: last.toFixed(1) + '%（最小' + (lo == null ? '-' : lo.toFixed(1)) + '% / 最大' + (hi == null ? '-' : hi.toFixed(1)) + '%）',
    state: last > 50 ? 1 : (last < 50 ? -1 : 0)
  });
  reasons.push({
    label: '観測回数',
    val: row.validCount + '回',
    state: 0
  });

  return {
    expectedGapPct: exp,
    confidence: conf,
    reasons: reasons,
    buyRatioLast: last,
    buyRatioMin: lo == null ? null : lo,
    buyRatioMax: hi == null ? null : hi,
    validCount: row.validCount,
    prevClose: row.prevClose == null ? null : row.prevClose
  };
}

async function handlePremarketPrediction(req, res) {
  // POST: 指定日の生ログから予想を作って保存する（Railway から叩かれる想定）。
  // 外部から自由に実行されると保存済みの予想を壊せてしまうため、
  // 立花中継・scan-run と同じ X-Relay-Secret による認証を必須にする
  if (req.method === 'POST') {
    if (!isAuthed(req)) return res.status(401).json({ error: 'unauthorized' });
    try {
      var body = readBody(req);
      // クエリ優先、無ければボディ、どちらも無ければサーバー側のJST当日
      var date = req.query.date || body.date;
      if (date == null || date === '') date = jstDateString();
      if (!isDateString(date)) return res.status(400).json({ error: 'invalid date' });

      var parsed = unpackFromRedis(await redis.get(PREMARKET_LOG_PREFIX + date));
      var rows = Array.isArray(parsed) ? summarizePremarketDate(date, parsed) : [];
      parsed = null; // 生ログはここで捨てる（予想と同時にメモリへ載せない）

      var preds = {};
      var count = 0;
      var skipped = 0;
      rows.forEach(function (row) {
        var pred = predictGapByQuote(row);
        // 買い比率が取れなかった銘柄・validCount が入っていない銘柄はどちらも
        // predictGapByQuote が null を返すため、まとめて skipped に数える
        if (!pred) { skipped++; return; }
        preds[row.code] = {
          expectedGapPct: pred.expectedGapPct,   // 予想ギャップ%
          confidence: pred.confidence,           // 確信度%
          buyRatioLast: pred.buyRatioLast,       // 予想に使った買い比率
          buyRatioMin: pred.buyRatioMin,         // 確信度の加減点の根拠
          buyRatioMax: pred.buyRatioMax,
          validCount: pred.validCount,           // その朝の有効観測回数
          // 実測ギャップは summarizePremarketDate が当日始値と前日終値から
          // 算出済みの gapPct をそのまま使う（ここで計算し直すと明細と食い違う）。
          // 始値が取れなかった銘柄は null になり、予想だけが残る
          actualGapPct: row.gapPct == null ? null : row.gapPct,
          prevClose: row.prevClose == null ? null : row.prevClose,
          open: row.open == null ? null : row.open,
          src: PM_Q_SRC
        };
        count++;
      });

      // 生ログが無い日に空の辞書で上書きすると、過去に保存した予想を消してしまう。
      // 1銘柄も作れなかった場合は保存せずに件数だけ返す
      if (count > 0) {
        // 日付ごとに1キー。銘柄ごとに分けると1日158回の書き込みになる
        await redis.set(PREMARKET_PRED_PREFIX + date, packForRedis(preds), { ex: PREMARKET_PRED_TTL });
      }
      return res.status(200).json({ ok: true, date: date, count: count, skipped: skipped });
    } catch (e) {
      return res.status(500).json({ error: 'save failed: ' + e.message });
    }
  }

  // GET: 保存済みの予想を返すだけの読み取り専用（無認証。premarket-summary と同じ扱い）。
  // 保存もTTLの延長も一切しない
  if (req.method === 'GET') {
    // date未指定だと保存済みの全日分を展開することになるため、Redisを触る前に弾く
    if (!req.query.date) return res.status(400).json({ error: 'date required' });
    try {
      var target = req.query.date;
      if (!isDateString(target)) return res.status(400).json({ error: 'invalid date' });
      var stored = unpackFromRedis(await redis.get(PREMARKET_PRED_PREFIX + target));
      if (!stored || typeof stored !== 'object') return res.status(200).json({ found: false, date: target });
      return res.status(200).json({
        found: true,
        date: target,
        count: Object.keys(stored).length,
        predictions: stored,
      });
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

// ① 銘柄リストの取得（GET: 現在のリストを返す）
// 保存はサーバー側（_scan.js の buildUniverse）が scan-run の中で行う。
// 以前あった無認証のPOST（アプリから銘柄リストを送りつける口）は廃止した。
async function handleScanUniverse(req, res) {
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
  if (!isAuthed(req)) return res.status(401).json({ error: 'unauthorized' });
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
      host: req.headers.host, // 銘柄リスト組み立て時に自分自身の /api/sector・/api/ranking を叩くため
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
  // mode=calib / mode=coverage のときだけ専用モードへ回す。それ以外は従来どおり date 指定の1日分明細
  if (resource === 'premarket-summary') {
    if (req.query.mode === 'calib') return handlePremarketCalib(req, res);
    if (req.query.mode === 'coverage') return handlePremarketCoverage(req, res);
    return handlePremarketSummary(req, res);
  }
  if (resource === 'premarket-prediction') return handlePremarketPrediction(req, res);
  if (resource === 'scan-universe') return handleScanUniverse(req, res);
  if (resource === 'scan-run') return handleScanRun(req, res);
  if (resource === 'scan-result') return handleScanResult(req, res);

  // ここから下はデバイス間同期処理
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const key = 'user:' + userId;

  if (req.method === 'POST') {
    try {
      const { favs, scoreHist, groups, groupNames, appTrades, personalTrades, forecasts, lastSectors } = readBody(req);
      // last_sectors（前回スキャンした業種）はサーバー側スキャンの銘柄リスト組み立てにも使う。
      // 未送信（undefined）の場合は保存済みの値をそのまま残す＝古いアプリからのPOSTで消さない
      let nextSectors = Array.isArray(lastSectors) ? lastSectors : null;
      if (nextSectors === null) {
        const prev = unpackFromRedis(await redis.get(key));
        nextSectors = (prev && Array.isArray(prev.lastSectors)) ? prev.lastSectors : [];
      }
      await redis.set(key, packForRedis({
        favs: favs || [],
        scoreHist: scoreHist || {},
        groups: groups || {},
        groupNames: groupNames || {},
        appTrades: appTrades || [],
        personalTrades: personalTrades || [],
        forecasts: forecasts || [],
        lastSectors: nextSectors,
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
        return res.status(200).json({ found: false, favs: [], scoreHist: {}, groups: {}, groupNames: {}, appTrades: [], personalTrades: [], forecasts: [], lastSectors: [] });
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
        lastSectors: parsed.lastSectors || [],
      });
    } catch (e) {
      return res.status(500).json({ error: 'load failed: ' + e.message });
    }
  }

  return res.status(405).json({ error: 'method not allowed' });
}
