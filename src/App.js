import { useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

// ── スマホ幅判定（768px未満をスマホ扱い。画面回転・分割表示にも追従）─────────
// iPadのSafariは「デスクトップ用Webサイトを表示」が既定のため、画面を半分にしても
// 広いレイアウト幅（≈980px）のまま縮小表示される。そのため window.innerWidth だけでは
// 「実際は狭い」ことを判定できない。iOS端末では devicePixelRatio から縮小率を逆算し、
// 画面上で実際に見えている幅に換算してスマホ判定する。
var MOBILE_BP=768; // この幅未満（見た目換算）をスマホ表示にする
function isIOSDevice(){
  var ua=navigator.userAgent||"";
  if(/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13以降のSafariはMacintoshを名乗るのでタッチ数で判別
  return /Macintosh/.test(ua)&&(navigator.maxTouchPoints||0)>1;
}
function calcIsMobile(){
  var w=window.innerWidth||document.documentElement.clientWidth||0;
  if(w<MOBILE_BP) return true;          // 素直に狭い場合はそのままスマホ判定
  if(!isIOSDevice()) return false;      // PCブラウザは幅どおりに判定
  var dpr=window.devicePixelRatio||1;
  // iOS端末の本来の倍率は2か3。縮小表示中はdprがその値より小さくなる
  var base=Math.max(2,Math.ceil(dpr-0.01));
  var scale=dpr/base;                   // 1未満＝ページが縮小表示されている
  if(scale>=0.98) return false;         // 縮小なし＝実寸どおりの幅
  return w*scale<MOBILE_BP;             // 見た目の幅で再判定
}
function useIsMobile(){
  var s=useState(calcIsMobile);var isMobile=s[0],setIsMobile=s[1];
  useEffect(function(){
    function onResize(){setIsMobile(calcIsMobile());}
    var vv=window.visualViewport;
    window.addEventListener("resize",onResize);
    window.addEventListener("orientationchange",onResize);
    if(vv&&vv.addEventListener) vv.addEventListener("resize",onResize);
    onResize(); // マウント直後にも一度判定（分割表示で開いた場合の取りこぼし防止）
    return function(){
      window.removeEventListener("resize",onResize);
      window.removeEventListener("orientationchange",onResize);
      if(vv&&vv.removeEventListener) vv.removeEventListener("resize",onResize);
    };
  },[]);
  return isMobile;
}
var MOBILE_HEADER_H=50,MOBILE_TABBAR_H=44; // ヘッダー高さ・スマホ用タブバー高さ（sticky位置計算に使用）

var BADGE = {
  BUY:   { bg:"#052e16", border:"#22d3a0", text:"#22d3a0", label:"買い"   },
  WATCH: { bg:"#1c1400", border:"#fbbf24", text:"#fbbf24", label:"様子見" },
  SKIP:  { bg:"#1f0010", border:"#f43f5e", text:"#f43f5e", label:"見送り" },
  FAILED:{ bg:"#1a1a1a", border:"#4a5568", text:"#94a3b8", label:"取得失敗" },
};
var MKT = {
  US: { bg:"#0a1e3a", border:"#3b82f6", text:"#93c5fd", label:"US" },
  JP: { bg:"#1a0a0a", border:"#f87171", text:"#fca5a5", label:"JP" },
};

function scoreColor(n){ return n>=58?"#22d3a0":n>=38?"#fbbf24":"#f43f5e"; }
function stateColor(state){return state===1?"#22d3a0":state===-1?"#f43f5e":"#fbbf24";}
function stateLabel(state){return state===1?"▲ 強気":state===-1?"▼ 弱気":"→ 中立";}
function bStyle(bg,border,text){ return{background:bg,border:"1px solid "+border,color:text,fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4,whiteSpace:"nowrap"}; }

// 決算発表予定日のバッジ情報（日本株は「翌営業日リスト」照合のため常に直近扱い）
function earningsInfo(dateStr){
  if(!dateStr) return null;
  var days=Math.ceil((new Date(dateStr+"T00:00:00")-new Date(new Date().toDateString()))/86400000);
  if(days<0) return null;
  var label=days===0?"本日":days===1?"明日":days+"日後";
  var urgent=days<=1;
  return{date:dateStr,days:days,label:label,urgent:urgent};
}

// 権利落ち日（概算・予想）のバッジ情報。決算日と違い「確定情報ではない」ため
// 緊急度による色分けはせず、常に同じ色＋「予想」表記で区別する
function exRightsInfo(dateStr){
  if(!dateStr) return null;
  var days=Math.ceil((new Date(dateStr+"T00:00:00")-new Date(new Date().toDateString()))/86400000);
  if(days<0||days>60) return null; // 過去・遠すぎる先は表示しない
  var label=days===0?"本日":days===1?"明日":days+"日後";
  return{date:dateStr,days:days,label:label};
}

// 対TOPIX相対強弱バッジ（日本株のみ）。個別銘柄の当日騰落率からTOPIX騰落率を引いた差分
// ±0.5%未満は誤差レベルとみなし非表示にする
function relStrengthInfo(rel){
  if(rel==null) return null;
  if(Math.abs(rel)<0.5) return null;
  var strong=rel>=0;
  return{diff:rel,label:(strong?"+":"")+rel.toFixed(1)+"%",strong:strong};
}

// ── スキャル・デイトレ向き簡易フィルタ（E簡易版）─────────────────────────
// 板情報（気配・スプレッド）は使わず、出来高（売買代金）とATR%（値動きの大きさ）だけで
// 「そもそもスキャルに向かなそうな銘柄」を簡易的に見分けるための目安。数値は一般的な
// 目安であり、必要に応じて調整してください
var SCALP_MIN_TURNOVER_JP=300000000; // 売買代金の目安：日本株 3億円/日 未満は薄いとみなす
var SCALP_MIN_TURNOVER_US=5000000;   // 米国株 500万ドル/日
var SCALP_MIN_ATR_PCT=1.2;           // ATRが株価の1.2%未満だと値幅が小さすぎる目安
function scalpFitInfo(s){
  if(s.price==null||!s.volume) return null;
  var turnover=s.price*s.volume;
  var minTurnover=s.market==="JP"?SCALP_MIN_TURNOVER_JP:SCALP_MIN_TURNOVER_US;
  var atrPct=(s.atr!=null&&s.price)?(s.atr/s.price*100):null;
  var reasons=[];
  if(turnover<minTurnover) reasons.push("薄商い");
  if(atrPct!=null&&atrPct<SCALP_MIN_ATR_PCT) reasons.push("値幅小");
  if(reasons.length===0) return null;
  return{label:reasons.join("・")};
}

// ── 決算日・権利落ち日のローカル記憶 ─────────────────────────────────────
// 外部APIが当日中に日付を返さなくなっても、実際の予定日を過ぎるまで表示を継続するための保険
var EVENT_DATE_CACHE_KEY="event_date_cache_v1";
function resolveEventDate(ticker,field,freshDate){
  var cache;
  try{cache=JSON.parse(localStorage.getItem(EVENT_DATE_CACHE_KEY))||{};}catch(e){cache={};}
  var key=ticker+"_"+field;
  if(freshDate){
    if(cache[key]!==freshDate){
      cache[key]=freshDate;
      try{localStorage.setItem(EVENT_DATE_CACHE_KEY,JSON.stringify(cache));}catch(e){}
    }
    return freshDate;
  }
  return cache[key]||null;
}

var CACHE={}, CACHE_TTL=15*60*1000; // 15分足に合わせてTTLを15分に短縮
var VERCEL_API="https://daytrade-simulator.vercel.app/api/stock";
var RANKING_API="https://daytrade-simulator.vercel.app/api/ranking";
var SECTOR_API="https://daytrade-simulator.vercel.app/api/sector";
var INTRADAY_API="https://daytrade-simulator.vercel.app/api/intraday";
var DAILY_API="https://daytrade-simulator.vercel.app/api/daily";
var TACHIBANA_WATCH_API="https://daytrade-simulator.vercel.app/api/sync?resource=tachibana-watch";
var TACHIBANA_QUOTE_API="https://daytrade-simulator.vercel.app/api/sync?resource=tachibana-quote";

// ── 立花証券のリアルタイム現在値を1銘柄ぶん取得する ──────────────────────
// しくみ：サーバー(VPS)が立花証券から受け取った値をRedisに書き込み、アプリはそれを読む。
// タップ直後はRedisにまだ値が無いので、①「この銘柄を見ている」と登録(watch) →
// ②1秒おきに最大8回まで取りに行く、という順番が必要。
// 取れなければ null を返し、呼び出し側でYahoo（約20分遅れ）にフォールバックする。
async function fetchTachibanaPrice(ticker){
  if(!ticker||!ticker.endsWith(".T")) return null; // 日本株のみ対応
  var code=ticker.replace(".T","");
  try{
    await fetch(TACHIBANA_WATCH_API,{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ticker:code}),signal:AbortSignal.timeout(8000)});
  }catch(e){ return null; }
  for(var i=0;i<8;i++){
    try{
      var res=await fetch(TACHIBANA_QUOTE_API+"&ticker="+encodeURIComponent(code),{signal:AbortSignal.timeout(8000)});
      var json=await res.json();
      if(json&&json.found){
        if(json.stale) return null;                      // 休場中の古い値ならYahooに任せる
        var raw=json.fields&&json.fields["p_1_DPP"];     // p_1_DPP＝現在値
        var p=raw!=null?parseFloat(raw):NaN;
        if(isFinite(p)&&p>0) return p;
      }
    }catch(e){}
    await new Promise(function(r){setTimeout(r,1000);});
  }
  return null;
}

// ── 当日5分足（カード常時ミニ表示用）─────────────────────────────────────
// J-Quantsの1分足をサーバー側(api/intraday.js)で5分足に集約して返す想定
// 土日・休場日はサーバー側で自動的に直近の取引日まで遡るため、date（実際の取引日）も受け取る
var INTRADAY_CACHE={}, INTRADAY_TTL=5*60*1000; // 5分足なのでTTLも5分

// J-Quantsのレートリミット対策：分足アドオンは「1分あたり60リクエスト」という
// 上限が公式に決まっているため、それを厳守できるよう厳密な間隔で1件ずつ順番に実行する。
// （同時3件・短い間隔、という前回の実装では実際には1分あたり300件近く出てしまい、
// 　429エラー→リトライの連鎖で余計に悪化していたため、シンプルな直列キューに変更）
var INTRADAY_QUEUE=[], INTRADAY_TIMER=null, INTRADAY_LAST_DISPATCH=0;
var INTRADAY_MIN_INTERVAL=1500; // 60件/分に余裕を持たせて約1.5秒に1件ペース（旧1100ms）
var INTRADAY_PAUSED_UNTIL=0; // 429を検知したら、この時刻まではキューを進めない
function scheduleIntradayQueue(){
  if(INTRADAY_TIMER||INTRADAY_QUEUE.length===0) return;
  var now=Date.now();
  var wait=Math.max(0,INTRADAY_MIN_INTERVAL-(now-INTRADAY_LAST_DISPATCH),INTRADAY_PAUSED_UNTIL-now);
  INTRADAY_TIMER=setTimeout(function(){
    INTRADAY_TIMER=null;
    var job=INTRADAY_QUEUE.shift();
    INTRADAY_LAST_DISPATCH=Date.now();
    if(job) job();
    scheduleIntradayQueue();
  },wait);
}
function enqueueIntraday(fn){
  return new Promise(function(resolve){
    INTRADAY_QUEUE.push(function(){fn().then(resolve);});
    scheduleIntradayQueue();
  });
}

// ── メイン株価取得（/api/stock）用のキュー ──────────────────────────
// 一定間隔ごとに、まとめてSTOCK_CONCURRENCY件ずつ呼び出すことで、
// Yahoo Finance・立花証券API双方への負荷を抑えつつスキャンを高速化する。
// 429を検知したらキュー全体を一時停止し、レート制限が収まってから再開する。
// ※旧J-Quants時代の60件/分制限を基準に「1.5秒に1件」だったが、立花証券API
// 　移行後は制限が緩和されている可能性があるため段階的に短縮してテスト中。
// 　Step1: 間隔を1.5秒→0.6秒に短縮（問題なし）
// 　Step2: 1件ずつ→3件ずつ同時実行に変更（問題なし）
// 　Step3: 3件ずつ→5件ずつに増加（今回）。tachibana-server側で5件同時の実績あり
// 　429エラーが増える場合はSTOCK_CONCURRENCYを3や1に、間隔を1500付近に戻せば元通り。
var STOCK_QUEUE=[], STOCK_TIMER=null, STOCK_LAST_DISPATCH=0;
var STOCK_MIN_INTERVAL=600; // バッチ発火の最短間隔
var STOCK_CONCURRENCY=5; // Step3: 1回の発火で同時に呼び出す件数
var STOCK_PAUSED_UNTIL=0;
function scheduleStockQueue(){
  if(STOCK_TIMER||STOCK_QUEUE.length===0) return;
  var now=Date.now();
  var wait=Math.max(0,STOCK_MIN_INTERVAL-(now-STOCK_LAST_DISPATCH),STOCK_PAUSED_UNTIL-now);
  STOCK_TIMER=setTimeout(function(){
    STOCK_TIMER=null;
    STOCK_LAST_DISPATCH=Date.now();
    for(var i=0;i<STOCK_CONCURRENCY;i++){
      var job=STOCK_QUEUE.shift();
      if(job) job();
    }
    scheduleStockQueue();
  },wait);
}
function enqueueStock(fn){
  return new Promise(function(resolve,reject){
    STOCK_QUEUE.push(function(){fn().then(resolve,reject);});
    scheduleStockQueue();
  });
}
// エラーメッセージがJ-Quantsのレート制限（429）由来かどうかの判定
function isRateLimitError(msg){
  return !!msg&&(msg.indexOf("429")>=0||msg.toLowerCase().indexOf("rate limit")>=0);
}

// レスポンス形式: { m1:{opens,highs,lows,closes,times}, date }（チャートモーダル用の1分足・ローソク足用）
//
// INTRADAY_INFLIGHT: 同じ銘柄への呼び出しがほぼ同時に複数箇所（モバイルの展開
// パネルと詳細パネルなど）から来ても、進行中のPromiseを共有して二重リクエスト
// にならないようにする。
var INTRADAY_INFLIGHT={};
async function fetchIntraday(ticker){
  var now=Date.now();
  if(INTRADAY_CACHE[ticker]&&now-INTRADAY_CACHE[ticker].ts<INTRADAY_TTL) return INTRADAY_CACHE[ticker].data;
  if(INTRADAY_INFLIGHT[ticker]) return INTRADAY_INFLIGHT[ticker];
  var p=enqueueIntraday(async function(){
    try{
      var res=await fetch(INTRADAY_API+"?ticker="+encodeURIComponent(ticker),{signal:AbortSignal.timeout(10000)});
      if(!res.ok) throw new Error("HTTP "+res.status);
      var json=await res.json();
      if(json&&json.rateLimited){
        // アクセス制限を検知：しばらくキュー全体を止めて様子を見る
        INTRADAY_PAUSED_UNTIL=Date.now()+120*1000;
        return null;
      }
      if(!json||!json.m1||!json.m1.closes||json.m1.closes.length<2) return null;
      var result={m1:json.m1,date:json.date||null};
      INTRADAY_CACHE[ticker]={ts:now,data:result};
      return result;
    }catch(e){return null;}
  });
  INTRADAY_INFLIGHT[ticker]=p;
  p.finally(function(){delete INTRADAY_INFLIGHT[ticker];});
  return p;
}

// ── 日足（カードのミニチャート・出来高急増後の値動きパターン分析用）───────
// 直近1年分の日足終値・出来高。値の変化が緩やかなので30分キャッシュ、分足用の直列
// キューとは別枠で（軽いデータなので待たせる必要が薄いため）直接取得する。
var DAILY_CACHE={}, DAILY_TTL=30*60*1000, DAILY_INFLIGHT={};
// ── ☀️ 日中型/夜間型の判定 ──────────────────────────────────────────────
// 過去1年の値動きを「日中分（始値→終値）」と「夜間分（前日終値→始値）」に分解して累積する。
// 検証（50銘柄・のべ23,105日）で、上昇銘柄でも寄り→引けの平均はマイナスと分かった。
// つまり上昇の大半は夜間に発生している。持ち越さないデイトレで取れるのは日中分だけなので、
// 日中分がプラスの「日中型」銘柄を選ぶことが、そのまま優位性になる
var DAYNIGHT={};
function computeDayNight(d){
  if(!d||!d.closes||!d.opens||d.closes.length<30)return null;
  var day=0,night=0,n=0;
  for(var i=1;i<d.closes.length;i++){
    var o=d.opens[i],c=d.closes[i],pc=d.closes[i-1];
    if(!(o>0&&c>0&&pc>0))continue;
    day+=(c-o)/o*100;night+=(o-pc)/pc*100;n++;
  }
  return n>=30?{day:Math.round(day),night:Math.round(night),days:n}:null;
}
// 一覧の並び替え用：日足がまだ無い銘柄の分を順番に取得してDAYNIGHTを埋める
async function fillDayNightFor(list,onProgress){
  var need=list.filter(function(s){return s.market==="JP"&&s.real&&!DAYNIGHT[s.ticker];});
  for(var i=0;i<need.length;i++){
    await fetchDaily(need[i].ticker);
    if(onProgress&&(i%5===4||i===need.length-1))onProgress(i+1,need.length);
  }
  return need.length;
}
async function fetchDaily(ticker){
  var now=Date.now();
  if(DAILY_CACHE[ticker]&&now-DAILY_CACHE[ticker].ts<DAILY_TTL) return DAILY_CACHE[ticker].data;
  if(DAILY_INFLIGHT[ticker]) return DAILY_INFLIGHT[ticker];
  var p=(async function(){
    try{
      var res=await fetch(DAILY_API+"?ticker="+encodeURIComponent(ticker),{signal:AbortSignal.timeout(10000)});
      if(!res.ok) throw new Error("HTTP "+res.status);
      var json=await res.json();
      if(!json||!json.closes||json.closes.length<2) return null;
      var result={closes:json.closes,dates:json.dates||[],volumes:json.volumes||[],opens:json.opens||[],highs:json.highs||[],lows:json.lows||[]};
      DAILY_CACHE[ticker]={ts:now,data:result};
      try{var dn=computeDayNight(result);if(dn)DAYNIGHT[ticker]=dn;}catch(e){}
      try{updateForecastLog(ticker,result);}catch(e){}
      return result;
    }catch(e){return null;}
  })();
  DAILY_INFLIGHT[ticker]=p;
  p.finally(function(){delete DAILY_INFLIGHT[ticker];});
  return p;
}

// 出来高ランキング取得（sector API失敗時の最終フォールバック用に残置）
// 通信が一時的に不安定な場合に備え、失敗時は1回だけ自動で再試行する
async function fetchRanking(market){
  async function attempt(){
    var res=await fetch(RANKING_API+"?market="+market,{signal:AbortSignal.timeout(15000),cache:"no-store"});
    if(!res.ok) throw new Error("ranking "+res.status);
    var json=await res.json();
    // ハイブリッド方式：volume・changeも受け取る
    var stocks=(json.stocks||[]).map(function(s){return{ticker:s.ticker,name:s.name,market:s.market,tvSymbol:s.tvSymbol,volume:s.volume||0,change:s.change||0};});
    return stocks.length>0?stocks:null;
  }
  try{return await attempt();}
  catch(e){
    console.warn("[fetchRanking] 1回目失敗、再試行します: "+e.message);
    try{return await attempt();}
    catch(e2){console.error("[fetchRanking] 2回目も失敗: "+e2.message);return null;}
  }
}

// AI業種選定→J-Quants絞り込みランキング取得（メインの取得経路）
// manualSectors指定時はAIのweb_search選定をスキップし、指定業種のランキングのみ取得（トークン節約）
// 通信が一時的に不安定な場合に備え、失敗時は1回だけ自動で再試行する
async function fetchSectorRanking(manualSectors){
  async function attempt(){
    var url=SECTOR_API;
    if(manualSectors&&manualSectors.length){url+="?sectors="+encodeURIComponent(manualSectors.join(","));}
    var res=await fetch(url,{signal:AbortSignal.timeout(25000),cache:"no-store"});
    if(!res.ok) throw new Error("sector "+res.status);
    var json=await res.json();
    var stocks=(json.stocks||[]).map(function(s){return{ticker:s.ticker,name:s.name,market:s.market,tvSymbol:s.tvSymbol,volume:s.volume||0,change:s.change||0};});
    return{stocks:stocks.length>0?stocks:null,sectors:json.sectors||[]};
  }
  try{return await attempt();}
  catch(e){
    console.warn("[fetchSectorRanking] 1回目失敗、再試行します: "+e.message);
    try{return await attempt();}
    catch(e2){console.error("[fetchSectorRanking] 2回目も失敗: "+e2.message);return{stocks:null,sectors:[]};}
  }
}

// 立花証券システムのログイン可能時間は8:30〜27:00(=翌3:00)。この時間外は
// APIが必ず失敗するため、無駄な問い合わせをせず先にメンテナンス中と判定する
function isTachibanaMaintenance(){
  var jst=new Date(Date.now()+9*60*60*1000);
  var mins=jst.getUTCHours()*60+jst.getUTCMinutes();
  return mins>=180&&mins<510; // 3:00〜8:30
}

async function buildStockUniverse(manualSectors,skipAI){
  var jp,sectors;
  if(skipAI){
    // 前回の業種データが無い場合のフォールバック：AI選定を呼ばず通常の出来高ランキングを使う
    jp=await fetchRanking("jp")||[];
    sectors=[];
  }else{
    var primary=await fetchSectorRanking(manualSectors);
    jp=primary.stocks;
    sectors=primary.sectors; // 業種名は保持（銘柄0件でも選定自体は成立しているため、次回「前回の業種」で使う）
    if(!jp||jp.length===0){
      jp=await fetchRanking("jp")||[]; // 表示する銘柄だけ通常ランキングで代替。sectorsはリセットしない
    }
  }
  var seen={},out=[];
  jp.forEach(function(s){if(!seen[s.ticker]){seen[s.ticker]=true;out.push(s);}});
  return{stocks:out,sectors:sectors};
}

// 15分足データ取得（メイン分析用・約20営業日分。実際の取得期間はapi/stock.js側で固定）
async function fetchYahoo(ticker){
  var now=Date.now();
  if(CACHE[ticker]&&now-CACHE[ticker].ts<CACHE_TTL){var cached=CACHE[ticker].data;return{closes:cached.closes.slice(),highs:cached.highs.slice(),lows:cached.lows.slice(),volumes:cached.volumes?cached.volumes.slice():[],opens:cached.opens?cached.opens.slice():[],dates:cached.dates?cached.dates.slice():[],currentPrice:cached.currentPrice,previousClose:cached.previousClose,real:cached.real,per:cached.per,pbr:cached.pbr,analystTarget:cached.analystTarget,earningsDate:cached.earningsDate,exRightsDate:cached.exRightsDate,topixChange:cached.topixChange,sectorChange:cached.sectorChange,sectorName:cached.sectorName};}
  var json=await enqueueStock(async function(){
    var res=await fetch(VERCEL_API+"?ticker="+encodeURIComponent(ticker),{signal:AbortSignal.timeout(25000),cache:"no-store"});
    var body=await res.json().catch(function(){return null;});
    if(!res.ok){
      var msg=body&&body.error?body.error:("HTTP "+res.status); // サーバー側のエラー詳細をそのまま伝える
      if(isRateLimitError(msg)) STOCK_PAUSED_UNTIL=Date.now()+90*1000; // レート制限検知：90秒キューを止めて様子を見る
      throw new Error(msg);
    }
    return body;
  });
  var result=json&&json.chart&&json.chart.result&&json.chart.result[0];
  if(!result) throw new Error("empty response");
  var q=result.indicators.quote[0],meta=result.meta;
  function fill(arr){var out=(arr||[]).slice();for(var j=0;j<out.length;j++)if(out[j]==null)out[j]=j>0?out[j-1]:0;return out;}
  var per=result.per||null,pbr=result.pbr||null,analystTarget=result.analystTarget||null,earningsDate=result.earningsDate||null,exRightsDate=result.exRightsDate||null,topixChange=result.topixChange!=null?result.topixChange:null;
  var sectorChange=result.sectorChange!=null?result.sectorChange:null,sectorName=result.sectorName||null;
  var filledClose=fill(q.close);
  var data={closes:filledClose,highs:fill(q.high),lows:fill(q.low),volumes:fill(q.volume),opens:fill(q.open),dates:q.date||[],currentPrice:meta.regularMarketPrice||filledClose[filledClose.length-1],previousClose:meta.chartPreviousClose||0,real:true,per:per,pbr:pbr,analystTarget:analystTarget,earningsDate:earningsDate,exRightsDate:exRightsDate,topixChange:topixChange,sectorChange:sectorChange,sectorName:sectorName};
  CACHE[ticker]={ts:now,data:data};
  return{closes:data.closes.slice(),highs:data.highs.slice(),lows:data.lows.slice(),volumes:data.volumes.slice(),opens:data.opens.slice(),dates:data.dates.slice(),currentPrice:data.currentPrice,previousClose:data.previousClose,real:data.real,per:data.per,pbr:data.pbr,analystTarget:data.analystTarget,earningsDate:data.earningsDate,exRightsDate:data.exRightsDate,topixChange:data.topixChange,sectorChange:data.sectorChange,sectorName:data.sectorName};
}


// 取得失敗（タイムアウト等）の場合、1回だけ自動で再試行。それでもダメならシミュレーションデータで代替
// ★診断用：実際の失敗理由をconsoleに出し、カード側でも表示できるようgenSimに理由を渡す
async function fetchYahooSafe(ticker){
  try{return await fetchYahoo(ticker);}
  catch(err){
    console.warn("[fetchYahoo] "+ticker+" 1回目失敗: "+err.message);
    if(isRateLimitError(err.message)) await new Promise(function(r){setTimeout(r,5000);}); // レート制限時は5秒待ってから再試行
    try{return await fetchYahoo(ticker);}
    catch(err2){
      console.error("[fetchYahoo] "+ticker+" 2回目も失敗→シミュレーションデータで代替: "+err2.message);
      return genSim(ticker,err2.message);
    }
  }
}

function genSim(ticker,errMsg){
  var h=0;for(var i=0;i<ticker.length;i++)h=(Math.imul(31,h)+ticker.charCodeAt(i))|0;
  var s=Math.abs(h);function rng(){s=(s*1664525+1013904223)&0x7fffffff;return s/0x7fffffff;}
  var price=rng()*400+60,closes=[],highs=[],lows=[];
  for(var d=0;d<63;d++){var v=rng()*0.025;price=Math.max(5,price*(1+rng()*0.006-0.003+(rng()-0.5)*v));closes.push(price);highs.push(price*(1+rng()*0.008));lows.push(price*(1-rng()*0.008));}
  return{closes:closes,highs:highs,lows:lows,currentPrice:price,previousClose:closes[closes.length-2],real:false,error:errMsg||null};
}

// ── トレードシミュレーター（仮想売買の記録・検証）───────────────────────────
// 「アプリ予想」＝アプリのシグナル判断に従った場合の検証、「個人予想」＝アプリの判断と異なる自分の判断の検証
function fmtMoney(v,isJP){return isJP?"¥"+Math.round(v).toLocaleString():"$"+v.toFixed(2);}
function fmtPnl(v,isJP){var sign=v>=0?"+":"";return isJP?sign+"¥"+Math.round(v).toLocaleString():sign+"$"+v.toFixed(2);}

// 保有上限日数：active(進行中)のままこの日数を超えたら自動で強制決済する（利確・損切り未到達の場合）
// activeトレードの開始時刻(startAtISO)から見て、その銘柄の市場(JP/US)の
// 直近の「引け（取引終了）」時刻をミリ秒タイムスタンプで返す（デイトレ想定：持ち越し禁止）
// JP: 大引け15:30 JST固定。US: 22:30/23:30(夏/冬)開始〜翌5:00/6:00(JST)がセッションのため、
// 開始が夜(セッション開始後)なら翌JST日の終値時刻、早朝(セッション中)ならその日の終値時刻を引けとする
function sessionCloseTime(market,startAtISO){
  var start=new Date(startAtISO);
  var jst=new Date(start.getTime()+9*60*60*1000);
  var y=jst.getUTCFullYear(),mo=jst.getUTCMonth(),d=jst.getUTCDate();
  var timeMin=jst.getUTCHours()*60+jst.getUTCMinutes();
  var closeTs;
  if(market==="JP"){
    closeTs=Date.UTC(y,mo,d,15-9,30); // 15:30 JST
  }else{
    var month=mo+1;
    var isSummer=(month>3&&month<11)||(month===3&&d>=8)||(month===11&&d<=7);
    var usStartMin=isSummer?22*60+30:23*60+30;
    var usEndMin=isSummer?5*60:6*60;
    var closeDate=timeMin>=usStartMin?d+1:d;
    closeTs=Date.UTC(y,mo,closeDate,Math.floor(usEndMin/60)-9,usEndMin%60);
  }
  if(closeTs<=start.getTime())closeTs+=24*60*60*1000; // 念のための保険（開始時刻より前にならないよう1日繰り上げ）
  return closeTs;
}
// 東証の休場日（祝日＋大晦日）。土日は自動判定するので載せていません
// ★年に1回、翌年分をここに追記してください
var JP_HOLIDAYS={
  "2026-01-01":1,"2026-01-02":1,"2026-01-12":1,"2026-02-11":1,"2026-02-23":1,"2026-03-20":1,
  "2026-04-29":1,"2026-05-04":1,"2026-05-05":1,"2026-05-06":1,"2026-07-20":1,"2026-08-11":1,
  "2026-09-21":1,"2026-09-22":1,"2026-09-23":1,"2026-10-12":1,"2026-11-03":1,"2026-11-23":1,"2026-12-31":1,
  "2027-01-01":1,"2027-01-11":1,"2027-02-11":1,"2027-02-23":1,"2027-03-22":1,"2027-04-29":1,
  "2027-05-03":1,"2027-05-04":1,"2027-05-05":1,"2027-07-19":1,"2027-08-11":1,"2027-09-20":1,
  "2027-09-23":1,"2027-10-11":1,"2027-11-03":1,"2027-11-23":1,"2027-12-31":1
};
// 日本時間の日付情報を取得（dayOffset=-1で前日）。key="YYYY-MM-DD" / dow=曜日(0:日〜6:土) / min=0時からの分
function jstInfo(dayOffset){
  var j=new Date(Date.now()+9*60*60*1000);
  if(dayOffset)j.setUTCDate(j.getUTCDate()+dayOffset);
  var m=j.getUTCMonth()+1,d=j.getUTCDate();
  return {key:j.getUTCFullYear()+"-"+(m<10?"0":"")+m+"-"+(d<10?"0":"")+d,dow:j.getUTCDay(),min:j.getUTCHours()*60+j.getUTCMinutes()};
}
// その市場の「今のセッション日」をYYYY-MM-DDで返す。
// 取得データの最終日付がこれと違えば＝まだ今日の足が1本も無い（寄り付き前・休場中）と判断できる
function currentSessionDate(market){
  var n=jstInfo(0);
  if(market==="JP")return n.key;
  return (n.min<12*60?jstInfo(-1):n).key; // 米国：日本時間の早朝は前日の米国営業日
}
// 今日がその市場の「取引日」かどうか（土日・日本の祝日は取引日ではない。米国の祝日は未対応）
function isTradingDay(market){
  var n=jstInfo(0);
  if(market==="JP")return n.dow>=1&&n.dow<=5&&!JP_HOLIDAYS[n.key];
  // 米国：日本時間の夜(22:30〜)は当日、早朝(〜6:00)は前日の米国営業日にあたる
  var day=n.min<12*60?jstInfo(-1):n;
  return day.dow>=1&&day.dow<=5;
}
// 今、その市場（JP/US）が取引時間中かどうか（土日・日本の祝日も考慮）
// 閉場中は前日終値等の古い値が返ってくるため、待機中→進行中の誤判定を防ぐために使用
function isMarketOpen(market){
  if(!isTradingDay(market))return false;
  var jst=new Date(Date.now()+9*60*60*1000);
  var mo=jst.getUTCMonth(),d=jst.getUTCDate();
  var timeMin=jst.getUTCHours()*60+jst.getUTCMinutes();
  if(market==="JP"){
    return (timeMin>=9*60&&timeMin<11*60+30)||(timeMin>=12*60+30&&timeMin<15*60+30);
  }else{
    var month=mo+1;
    var isSummer=(month>3&&month<11)||(month===3&&d>=8)||(month===11&&d<=7);
    var usStartMin=isSummer?22*60+30:23*60+30;
    var usEndMin=isSummer?5*60:6*60;
    return timeMin>=usStartMin||timeMin<usEndMin;
  }
}
function tradeStorageKey(kind){return kind==="app"?"trade_app_v1":"trade_personal_v1";}
function loadTrades(kind){try{var v=localStorage.getItem(tradeStorageKey(kind));return v?JSON.parse(v):[];}catch(e){return[];}}
function saveTrades(kind,list){try{localStorage.setItem(tradeStorageKey(kind),JSON.stringify(list));}catch(e){}}

// 買い判定の方向を決める：登録時の価格より安ければ「下値待ち（指値買い）」、高ければ「上抜け待ち（逆指値買い）」
function getBuyDirection(t){
  if(t.buyDirection)return t.buyDirection;
  if(t.lastPrice!=null)return t.buyPrice<=t.lastPrice?"down":"up";
  return "down";
}

// ── R倍数（リスク単位）関連 ─────────────────────────────────
// 1R＝そのトレードで最初に許容した損失額。(買値−損切り)×株数 で後から算出できるため、
// 既存トレードも損切りが入っていればそのまま集計対象になる（保存フィールドの追加は不要）
var RISK_UNIT_KEY="risk_unit_yen",RISK_UNIT_DEFAULT=10000; // 想定元手100万円の1%
function loadRiskUnit(){var v=parseFloat(localStorage.getItem(RISK_UNIT_KEY));return v>0?v:RISK_UNIT_DEFAULT;}
function saveRiskUnit(v){try{if(v>0)localStorage.setItem(RISK_UNIT_KEY,String(v));}catch(e){}}
var CAPITAL_KEY="capital_yen",CAPITAL_DEFAULT=1000000; // 想定元手
function loadCapital(){var v=parseFloat(localStorage.getItem(CAPITAL_KEY));return v>0?v:CAPITAL_DEFAULT;}
function saveCapital(v){try{if(v>0)localStorage.setItem(CAPITAL_KEY,String(v));}catch(e){}}
function tradeRisk(t){
  if(t.stopPrice==null)return null;
  var entry=t.startPrice!=null?t.startPrice:t.buyPrice;
  var r=(entry-t.stopPrice)*(t.shares||1);
  return r>0?r:null;
}
function tradeR(t){var risk=tradeRisk(t);return(risk&&t.pnl!=null)?t.pnl/risk:null;}
// 完了トレードからR集計（平均R・累計R・プロフィットファクター・損益分岐勝率）を算出
function calcRStats(doneList){
  var rows=(doneList||[]).filter(function(t){return tradeR(t)!=null;});
  if(!rows.length)return{n:0};
  var totalR=rows.reduce(function(a,t){return a+tradeR(t);},0);
  var wins=rows.filter(function(t){return t.pnl>0;}),losses=rows.filter(function(t){return t.pnl<=0;});
  var gp=wins.reduce(function(a,t){return a+t.pnl;},0),gl=Math.abs(losses.reduce(function(a,t){return a+t.pnl;},0));
  var avgW=wins.length?wins.reduce(function(a,t){return a+tradeR(t);},0)/wins.length:null;
  var avgL=losses.length?Math.abs(losses.reduce(function(a,t){return a+tradeR(t);},0)/losses.length):null;
  return{n:rows.length,totalR:totalR,avgR:totalR/rows.length,pf:gl>0?gp/gl:null,
    beRate:(avgW&&avgL)?Math.round(avgL/(avgW+avgL)*100):null};
}
function addTradeRecord(kind,s,buyPrice,sellPrice,shares,stopPrice,buyDirection){
  var list=loadTrades(kind);
  var curPrice=s.rawPrice!=null?s.rawPrice:null;
  // 登録時点で「過去実績に基づく重み補正」が何点効いていたか（検証パネル用）
  var wAdjItem=(s.breakdown||[]).find(function(b){return b.label==="実績反映調整";});
  var weightAdjustAtAdd=wAdjItem?wAdjItem.delta:0;
  // 登録時点のスコア・点灯シグナル・🔮統計予想を記録（実トレード結果とシグナルを紐付けるため）
  // → 将来「自分の勝ちトレードに実際に効いていたシグナル」を分析できるようにする土台。今は記録のみ
  var sigKeysAtAdd=(s.signals||[]).map(function(x){return baseSigLabel(x.label)+"#"+x.state;});
  var forecastAtAdd=(function(){
    try{var f=calcStatForecast(s.signals,getUniverseSignalStats());return f.ready?{expPct:f.expPct,upRate:f.upRate}:null;}catch(e){return null;}
  })();
  list.push({
    id:"t"+Date.now()+Math.random().toString(36).slice(2,6),
    ticker:s.ticker,name:s.name,market:s.market,
    buyPrice:buyPrice,sellPrice:sellPrice,
    stopPrice:(stopPrice!=null&&stopPrice>0)?stopPrice:null, // 損切り価格（必須・R計算の基礎）
    shares:shares>0?shares:1,
    buyDirection:buyDirection==="up"?"up":"down", // 登録画面のスイッチで指定された値をそのまま使用（自動判定はしない）
    status:"waiting", // waiting(待機中) → active(進行中) → done(完了)
    startPrice:null,startAt:null,endPrice:null,endAt:null,
    pnl:null,pnlPercent:null,exitReason:null, // take_profit(利確) / stop_loss(損切り) / time_exit(引けで強制決済) / forced(強制完了)
    signalAtAdd:s.timing||null, // 登録時点のアプリ判定（BUY/WATCH/SKIP）＝後から検証するための記録
    weightAdjustAtAdd:weightAdjustAtAdd, // 登録時点の実績反映調整の点数（検証パネル用）
    scoreAtAdd:s.score!=null?s.score:null, // 登録時点のスコア
    sigKeysAtAdd:sigKeysAtAdd, // 登録時点で点灯していたシグナル一覧
    forecastAtAdd:forecastAtAdd, // 登録時点の🔮翌営業日予想（期待変化率・上昇確率）
    lastPrice:curPrice,
    addedAt:new Date().toISOString()
  });
  saveTrades(kind,list);
  return list;
}
// 指定銘柄がアプリ予想・個人予想のどちらかで進行中(waiting/active)かどうか
function hasActiveTrade(ticker,appTrades,personalTrades){
  var lists=[appTrades||[],personalTrades||[]];
  for(var i=0;i<lists.length;i++){
    for(var j=0;j<lists[i].length;j++){
      var t=lists[i][j];
      if(t.ticker===ticker&&(t.status==="waiting"||t.status==="active")) return true;
    }
  }
  return false;
}
// ★ボタンの見た目：進行中トレードがあれば赤、無ければ従来通りお気に入り色分け
function starStyle(ticker,isFav,appTrades,personalTrades){
  if(hasActiveTrade(ticker,appTrades,personalTrades)) return {symbol:"★",color:"#f43f5e"};
  return isFav(ticker)?{symbol:"★",color:"#fbbf24"}:{symbol:"☆",color:"#2a4060"};
}
function removeTradeRecord(kind,id){var list=loadTrades(kind).filter(function(t){return t.id!==id;});saveTrades(kind,list);return list;}

// 売買価格・株数・損切り価格の編集（進行中・完了済みの場合は開始/終了価格や損益も再計算）
function editTradeRecord(kind,id,updates){
  var list=loadTrades(kind).map(function(t){
    if(t.id!==id)return t;
    var next=Object.assign({},t,updates);
    if(t.status==="waiting"&&updates.buyDirection==null&&updates.buyPrice!=null&&t.lastPrice!=null){
      // 指値/逆指値が手動指定されなかった場合のみ、価格変更から自動判定する
      next.buyDirection=updates.buyPrice<=t.lastPrice?"down":"up";
    }
    if(t.status!=="waiting"&&updates.buyPrice!=null)next.startPrice=updates.buyPrice;
    if(t.status==="done"){
      if(updates.sellPrice!=null)next.endPrice=updates.sellPrice;
      var pnlPerShare=next.endPrice-next.startPrice;
      next.pnl=pnlPerShare*(next.shares||1);
      next.pnlPercent=next.startPrice?(pnlPerShare/next.startPrice*100):0;
    }
    return next;
  });
  saveTrades(kind,list);
  return list;
}

// 現在価格で強制的に完了させる（待機中でもOK：その場合は開始・終了とも現在価格＝損益0で記録）
function forceCompleteTradeRecord(kind,id,curPrice){
  var list=loadTrades(kind).map(function(t){
    if(t.id!==id||t.status==="done")return t;
    var startP=t.status==="active"?t.startPrice:curPrice;
    var pnlPerShare=curPrice-startP,pnl=pnlPerShare*(t.shares||1),pnlPercent=startP?(pnlPerShare/startP*100):0;
    return Object.assign({},t,{status:"done",startPrice:startP,startAt:t.startAt||new Date().toISOString(),
      endPrice:curPrice,endAt:new Date().toISOString(),pnl:pnl,pnlPercent:pnlPercent,exitReason:"forced",lastPrice:curPrice});
  });
  saveTrades(kind,list);
  return list;
}

// 最新価格（{ticker:price}）を全トレードに適用し、waiting→active→doneの状態遷移を判定
// ※ 前後2点の「またぎ」ではなく「閾値に到達しているか」を直接判定するため、更新間隔中に価格が飛んでも見逃さない
function applyPricesToTrades(kind,priceMap){
  var list=loadTrades(kind);
  var changed=false;
  var next=list.map(function(t){
    if(t.status==="done")return t;
    // 土日・祝日など「取引日でない日」は、価格が古い終値のままなので一切状態を動かさない
    if(!isTradingDay(t.market))return t;
    // 引け（取引終了）を過ぎたactiveトレードは、価格取得の成否に関わらず自動決済する（デイトレ想定：持ち越し禁止）
    if(t.status==="active"&&t.startAt&&Date.now()>=sessionCloseTime(t.market,t.startAt)){
      changed=true;
      // 取引時間中に決済する場合＝前営業日から持ち越された分なので、現在値ではなく最後に記録した価格を使う
      var exitP=(isMarketOpen(t.market)&&t.lastPrice!=null)?t.lastPrice:(priceMap[t.ticker]!=null?priceMap[t.ticker]:t.lastPrice);
      var pnlPerShare3=exitP-t.startPrice,pnl3=pnlPerShare3*(t.shares||1),pnlPercent3=t.startPrice?(pnlPerShare3/t.startPrice*100):0;
      return Object.assign({},t,{status:"done",endPrice:exitP,endAt:new Date().toISOString(),pnl:pnl3,pnlPercent:pnlPercent3,exitReason:"time_exit",lastPrice:exitP});
    }
    var cur=priceMap[t.ticker];
    if(cur==null)return t;
    if(t.status==="waiting"){
      var dir=getBuyDirection(t);
      var reached=dir==="down"?cur<=t.buyPrice:cur>=t.buyPrice;
      if(reached&&isMarketOpen(t.market)){
        changed=true;
        return Object.assign({},t,{status:"active",startPrice:t.buyPrice,startAt:new Date().toISOString(),lastPrice:cur});
      }
      if(cur!==t.lastPrice){changed=true;return Object.assign({},t,{lastPrice:cur});}
      return t;
    }
    // status==="active"：利確（売り価格到達）→損切り（設定時のみ）の順で判定
    if(cur>=t.sellPrice){
      changed=true;
      var pnlPerShare=t.sellPrice-t.startPrice,pnl=pnlPerShare*(t.shares||1),pnlPercent=t.startPrice?(pnlPerShare/t.startPrice*100):0;
      return Object.assign({},t,{status:"done",endPrice:t.sellPrice,endAt:new Date().toISOString(),pnl:pnl,pnlPercent:pnlPercent,exitReason:"take_profit",lastPrice:cur});
    }
    if(t.stopPrice!=null&&cur<=t.stopPrice){
      changed=true;
      var pnlPerShare2=t.stopPrice-t.startPrice,pnl2=pnlPerShare2*(t.shares||1),pnlPercent2=t.startPrice?(pnlPerShare2/t.startPrice*100):0;
      return Object.assign({},t,{status:"done",endPrice:t.stopPrice,endAt:new Date().toISOString(),pnl:pnl2,pnlPercent:pnlPercent2,exitReason:"stop_loss",lastPrice:cur});
    }
    if(cur!==t.lastPrice){changed=true;return Object.assign({},t,{lastPrice:cur});}
    return t;
  });
  if(changed)saveTrades(kind,next);
  return next;
}

// ── AI分析 共通ユーティリティ ────────────────────────────────────────────────
var AI_API_URL="https://daytrade-simulator.vercel.app/api/ai";
// 対象銘柄の各シグナルについて、スキャン銘柄全体での過去的中率をAIへの参考情報として整形
// （サンプル10件未満のシグナルは参考にならないため含めない）
// あわせて🔮統計ベース予想（翌営業日の期待変化率・上昇確率）とスコア帯実績も渡し、
// AIの見通しが実データに基づくようにする
function buildAccuracyPart(signals,score){
  var stats=getUniverseSignalStats();
  var lines=[];
  (signals||[]).forEach(function(sig){
    var key=baseSigLabel(sig.label)+"#"+sig.state;
    var s=stats[key];
    if(s&&s.t>=10) lines.push("  "+sig.label+": 過去的中率"+Math.round(signalQuality(s,key)*100)+"%("+s.t+"件, 予想方向が翌営業日に当たった率)");
  });
  var out=lines.length?("過去のシグナル的中率(参考・スキャン銘柄全体集計):\n"+lines.join("\n")+"\n"):"";
  var fc=calcStatForecast(signals,stats);
  if(fc.ready) out+="🔮統計ベース翌営業日予想(過去実績のみで算出): 期待変化率"+(fc.expPct>=0?"+":"")+fc.expPct.toFixed(1)+"% / 上昇した割合"+fc.upRate+"%("+fc.totalN+"件)\n";
  if(score!=null){
    var band=getUniverseBandStats().find(function(b){return b.band===bandLabelFor(score);});
    if(band&&band.total>=5) out+="スコア帯"+band.band+"点の過去実績: 翌営業日的中率"+band.winRate+"%("+band.total+"件)\n";
  }
  return out;
}
function buildAiPrompt(s){
  var isJP=s.market==="JP";
  var relPart=(isJP&&s.relStrength!=null)?("対TOPIX相対: "+(s.relStrength>=0?"+":"")+s.relStrength.toFixed(1)+"%（個別銘柄騰落率−TOPIX騰落率。市場全体を除いた銘柄固有の強さの目安）\n"):"";
  var histPart="";
  if(s.scoreHist&&s.scoreHist.length>=2){
    var days=s.tradeType==="short"?5:s.tradeType==="mid"?7:10;
    var slice=s.scoreHist.slice(-days);
    var trend=slice[slice.length-1].s-slice[0].s;
    var atrTrend=slice[slice.length-1].atr-slice[0].atr;
    histPart="スコア推移(直近"+slice.length+"日):\n"+
      slice.map(function(x){return"  "+x.d+": "+x.s+"点 ATR:"+x.atr;}).join("\n")+"\n"+
      "スコアトレンド: "+(trend>10?"↑上昇中(+"+trend+")":trend<-10?"↓下落中("+trend+")":"→横ばい")+"\n"+
      "ATRトレンド: "+(atrTrend>0?"↑拡大中(ボラ増)":"↓縮小中(ボラ減)")+"\n";
  }
  var accPart=buildAccuracyPart(s.signals,s.score);
  return "あなたは株式トレードのアナリストです。以下の銘柄データを分析して、日本語で簡潔に解説してください。\n\n"+
    "銘柄: "+s.ticker+" ("+s.name+")\n市場: "+s.market+"\n現在値: "+s.price+"\n前日比: "+s.change+"%\n"+
    "総合スコア: "+s.score+"/100\nトレードタイプ: "+s.tradeLabel+"\n"+
    "52週高値比: "+s.fromHigh.toFixed(1)+"%\n52週安値比: "+(s.fromLow>=0?"+":"")+s.fromLow.toFixed(1)+"%\n"+
    "52週ポジション: "+s.position52.toFixed(0)+"% (0%=安値圏 100%=高値圏)\n"+
    "ATR(14日): "+(isJP?"¥":"$")+s.atr+" / 想定値幅: "+(isJP?"¥":"$")+s.atrLower+"〜"+(isJP?"¥":"$")+s.atrUpper+"\n"+
    relPart+
    histPart+
    accPart+
    "シグナル:\n"+s.signals.map(function(sig){return"  "+sig.label+": "+sig.val;}).join("\n")+"\n\n"+
    "まず最初の1行に、次の形式のタグで数値データだけを出力してください（前後に説明や```を付けないこと。これが最優先です）:\n"+
    "<AI_DATA>{\"entry\":"+(isJP?"整数":"小数")+",\"target\":"+(isJP?"整数":"小数")+",\"stop\":"+(isJP?"整数":"小数")+",\"forecast\":{\"direction\":\"上昇 or 下落 or 中立\",\"confidence\":整数0〜100,\"timeframe\":\"文字列\",\"reason\":\"文字列\"}}</AI_DATA>\n\n"+
    "その後で、以下のトレード判断を日本語で分かりやすく解説してください:\n1. 📌 今日中に買うべきか / 見送るべきか（理由を2文で）\n2. 💰 entry: 具体的な買いレンジ（買いを検討すべき価格帯）\n3. 🎯 target: 利確ライン（ATR比での根拠も添えて）\n4. 🛑 stop: 損切りライン（サポートやBB下限など根拠も添えて）\n5. 🔮 今後の見通し: 必ずWeb検索でこの銘柄の最新ニュース・決算・材料を調べた上で、今後数日〜1週間程度で上昇/下落/中立のどれに向かいやすいかを予想し、確信度と根拠を1〜2文で述べてください";
}
// 上位N件 → claude.ai貼り付け用プロンプトを生成
// jpLimited(既定true): 日本株限定で「出来高急増率」×「ボラティリティ」の合成ランキングで上位N件を選出
// jpLimited=falseを渡すと市場フィルタ・並べ替えをせず渡された銘柄をそのまま出力する（個別銘柄コピー用）
var SURGE_WEIGHT=0.5, VOLATILITY_WEIGHT=0.5; // 出来高急増率/ボラティリティの重み（合計1.0）
function buildVolumeRankingPrompt(stocks,topN,jpLimited){
  var n=topN||10;
  var top;
  if(jpLimited===false){
    top=stocks.slice(0,n);
  }else{
    var pool=stocks.filter(function(s){return s.market==="JP";});
    var metrics=pool.map(function(s){
      var surge=s.volSurge||1; // 出来高急増率＝直近5日出来高÷過去20日平均（自分比の"今の勢い"）
      var volatility=s.rawPrice?((s.atr||0)/s.rawPrice):0; // ATR%
      return{s:s,surge:surge,volatility:volatility};
    });
    var maxSurge=Math.max.apply(null,metrics.map(function(m){return m.surge;}).concat([1]));
    var maxVol=Math.max.apply(null,metrics.map(function(m){return m.volatility;}).concat([1e-9]));
    metrics.forEach(function(m){
      m.rankScore=(m.surge/maxSurge)*SURGE_WEIGHT+(m.volatility/maxVol)*VOLATILITY_WEIGHT;
    });
    top=metrics.sort(function(a,b){return b.rankScore-a.rankScore;}).slice(0,n).map(function(m){return m.s;});
  }
  var lines=top.map(function(s,i){
    var unit=s.market==="JP"?"¥":"$";
    var trendLine="";
    if(s.scoreHist&&s.scoreHist.length>=2){
      var slice=s.scoreHist.slice(-5);
      var trend=slice[slice.length-1].s-slice[0].s;
      trendLine="  スコア推移: "+(trend>10?"↑上昇中(+"+trend+")":trend<-10?"↓下落中("+trend+")":"→横ばい")+"\n";
    }
    var per=s.per!=null?s.per.toFixed(1):"─";
    var pbr=s.pbr!=null?s.pbr.toFixed(2):"─";
    var target=s.analystTarget!=null?unit+s.analystTarget:"─";
    var prevH=s.pivot&&s.pivot.prevHigh!=null?unit+s.pivot.prevHigh:"─";
    var prevL=s.pivot&&s.pivot.prevLow!=null?unit+s.pivot.prevLow:"─";
    var wH=s.weekHigh!=null?unit+s.weekHigh:"─";
    var wL=s.weekLow!=null?unit+s.weekLow:"─";
    var signalsLine=s.signals&&s.signals.length
      ?"  シグナル全項目:\n"+s.signals.map(function(sig){return"    "+sig.label+": "+sig.val;}).join("\n")+"\n"
      :"";
    return(i+1)+". "+s.ticker+" ("+s.name+") ["+s.market+"]\n"+
      "  現在値: "+unit+s.price+"  前日比: "+s.change+"%\n"+
      "  出来高: "+(s.volume||0).toLocaleString()+"（急増率: "+(s.volSurge?s.volSurge.toFixed(1)+"倍":"─")+"）\n"+
      "  総合スコア: "+s.score+"/100  トレードタイプ: "+s.tradeLabel+"\n"+
      trendLine+
      "  ATR: "+unit+s.atr+"  想定値幅: "+unit+s.atrLower+"〜"+unit+s.atrUpper+"\n"+
      "  52週ポジション: "+(s.position52!=null?s.position52.toFixed(0)+"%":"─")+"\n"+
      "  PER: "+per+"  PBR: "+pbr+"  アナリスト目標株価: "+target+"\n"+
      "  前日高値/安値: "+prevH+"〜"+prevL+"  週足高値/安値: "+wH+"〜"+wL+"\n"+
      signalsLine;
  }).join("\n\n");
  var note=jpLimited===false?"":"（日本株限定・出来高急増率×ボラティリティ順）";
  return"あなたは株式トレードのアナリストです。以下はスコア上位"+top.length+"銘柄のデータです"+note+"。\n\n"+
    lines+"\n\n"+
    "各銘柄について「買い」「売り」「見送り」のいずれかを判定し、理由を1〜2文で日本語で答えてください。\n"+
    "出力形式:\n銘柄コード: 判定（買い/売り/見送り） — 理由";
}
// 表示用にAI_DATAタグ（数値データ用の内部タグ）を隠す。
// 書きかけの「<AI_D」のような未完成のタグも隠して、画面にチラつかないようにする。
function stripAiData(t){
  var m=t.match(/<AI_DATA>[\s\S]*?<\/AI_DATA>/);
  if(m) return t.replace(m[0],"");
  var i=t.indexOf("<AI_DATA>");
  if(i!==-1) return t.slice(0,i);
  var j=t.lastIndexOf("<");
  if(j!==-1&&"<AI_DATA>".indexOf(t.slice(j))===0) return t.slice(0,j);
  return t;
}
// AI_DATAタグ（無ければ末尾JSON）から数値データを取り出し、本文と分けて返す
function parseAiResult(raw){
  var tagMatch=raw.match(/<AI_DATA>([\s\S]*?)<\/AI_DATA>/);
  var parsed=null,cleanText=raw;
  if(tagMatch){
    try{parsed=JSON.parse(tagMatch[1]);}catch(je){}
    cleanText=raw.replace(tagMatch[0],"");
  }else{
    var stripped=raw.replace(/```json[\s\S]*?```/g,"");
    var braceIdx=stripped.lastIndexOf("{");
    if(braceIdx!==-1){
      try{parsed=JSON.parse(stripped.slice(braceIdx));cleanText=stripped.slice(0,braceIdx);}catch(je2){}
    }
  }
  return{parsed:parsed,cleanText:cleanText};
}
async function callAiAnalysis(s,setAiText,setAiEntry,setAiLoading){
  var raw="";
  try{
    var res=await fetch(AI_API_URL,{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        prompt:buildAiPrompt(s),
        system:"必ず自分でWeb検索ツールを使って、この銘柄の最新ニュース・材料を確認してから回答してください。ユーザーに質問や確認を求めず、自律的に分析を完了してください。\n\n回答の一番最初に、解説文より前に必ず次の形式でJSONデータを出力してください:\n<AI_DATA>{\"entry\":推奨エントリー価格の数値,\"target\":利確目標価格の数値,\"stop\":損切りラインの数値,\"forecast\":{\"direction\":\"上昇\"または\"下落\"または\"中立\",\"confidence\":0〜100の確信度数値,\"timeframe\":\"期間目安(例:1〜3営業日)\",\"reason\":\"見通しの理由を1文で\"}}</AI_DATA>\nこのタグの後に、通常の分析コメント（買い/売り推奨、Entry/Target/Stopの詳細、今後の見通しなど）を日本語で記載してください。",
        useWebSearch:true,
        stream:true
      }),signal:AbortSignal.timeout(45000)});
    if(!res.ok) throw new Error("サーバーエラー("+res.status+")");

    if(res.body&&res.body.getReader){
      // ストリーミング：届いた文字を書けた端から画面に反映していく
      var reader=res.body.getReader(),dec=new TextDecoder(),last=0;
      for(;;){
        var r=await reader.read();
        if(r.done) break;
        raw+=dec.decode(r.value,{stream:true});
        var now=Date.now();
        if(now-last>120){last=now;setAiText(stripAiData(raw));} // 描画は最短0.12秒間隔に間引く
      }
    }else{
      // 万一ストリーミングが使えない環境では従来どおり全文まとめて受け取る
      var txt=await res.text();
      try{var j2=JSON.parse(txt);if(j2.error) throw new Error(j2.error);raw=j2.text||"";}
      catch(pe){raw=txt;}
    }

    var out=parseAiResult(raw);
    if(out.parsed&&typeof out.parsed.entry!=="undefined") setAiEntry(out.parsed);
    if(out.parsed&&out.parsed.forecast) recordAiForecast(s.ticker,s.price,out.parsed.forecast);
    setAiText(out.cleanText.trim()||"分析できませんでした。");
  }catch(e){
    // 途中まで届いていれば、それを残したうえで注意書きを添える（全部消えるより親切）
    var partial=stripAiData(raw).trim();
    var msg="エラーが発生しました: "+(e.message||JSON.stringify(e)||"不明なエラー");
    setAiText(partial?(partial+"\n\n──\n（"+msg+" 途中までの内容を表示しています）"):msg);
  }
  setAiLoading(false);
}
// ── AI予想（forecast）の的中率トラッキング ───────────────────────────────
// AI分析を実行するたびに「その日時点の予想方向・確信度・株価」を記録し、
// 後日scoreHist（実際の値動き）と突き合わせてAI予想自体の的中率を検証する
function recordAiForecast(ticker,price,forecast){
  if(!forecast||!forecast.direction||price==null) return;
  var key="aipred_"+ticker;
  var today=new Date().toISOString().slice(0,10);
  var hist;try{hist=JSON.parse(localStorage.getItem(key)||"[]");}catch(e){hist=[];}
  var idx=hist.findIndex(function(x){return x.d===today;});
  var entry={d:today,p:price,dir:forecast.direction,conf:forecast.confidence};
  if(idx>=0)hist[idx]=entry;else hist.push(entry);
  if(hist.length>60)hist=hist.slice(-60); // 最大60日分保持
  try{localStorage.setItem(key,JSON.stringify(hist));}catch(e){}
}
// 全銘柄のAI予想記録とscoreHist（実際の終値）を突き合わせて的中率を算出
// 「中立」予想は方向判定ができないため集計対象から除外する
function calcAiForecastAccuracy(){
  var horizons=[1,3];
  var byHorizon={};horizons.forEach(function(h){byHorizon[h]={w:0,t:0};});
  var byConf={"50-69":{w:0,t:0},"70-89":{w:0,t:0},"90+":{w:0,t:0}};
  try{
    Object.keys(localStorage).forEach(function(key){
      if(key.indexOf("aipred_")!==0) return;
      var ticker=key.slice(7);
      var preds;try{preds=JSON.parse(localStorage.getItem(key)||"[]");}catch(e){preds=[];}
      var hist;try{hist=JSON.parse(localStorage.getItem("sh_"+ticker)||"[]");}catch(e){hist=[];}
      if(!hist.length||!preds.length) return;
      preds.forEach(function(pr){
        if(!pr.dir||pr.dir.indexOf("中立")!==-1) return;
        var idx=hist.findIndex(function(x){return x.d===pr.d;});
        if(idx<0) return;
        horizons.forEach(function(h){
          var base=hist[idx],nxt=hist[idx+h];
          if(!nxt||nxt.p==null||base.p==null) return;
          if(bizDayDiff(base.d,nxt.d)!==h) return; // 記録が飛んだペアは「h日後」として不正確なので除外
          var move=priceMoveState(base.p,nxt.p);
          if(move===0) return; // 誤差レベルの値動きは集計対象外
          var won=pr.dir.indexOf("上昇")!==-1?(move>0):(move<0);
          byHorizon[h].t++;if(won)byHorizon[h].w++;
          if(h===1){
            var band=pr.conf>=90?"90+":pr.conf>=70?"70-89":"50-69";
            byConf[band].t++;if(won)byConf[band].w++;
          }
        });
      });
    });
  }catch(e){}
  function pct(o){return o.t>0?Math.round(o.w/o.t*100):null;}
  return{
    byHorizon:horizons.map(function(h){return{h:h,winRate:pct(byHorizon[h]),total:byHorizon[h].t};}),
    byConfidence:["50-69","70-89","90+"].map(function(k){return{band:k,winRate:pct(byConf[k]),total:byConf[k].t};})
  };
}
// 見通し（forecast）表示用の共通コンポーネント
function ForecastBox(f){
  if(!f) return null;
  var col=f.direction&&f.direction.indexOf("上昇")!==-1?"#22d3a0":f.direction&&f.direction.indexOf("下落")!==-1?"#f43f5e":"#fbbf24";
  var icon=col==="#22d3a0"?"📈":col==="#f43f5e"?"📉":"➖";
  return(
    <div style={{background:"#040c18",border:"1px solid "+col+"40",borderRadius:8,padding:"8px 10px",marginTop:8}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
        <div style={{fontSize:11,fontWeight:700,color:col}}>{icon} 今後の見通し: {f.direction||"─"}</div>
        <div style={{fontSize:11,fontWeight:700,color:col}}>確信度 {f.confidence!=null?f.confidence+"%":"─"}</div>
      </div>
      {f.timeframe&&<div style={{fontSize:11,color:"#4a7090",marginBottom:3}}>期間目安: {f.timeframe}</div>}
      {f.reason&&<div style={{fontSize:12,color:"#b8cce0",lineHeight:1.5}}>{f.reason}</div>}
    </div>
  );
}
// ────────────────────────────────────────────────────────────────────────────

function calcSMA(arr,p){return arr.map(function(_,i){if(i<p-1)return null;var s=0;for(var j=i-p+1;j<=i;j++)s+=arr[j];return s/p;});}
function calcEMA(arr,p){var k=2/(p+1),out=[arr[0]];for(var i=1;i<arr.length;i++)out.push(arr[i]*k+out[i-1]*(1-k));return out;}
function calcMACD(arr){var e12=calcEMA(arr,12),e26=calcEMA(arr,26),ml=e12.map(function(v,i){return v-e26[i];}),sig=calcEMA(ml,9);return ml.map(function(v,i){return{hist:v-sig[i]};});}
function calcRSI(arr){var p=14,out=[];for(var x=0;x<p;x++)out.push(null);var ag=0,al=0;for(var i=1;i<=p;i++){var diff2=arr[i]-arr[i-1];if(diff2>=0)ag+=diff2;else al-=diff2;}ag/=p;al/=p;out.push(100-100/(1+ag/(al||1e-9)));for(var j=p+1;j<arr.length;j++){var diff=arr[j]-arr[j-1];ag=(ag*(p-1)+Math.max(diff,0))/p;al=(al*(p-1)+Math.max(-diff,0))/p;out.push(100-100/(1+ag/(al||1e-9)));}return out;}
function calcBoll(arr){var p=20,k=2;return arr.map(function(_,i){if(i<p-1)return null;var bl=arr.slice(i-p+1,i+1),m=bl.reduce(function(a,b){return a+b;})/p,sd=Math.sqrt(bl.reduce(function(a,b){return a+(b-m)*(b-m);},0)/p);return{upper:m+k*sd,lower:m-k*sd};});}
function calcStoch(closes,highs,lows){var p=14;return closes.map(function(_,i){if(i<p-1)return null;var hi=Math.max.apply(null,highs.slice(i-p+1,i+1)),lo=Math.min.apply(null,lows.slice(i-p+1,i+1));if(lo===hi)return 50;return((closes[i]-lo)/(hi-lo))*100;});}

// VWAP（出来高加重平均価格）
function calcVWAP(closes,highs,lows,volumes){var cumTPV=0,cumVol=0;for(var i=0;i<closes.length;i++){var tp=(highs[i]+lows[i]+closes[i])/3,v=volumes[i]||0;cumTPV+=tp*v;cumVol+=v;}return cumVol>0?cumTPV/cumVol:null;}

// ピボットポイント（前日相当26本から計算）
function calcPivot(closes,highs,lows){var DAY=26,len=closes.length;if(len<DAY*2)return null;var ph=highs.slice(len-DAY*2,len-DAY),pl=lows.slice(len-DAY*2,len-DAY);var prevH=Math.max.apply(null,ph),prevL=Math.min.apply(null,pl),prevC=closes[len-DAY-1];var pp=(prevH+prevL+prevC)/3;return{pp:pp,r1:pp*2-prevL,s1:pp*2-prevH,r2:pp+(prevH-prevL),s2:pp-(prevH-prevL),prevHigh:prevH,prevLow:prevL,prevClose:prevC};}
// ATR(真の値幅の平均)。period本分のTrue Rangeを単純平均。ボラティリティ判定に使用
function calcATR(closes,highs,lows,period){var trs=[];for(var i=1;i<closes.length;i++){var h=highs[i]||closes[i],l=lows[i]||closes[i],pc=closes[i-1];trs.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));}var slice=trs.slice(-period);return slice.length?slice.reduce(function(a,b){return a+b;},0)/slice.length:null;}

// ===== 予測レンジ（簡易版） =====
// 直近period日の値動きの荒さσを求める。σ＝1日あたり何%動くかの目安（対数ベース）
function calcVolSigma(closes,period){
  if(!closes||closes.length<period+2)return null;
  var r=[],st=closes.length-period;
  for(var i=st;i<closes.length;i++){
    if(closes[i-1]>0&&closes[i]>0)r.push(Math.log(closes[i]/closes[i-1]));
  }
  if(r.length<5)return null;
  var m=0;for(var a=0;a<r.length;a++)m+=r[a];m/=r.length;
  var v=0;for(var b=0;b<r.length;b++)v+=(r[b]-m)*(r[b]-m);
  return Math.sqrt(v/(r.length-1));
}
// days営業日先のレンジ。√days＝時間の平方根ルール（日数が伸びるほど緩やかに広がる）
function volBandAt(price,sigma,days,k){
  var w=k*sigma*Math.sqrt(days);
  return{u:price*Math.exp(w),l:price*Math.exp(-w)};
}
var BAND_K68=1.0, BAND_K90=1.645, BAND_DAYS=5; // 68%帯・90%帯・予測日数

// ===== 予測レンジの記録と較正 =====
// 保存するのは {t:銘柄, d:予測日, p:基準価格, s:σ, a:5営業日後の実際の終値} だけ。
// 帯そのものは持たない。p・s・aさえあれば、どんな係数kでも後から成績を計算し直せる
var FC_KEY="fc_log_v1", FC_MAX_DAYS=180, FC_MAX_ROWS=3000, FC_MIN_SAMPLES=30;
var FC_CAL_CACHE=null, FC_CAL_TS=0;
function fcLoad(){try{var v=localStorage.getItem(FC_KEY);return v?JSON.parse(v):[];}catch(e){return[];}}
function fcSave(list){try{localStorage.setItem(FC_KEY,JSON.stringify(list));FC_CAL_CACHE=null;}catch(e){}}
function fcIsFav(t){try{return JSON.parse(localStorage.getItem("fav_tickers")||"[]").indexOf(t)>=0;}catch(e){return false;}}

// 日足を取ったタイミングで呼ぶ。(1)期日が来た予測の答え合わせ (2)当日分の記録
function updateForecastLog(ticker,d){
  if(!fcIsFav(ticker))return;                                   // お気に入り銘柄のみ対象
  if(!d||!d.closes||!d.dates||d.closes.length<30)return;
  var list=fcLoad(),changed=false,n=d.closes.length;
  var idx={};for(var i=0;i<d.dates.length;i++)idx[d.dates[i]]=i;

  // (1) 答え合わせ：予測日から5営業日後の終値が出ていれば書き込む
  for(var j=0;j<list.length;j++){
    var r=list[j];
    if(r.t!==ticker||r.a!=null)continue;
    var bi=idx[r.d];
    if(bi==null||bi+BAND_DAYS>=n)continue;
    r.a=d.closes[bi+BAND_DAYS];changed=true;
  }

  // (2) 当日分を記録（同じ銘柄・同じ日は1件だけ）
  var today=d.dates[n-1];
  var dup=false;for(var k=0;k<list.length;k++){if(list[k].t===ticker&&list[k].d===today){dup=true;break;}}
  if(!dup){
    var sg=calcVolSigma(d.closes,20);
    if(sg>0){list.push({t:ticker,d:today,p:d.closes[n-1],s:Math.round(sg*100000)/100000});changed=true;}
  }

  if(!changed)return;
  // 古い記録は捨てる（180日より前 or 3000件超）
  var limit=new Date(Date.now()-FC_MAX_DAYS*86400000).toISOString().slice(0,10);
  list=list.filter(function(r){return r.d>=limit;});
  if(list.length>FC_MAX_ROWS)list=list.slice(list.length-FC_MAX_ROWS);
  fcSave(list);
}

// 実測から係数を求める。z=|ln(実績/基準)|/(σ√5) の分位点が、そのまま最適なkになる
function fcCalibration(){
  var now=Date.now();
  if(FC_CAL_CACHE&&now-FC_CAL_TS<60000)return FC_CAL_CACHE;
  var list=fcLoad(),z=[],rt=Math.sqrt(BAND_DAYS),total=list.length;
  for(var i=0;i<list.length;i++){
    var r=list[i];
    if(r.a>0&&r.p>0&&r.s>0)z.push(Math.abs(Math.log(r.a/r.p))/(r.s*rt));
  }
  var out;
  if(z.length<FC_MIN_SAMPLES){
    out={n:z.length,total:total,k68:1,k90:1,ready:false};
  }else{
    z.sort(function(a,b){return a-b;});
    function q(pp){return z[Math.min(z.length-1,Math.floor(pp*z.length))];}
    function cov(k){var c=0;for(var i2=0;i2<z.length;i2++)if(z[i2]<=k)c++;return Math.round(c/z.length*100);}
    out={n:z.length,total:total,k68:q(0.68)/BAND_K68,k90:q(0.90)/BAND_K90,ready:true,cov68:cov(BAND_K68),cov90:cov(BAND_K90)};
  }
  FC_CAL_CACHE=out;FC_CAL_TS=now;return out;
}

// 別デバイスの記録と突き合わせる。同じ銘柄・同じ日は「答え合わせ済み」を優先して残す
function fcMerge(remote){
  if(!remote||!remote.length)return;
  var map={},list=fcLoad();
  function put(r){
    if(!r||!r.t||!r.d)return;
    var key=r.t+"|"+r.d,old=map[key];
    if(!old||(old.a==null&&r.a!=null))map[key]=r;
  }
  list.forEach(put);remote.forEach(put);
  var merged=Object.keys(map).map(function(k){return map[k];});
  merged.sort(function(a,b){return a.d<b.d?-1:a.d>b.d?1:0;});
  if(merged.length>FC_MAX_ROWS)merged=merged.slice(merged.length-FC_MAX_ROWS);
  fcSave(merged);
}

// お気に入り全銘柄の予測を1日1回まとめて記録する（1銘柄ずつ開かなくても貯まるように）
var FC_RUN_KEY="fc_last_run";
function fcTodayJST(){return new Date(Date.now()+9*3600000).toISOString().slice(0,10);}
async function recordFavForecasts(favs){
  if(!favs||!favs.length)return;
  var today=fcTodayJST();
  try{if(localStorage.getItem(FC_RUN_KEY)===today)return;}catch(e){} // その日すでに実行済みなら何もしない
  for(var i=0;i<favs.length;i++){
    await fetchDaily(favs[i]); // この中で updateForecastLog が走る
    await new Promise(function(r){setTimeout(r,400);}); // Yahooに負担をかけない間隔
  }
  try{localStorage.setItem(FC_RUN_KEY,today);}catch(e){}
}

// ── 買値（デイトレ用エントリー）まわりの共通ヘルパー ──────────────────
// 東証の呼値（値段の刻み）。これに丸めないと実際には発注できない価格になる
var TICKS_JP=[[3000,1],[5000,5],[30000,10],[50000,50],[300000,100],[500000,500],[3000000,1000],[5000000,5000]];
function tickSizeFor(v,isJP){
  if(!isJP) return 0.01;
  for(var i=0;i<TICKS_JP.length;i++){ if(v<=TICKS_JP[i][0]) return TICKS_JP[i][1]; }
  return 10000;
}
// 呼値に丸める（dir: 1=切り上げ / -1=切り捨て / 0=四捨五入）
function roundTickPrice(v,dir,isJP){
  var t=tickSizeFor(v,isJP),q=v/t;
  var out=(dir>0?Math.ceil(q):dir<0?Math.floor(q):Math.round(q))*t;
  return isJP?Math.round(out):parseFloat(out.toFixed(2));
}
// 15分足を日付でまとめ直して「日足ATR」を算出する。
// スコア計算で使うatrは15分足1本分の値幅（数円）しかなく、デイトレの
// 利確・損切り幅の基準にすると極端に狭くなるため、日足に換算し直して使う。
// 当日はまだ途中なので除外する。
function calcDailyATR(closes,highs,lows,dates,period){
  if(!dates||dates.length!==closes.length||closes.length<2) return null;
  var dh=[],dl=[],dc=[],cur=null;
  for(var i=0;i<closes.length;i++){
    if(dates[i]!==cur){cur=dates[i];dh.push(highs[i]);dl.push(lows[i]);dc.push(closes[i]);}
    else{var k=dh.length-1;
      if(highs[i]>dh[k])dh[k]=highs[i];
      if(lows[i]<dl[k])dl[k]=lows[i];
      dc[k]=closes[i];}
  }
  if(dc.length<4) return null;
  dh.pop();dl.pop();dc.pop(); // 当日（未完成の足）を除く
  return calcATR(dc,dh,dl,Math.min(period||14,dc.length-1));
}
// 買値・利確・損切りを組み立てる
// mode: "now"=現在値で追随 / "break"=上抜け待ち(逆指値)　※押し目待ち(dip)は廃止
// anchor: 買値の基準になる価格（dipならVWAP、breakなら当日高値+1ティック）
// 利確幅は「日足ATR×0.4」。ただし最低+1.0%・最大+3.0%に収める。損切り幅はその半分（RR約1:2）
function buildBuyPlan(mode,anchor,atrDaily,isJP,reason,warn){
  if(anchor==null||!(atrDaily>0)) return null;
  var entry=roundTickPrice(anchor,mode==="break"?1:0,isJP);
  var up=Math.min(Math.max(atrDaily*0.4,entry*0.010),entry*0.030);
  var dn=up/2;
  var target=roundTickPrice(entry+up,-1,isJP);
  var stop=roundTickPrice(entry-dn,-1,isJP);
  var tk=tickSizeFor(entry,isJP);
  if(target<=entry) target=roundTickPrice(entry+tk*2,1,isJP);   // 丸めで同値になった時の保険
  if(stop>=entry)   stop=roundTickPrice(entry-tk*2,-1,isJP);
  return{
    entry:entry,target:target,stop:stop,mode:mode,reason:reason,warn:warn||null,
    atrDaily:atrDaily,
    gainPct:parseFloat(((target-entry)/entry*100).toFixed(1)),
    lossPct:parseFloat(((entry-stop)/entry*100).toFixed(1)),
    rr:(entry-stop)>0?parseFloat(((target-entry)/(entry-stop)).toFixed(1)):null
  };
}

// 上位足の方向判定。factor本ごとに間引いた擬似終値列でEMA5/13クロスを見る（1:上昇 -1:下降 0:横ばい/データ不足）
function resampleDir(closes,factor){var arr=[];for(var i=closes.length-1;i>=0&&arr.length<40;i-=factor){arr.unshift(closes[i]);}if(arr.length<14)return 0;var e5=calcEMA(arr,5),e13=calcEMA(arr,13),m=arr.length-1;return e5[m]>e13[m]?1:(e5[m]<e13[m]?-1:0);}

// ── 勝敗判定の共通しきい値 ──────────────────────────────────────────────
// スキャン時刻が日によってバラバラなため、極小の値動き（誤差レベル）まで
// 勝ち/負けとして数えると統計がブレる。しきい値未満の変動は「引き分け」として
// 集計対象から除外する（的中率の分母・分子どちらにも数えない）
var WIN_THRESHOLD_PCT=0.3;
// basePrice→nextPriceの変化率がしきい値以上なら1(上昇)/-1(下降)、しきい値未満は0(判定対象外)
function priceMoveState(basePrice,nextPrice){
  if(basePrice==null||nextPrice==null||basePrice===0) return null;
  var changePct=(nextPrice-basePrice)/basePrice*100;
  if(Math.abs(changePct)<WIN_THRESHOLD_PCT) return 0;
  return changePct>0?1:-1;
}
// ── 記録日ペアの営業日差を数える ─────────────────────────────────────────
// スキャンしない日があると「隣り合う記録」が数日離れることがあり、それを
// 「1日後の実績」として集計すると統計が汚れる。土日を除いた日数差を返し、
// 集計側で「想定の営業日差と一致するペアだけ」を採用するために使う
function bizDayDiff(dStr1,dStr2){
  var a=new Date(dStr1+"T00:00:00"),b=new Date(dStr2+"T00:00:00");
  if(isNaN(a.getTime())||isNaN(b.getTime())||b<=a) return null;
  var n=0,cur=new Date(a);
  while(cur<b){
    cur.setDate(cur.getDate()+1);
    var dw=cur.getDay();
    if(dw!==0&&dw!==6)n++;
    if(n>30)return n; // 異常に離れたペアの無限ループ防止
  }
  return n;
}
// シグナル統計が「何営業日分（何日分の記録）から作られたか」を返す
// 同じ日に多数の銘柄をスキャンすると件数だけが水増しされるため、日数でも信頼性を測る
function sigStatDays(st){
  return st&&st.dd?Object.keys(st.dd).length:0;
}

// スコア高銘柄の翌日実績を算出
// scoreHist: [{d,s,p},...] pは記録日の終値
// threshold: 対象スコア下限（デフォルト60）
// 戻り値: {winRate, total, byBand}
function calcActualWinRate(scoreHist,threshold){
  threshold=threshold||60;
  var wins=0,total=0;
  var byBand={"60":{w:0,t:0},"80":{w:0,t:0},"100":{w:0,t:0}};
  for(var i=0;i<scoreHist.length-1;i++){
    var cur=scoreHist[i],nxt=scoreHist[i+1];
    if(cur.s<threshold||cur.p==null||nxt.p==null) continue;
    if(bizDayDiff(cur.d,nxt.d)!==1) continue; // 記録が飛んだペア（数日分の値動き）は翌日実績に含めない
    var move=priceMoveState(cur.p,nxt.p);
    if(move===0) continue; // 誤差レベルの値動きは集計対象外
    var won=move>0;
    wins+=won?1:0;
    total++;
    var band=cur.s>=100?"100":cur.s>=80?"80":"60";
    byBand[band].t++;
    if(won) byBand[band].w++;
  }
  return{winRate:total>0?Math.round(wins/total*100):null,total:total,byBand:byBand};
}

// ── シグナル別的中率の検証 ─────────────────────────────────────────────
// signalsのlabelは末尾に動的な数値が付くもの(例:"RSI(35.2)")があるため、
// 基準ラベルのみ抽出して同一シグナルとして集計できるようにする
function baseSigLabel(label){return label.replace(/\([^)]*\)$/,"");}

// 現在時刻（端末のローカル時刻＝日本国内利用前提でJST）から取引時間帯ラベルを判定
// 日本株の寄り付き〜引けの目安で区切り、それ以外（米国株スキャン・時間外）は"時間外"にまとめる
var INTRADAY_SESSIONS=["寄り付き","前場","後場前半","後場後半"];
function currentSessionLabel(){
  var now=new Date();
  var mins=now.getHours()*60+now.getMinutes();
  if(mins>=9*60&&mins<10*60) return "寄り付き";
  if(mins>=10*60&&mins<11*60+30) return "前場";
  if(mins>=12*60+30&&mins<14*60) return "後場前半";
  if(mins>=14*60&&mins<15*60+30) return "後場後半";
  return "時間外";
}

// 1銘柄分のscoreHistから、シグナルごとの勝敗数をstatsに積算する
// daysAfter: 何営業日後の価格と比較するか(scoreHistの記録間隔=1エントリ想定)
function accumulateSignalStats(hist,daysAfter,stats){
  for(var i=0;i<hist.length-daysAfter;i++){
    var cur=hist[i],nxt=hist[i+daysAfter];
    if(cur.p==null||nxt.p==null||!cur.sig) continue;
    if(bizDayDiff(cur.d,nxt.d)!==daysAfter) continue; // 記録が飛んだペアは「◯日後」の実績として不正確なので除外
    var move=priceMoveState(cur.p,nxt.p);
    if(move===0) continue; // 誤差レベルの値動きは集計対象外
    var won=move>0;
    var changePct=(nxt.p-cur.p)/cur.p*100; // Dの機能：平均騰落率の算出用
    cur.sig.forEach(function(key){
      if(!stats[key])stats[key]={w:0,t:0,sumPct:0,dd:{}};
      if(!stats[key].dd)stats[key].dd={};
      stats[key].dd[cur.d]=1; // 何営業日分の記録から作られた統計かを追跡（同日水増し対策）
      stats[key].t++;
      stats[key].sumPct+=changePct;
      if(won)stats[key].w++;
    });
  }
}

// 指定tickerリストのscoreHistを横断してシグナル別的中率を算出（翌営業日判定のみ）
// 戻り値: [{signal,winRate,total}, ...] 的中率が高い順
function calcSignalAccuracy(tickers){
  var stats={};
  (tickers||[]).forEach(function(ticker){
    var hist=(function(){try{return JSON.parse(localStorage.getItem("sh_"+ticker)||"[]");}catch(e){return[];}})();
    accumulateSignalStats(hist,1,stats);
  });
  return Object.keys(stats).map(function(k){
    var s=stats[k];
    return{signal:k,winRate:s.t>0?Math.round(signalQuality(s,k)*100):null,avgPct:s.t>0?signalAvgPct(s,k):null,total:s.t};
  }).sort(function(a,b){return(b.winRate||0)-(a.winRate||0);});
}
// お気に入り登録銘柄全体で集計（お気に入りタブ用）
function calcFavSignalAccuracy(){
  var favList=(function(){try{return JSON.parse(localStorage.getItem("fav_tickers")||"[]");}catch(e){return[];}})();
  return calcSignalAccuracy(favList);
}
// シグナル別的中率を複数ホライズン（1日後/3日後/5日後）でまとめて算出
// どのシグナルがどの時間軸で当たりやすいかを見るための拡張版
var ACCURACY_HORIZONS=[1,3,5];
function calcSignalAccuracyMulti(tickers){
  var statsByH={};
  ACCURACY_HORIZONS.forEach(function(h){statsByH[h]={};});
  (tickers||[]).forEach(function(ticker){
    var hist=(function(){try{return JSON.parse(localStorage.getItem("sh_"+ticker)||"[]");}catch(e){return[];}})();
    ACCURACY_HORIZONS.forEach(function(h){accumulateSignalStats(hist,h,statsByH[h]);});
  });
  var keys={};
  ACCURACY_HORIZONS.forEach(function(h){Object.keys(statsByH[h]).forEach(function(k){keys[k]=1;});});
  return Object.keys(keys).map(function(k){
    var row={signal:k};
    ACCURACY_HORIZONS.forEach(function(h){
      var s=statsByH[h][k];
      row["d"+h]=s?{winRate:Math.round(signalQuality(s,k)*100),avgPct:signalAvgPct(s,k),total:s.t}:{winRate:null,avgPct:null,total:0};
    });
    return row;
  }).sort(function(a,b){
    var ra=a.d1.total>=5,rb=b.d1.total>=5;
    if(ra!==rb) return ra?-1:1;              // 件数5件未満（参考値）は下にまとめる
    return(b.d1.avgPct||0)-(a.d1.avgPct||0); // 期待値＝1日後の平均騰落率が高い順
  });
}
// お気に入り登録銘柄全体で集計（複数ホライズン版）
function calcFavSignalAccuracyMulti(){
  var favList=(function(){try{return JSON.parse(localStorage.getItem("fav_tickers")||"[]");}catch(e){return[];}})();
  return calcSignalAccuracyMulti(favList);
}

// ── スキャン対象銘柄全体での的中率集計（スコア重み調整・AI判定材料用）─────
// お気に入りは個人の好みで選ばれ銘柄構成に偏りが出るため、重み調整やAIへの
// 参考情報にはスキャンした銘柄全体（sh_*キー全部）を対象にする
var UNIVERSE_STATS_CACHE=null,UNIVERSE_STATS_TS=0,UNIVERSE_STATS_TTL=15*60*1000;
function getUniverseSignalStats(){
  var now=Date.now();
  if(UNIVERSE_STATS_CACHE&&now-UNIVERSE_STATS_TS<UNIVERSE_STATS_TTL) return UNIVERSE_STATS_CACHE;
  var stats={};
  try{
    Object.keys(localStorage).forEach(function(k){
      if(k.indexOf("sh_")!==0||k.indexOf("sh_intraday_")===0) return; // イントラデイ履歴の混入を防止
      if(!/\.T$/.test(k.slice(3))) return; // JP銘柄のみ（US銘柄は取引時間帯が異なり翌日統計を汚すため除外）
      var hist=JSON.parse(localStorage.getItem(k)||"[]");
      accumulateSignalStats(hist,1,stats);
    });
  }catch(e){}
  UNIVERSE_STATS_CACHE=stats;UNIVERSE_STATS_TS=now;
  return stats;
}
// ── スコア帯別（0-100点）の実績的中率集計（全スキャン銘柄横断・スコアロジック自体の検証用）──
// 「スコアが高い銘柄ほど本当に翌営業日上がりやすいか」を帯ごとに可視化する
var UNIVERSE_BAND_CACHE=null,UNIVERSE_BAND_TS=0;
var SCORE_BANDS=[{min:0,max:40,label:"〜39"},{min:40,max:60,label:"40-59"},{min:60,max:80,label:"60-79"},{min:80,max:101,label:"80+"}];
function bandLabelFor(score){
  for(var i=0;i<SCORE_BANDS.length;i++){if(score>=SCORE_BANDS[i].min&&score<SCORE_BANDS[i].max)return SCORE_BANDS[i].label;}
  return SCORE_BANDS[SCORE_BANDS.length-1].label;
}
function getUniverseBandStats(){
  var now=Date.now();
  if(UNIVERSE_BAND_CACHE&&now-UNIVERSE_BAND_TS<UNIVERSE_STATS_TTL) return UNIVERSE_BAND_CACHE;
  var stats={};
  try{
    Object.keys(localStorage).forEach(function(k){
      if(k.indexOf("sh_")!==0||k.indexOf("sh_intraday_")===0) return; // イントラデイ履歴の混入を防止
      if(!/\.T$/.test(k.slice(3))) return; // JP銘柄のみ
      var hist=JSON.parse(localStorage.getItem(k)||"[]");
      for(var i=0;i<hist.length-1;i++){
        var cur=hist[i],nxt=hist[i+1];
        if(cur.p==null||nxt.p==null) continue;
        if(bizDayDiff(cur.d,nxt.d)!==1) continue; // 記録が飛んだペアは翌日実績に含めない
        var move=priceMoveState(cur.p,nxt.p);
        if(move===0) continue; // 誤差レベルの値動きは集計対象外
        var band=bandLabelFor(cur.s);
        if(!stats[band])stats[band]={w:0,t:0};
        stats[band].t++;
        if(move>0)stats[band].w++;
      }
    });
  }catch(e){}
  UNIVERSE_BAND_CACHE=SCORE_BANDS.map(function(b){
    var s=stats[b.label]||{w:0,t:0};
    return{band:b.label,winRate:s.t>0?Math.round(s.w/s.t*100):null,total:s.t};
  });
  UNIVERSE_BAND_TS=now;
  return UNIVERSE_BAND_CACHE;
}

// ── 時間帯別（セッション別）の的中率集計（Dの機能・sh_intraday_*横断）─────
// 「その時間帯にスコア60点以上だった銘柄が、その日の（記録された最後の＝引けに近い）
// 時点までに上がっていたか」を集計する。翌営業日ではなく“その日の中”の答え合わせ。
var INTRADAY_ACC_CACHE=null,INTRADAY_ACC_TS=0;
function calcIntradayAccuracy(){
  var now=Date.now();
  if(INTRADAY_ACC_CACHE&&now-INTRADAY_ACC_TS<UNIVERSE_STATS_TTL) return INTRADAY_ACC_CACHE;
  var scoreStats={};
  INTRADAY_SESSIONS.forEach(function(s){scoreStats[s]={w:0,t:0};});
  try{
    Object.keys(localStorage).forEach(function(k){
      if(k.indexOf("sh_intraday_")!==0) return;
      var hist;try{hist=JSON.parse(localStorage.getItem(k)||"[]");}catch(e){hist=[];}
      var byDate={};
      hist.forEach(function(e){(byDate[e.d]=byDate[e.d]||[]).push(e);});
      Object.keys(byDate).forEach(function(d){
        var entries=byDate[d];
        var closeEntry=entries[entries.length-1]; // その日最後の記録＝引けに近いスナップショット
        if(closeEntry.p==null) return;
        entries.forEach(function(e){
          if(e===closeEntry||e.p==null||e.s<60) return;
          if(INTRADAY_SESSIONS.indexOf(e.session)===-1) return;
          var move=priceMoveState(e.p,closeEntry.p);
          if(move===0) return; // 誤差レベルの値動きは集計対象外
          scoreStats[e.session].t++;
          if(move>0) scoreStats[e.session].w++;
        });
      });
    });
  }catch(e){}
  INTRADAY_ACC_CACHE=INTRADAY_SESSIONS.map(function(s){
    var v=scoreStats[s];
    return{session:s,winRate:v.t>0?Math.round(v.w/v.t*100):null,total:v.t};
  });
  INTRADAY_ACC_TS=now;
  return INTRADAY_ACC_CACHE;
}
// ── 地合い別（TOPIXプラスの日/マイナスの日）シグナル的中率 ──────────────────
// scoreHistに記録し始めたctx（地合い）を使う。ctxの無い古い記録は対象外なので、
// 記録開始からデータが貯まるまでは「蓄積中」表示になる（自動で有効化される待機機能）
var REGIME_STATS_CACHE=null,REGIME_STATS_TS=0;
function getRegimeSignalStats(){
  var now=Date.now();
  if(REGIME_STATS_CACHE&&now-REGIME_STATS_TS<UNIVERSE_STATS_TTL) return REGIME_STATS_CACHE;
  var stats={up:{},down:{}};
  try{
    Object.keys(localStorage).forEach(function(k){
      if(k.indexOf("sh_")!==0||k.indexOf("sh_intraday_")===0) return;
      if(!/\.T$/.test(k.slice(3))) return; // JP銘柄のみ
      var hist;try{hist=JSON.parse(localStorage.getItem(k)||"[]");}catch(e){hist=[];}
      for(var i=0;i<hist.length-1;i++){
        var cur=hist[i],nxt=hist[i+1];
        if(cur.p==null||nxt.p==null||!cur.sig||!cur.ctx||cur.ctx.topix==null) continue;
        if(bizDayDiff(cur.d,nxt.d)!==1) continue;
        var move=priceMoveState(cur.p,nxt.p);
        if(move===0) continue;
        var bucket=cur.ctx.topix>=0?stats.up:stats.down;
        cur.sig.forEach(function(key){
          if(!bucket[key])bucket[key]={w:0,t:0};
          bucket[key].t++;
          if(move>0)bucket[key].w++;
        });
      }
    });
  }catch(e){}
  REGIME_STATS_CACHE=stats;REGIME_STATS_TS=now;
  return stats;
}
// ── 実トレード×シグナル：完了トレードの損益と、登録時に点灯していたシグナルの関係 ──
// sigKeysAtAddを保存し始めた新しいトレードだけが対象。完了トレードが貯まると自動で表示される
function calcTradeSignalStats(){
  var all=loadTrades("app").concat(loadTrades("personal"));
  var stats={};
  all.forEach(function(t){
    if(t.status!=="done"||t.pnlPercent==null||!t.sigKeysAtAdd||!t.sigKeysAtAdd.length) return;
    t.sigKeysAtAdd.forEach(function(key){
      if(!stats[key])stats[key]={w:0,t:0,sumPct:0};
      stats[key].t++;stats[key].sumPct+=t.pnlPercent;
      if(t.pnlPercent>0)stats[key].w++;
    });
  });
  return Object.keys(stats).map(function(k){
    var s=stats[k];
    return{signal:k,winRate:Math.round(s.w/s.t*100),avgPct:s.sumPct/s.t,total:s.t};
  }).sort(function(a,b){return b.winRate-a.winRate;});
}
// ── 勝敗しきい値（WIN_THRESHOLD_PCT）の検証：スコア60点以上の記録を対象に、
// しきい値を変えた場合の的中率と件数を並べて比較する（0.3%が適切かの判断材料）──
function calcThresholdCheck(){
  var thrs=[0.1,0.3,0.5,0.8];
  var acc=thrs.map(function(){return{w:0,t:0};});
  try{
    Object.keys(localStorage).forEach(function(k){
      if(k.indexOf("sh_")!==0||k.indexOf("sh_intraday_")===0) return;
      if(!/\.T$/.test(k.slice(3))) return; // JP銘柄のみ
      var hist;try{hist=JSON.parse(localStorage.getItem(k)||"[]");}catch(e){hist=[];}
      for(var i=0;i<hist.length-1;i++){
        var cur=hist[i],nxt=hist[i+1];
        if(cur.p==null||nxt.p==null||cur.s==null||cur.s<60) continue;
        if(bizDayDiff(cur.d,nxt.d)!==1) continue;
        var chg=(nxt.p-cur.p)/cur.p*100;
        thrs.forEach(function(thr,idx){
          if(Math.abs(chg)<thr) return;
          acc[idx].t++;
          if(chg>0)acc[idx].w++;
        });
      }
    });
  }catch(e){}
  return thrs.map(function(thr,idx){
    var a=acc[idx];
    return{thr:thr,winRate:a.t>0?Math.round(a.w/a.t*100):null,total:a.t};
  });
}
// ── データ管理（バックアップ/復元/掃除）───────────────────────────────────
// iPadのSafariはストレージ圧迫時などにlocalStorageを消すことがあるため、
// 学習データ（スコア履歴・地合い・トレード記録）をJSONファイルに書き出して守る
function exportAllData(){
  try{
    var data={};
    Object.keys(localStorage).forEach(function(k){data[k]=localStorage.getItem(k);});
    var blob=new Blob([JSON.stringify(data)],{type:"application/json"});
    var a=document.createElement("a");
    a.href=URL.createObjectURL(blob);
    a.download="daytrade_backup_"+new Date().toISOString().slice(0,10)+".json";
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    setTimeout(function(){URL.revokeObjectURL(a.href);},2000);
  }catch(e){alert("書き出しに失敗しました: "+e.message);}
}
function importAllData(file){
  var reader=new FileReader();
  reader.onload=function(){
    try{
      var data=JSON.parse(reader.result);
      var keys=Object.keys(data);
      if(!keys.length){alert("ファイルにデータがありません");return;}
      if(!window.confirm("バックアップから"+keys.length+"件のデータを復元します。現在のデータは上書きされます。よろしいですか？"))return;
      keys.forEach(function(k){try{localStorage.setItem(k,data[k]);}catch(e){}});
      alert("復元しました。ページを再読み込みします");
      window.location.reload();
    }catch(e){alert("復元に失敗しました: 正しいバックアップファイルか確認してください");}
  };
  reader.readAsText(file);
}
function cleanupOldData(){
  if(!window.confirm("90日以上更新のない銘柄の履歴データ（スコア履歴・AI予想記録）を削除します。よろしいですか？"))return;
  var cutoff=new Date(Date.now()-90*24*60*60*1000).toISOString().slice(0,10);
  var removed=0;
  try{
    Object.keys(localStorage).forEach(function(k){
      if(k.indexOf("sh_")!==0&&k.indexOf("aipred_")!==0) return;
      var list;try{list=JSON.parse(localStorage.getItem(k)||"[]");}catch(e){return;}
      if(!list.length){localStorage.removeItem(k);removed++;return;}
      var lastD=list[list.length-1].d;
      if(lastD&&lastD<cutoff){localStorage.removeItem(k);removed++;}
    });
  }catch(e){}
  alert(removed?("90日以上更新のない銘柄データを"+removed+"件削除しました"):"削除対象はありませんでした");
}
// シグナルの方向（強気/弱気/中立）を踏まえた「精度」を0〜1で返す共通関数。
// 弱気(state=-1)シグナルは「翌営業日に上がらなかった率」、それ以外は「上がった率」が精度の目安。
// （画面の的中率表示・スコアの重み調整・AIへの参考情報、すべてここを通す）
function signalQuality(stat,sigKey){
  var state=parseInt(sigKey.split("#")[1],10);
  var winRate=stat.w/stat.t;
  return state===-1?(1-winRate):winRate;
}
// シグナルの向き通りに動いた場合の平均リターン（%）。Dの機能。
// 弱気(state=-1)シグナルは「下落率」がプラス材料なので符号を反転し、
// 「そのシグナル通りに動いたら何%取れたか」に統一して返す
function signalAvgPct(stat,sigKey){
  if(!stat||!stat.t) return null;
  var state=parseInt(sigKey.split("#")[1],10);
  var avg=stat.sumPct/stat.t;
  return state===-1?-avg:avg;
}
// ── 期待値マイナス警告（⚠️）─────────────────────────────────────────────
// 件数が十分あるのに平均騰落率がマイナス＝「勝率は高いが小さく勝って大きく負ける」
// シグナルを見つけるための判定。スコアには一切影響せず、画面表示のみに使う
var EXPECTANCY_MIN_SAMPLES=10;
function isNegExpectancy(c){
  return !!(c&&c.total>=EXPECTANCY_MIN_SAMPLES&&c.avgPct!=null&&c.avgPct<0);
}
// 詳細パネル用：点灯中シグナル1件が「期待値マイナス（勝率の罠）」かを判定。
// 重み付けと同じ全体統計（JP銘柄・翌営業日ベース）を参照する。
// 中立シグナルは方向を予想していないため対象外。5営業日分未満は水増しの恐れがあり除外
function isSigNegExpectancy(sig){
  if(!sig||!sig.state) return false;
  var key=baseSigLabel(sig.label)+"#"+sig.state;
  var s=getUniverseSignalStats()[key];
  if(!s||s.t<EXPECTANCY_MIN_SAMPLES||sigStatDays(s)<5) return false;
  var avg=signalAvgPct(s,key);
  return avg!=null&&avg<0;
}
// ── 統計ベースの未来予想（🔮パネル用）──────────────────────────────────────
// 点灯中シグナルの過去実績（平均騰落率・上昇率）を件数で重み付け平均して
// 「期待変化率」と「上昇確率の目安」を返す。サンプル10件未満のシグナルは除外し、
// 有効シグナルが3種類未満の間は ready:false（＝データ蓄積中の表示）を返す
var FORECAST_MIN_SAMPLES=10,FORECAST_MIN_SIGNALS=3,FORECAST_WEIGHT_CAP=30;
function calcStatForecast(signals,stats){
  var sumW=0,sumMove=0,sumUp=0,used=0,totalN=0;
  (signals||[]).forEach(function(x){
    var key=baseSigLabel(x.label)+"#"+x.state;
    var st=stats[key];
    if(!st||st.t<FORECAST_MIN_SAMPLES||sigStatDays(st)<5) return; // 件数不足 or 5営業日分未満は除外
    var w=Math.min(st.t,FORECAST_WEIGHT_CAP); // 特定シグナルだけが極端に効きすぎないよう重みに上限
    sumW+=w;totalN+=st.t;used++;
    sumMove+=(st.sumPct/st.t)*w;
    sumUp+=(st.w/st.t)*w;
  });
  if(used<FORECAST_MIN_SIGNALS||sumW===0) return{ready:false,used:used,totalN:totalN};
  return{ready:true,used:used,totalN:totalN,expPct:sumMove/sumW,upRate:Math.round(sumUp/sumW*100)};
}
// 今日版（引けまで）用：sh_intraday_全体から「各時間帯のスナップショット→同日最後の記録」への
// 変化率をシグナル別に積算する（getUniverseSignalStatsのイントラデイ版・キャッシュ付き）
var INTRADAY_SIG_CACHE=null,INTRADAY_SIG_TS=0;
function getIntradaySignalStats(){
  var now=Date.now();
  if(INTRADAY_SIG_CACHE&&now-INTRADAY_SIG_TS<UNIVERSE_STATS_TTL) return INTRADAY_SIG_CACHE;
  var stats={};
  try{
    Object.keys(localStorage).forEach(function(k){
      if(k.indexOf("sh_intraday_")!==0) return;
      var hist;try{hist=JSON.parse(localStorage.getItem(k)||"[]");}catch(e){hist=[];}
      var byDate={};
      hist.forEach(function(e){(byDate[e.d]=byDate[e.d]||[]).push(e);});
      Object.keys(byDate).forEach(function(d){
        var entries=byDate[d];
        var closeEntry=entries[entries.length-1]; // その日最後の記録＝引けに近いスナップショット
        if(closeEntry.p==null) return;
        entries.forEach(function(e){
          if(e===closeEntry||e.p==null||!e.sig) return;
          var move=priceMoveState(e.p,closeEntry.p);
          if(move===0) return; // 誤差レベルの値動きは集計対象外
          var changePct=(closeEntry.p-e.p)/e.p*100;
          e.sig.forEach(function(key){
            if(!stats[key])stats[key]={w:0,t:0,sumPct:0,dd:{}};
            if(!stats[key].dd)stats[key].dd={};
            stats[key].dd[e.d]=1; // 何営業日分の記録かを追跡（同日水増し対策）
            stats[key].t++;stats[key].sumPct+=changePct;
            if(move>0)stats[key].w++;
          });
        });
      });
    });
  }catch(e){}
  INTRADAY_SIG_CACHE=stats;INTRADAY_SIG_TS=now;
  return stats;
}
// シグナル1件分の重み係数（1.0=調整なし、0=ミュート）。
// サンプル10件未満 または 5営業日分未満 は調整なし（同日に多銘柄スキャンした水増し対策）
// 10〜19件は最大±10%／20件以上は最大±20%
// 30件以上あって的中率45%未満のシグナルは「ノイズ」と判断し配点ゼロ（自動ミュート）
function getSignalWeight(sigKey){
  var s=getUniverseSignalStats()[sigKey];
  if(!s||s.t<10||sigStatDays(s)<5) return 1;
  var quality=signalQuality(s,sigKey);
  if(s.t>=30&&quality<0.45) return 0; // 自動ミュート
  var maxAdjust=s.t>=20?0.2:0.1;
  var mult=1+(quality-0.5)*2*maxAdjust;
  return Math.max(1-maxAdjust,Math.min(1+maxAdjust,mult));
}
// breakdown表示名 → 実際に積み上がるシグナルラベル群のマッピング（重み適用用）
var CATEGORY_SIGNAL_MAP={
  "VWAP":["VWAP"],"VWAP傾き":["VWAP傾き"],"Pivot":["Pivot"],"ATR(値幅)":["ATR"],"ATR消化率":["ATR消化率"],"対TOPIX":["対TOPIX"],
  "トレンド":["トレンド","上位足一致(5本毎)","上位足一致(15本毎)"],"EMA整列":["EMA整列"],
  "MACD":["MACD"],"RSI":["RSI"],"BB":["BB","BB収束"],"Stoch":["Stoch"],
  "出来高/OBV":["OBV","出来高"],
  "ギャップ":["ギャップ"],"当日ブレイク":["当日ブレイク"],"寄り付きレンジ":["寄り付きレンジ"],"コンフルエンス":["コンフルエンス"]
};
// 過去の的中率に基づき、breakdownカテゴリごとの点数を補正する
function applySignalWeights(sc,signals,breakdown){
  var adjust=0;
  breakdown.forEach(function(b){
    var labels=CATEGORY_SIGNAL_MAP[b.label];
    if(!labels||!b.delta) return;
    var fired=signals.filter(function(sig){return labels.indexOf(baseSigLabel(sig.label))>=0;});
    if(!fired.length) return;
    var mults=fired.map(function(sig){return getSignalWeight(baseSigLabel(sig.label)+"#"+sig.state);});
    var avgMult=mults.reduce(function(a,b){return a+b;},0)/mults.length;
    adjust+=b.delta*(avgMult-1);
  });
  return sc+adjust;
}
// ブラウザのコンソールから確認できるように公開（例: getSignalAccuracy()）
if(typeof window!=="undefined"){
  window.getSignalAccuracy=function(){return calcFavSignalAccuracy();};
}
// ──────────────────────────────────────────────────────────────────────

function analyzeStock(stock,pd,vixVal){
  var closes=pd.closes.slice(),highs=pd.highs.slice(),lows=pd.lows.slice();
  var volumes=pd.volumes?pd.volumes.slice():[];
  var n=closes.length-1;
  // ── 足種別パラメータ切替 ──────────────────────────────────────────────────
  var isJP=stock.market==="JP";
  // デイトレ対応：JP/US共に15分足に統一（取引時間が約6.5時間で揃うため1日≒26本で共通化）
  // JP: J-Quantsの1分足をサーバー側(api/stock.js)で15分足に集計 / US: Yahoo Financeから15分足を直接取得
  var DAY_BARS   =26;   // 1日あたりのバー数
  var BB_P       =520;  // 20日相当(26本×20日)
  var RECENT_BARS=520;  // 20日相当
  var BB_LOOKBACK_S=130;// short: 約5日相当
  var BB_LOOKBACK_M=260;// mid:   約10日相当
  var BB_LOOKBACK_L=520;// stable: 約20日相当
  var YEAR_BARS=closes.length;     // 取得全期間を52週相当として使用
  // ───────────────────────────────────────────────────────────────────────
  var macdArr=calcMACD(closes),rsiVal=calcRSI(closes)[n];
  var bollVal=calcBoll(closes)[n],stochVal=calcStoch(closes,highs,lows)[n];
  var mNow=macdArr[n],mPrev=macdArr[n-1],price=pd.currentPrice||closes[n];
  var sc=0,signals=[];
  var breakdown=[],scChk=0; // ── スコア内訳（どの項目が何点効いたか）記録用 ──

  // ── ATR（値幅）算出 ─────────────────────────────────────────────────────
  var atrRaw=calcATR(closes,highs,lows,14);
  var atr=atrRaw!=null?Math.round(atrRaw):Math.round(price*0.02);
  var atrPct=price>0?(atr/price*100):0;

  // ── 当日データの切り出し（dates配列から本日分の開始インデックスを特定）────
  // 取引時間中は当日のバーがまだ26本(DAY_BARS)に満たないため、日付一致で
  // 厳密に「本日分」だけを取り出す（固定本数での近似だと前日分が混入するため）
  // ギャップ・当日ブレイク・VWAP傾きの各シグナルで共通して使う
  var todayStart=null;
  var sessionStarted=true; // 今日の足が1本でもあるか（寄り付き前ならfalse）
  if(pd.dates&&pd.dates.length===closes.length&&pd.dates.length>0){
    var lastD=pd.dates[pd.dates.length-1];
    // 取得データの最終日付が「今日」でなければ、まだ寄り付いていない（or 休場）
    sessionStarted=(lastD===currentSessionDate(stock.market));
    if(sessionStarted){
      for(var di2=pd.dates.length-1;di2>=0;di2--){
        if(pd.dates[di2]!==lastD){todayStart=di2+1;break;}
      }
      if(todayStart===null) todayStart=0; // 全データが同一日（データ不足時のフォールバック）
    }
  }

  // ── VWAP・ピボット計算 ─────────────────────────────────────────────────────
  // VWAPは「当日分のみ」で算出する（デイトレの押し目基準にするため）。
  // 全期間累積だと数日前の値を引きずり、チャート上のVWAPとズレるため。
  var vwap=null;
  if(volumes.length>0&&sessionStarted){
    if(todayStart!==null&&n-todayStart>=1){
      vwap=calcVWAP(closes.slice(todayStart),highs.slice(todayStart),lows.slice(todayStart),volumes.slice(todayStart));
    }
    if(vwap===null) vwap=calcVWAP(closes,highs,lows,volumes); // 当日データが取れない時のみ従来通り
  }
  var pivot=calcPivot(closes,highs,lows);

  // ── VWAP シグナル（メイン・最大15点）────────────────────────────────────
  if(vwap!==null){
    var vwapDiff=(price-vwap)/vwap*100;
    if(price>vwap&&vwapDiff<=1.0){sc+=15;signals.push({label:"VWAP",val:"上抜け直後",state:1});}
    else if(price>vwap){sc+=8;signals.push({label:"VWAP",val:"上方乖離(+"+vwapDiff.toFixed(1)+"%)",state:1});}
    else if(price<vwap&&vwapDiff>=-1.0){sc+=10;signals.push({label:"VWAP",val:"下抜け直後",state:-1});}
    else{sc-=8;signals.push({label:"VWAP",val:"下方乖離("+vwapDiff.toFixed(1)+"%)",state:-1});}
  }
  breakdown.push({label:"VWAP",delta:sc-scChk});scChk=sc;

  // ── VWAP傾き（補助・最大6点）────────────────────────────────────────────
  // 「本日分」のバーだけを使って直近4本(約1時間)前のVWAPと比較する。
  // 全期間累積のVWAPだと1日分の傾きはほぼ動かないため、本日データに限定する。
  // 価格がVWAPより上でも、VWAP自体が下降中なら勢いは弱いとみなし加点を抑える。
  var VWAP_SLOPE_LOOKBACK=4;
  if(todayStart!==null&&vwap!==null&&n-todayStart>=VWAP_SLOPE_LOOKBACK){
    var vwapPrev=calcVWAP(closes.slice(todayStart,n+1-VWAP_SLOPE_LOOKBACK),highs.slice(todayStart,n+1-VWAP_SLOPE_LOOKBACK),lows.slice(todayStart,n+1-VWAP_SLOPE_LOOKBACK),volumes.slice(todayStart,n+1-VWAP_SLOPE_LOOKBACK));
    if(vwapPrev!==null&&vwapPrev>0){
      var vwapSlopePct=(vwap-vwapPrev)/vwapPrev*100;
      var aboveVwap=price>vwap;
      if(vwapSlopePct>=0.15){sc+=aboveVwap?6:2;signals.push({label:"VWAP傾き",val:"上昇中(+"+vwapSlopePct.toFixed(2)+"%)",state:1});}
      else if(vwapSlopePct<=-0.15){sc-=aboveVwap?4:2;signals.push({label:"VWAP傾き",val:"下降中("+vwapSlopePct.toFixed(2)+"%)",state:-1});}
      else{signals.push({label:"VWAP傾き",val:"横ばい",state:0});}
    }
  }
  breakdown.push({label:"VWAP傾き",delta:sc-scChk});scChk=sc;

  // ── Pivotポイント シグナル（補助・最大5点）─────────────────────────────
  if(pivot!==null){
    if(price>pivot.r1){sc-=3;signals.push({label:"Pivot",val:"R1上抜け(過熱)",state:-1});}
    else if(price>pivot.pp&&price<=pivot.r1){sc+=5;signals.push({label:"Pivot",val:"PP〜R1(上昇ゾーン)",state:1});}
    else if(price>=pivot.s1&&price<=pivot.pp){sc+=3;signals.push({label:"Pivot",val:"S1〜PP(中立)",state:0});}
    else{sc-=4;signals.push({label:"Pivot",val:"S1下(弱気)",state:-1});}
  }
  breakdown.push({label:"Pivot",delta:sc-scChk});scChk=sc;

  // ── ATR シグナル（値幅フィルター・新規・最大10点）───────────────────────
  if(atrPct>=0.15){sc+=10;signals.push({label:"ATR",val:"値幅十分("+atrPct.toFixed(2)+"%)",state:1});}
  else if(atrPct>=0.08){sc+=5;signals.push({label:"ATR",val:"値幅やや小("+atrPct.toFixed(2)+"%)",state:0});}
  else{sc-=5;signals.push({label:"ATR",val:"値幅不足("+atrPct.toFixed(2)+"%)",state:-1});}
  breakdown.push({label:"ATR(値幅)",delta:sc-scChk});scChk=sc;
  // ────────────────────────────────────────────────────────────────────────────

  // ── ATR消化率（補助・最大-8点）───────────────────────────────────────────
  // 本日の値幅(高値-安値)がATR(14)の何%に達しているかを見る。既に値幅の大部分を
  // 使い切っている場合、その日のうちにさらに同方向へ伸びる余地は乏しく、
  // 高値掴み・追いかけ買いのリスクが高いと判断してスコアを抑える（ボーナスは付けない）
  if(todayStart!==null&&atr>0){
    var tHighsAtr=highs.slice(todayStart,n+1),tLowsAtr=lows.slice(todayStart,n+1);
    if(tHighsAtr.length>0){
      var todayRange=Math.max.apply(null,tHighsAtr)-Math.min.apply(null,tLowsAtr);
      var atrUsedPct=todayRange/atr*100;
      if(atrUsedPct>=130){sc-=8;signals.push({label:"ATR消化率",val:"消化"+atrUsedPct.toFixed(0)+"%(過熱・追随危険)",state:-1});}
      else if(atrUsedPct>=90){sc-=4;signals.push({label:"ATR消化率",val:"消化"+atrUsedPct.toFixed(0)+"%(値幅使い切り注意)",state:-1});}
      else if(atrUsedPct>=50){signals.push({label:"ATR消化率",val:"消化"+atrUsedPct.toFixed(0)+"%(順調)",state:0});}
      else{signals.push({label:"ATR消化率",val:"消化"+atrUsedPct.toFixed(0)+"%(値幅余地あり)",state:0});}
    }
  }
  breakdown.push({label:"ATR消化率",delta:sc-scChk});scChk=sc;

  var change=pd.previousClose?((price-pd.previousClose)/pd.previousClose*100).toFixed(2):"0.00";

  // ── 対TOPIX相対強弱（日本株限定・最大6点）───────────────────────────────
  // 個別銘柄の当日騰落率からTOPIXの当日騰落率を引いた差分。市場全体の地合いを
  // 除いた「銘柄固有の強さ」を測る補助シグナル（過信厳禁、あくまで参考値）
  var topixChange=(stock.market==="JP"&&pd.topixChange!=null)?pd.topixChange:null;
  var relStrength=topixChange!=null?(parseFloat(change)-topixChange):null;
  if(relStrength!=null){
    if(relStrength>=1.5){sc+=6;signals.push({label:"対TOPIX",val:"市場より強い(+"+relStrength.toFixed(1)+"%)",state:1});}
    else if(relStrength>=0.5){sc+=3;signals.push({label:"対TOPIX",val:"やや市場より強い(+"+relStrength.toFixed(1)+"%)",state:1});}
    else if(relStrength<=-1.5){sc-=6;signals.push({label:"対TOPIX",val:"市場より弱い("+relStrength.toFixed(1)+"%)",state:-1});}
    else if(relStrength<=-0.5){sc-=3;signals.push({label:"対TOPIX",val:"やや市場より弱い("+relStrength.toFixed(1)+"%)",state:-1});}
    else{signals.push({label:"対TOPIX",val:"市場並み("+relStrength.toFixed(1)+"%)",state:0});}
  }
  breakdown.push({label:"対TOPIX",delta:sc-scChk});scChk=sc;
  // ────────────────────────────────────────────────────────────────────────────

  // ── 対業種相対強弱（日本株限定・参考表示のみ、スコアには加算しない）──────
  // 個別銘柄の当日騰落率から、その銘柄が属する業種の平均騰落率を引いた差分。
  // 「市場全体」ではなく「同業他社」との比較で相対的な強さ・弱さを見るための補助情報。
  var sectorChange=(stock.market==="JP"&&pd.sectorChange!=null)?pd.sectorChange:null;
  var sectorName=stock.market==="JP"?(pd.sectorName||null):null;
  var sectorRelStrength=sectorChange!=null?(parseFloat(change)-sectorChange):null;
  // ────────────────────────────────────────────────────────────────────────────

  var dispPrice=stock.market==="JP"?"¥"+Math.round(price).toLocaleString():"$"+price.toFixed(2);
  // 52週相当: 60日分データの全体を使用
  var yearData=closes.slice(-YEAR_BARS);
  var high52=yearData.length>0?Math.max.apply(null,yearData):price;
  var low52=yearData.length>0?Math.min.apply(null,yearData):price;
  var fromHigh=high52>0?((price-high52)/high52*100):0;
  var fromLow=low52>0?((price-low52)/low52*100):0;
  var range52=high52-low52||1;
  var position52=((price-low52)/range52*100);
  var yearRange=high52>0?(high52-low52)/low52*100:0; // 52週高安レンジ(%)。ボラティリティ種別判定に使用
  var absChange=Math.abs(parseFloat(change)); // 前日比(%)の絶対値。同上

  // ── ボラティリティ種別判定（BB収束lookback選択・トレードタイプ表示ラベルの両方で使用）──
  // デイトレ対応：avgBarChangeは足の粒度に依存するため15分足基準に再調整（旧: short>=2% mid>=1%）
  // yearRange・absChangeは日次/期間ベースの指標のため足種変更の影響を受けず、閾値はそのまま
  var recentC=closes.slice(-RECENT_BARS);
  var avgBarChange=0;
  if(recentC.length>1){var tc=0;for(var di=1;di<recentC.length;di++)tc+=Math.abs((recentC[di]-recentC[di-1])/recentC[di-1]*100);avgBarChange=tc/(recentC.length-1);}
  var volType=yearRange>=60||avgBarChange>=1.0||absChange>=5?"short":yearRange>=25||avgBarChange>=0.5||absChange>=2?"mid":"stable";
  var bbLookback=volType==="short"?BB_LOOKBACK_S:volType==="mid"?BB_LOOKBACK_M:BB_LOOKBACK_L;

  // ── トレンド（メイン・最大18点）：直近の勢い(8点)＋上位足一致(10点)────
  var emaFast5=calcEMA(closes,5),emaFast13=calcEMA(closes,13);
  var trendDirNow=emaFast5[n]>emaFast13[n]?1:(emaFast5[n]<emaFast13[n]?-1:0);
  if(trendDirNow===1){sc+=8;signals.push({label:"トレンド",val:"上昇",state:1});}
  else if(trendDirNow===-1){sc-=6;signals.push({label:"トレンド",val:"下降",state:-1});}
  else{sc+=2;signals.push({label:"トレンド",val:"横ばい",state:0});}
  var dir5=resampleDir(closes,5),dir15=resampleDir(closes,15);
  if(trendDirNow===1&&dir5===1){sc+=5;signals.push({label:"上位足一致(5本毎)",val:"上昇一致",state:1});}
  if(trendDirNow===1&&dir15===1){sc+=5;signals.push({label:"上位足一致(15本毎)",val:"上昇一致",state:1});}
  if(trendDirNow===-1&&dir5===-1){sc-=3;signals.push({label:"上位足一致(5本毎)",val:"下降一致",state:-1});}
  if(trendDirNow===-1&&dir15===-1){sc-=3;signals.push({label:"上位足一致(15本毎)",val:"下降一致",state:-1});}
  breakdown.push({label:"トレンド",delta:sc-scChk});scChk=sc;

  // ── EMA多重整列（補助・最大8点）─────────────────────────────────────────
  // EMA5・EMA20・EMA60の並び順を見る。短期>中期>長期の順に並んでいれば
  // 「押し目待ちの上昇トレンド」として信頼度が高い。逆順は下降の継続を示唆
  var emaMid20=calcEMA(closes,20),emaSlow60=calcEMA(closes,60);
  var e5v=emaFast5[n],e20v=emaMid20[n],e60v=emaSlow60[n];
  if(e5v>e20v&&e20v>e60v){sc+=8;signals.push({label:"EMA整列",val:"完全上昇整列(5>20>60)",state:1});}
  else if(e5v<e20v&&e20v<e60v){sc-=6;signals.push({label:"EMA整列",val:"完全下降整列(5<20<60)",state:-1});}
  else{signals.push({label:"EMA整列",val:"整列なし(もつれ)",state:0});}
  breakdown.push({label:"EMA整列",delta:sc-scChk});scChk=sc;


  // ── MACD（補助・最大4点）───────────────────────────────────────────────
  if(mNow.hist>0&&mPrev&&mPrev.hist<=0){sc+=4;signals.push({label:"MACD",val:"ゴールデンクロス",state:1});}
  else if(mNow.hist>0){sc+=2;signals.push({label:"MACD",val:"強気ゾーン",state:1});}
  else if(mNow.hist<0&&mPrev&&mPrev.hist>=0){sc-=4;signals.push({label:"MACD",val:"デッドクロス",state:-1});}
  else{sc-=2;signals.push({label:"MACD",val:"弱気ゾーン",state:-1});}
  breakdown.push({label:"MACD",delta:sc-scChk});scChk=sc;

  // ── RSI（補助・最大8点）────────────────────────────────────────────────
  var rl="RSI("+rsiVal.toFixed(1)+")";
  if(rsiVal<30){sc+=8;signals.push({label:rl,val:"売られすぎ",state:1});}
  else if(rsiVal<40){sc+=6;signals.push({label:rl,val:"やや売られ",state:1});}
  else if(rsiVal<50){sc+=4;signals.push({label:rl,val:"やや弱め",state:0});}
  else if(rsiVal<60){sc+=2;signals.push({label:rl,val:"中立",state:0});}
  else if(rsiVal<70){sc+=1;signals.push({label:rl,val:"やや強め",state:0});}
  else{sc-=3;signals.push({label:rl,val:"買われすぎ",state:-1});}
  breakdown.push({label:"RSI",delta:sc-scChk});scChk=sc;

  // ── BB位置（最大8点）+ BB収束ボーナス（最大7点）────────────────────────
  var bbSqueeze=false;
  if(bollVal){
    var bbPos=(closes[n]-bollVal.lower)/(bollVal.upper-bollVal.lower||1);
    if(price<=bollVal.lower){sc+=8;signals.push({label:"BB",val:"下限→反発",state:1});}
    else if(bbPos<0.2){sc+=5;signals.push({label:"BB",val:"下限付近",state:1});}
    else if(price>=bollVal.upper){sc-=6;signals.push({label:"BB",val:"上限→過熱",state:-1});}
    else if(bbPos>0.8){sc+=1;signals.push({label:"BB",val:"上限付近",state:0});}
    else{sc+=3;signals.push({label:"BB",val:"バンド内",state:0});}

    // BB収束検知（トレードタイプ別日数）
    var bollArr=calcBoll(closes);
    var recentBW=[];
    for(var bi=n-bbLookback+1;bi<=n;bi++){
      if(bollArr[bi]){recentBW.push(bollArr[bi].upper-bollArr[bi].lower);}
    }
    if(recentBW.length>=3){
      var bwAvg=recentBW.reduce(function(a,b){return a+b;})/recentBW.length;
      var bwNow=bollVal.upper-bollVal.lower;
      var bwRatio=bwNow/bwAvg;
      if(bwRatio<=0.7){sc+=7;bbSqueeze=true;signals.push({label:"BB収束",val:"強収束("+Math.round(bwRatio*100)+"%)",state:1});}
      else if(bwRatio<=0.85){sc+=4;bbSqueeze=true;signals.push({label:"BB収束",val:"収束中("+Math.round(bwRatio*100)+"%)",state:1});}
      else if(bwRatio>=1.3){signals.push({label:"BB収束",val:"拡大中",state:-1});}
      else{signals.push({label:"BB収束",val:"平常("+Math.round(bwRatio*100)+"%)",state:0});}
    }
  }
  breakdown.push({label:"BB",delta:sc-scChk});scChk=sc;

  // ── Stoch（補助・最大6点）──────────────────────────────────────────────
  if(stochVal!==null){
    var sl="Stoch("+stochVal.toFixed(1)+")";
    if(stochVal<20){sc+=6;signals.push({label:sl,val:"売られすぎ",state:1});}
    else if(stochVal<35){sc+=4;signals.push({label:sl,val:"やや売られ",state:1});}
    else if(stochVal>80){sc-=4;signals.push({label:sl,val:"買われすぎ",state:-1});}
    else if(stochVal>65){sc+=2;signals.push({label:sl,val:"やや強め",state:0});}
    else{sc+=3;signals.push({label:sl,val:"中立",state:0});}
  }
  breakdown.push({label:"Stoch",delta:sc-scChk});scChk=sc;

  // ── シグナル重複ボーナス（最大4点・2階層でシンプルに）────────────────
  var overlapLabels=[];
  var hasRSIOversold=signals.find(function(sig){return sig.label.startsWith("RSI")&&(sig.val==="売られすぎ"||sig.val==="やや売られ");});
  var hasBBLow=signals.find(function(sig){return sig.label==="BB"&&(sig.val==="下限→反発"||sig.val==="下限付近");});
  var hasStochOversold=signals.find(function(sig){return sig.label.startsWith("Stoch")&&(sig.val==="売られすぎ"||sig.val==="やや売られ");});
  var hasTrendUp=signals.find(function(sig){return sig.label==="トレンド"&&sig.val==="上昇";});
  var hasGC=signals.find(function(sig){return sig.label==="MACD"&&sig.val==="ゴールデンクロス";});
  var hasDC=signals.find(function(sig){return sig.label==="MACD"&&sig.val==="デッドクロス";});
  var hasBearTrend=signals.find(function(sig){return sig.label==="トレンド"&&sig.val==="下降";});
  var overlap=0;

  var oversoldCount=(hasRSIOversold?1:0)+(hasBBLow?1:0)+(hasStochOversold?1:0);
  if(oversoldCount>=3){overlap=4;overlapLabels.push("RSI+BB+Stoch一致");}
  else if(oversoldCount>=2){overlap=2;overlapLabels.push("2指標一致");}

  sc=sc+overlap;
  breakdown.push({label:"重複ボーナス",delta:sc-scChk});scChk=sc;

  // ── 出来高・OBV（メイン・最大15点）───────────────────────────────────
  var obScore=0;
  // OBV: 直近1日分のバーの終値位置平均で判定
  var obvBars=Math.min(DAY_BARS,n+1);
  var cpSum=0;
  for(var oi=n-obvBars+1;oi<=n;oi++){var dr=highs[oi]-lows[oi]||1;cpSum+=(closes[oi]-lows[oi])/dr;}
  var closePosition=cpSum/obvBars;
  if(closePosition>=0.8){obScore+=7;signals.push({label:"OBV",val:"買い優勢",state:1});}
  else if(closePosition>=0.6){obScore+=4;signals.push({label:"OBV",val:"やや買い優勢",state:1});}
  else if(closePosition<=0.2){obScore-=6;signals.push({label:"OBV",val:"売り優勢",state:-1});}
  else if(closePosition<=0.4){obScore-=3;signals.push({label:"OBV",val:"やや売り優勢",state:-1});}
  else{signals.push({label:"OBV",val:"中立",state:0});}

  // 出来高: 直近5日分合計 vs 長期20日平均（同期間）で比較
  if(volumes.length>0){
    var volDay5=DAY_BARS*5,volDay20=DAY_BARS*20;
    var recentSum=volumes.slice(-volDay5).reduce(function(a,b){return a+b;},0);
    var longVols=volumes.slice(-volDay20,-volDay5);
    var avgSum=longVols.length>0?longVols.reduce(function(a,b){return a+b;},0)/longVols.length*volDay5:0;
    var surge=avgSum>0?recentSum/avgSum:1;
    if(surge>=2.0){
      obScore+=(closePosition>=0.6?8:closePosition<=0.4?-8:2);
      signals.push({label:"出来高",val:surge.toFixed(1)+"倍"+(closePosition>=0.6?"(買い)":closePosition<=0.4?"(売り)":"(中立)"),state:closePosition>=0.6?1:closePosition<=0.4?-1:0});
    }else if(surge>=1.5){obScore+=3;signals.push({label:"出来高",val:"やや増加("+surge.toFixed(1)+"倍)",state:1});}
    else if(surge>=0.8){signals.push({label:"出来高",val:"平常("+surge.toFixed(1)+"倍)",state:0});}
    else{obScore-=2;signals.push({label:"出来高",val:"低調("+surge.toFixed(1)+"倍)",state:-1});}
  }else{
    signals.push({label:"出来高",val:"データなし",state:0});
  }
  sc=sc+obScore;
  breakdown.push({label:"出来高/OBV",delta:sc-scChk});scChk=sc;

  // ── 寄り付きギャップ（補助・最大5点）───────────────────────────────────
  // 当日始値が前日終値からどれだけ離れて始まったか。さらに「ギャップを維持
  // しているか(モメンタム継続)／埋めに来ているか(反転警戒)」も合わせて判定
  if(todayStart!==null&&pd.opens&&pd.opens[todayStart]>0){
    var todayOpen=pd.opens[todayStart];
    var gapPct=pd.previousClose?((todayOpen-pd.previousClose)/pd.previousClose*100):0;
    var holdPct=todayOpen?((price-todayOpen)/todayOpen*100):0;
    if(gapPct>=1.5){
      if(holdPct>=-0.3){sc+=5;signals.push({label:"ギャップ",val:"上ギャップ維持(+"+gapPct.toFixed(1)+"%)",state:1});}
      else{sc-=3;signals.push({label:"ギャップ",val:"上ギャップ失速(埋め警戒)",state:-1});}
    }else if(gapPct<=-1.5){
      if(holdPct<=0.3){sc-=5;signals.push({label:"ギャップ",val:"下ギャップ継続("+gapPct.toFixed(1)+"%)",state:-1});}
      else{sc+=3;signals.push({label:"ギャップ",val:"下ギャップ埋め戻し",state:1});}
    }else{
      signals.push({label:"ギャップ",val:"ギャップなし",state:0});
    }
    // ── ギャップ過熱（配点0・観測用）────────────────────────────────
    // 検証（60分足2年×3回）で「+2%超で寄り付いた日は日中失速しやすい」傾向が一貫して出たため、
    // まず配点ゼロのシグナルとして搭載し、的中率パネルで実績を観測する。
    // 効くと確認できたら配点する（既存の実績反映調整・自動ミュートの枠組みに乗る）
    if(gapPct>=2){signals.push({label:"ギャップ過熱",val:"+"+gapPct.toFixed(1)+"%で寄り付き(日中失速警戒)",state:-1});}
  }
  breakdown.push({label:"ギャップ",delta:sc-scChk});scChk=sc;

  // ── 当日高安ブレイク（補助・最大8点）───────────────────────────────────
  // 現在値が「本日これまでの高値/安値」を更新したか。出来高急増を伴う場合は
  // 信頼度の高いブレイクとみなし加点を強める
  if(todayStart!==null&&todayStart<n){
    var tHighs=highs.slice(todayStart,n),tLows=lows.slice(todayStart,n); // 現在足を除く本日の値幅
    if(tHighs.length>0){
      var tHigh=Math.max.apply(null,tHighs),tLow=Math.min.apply(null,tLows);
      var hasVolSurge=signals.find(function(sig){return sig.label==="出来高"&&sig.state===1;});
      if(price>tHigh){
        sc+=hasVolSurge?8:4;
        signals.push({label:"当日ブレイク",val:"高値更新"+(hasVolSurge?"(出来高伴う)":""),state:1});
      }else if(price<tLow){
        sc-=hasVolSurge?8:4;
        signals.push({label:"当日ブレイク",val:"安値更新"+(hasVolSurge?"(出来高伴う)":""),state:-1});
      }else{
        signals.push({label:"当日ブレイク",val:"レンジ内",state:0});
      }
    }
  }
  breakdown.push({label:"当日ブレイク",delta:sc-scChk});scChk=sc;

  // ── 寄り付きレンジブレイク Opening Range Break（補助・最大±8点）─────────
  // 寄り付き最初の2本(15分足×2=30分)の高安を「寄り付きレンジ」とし、その後の
  // 値動きがレンジを上下どちらに抜けたかを見る。日本株デイトレで定番の手法
  var OR_BARS=2; // 寄り付きから30分
  if(todayStart!==null&&n-todayStart>=OR_BARS){
    var orHighs=highs.slice(todayStart,todayStart+OR_BARS),orLows=lows.slice(todayStart,todayStart+OR_BARS);
    var orHigh=Math.max.apply(null,orHighs),orLow=Math.min.apply(null,orLows);
    if(price>orHigh){sc+=8;signals.push({label:"寄り付きレンジ",val:"レンジ上抜け(ORB買い)",state:1});}
    else if(price<orLow){sc-=8;signals.push({label:"寄り付きレンジ",val:"レンジ下抜け(ORB売り)",state:-1});}
    else{signals.push({label:"寄り付きレンジ",val:"レンジ内(様子見)",state:0});}
  }
  breakdown.push({label:"寄り付きレンジ",delta:sc-scChk});scChk=sc;

  // ── コンフルエンスボーナス（複合・最大±15点）─────────────────────────────
  // 個別シグナルは単独では精度が低くても、値動き・出来高・トレンドなど異なる系統が
  // 同時に同じ方向を向いている場面は期待値が高い、という考え方に基づくボーナス。
  // 主要8シグナルのうち、同方向(state)がいくつ揃っているかで加減点する
  var CONFLUENCE_LABELS=["VWAP","VWAP傾き","EMA整列","トレンド","出来高","当日ブレイク","寄り付きレンジ","ギャップ"];
  var bullCount=0,bearCount=0;
  CONFLUENCE_LABELS.forEach(function(lbl){
    var hit=signals.find(function(sig){return sig.label===lbl;});
    if(hit&&hit.state===1) bullCount++;
    if(hit&&hit.state===-1) bearCount++;
  });
  if(bullCount>=6){sc+=15;signals.push({label:"コンフルエンス",val:"強気シグナル多数一致("+bullCount+"/8)",state:1});}
  else if(bullCount>=4){sc+=8;signals.push({label:"コンフルエンス",val:"強気シグナル一致("+bullCount+"/8)",state:1});}
  else if(bullCount>=3){sc+=4;signals.push({label:"コンフルエンス",val:"強気シグナルやや一致("+bullCount+"/8)",state:1});}
  else if(bearCount>=6){sc-=15;signals.push({label:"コンフルエンス",val:"弱気シグナル多数一致("+bearCount+"/8)",state:-1});}
  else if(bearCount>=4){sc-=8;signals.push({label:"コンフルエンス",val:"弱気シグナル一致("+bearCount+"/8)",state:-1});}
  else if(bearCount>=3){sc-=4;signals.push({label:"コンフルエンス",val:"弱気シグナルやや一致("+bearCount+"/8)",state:-1});}
  else{signals.push({label:"コンフルエンス",val:"シグナル分散(一致なし)",state:0});}
  breakdown.push({label:"コンフルエンス",delta:sc-scChk});scChk=sc;

  // ── 過去の的中率に基づく重み調整（サンプル10件未満のシグナルは調整なし）──
  sc=applySignalWeights(sc,signals,breakdown);
  if(sc-scChk!==0){breakdown.push({label:"実績反映調整",delta:sc-scChk});}
  scChk=sc;

  var scoreCap=100;
  if(hasDC&&hasBearTrend){scoreCap=20;}
  else if(hasDC){scoreCap=30;}
  else if(hasBearTrend){scoreCap=35;}

  // ── VWAP乖離・出来高低調によるスコア上限抑制 ─────────────────────────────
  if(vwap!==null){
    var vwapDeviation=(price-vwap)/vwap*100;
    var hasLowVolume=signals.find(function(sig){return sig.label==="出来高"&&sig.state===-1;});
    var hasPivotWeak=signals.find(function(sig){return sig.label==="Pivot"&&sig.state===-1;});
    if(vwapDeviation<=-5&&hasLowVolume&&hasPivotWeak){
      scoreCap=Math.min(scoreCap,35);
      signals.push({label:"警戒",val:"VWAP乖離+出来高低調",state:-1});
    }else if(vwapDeviation<=-5&&(hasLowVolume||hasPivotWeak)){
      scoreCap=Math.min(scoreCap,50);
    }else if(vwapDeviation<=-3&&hasLowVolume){
      scoreCap=Math.min(scoreCap,55);
    }
  }
  // ────────────────────────────────────────────────────────────────────────────

  sc=Math.min(scoreCap,Math.max(0,sc));
  if(sc-scChk!==0){breakdown.push({label:"上限抑制(下降/デッドクロス/VWAP)",delta:sc-scChk});}
  scChk=sc;

  // ── VIX連動スコアキャップ（スキャル・デイトレ向け）────────────────────────
  if(vixVal!=null){
    var vn=parseFloat(vixVal);
    var vixCap=vn>=30?45:vn>=25?65:vn>=20?80:100;
    if(vixCap<100){
      sc=Math.min(vixCap,sc);
      signals.push({label:"VIX",val:"警戒("+vn.toFixed(1)+")→cap"+vixCap,state:-1});
    }
  }
  if(sc-scChk!==0){breakdown.push({label:"VIXキャップ",delta:sc-scChk});}
  scChk=sc;
  // ──────────────────────────────────────────────────────────────────────────

  // トレードタイプ表示ラベル：BB収束lookback選択で使ったvolType（yearRange/avgBarChange/absChangeは
  // 冒頭で算出済み・足種変更の影響を受けないabsChange/yearRangeとavgBarChangeを流用するため再計算不要
  var tradeType=volType,tradeLabel,tradeColor;
  if(tradeType==="short"){tradeLabel="⚡スキャル";tradeColor="#f43f5e";}
  else if(tradeType==="mid"){tradeLabel="📈デイトレ";tradeColor="#fbbf24";}
  else{tradeLabel="🌊スイング";tradeColor="#22d3a0";}

  var winRateRaw=Math.min(88,Math.max(15,sc*0.72));
  // 実績winRateは後でactualWinRateが揃ってから上書き（表示用は暫定値）
  var winRate=winRateRaw;
  var expVal=(winRate/100*2.5-(1-winRate/100)*1.5).toFixed(2);
  var timing=sc>=58?"BUY":sc>=38?"WATCH":"SKIP";
  // データ取得に失敗し疑似データ(genSim)で補完された場合は、本物らしい価格・判定を
  // 表示してしまわないよう「取得失敗」扱いにする（価格欄は"―"、判定バッジも専用表示）
  if(!pd.real){
    dispPrice="―";
    timing="FAILED";
  }

  var aptScore=0;
  try{
    if(sc>=58) aptScore+=30;
    else if(sc>=38) aptScore+=15;
    var hasTrendUpApt=signals&&signals.find(function(sig){return sig&&sig.label==="トレンド"&&sig.val==="上昇";});
    if(hasTrendUpApt) aptScore+=25;
    if(position52!=null&&position52<=25) aptScore+=25;
    else if(position52!=null&&position52<=50) aptScore+=15;
    if(tradeType==="mid") aptScore+=20;
    else if(tradeType==="stable") aptScore+=10;
    aptScore=Math.min(100,Math.max(0,aptScore));
  }catch(e){aptScore=0;}

  // ── 本日の想定値幅（atrはスコア計算冒頭で算出済みのものを再利用）──────────
  var atrUpper=Math.round(price+atr);
  var atrLower=Math.round(price-atr);
  // ── 利確/損切りライン（標準パターン：利確ATR×1.5／損切りATR×0.75、リスクリワード比1:2）──
  var isJPmkt=stock.market==="JP";
  var profitTargetV=price+atr*1.5;
  var stopLossV=price-atr*0.75;
  var profitLoss={
    target:isJPmkt?Math.round(profitTargetV):parseFloat(profitTargetV.toFixed(2)),
    stop:isJPmkt?Math.round(stopLossV):parseFloat(stopLossV.toFixed(2))
  };
  // ── デイトレ用 買値（エントリー1本）────────────────────────────────
  // VWAPより上の銘柄のみ対象。VWAP下・値幅使い切り時は買値を出さない(null)
  var atrDaily=calcDailyATR(closes,highs,lows,pd.dates,14);
  if(!(atrDaily>0)) atrDaily=atr*5; // 日足に換算できない時の近似（15分足26本ぶん≒√26倍）
  var buyPlan=null;
  if(pd.real&&vwap!==null&&price>vwap&&atr>0){
    var sigState=function(lbl){var h=signals.find(function(x){return x.label===lbl;});return h?h.state:0;};
    var overheat=signals.find(function(x){return x.label==="ATR消化率"&&x.state===-1;});
    var todayHigh=null;
    if(todayStart!==null&&todayStart<n){
      var hArr=highs.slice(todayStart,n);
      if(hArr.length) todayHigh=Math.max.apply(null,hArr);
    }
    if(!overheat){
      var hasMomentum=(sigState("VWAP傾き")===1&&sigState("出来高")===1);
      var bpMode=null,bpAnchor,bpReason;
      if(hasMomentum&&todayHigh!==null&&price>todayHigh){
        bpMode="now"; bpAnchor=price; bpReason="当日高値を更新中（現在値で追随）";
      }else if(hasMomentum&&todayHigh!==null){
        bpMode="break"; bpAnchor=todayHigh+tickSizeFor(todayHigh,isJPmkt);
        bpReason="当日高値"+roundTickPrice(todayHigh,0,isJPmkt)+"の上抜け待ち（逆指値）";
      }
      // ※押し目待ち(dip)は廃止。勢いの条件に当てはまらない銘柄は買いプランを表示しない
      if(bpMode){
        // 残り時間チェック（日本株・14:30以降のブレイク狙いは伸びきらない可能性）
        var jstNow=new Date(Date.now()+9*3600*1000);
        var jstMin=jstNow.getUTCHours()*60+jstNow.getUTCMinutes();
        var lateWarn=(isJPmkt&&jstMin>=870)?"引けまで残りわずか":null;
        buyPlan=buildBuyPlan(bpMode,bpAnchor,atrDaily,isJPmkt,bpReason,lateWarn);
      }
    }
  }
  // ── 週足高安値（直近5営業日相当）──────────────────────────────────────────
  var weekBars=Math.min(DAY_BARS*5,closes.length);
  var weekHighsArr=highs.slice(-weekBars),weekLowsArr=lows.slice(-weekBars);
  var weekHigh=weekHighsArr.length?Math.max.apply(null,weekHighsArr):null;
  var weekLow=weekLowsArr.length?Math.min.apply(null,weekLowsArr):null;
  var wDec=stock.market==="JP"?0:2;
  weekHigh=weekHigh!=null?parseFloat(weekHigh.toFixed(wDec)):null;
  weekLow=weekLow!=null?parseFloat(weekLow.toFixed(wDec)):null;
  // ── サポートレベル（下値目安）──────────────────────────────────────────────
  var support=null;
  if(lows.length>=BB_P){
    var validLows=lows.filter(function(v){return v!=null&&v>0&&!isNaN(v)&&isFinite(v);});
    var isJPfmt=stock.market==="JP";
    var s1v=validLows.length>=BB_P?Math.min.apply(null,validLows.slice(-BB_P)):null; // 20日相当
    var s2v=validLows.length>=1?Math.min.apply(null,validLows.slice(-YEAR_BARS)):null; // 全期間
    var atrFv=price-atr*1.5;
    if(s1v!==null&&s2v!==null&&isFinite(s1v)&&isFinite(s2v)){
      support={
        s1:isJPfmt?Math.round(s1v):parseFloat(s1v.toFixed(2)),
        s2:isJPfmt?Math.round(s2v):parseFloat(s2v.toFixed(2)),
        atrFloor:isJPfmt?Math.round(atrFv):parseFloat(atrFv.toFixed(2))
      };
    }
  }
  // ── レジスタンスレベル（上値目安：サポートの逆＝20日高値＋ATR上限）───────────
  var resistance=null;
  if(highs.length>=BB_P){
    var validHighs=highs.filter(function(v){return v!=null&&v>0&&!isNaN(v)&&isFinite(v);});
    var r1v=validHighs.length>=BB_P?Math.max.apply(null,validHighs.slice(-BB_P)):null; // 20日相当
    var atrCv=price+atr*1.5;
    if(r1v!==null&&isFinite(r1v)){
      resistance={
        r1:isJPmkt?Math.round(r1v):parseFloat(r1v.toFixed(2)),
        atrCeil:isJPmkt?Math.round(atrCv):parseFloat(atrCv.toFixed(2))
      };
    }
  }
  // ────────────────────────────────────────────────────────────────────────

  // ── スコア履歴をlocalStorageに蓄積（自動・最大40日分）────────────────────
  var scoreHist=(function(){
    try{
      var key="sh_"+stock.ticker;
      var hist=JSON.parse(localStorage.getItem(key)||"[]");
      var today=new Date().toISOString().slice(0,10);
      var sigKeys=signals.map(function(x){return baseSigLabel(x.label)+"#"+x.state;});
      // 地合い情報（対TOPIX前日比・VIX・時間帯）も一緒に記録しておく（Cの機能）
      // → 「上げ相場ではこのシグナルが効く」等の分析に後日使うための記録のみ。現時点では集計には使わない
      var ctx={topix:topixChange!=null?topixChange:null,vix:vixVal!=null?parseFloat(vixVal):null,session:currentSessionLabel(),market:stock.market};
      if(hist.length&&hist[hist.length-1].d===today){
        hist[hist.length-1]={d:today,s:sc,atr:atr,p:price,sig:sigKeys,ctx:ctx};
      }else{
        hist.push({d:today,s:sc,atr:atr,p:price,sig:sigKeys,ctx:ctx});
        if(hist.length>40)hist.shift();
      }
      localStorage.setItem(key,JSON.stringify(hist));
      return hist;
    }catch(e){return[];}
  })();
  // ────────────────────────────────────────────────────────────────────────

  // ── 時間帯別検証用のイントラデイ履歴（①のscoreHistとは別キー・別ロジック）───
  // 1日に複数件残す（同一日・同一時間帯の再スキャンのみ上書き）。Dの機能専用。
  // JP銘柄のみ記録（時間帯ラベルが日本市場基準のため、US銘柄を混ぜると統計が汚れる）。
  // sigは点灯中（state≠0）のみ保存し、localStorage容量を大幅節約する
  (function(){
    try{
      if(stock.market!=="JP") return;
      var ikey="sh_intraday_"+stock.ticker;
      var ihist=JSON.parse(localStorage.getItem(ikey)||"[]");
      var itoday=new Date().toISOString().slice(0,10);
      var isession=currentSessionLabel();
      var isigKeys=signals.filter(function(x){return x.state!==0;}).map(function(x){return baseSigLabel(x.label)+"#"+x.state;});
      var ilast=ihist[ihist.length-1];
      var ientry={d:itoday,session:isession,s:sc,p:price,sig:isigKeys};
      if(ilast&&ilast.d===itoday&&ilast.session===isession){
        ihist[ihist.length-1]=ientry;
      }else{
        ihist.push(ientry);
        if(ihist.length>200)ihist.shift(); // 目安：1日最大4件×約50日分
      }
      localStorage.setItem(ikey,JSON.stringify(ihist));
    }catch(e){}
  })();

  return{ticker:stock.ticker,tvSymbol:stock.tvSymbol,name:stock.name,market:stock.market,
    volume:stock.volume||0,volSurge:(typeof surge!=="undefined"?surge:1),
    price:dispPrice,rawPrice:pd.real?price:null,score:sc,winRate:winRate.toFixed(1),expVal:expVal,
    timing:timing,signals:signals,breakdown:breakdown,change:change,spark:closes.slice(-30),
    real:pd.real,failReason:pd.error||null,closes:closes,highs:highs,lows:lows,volumes:volumes,per:pd.per||null,pbr:pd.pbr||null,
    analystTarget:pd.analystTarget||null,earningsDate:resolveEventDate(stock.ticker,"earningsDate",pd.earningsDate||null),exRightsDate:resolveEventDate(stock.ticker,"exRightsDate",pd.exRightsDate||null),weekHigh:weekHigh,weekLow:weekLow,
    topixChange:topixChange,relStrength:relStrength,
    sectorChange:sectorChange,sectorName:sectorName,sectorRelStrength:sectorRelStrength,
    high52:high52,low52:low52,fromHigh:fromHigh,fromLow:fromLow,position52:position52,
    overlapLabels:overlapLabels,
    tradeType:tradeType,tradeLabel:tradeLabel,tradeColor:tradeColor,
    aptScore:aptScore,
    atr:atr,atrUpper:atrUpper,atrLower:atrLower,support:support,resistance:resistance,profitLoss:profitLoss,buyPlan:buyPlan,
    scoreHist:scoreHist,
    actualWinRate:calcActualWinRate(scoreHist),
    vwap:vwap?parseFloat(vwap.toFixed(stock.market==="JP"?0:2)):null,
    pivot:pivot?{pp:parseFloat(pivot.pp.toFixed(stock.market==="JP"?0:2)),r1:parseFloat(pivot.r1.toFixed(stock.market==="JP"?0:2)),s1:parseFloat(pivot.s1.toFixed(stock.market==="JP"?0:2)),r2:parseFloat(pivot.r2.toFixed(stock.market==="JP"?0:2)),s2:parseFloat(pivot.s2.toFixed(stock.market==="JP"?0:2)),prevHigh:parseFloat(pivot.prevHigh.toFixed(stock.market==="JP"?0:2)),prevLow:parseFloat(pivot.prevLow.toFixed(stock.market==="JP"?0:2)),prevClose:parseFloat(pivot.prevClose.toFixed(stock.market==="JP"?0:2))}:null,
    yahooUrl:"https://finance.yahoo.co.jp/quote/"+stock.ticker};
}

function classifyStockFn(s){
  var sigs=s.signals,macdSig=null;
  for(var i=0;i<sigs.length;i++){if(sigs[i].label==="MACD"){macdSig=sigs[i];break;}}
  if(!macdSig) return null;
  if(macdSig.val==="ゴールデンクロス") return{type:"GC_NOW",label:"GC発生",color:"#22d3a0",bg:"#052e16",border:"#22d3a0"};
  if(macdSig.val==="デッドクロス")     return{type:"DC_NOW",label:"DC発生",color:"#f43f5e",bg:"#1f0010",border:"#f43f5e"};
  if(macdSig.val==="強気ゾーン"&&s.score>=60) return{type:"GC_NEAR",label:"GC接近",color:"#fbbf24",bg:"#1c1400",border:"#fbbf24"};
  if(macdSig.val==="弱気ゾーン"&&s.score<=35) return{type:"DC_NEAR",label:"DC接近",color:"#fb923c",bg:"#1a0800",border:"#fb923c"};
  if(macdSig.val==="強気ゾーン"&&s.score>=50) return{type:"GC_WATCH",label:"GC監視",color:"#60a5fa",bg:"#0a1e3a",border:"#3b82f6"};
  return{type:"NONE",label:"中立",color:"#4a7090",bg:"#071428",border:"#1e3050"};
}

function SparklineWithMA(p){
  var data=p.data,up=p.up;
  if(!data||data.length<2) return null;
  var W=100,H=48;
  var sma5=[],sma25=[];
  for(var i=0;i<data.length;i++){
    if(i>=4){var s5=0;for(var j=i-4;j<=i;j++)s5+=data[j];sma5.push(s5/5);}else sma5.push(null);
    if(i>=24){var s25=0;for(var j2=i-24;j2<=i;j2++)s25+=data[j2];sma25.push(s25/25);}else sma25.push(null);
  }
  var allVals=data.slice();
  sma5.forEach(function(v){if(v!==null)allVals.push(v);});
  sma25.forEach(function(v){if(v!==null)allVals.push(v);});
  var mn=Math.min.apply(null,allVals),mx=Math.max.apply(null,allVals),rng=mx-mn||1;
  function toY(v){return H-((v-mn)/rng)*(H-5)-2.5;}
  function toX(i){return(i/(data.length-1))*(W-1);}
  var pricePts=data.map(function(v,i){return toX(i)+","+toY(v);}).join(" ");
  var ma5Pts=sma5.reduce(function(acc,v,i){if(v!==null)acc.push(toX(i)+","+toY(v));return acc;},[]).join(" ");
  var ma25Pts=sma25.reduce(function(acc,v,i){if(v!==null)acc.push(toX(i)+","+toY(v));return acc;},[]).join(" ");
  var priceColor=up?"#22d3a0":"#f43f5e";
  return(
    <svg width="100%" height={H} viewBox={"0 0 "+W+" "+H} preserveAspectRatio="none" style={{display:"block"}}>
      {ma25Pts&&<polyline points={ma25Pts} fill="none" stroke="#818cf8" strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round"/>}
      {ma5Pts&&<polyline points={ma5Pts} fill="none" stroke="#fbbf24" strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round"/>}
      <polyline points={pricePts} fill="none" stroke={priceColor} strokeWidth={1} strokeLinejoin="round" strokeLinecap="round" opacity={0.5}/>
    </svg>
  );
}

// ── 当日5分足ミニチャート（カードに常時表示）───────────────────────────
// 右側に価格の目盛り、下側に時刻ラベルを表示する。読み込み中/データなしはプレースホルダー表示。
// 当日以外のデータの場合、時刻ラベルに付ける短い日付("7/10"形式)。
// "14:00"だけだと今日の未来時刻に見えてしまう（実際は別の日）ため、日付を明示する。
function formatShortDate(isoDate){
  if(!isoDate) return "";
  var d=new Date(isoDate+"T00:00:00");
  return (d.getMonth()+1)+"/"+d.getDate();
}
// rngを渡すと、その値幅に応じた丸め単位にする（絶対価格だけで丸めると、値幅が
// 狭い銘柄で複数の価格ラベルが同じ表示に潰れてしまうため）。rng省略時は従来通り。
function fmtPriceLabel(v,rng){
  var av=Math.abs(v);
  var step;
  if(rng!=null&&rng>0){
    var target=rng/20;
    var mag=Math.pow(10,Math.floor(Math.log10(target)));
    var norm=target/mag;
    var niceNorm=norm<1.5?1:norm<3.5?2:norm<7.5?5:10;
    step=Math.max(niceNorm*mag,0.1);
  }else{
    step=av>=10000?100:av>=5000?50:av>=1000?10:av>=100?5:av>=10?1:0.5;
  }
  var rounded=Math.round(v/step)*step;
  return rounded>=1000?Math.round(rounded).toLocaleString("ja-JP"):rounded.toFixed(step<1?1:0);
}
// 時刻ラベル：できるだけ正時（9:00,10:00…）を優先して選ぶ。正時が少ない場合は均等間引きで補う。
// label（表示文字列）とindex（元配列でのインデックス）を返す。呼び出し側はindexを使って
// toX(index)でチャート上の実際の位置に合わせて配置する（昼休みなどで足の間隔が不均一な
// ため、単純にflexboxで均等配置すると線の形と時刻表示がズレてしまう）。
function pickTimeLabels(times,maxCount){
  var onHour=[];
  for(var i=0;i<times.length;i++){
    if(times[i]&&times[i].slice(-2)==="00") onHour.push(i);
  }
  var idxs;
  if(onHour.length>=2){
    if(onHour.length>maxCount){
      idxs=[];
      for(var k=0;k<maxCount;k++) idxs.push(onHour[Math.round(k*(onHour.length-1)/(maxCount-1))]);
    }else{
      idxs=onHour;
    }
  }else{
    idxs=[];
    var n=Math.min(maxCount,times.length);
    for(var k2=0;k2<n;k2++) idxs.push(Math.round(k2*(times.length-1)/((n-1)||1)));
  }
  return idxs.map(function(i){return {label:times[i],index:i};});
}
// timeLabelsの各ラベルを、toX(index)で計算した実際の位置にabsolute配置する。
// chartWidthはSVG部分の幅(px相当のflex比率)、rightGutterは右側の価格目盛り列の幅(px)。
function TimeLabelRow(p){
  var timeLabels=p.timeLabels,toX=p.toX,W=p.W,rightGutter=p.rightGutter||0;
  if(!timeLabels.length) return null;
  return(
    <div style={{display:"flex",gap:6,marginTop:3}}>
      <div style={{position:"relative",flex:1,height:14,minWidth:0}}>
        {timeLabels.map(function(t,i){
          var leftPct=(toX(t.index)/(W-1))*100;
          var isFirst=i===0,isLast=i===timeLabels.length-1;
          return(
            <span key={i} style={{position:"absolute",left:leftPct+"%",top:0,fontSize:11,color:"#6a90b0",whiteSpace:"nowrap",transform:isFirst?"translateX(0%)":isLast?"translateX(-100%)":"translateX(-50%)"}}>{t.label}</span>
          );
        })}
      </div>
      {rightGutter>0&&<div style={{width:rightGutter,flexShrink:0}}/>}
    </div>
  );
}
// 日付ラベル：均等間引きでmaxCount個選ぶ（日足は「正時」のような区切りが無いため単純均等）
function pickDateLabels(dates,maxCount){
  var idxs=[];
  var n=Math.min(maxCount,dates.length);
  for(var k=0;k<n;k++) idxs.push(Math.round(k*(dates.length-1)/((n-1)||1)));
  return idxs.map(function(i){
    var d=new Date(dates[i]+"T00:00:00");
    return {label:(d.getMonth()+1)+"/"+d.getDate(),index:i};
  });
}
// ── カードのミニチャート用：日足（直近3ヶ月） ──────────────────────────
function DailyMiniChart(p){
  var data=p.data,H=96;
  var wrapStyle={height:H+16,display:"flex",alignItems:"center",justifyContent:"center"};
  if(data===false){
    return <div style={wrapStyle}><span style={{fontSize:9,color:"#2a4060"}}>タップして詳細を見ると表示</span></div>;
  }
  if(data===undefined){
    return <div style={wrapStyle}><span style={{fontSize:9,color:"#2a4060"}}>読込中…</span></div>;
  }
  if(data===null||!data.closes||data.closes.length<2){
    return <div style={wrapStyle}><span style={{fontSize:9,color:"#2a4060"}}>データなし</span></div>;
  }
  var closes=data.closes,dates=data.dates||[],highs=data.highs||[],lows=data.lows||[];
  // VWAPは本来「1日の中」の指標のため、日足(1本=1日)では出来高加重ではなく
  // その日の代表値（高値・安値・終値の平均＝典型価格）として表示する。
  var ma25=trailingSMA(closes,25),ma75=trailingSMA(closes,75);
  var vwapProxy=closes.map(function(c,i){return(highs[i]!=null&&lows[i]!=null)?(highs[i]+lows[i]+c)/3:null;});
  var W=100;
  var allVals=closes.concat(ma25.filter(function(v){return v!=null;})).concat(ma75.filter(function(v){return v!=null;})).concat(vwapProxy.filter(function(v){return v!=null;}));
  var mn=Math.min.apply(null,allVals),mx=Math.max.apply(null,allVals);
  var rng=mx-mn||1;
  function toY(v){return H-((v-mn)/rng)*(H-4)-2;}
  function toX(i){return(i/(closes.length-1))*(W-1);}
  function toPts(arr){return arr.map(function(v,i){return v==null?null:toX(i)+","+toY(v);}).filter(function(v){return v!=null;}).join(" ");}
  var pts=toPts(closes);
  var pts25=toPts(ma25),pts75=toPts(ma75),ptsVwap=toPts(vwapProxy);
  var priceLevels=[mx, mn+rng*2/3, mn+rng/3, mn];
  var dateLabels=pickDateLabels(dates,4);
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"#6a90b0",marginBottom:2}}>
        <span>日足</span>
      </div>
      <div style={{display:"flex",gap:6}}>
        <div style={{flex:1,minWidth:0}}>
          <svg width="100%" height={H} viewBox={"0 0 "+W+" "+H} preserveAspectRatio="none" style={{display:"block"}}>
            {priceLevels.map(function(v,i){
              var y=toY(v);
              return <line key={i} x1={0} y1={y} x2={W} y2={y} stroke="#26344a" strokeWidth={0.5} strokeDasharray="2,2"/>;
            })}
            <polyline points={pts} fill="none" stroke="#e8eef5" strokeWidth={0.4} strokeLinejoin="round" strokeLinecap="round"/>
            {ptsVwap&&<polyline points={ptsVwap} fill="none" stroke="#38bdf8" strokeWidth={0.3}/>}
            {pts75&&<polyline points={pts75} fill="none" stroke="#f472b6" strokeWidth={0.3}/>}
            {pts25&&<polyline points={pts25} fill="none" stroke="#a3e635" strokeWidth={0.3}/>}
          </svg>
        </div>
        <div style={{width:52,flexShrink:0,display:"flex",flexDirection:"column",justifyContent:"space-between",fontSize:11,color:"#a8c0d8",textAlign:"right",height:H,paddingTop:2,paddingBottom:2,boxSizing:"border-box"}}>
          {priceLevels.map(function(v,i){return <span key={i}>{fmtPriceLabel(v,rng)}</span>;})}
        </div>
      </div>
      {dateLabels.length>0&&<TimeLabelRow timeLabels={dateLabels} toX={toX} W={W} rightGutter={58}/>}
    </div>
  );
}
// ── カードのミニチャート用：5分足（当日分のみ、1分足を5本ずつ束ねて集約） ──
function CardMiniChart5m(p){
  var data=p.data,H=96;
  var wrapStyle={height:H+16,display:"flex",alignItems:"center",justifyContent:"center"};
  if(data===false){
    return <div style={wrapStyle}><span style={{fontSize:9,color:"#2a4060"}}>タップして詳細を見ると表示</span></div>;
  }
  if(data===undefined){
    return <div style={wrapStyle}><span style={{fontSize:9,color:"#2a4060"}}>読込中…</span></div>;
  }
  if(data===null||!data.m1||!data.m1.closes||data.m1.closes.length<2){
    return <div style={wrapStyle}><span style={{fontSize:9,color:"#2a4060"}}>データなし</span></div>;
  }
  var m1=data.m1,latestDate=data.date;
  var idxs=[];
  for(var i=0;i<m1.closes.length;i++){ if(!m1.dates||m1.dates[i]===latestDate) idxs.push(i); }
  if(idxs.length<2){ idxs=m1.closes.map(function(_,i){return i;}); } // 当日分が拾えない時は全体を使う
  var srcOpens=m1.opens||m1.closes,srcHighs=m1.highs||m1.closes,srcLows=m1.lows||m1.closes;
  var opens=idxs.map(function(i){return srcOpens[i];}),highs=idxs.map(function(i){return srcHighs[i];});
  var lows=idxs.map(function(i){return srcLows[i];}),closesArr=idxs.map(function(i){return m1.closes[i];});
  var times=idxs.map(function(i){return(m1.times||[])[i];});
  var candles=aggregateCandles(opens,highs,lows,closesArr,null,times,null,5); // 1分足5本→5分足1本
  if(candles.length<2){
    return <div style={wrapStyle}><span style={{fontSize:9,color:"#2a4060"}}>データなし</span></div>;
  }
  var closes=candles.map(function(c){return c.close;});
  var cHighs=candles.map(function(c){return c.high;}),cLows=candles.map(function(c){return c.low;});
  var cTimes=candles.map(function(c){return c.time;});
  var ma25=trailingSMA(closes,25),ma75=trailingSMA(closes,75);
  var vwapProxy=closes.map(function(c,i){return(cHighs[i]!=null&&cLows[i]!=null)?(cHighs[i]+cLows[i]+c)/3:null;});
  var W=100;
  var allVals=closes.concat(ma25.filter(function(v){return v!=null;})).concat(ma75.filter(function(v){return v!=null;})).concat(vwapProxy.filter(function(v){return v!=null;}));
  var mn=Math.min.apply(null,allVals),mx=Math.max.apply(null,allVals);
  var rng=mx-mn||1;
  function toY(v){return H-((v-mn)/rng)*(H-4)-2;}
  function toX(i){return(i/(closes.length-1))*(W-1);}
  function toPts(arr){return arr.map(function(v,i){return v==null?null:toX(i)+","+toY(v);}).filter(function(v){return v!=null;}).join(" ");}
  var pts=toPts(closes);
  var pts25=toPts(ma25),pts75=toPts(ma75),ptsVwap=toPts(vwapProxy);
  var priceLevels=[mx, mn+rng*2/3, mn+rng/3, mn];
  var timeLabels=pickTimeLabels(cTimes,4);
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"#6a90b0",marginBottom:2}}>
        <span>5分足</span>
      </div>
      <div style={{display:"flex",gap:6}}>
        <div style={{flex:1,minWidth:0}}>
          <svg width="100%" height={H} viewBox={"0 0 "+W+" "+H} preserveAspectRatio="none" style={{display:"block"}}>
            {priceLevels.map(function(v,i){
              var y=toY(v);
              return <line key={i} x1={0} y1={y} x2={W} y2={y} stroke="#26344a" strokeWidth={0.5} strokeDasharray="2,2"/>;
            })}
            <polyline points={pts} fill="none" stroke="#e8eef5" strokeWidth={0.4} strokeLinejoin="round" strokeLinecap="round"/>
            {ptsVwap&&<polyline points={ptsVwap} fill="none" stroke="#38bdf8" strokeWidth={0.3}/>}
            {pts75&&<polyline points={pts75} fill="none" stroke="#f472b6" strokeWidth={0.3}/>}
            {pts25&&<polyline points={pts25} fill="none" stroke="#a3e635" strokeWidth={0.3}/>}
          </svg>
        </div>
        <div style={{width:52,flexShrink:0,display:"flex",flexDirection:"column",justifyContent:"space-between",fontSize:11,color:"#a8c0d8",textAlign:"right",height:H,paddingTop:2,paddingBottom:2,boxSizing:"border-box"}}>
          {priceLevels.map(function(v,i){return <span key={i}>{fmtPriceLabel(v,rng)}</span>;})}
        </div>
      </div>
      {timeLabels.length>0&&<TimeLabelRow timeLabels={timeLabels} toX={toX} W={W} rightGutter={58}/>}
    </div>
  );
}
// ── チャート詳細用：1分足＋25期・75期の短期移動平均（iSPEED等と同じ考え方）───
// MAは「週足」ではなく、1分足そのものを25本・75本分で平均した短期MA。
// 同じ1分足データ・同じX軸（今日の時刻）から計算するので、価格の折れ線と
// 自然に重ねて表示できる（週足MAのように別軸になる問題が起きない）。
function trailingSMA(closes,period){
  var result=new Array(closes.length).fill(null);
  var sum=0;
  for(var i=0;i<closes.length;i++){
    sum+=closes[i];
    if(i>=period) sum-=closes[i-period];
    if(i>=period-1) result[i]=sum/period;
  }
  return result;
}
// 1分足をbucket本ずつ束ねてローソク足(OHLC)に集約する。endIndexは元の1分足配列での
// 最終インデックス（MA・VWAPを1分足ベースで計算した値をローソクに揃えて拾うために使う）。
function aggregateCandles(opens,highs,lows,closes,volumes,times,dates,bucket){
  var n=closes.length,candles=[];
  for(var i=0;i<n;i+=bucket){
    var end=Math.min(i+bucket,n);
    var h=-Infinity,l=Infinity,vol=0;
    for(var j=i;j<end;j++){
      if(highs[j]>h)h=highs[j];
      if(lows[j]<l)l=lows[j];
      if(volumes)vol+=volumes[j]||0;
    }
    candles.push({open:opens[i],high:h,low:l,close:closes[end-1],volume:vol,endIndex:end-1,time:times[end-1],date:dates?dates[end-1]:null});
  }
  return candles;
}
// 1分足全体に対して、日付が変わるたびにリセットする「その日の累積VWAP」を計算する。
// （VWAPは本来1日の中の指標のため、複数日分のデータでも日をまたいで積み上げない）
function dailyVWAPSeries(closes,highs,lows,volumes,dates){
  var result=new Array(closes.length).fill(null);
  var cumTPV=0,cumVol=0,prevDate=null;
  for(var i=0;i<closes.length;i++){
    if(dates&&dates[i]!==prevDate){cumTPV=0;cumVol=0;prevDate=dates[i];}
    var tp=(highs[i]+lows[i]+closes[i])/3,v=volumes[i]||0;
    cumTPV+=tp*v;cumVol+=v;
    result[i]=cumVol>0?cumTPV/cumVol:null;
  }
  return result;
}
// ── 「銘柄の癖」パターン分析：出来高急増後の値動き ───────────────────────
// 過去1年の日足から「出来高が急増した日」を探し、その翌営業日・翌々営業日の
// 平均騰落率を集計する。材料に強く伸びやすい銘柄か、逆に急騰後は剥落しやすい
// 銘柄かの目安になる。
// 「急増」の判定基準は、その日を含まない直近20営業日（約1ヶ月）の平均出来高。
// デイトレ・スキャル用途では「今の水準からして多いかどうか」が知りたいため、
// 半年前の閑散期・活況期まで含めた1年間まるごとの平均だと基準が鈍ってしまう。
// 直近20日の移動平均にすることで、時期による偏りを受けにくくしている。
// サンプル（急増日）が少なすぎる場合は参考にならないためnullを返し、
// 表示側で「非表示」扱いにする。
var VOLUME_SPIKE_RATIO=1.5;
var VOLUME_SPIKE_LOOKBACK=20; // 何営業日分の平均出来高と比較するか
function computeVolumeSpikePattern(daily){
  if(!daily||!daily.closes||!daily.volumes||daily.closes.length<VOLUME_SPIKE_LOOKBACK+10) return null;
  var closes=daily.closes,volumes=daily.volumes,n=closes.length;
  var next1=[],next2=[];
  for(var i=VOLUME_SPIKE_LOOKBACK;i<n-1;i++){
    var sum=0,cnt=0;
    for(var j=i-VOLUME_SPIKE_LOOKBACK;j<i;j++){if(volumes[j]>0){sum+=volumes[j];cnt++;}}
    if(cnt<10) continue; // 直近の出来高データが乏しい期間は判定をスキップ
    var trailingAvg=sum/cnt;
    if(volumes[i]>trailingAvg*VOLUME_SPIKE_RATIO){
      next1.push((closes[i+1]-closes[i])/closes[i]*100);
      if(i+2<n) next2.push((closes[i+2]-closes[i])/closes[i]*100);
    }
  }
  if(next1.length<3) return null; // 該当日が少なすぎる場合はたまたまの可能性が高いため非表示
  function avg(arr){return arr.reduce(function(a,b){return a+b;},0)/arr.length;}
  return{count1:next1.length,avgNext1:avg(next1),count2:next2.length,avgNext2:next2.length?avg(next2):null};
}
// 日足6ヶ月チャート＋予測レンジ（右端に帯を描く）
// 帯は右端15%の枠に5営業日分を割り当てて描く（そのままだと細すぎて見えないため）
function DailyChartWithBand(p){
  var d=p.daily,H=p.height||180,W=360,FX=306,BARS=126; // BARS=約6ヶ月
  var cal=fcCalibration(); // 実測から求めた較正係数（件数が足りないうちは1のまま）
  var k68=p.k68||cal.k68,k90=p.k90||cal.k90;
  if(!d||!d.closes||d.closes.length<30)
    return(<div style={{height:H,display:"flex",alignItems:"center",justifyContent:"center",color:"#4a7090",fontSize:11}}>日足データ取得中…</div>);

  var full=d.closes;
  var ma25a=trailingSMA(full,25),ma75a=trailingSMA(full,75);
  var closes=full.slice(-BARS),ma25=ma25a.slice(-BARS),ma75=ma75a.slice(-BARS);
  var dates=(d.dates||[]).slice(-BARS);
  var n=closes.length,last=closes[n-1];
  var sigma=calcVolSigma(full,20);

  // 1〜5営業日先の帯を作る
  var b68=[],b90=[];
  if(sigma){
    for(var t=1;t<=BAND_DAYS;t++){
      b68.push(volBandAt(last,sigma,t,BAND_K68*k68));
      b90.push(volBandAt(last,sigma,t,BAND_K90*k90));
    }
  }

  // 縦軸の範囲（帯の一番外側まで入るようにする）
  var vals=closes.slice();
  [ma25,ma75].forEach(function(arr){arr.forEach(function(v){if(v!=null)vals.push(v);});});
  if(b90.length){vals.push(b90[BAND_DAYS-1].u);vals.push(b90[BAND_DAYS-1].l);}
  var mn=Math.min.apply(null,vals),mx=Math.max.apply(null,vals);
  var rng=(mx-mn)||1;mn-=rng*0.05;mx+=rng*0.05;rng=mx-mn;

  function toY(v){return H-((v-mn)/rng)*(H-6)-3;}
  function toXh(i){return n>1?(i/(n-1))*FX:0;}        // 履歴部のX
  function toXf(t){return FX+(t/BAND_DAYS)*(W-FX);}   // 予測部のX
  function lineOf(arr){
    var o=[];for(var i=0;i<arr.length;i++){if(arr[i]!=null)o.push(toXh(i)+","+toY(arr[i]));}
    return o.join(" ");
  }
  function bandPts(b){
    var up=[],lo=[];
    for(var t=1;t<=BAND_DAYS;t++){up.push(toXf(t)+","+toY(b[t-1].u));lo.unshift(toXf(t)+","+toY(b[t-1].l));}
    return FX+","+toY(last)+" "+up.join(" ")+" "+lo.join(" ");
  }
  function fmt(v){return Math.round(v).toLocaleString();}
  var dateLabels=dates.length>1?pickDateLabels(dates,5):[]; // 日付ラベル＋その位置の縦目盛線
  var priceLevels=[mx,mn+rng*2/3,mn+rng/3,mn]; // 右端に出す価格目盛（4本）
  var GUTTER=46; // 価格ラベル用の右余白

  return(
    <div>
      <div style={{display:"flex",gap:4}}>
      <div style={{position:"relative",flex:1,minWidth:0}}>
        <div style={{position:"absolute",top:3,left:4,zIndex:2,display:"flex",flexDirection:"column",gap:2,pointerEvents:"none"}}>
          <span style={{fontSize:9,color:"#a3e635"}}>25日MA</span>
          <span style={{fontSize:9,color:"#f472b6"}}>75日MA</span>
        </div>
        <span style={{position:"absolute",top:3,right:4,zIndex:2,fontSize:9,color:"#6a90b0",background:"#03080fd0",border:"1px solid #1a2c44",borderRadius:4,padding:"2px 5px"}}>日足6ヶ月</span>
        <svg width="100%" height={H} viewBox={"0 0 "+W+" "+H} preserveAspectRatio="none" style={{display:"block"}}>
          {priceLevels.map(function(v,i){
            return(<line key={"h"+i} x1={0} y1={toY(v)} x2={W} y2={toY(v)} stroke="#1a2c44" strokeWidth={1} vectorEffect="non-scaling-stroke"/>);
          })}
          {dateLabels.map(function(t,i){
            if(i===0)return null; // 左端は枠と重なるので引かない
            return(<line key={"g"+i} x1={toXh(t.index)} y1={0} x2={toXh(t.index)} y2={H} stroke="#1a2c44" strokeWidth={1} vectorEffect="non-scaling-stroke"/>);
          })}
          {b90.length>0&&<polygon points={bandPts(b90)} fill="#38bdf8" opacity={0.10}/>}
          {b68.length>0&&<polygon points={bandPts(b68)} fill="#38bdf8" opacity={0.20}/>}
          <line x1={FX} y1={0} x2={FX} y2={H} stroke="#2a4060" strokeWidth={1} strokeDasharray="2,2" vectorEffect="non-scaling-stroke"/>
          <line x1={FX} y1={toY(last)} x2={W} y2={toY(last)} stroke="#8a9bb0" strokeWidth={1} strokeDasharray="3,2" vectorEffect="non-scaling-stroke"/>
          <polyline points={lineOf(ma75)} fill="none" stroke="#f472b6" strokeWidth={1} vectorEffect="non-scaling-stroke"/>
          <polyline points={lineOf(ma25)} fill="none" stroke="#a3e635" strokeWidth={1} vectorEffect="non-scaling-stroke"/>
          <polyline points={lineOf(closes)} fill="none" stroke="#e8eef5" strokeWidth={0.9} vectorEffect="non-scaling-stroke"/>
        </svg>
      </div>
      <div style={{width:GUTTER,flexShrink:0,position:"relative",height:H}}>
        {priceLevels.map(function(v,i){
          var tf=i===0?"translateY(0%)":i===priceLevels.length-1?"translateY(-100%)":"translateY(-50%)";
          return(<span key={i} style={{position:"absolute",right:0,top:(toY(v)/H)*100+"%",transform:tf,fontSize:10,color:"#a8c0d8",whiteSpace:"nowrap"}}>{fmtPriceLabel(v,rng)}</span>);
        })}
      </div>
      </div>
      {dates.length>1&&(
        <div style={{display:"flex",gap:4}}>
        <div style={{position:"relative",flex:1,minWidth:0,height:13,marginTop:1}}>
          {dateLabels.map(function(t,i){
            return(<span key={i} style={{position:"absolute",left:(toXh(t.index)/W)*100+"%",top:0,fontSize:9,color:"#6a90b0",whiteSpace:"nowrap",transform:i===0?"translateX(0%)":"translateX(-50%)"}}>{t.label}</span>);
          })}
          <span style={{position:"absolute",right:0,top:0,fontSize:9,color:"#38bdf8",whiteSpace:"nowrap"}}>+5日</span>
        </div>
        <div style={{width:GUTTER,flexShrink:0}}/>
        </div>
      )}
      {sigma?(
        <div style={{display:"flex",gap:10,flexWrap:"wrap",fontSize:10,color:"#6a90b0",padding:"5px 4px 2px",fontFamily:"monospace"}}>
          <span>1日後 <b style={{color:"#38bdf8"}}>{fmt(b68[0].l)}〜{fmt(b68[0].u)}</b></span>
          <span>5日後 <b style={{color:"#38bdf8"}}>{fmt(b68[4].l)}〜{fmt(b68[4].u)}</b></span>
          <span style={{color:"#4a7090"}}>(68%目安・濃い帯)</span>
          {cal.ready
            ? <span style={{color:"#22d3a0"}} title={"較正前の実カバー率: 68%帯="+cal.cov68+"% / 90%帯="+cal.cov90+"%"}>較正済 判定{cal.n}件</span>
            : <span style={{color:"#4a7090"}} title="記録は毎日たまります。判定は5営業日後に自動でつきます">記録{cal.total}件 / 判定{cal.n}件（較正まで{FC_MIN_SAMPLES}件）</span>}
        </div>
      ):(
        <div style={{fontSize:10,color:"#4a7090",padding:"5px 4px"}}>データ不足のため予測レンジは非表示</div>
      )}
    </div>
  );
}

function IntradayChart1m(p){
  var data=p.data,H=p.height||140,BUCKET=1,CANDLE_W=13,RIGHT_GUTTER=52;
  var wrapStyle={height:H+16,display:"flex",alignItems:"center",justifyContent:"center"};
  var scrollRef=useRef(null);
  var isMobile=useIsMobile();
  var maInfoOpenS=useState(false);var maInfoOpen=maInfoOpenS[0],setMaInfoOpen=maInfoOpenS[1]; // 左上「MA/VWAP」タップ時の説明モーダル
  var visRangeS=useState(null);var visRange=visRangeS[0],setVisRange=visRangeS[1]; // 表示中の足の範囲（縦軸の自動調整用）

  var aiLevels=p.aiEntry||null; // AI分析のentry/target/stop/forecast
  var hasForecast=!!(aiLevels&&aiLevels.forecast&&aiLevels.forecast.direction);
  var PROJECTION_W=hasForecast?46:0; // 予測トレンド線用の余白
  var hasData=!!(data&&data.m1&&data.m1.closes&&data.m1.closes.length>=2);
  var m1=hasData?data.m1:{closes:[],opens:[],highs:[],lows:[],times:[],volumes:null,dates:null};
  var fullOpens=m1.opens||m1.closes,fullHighs=m1.highs||m1.closes,fullLows=m1.lows||m1.closes;
  var fullCloses=m1.closes,fullTimes=m1.times||[],fullVolumes=m1.volumes||null,fullDates=m1.dates||null; // volumesが無ければVWAPは非表示
  // チャートの表示範囲は「当日を含む直近2営業日」までに絞る（それより古いデータは切り捨てる）
  if(fullDates&&fullDates.length){
    var uniqDates=[];
    fullDates.forEach(function(d){if(uniqDates.indexOf(d)===-1)uniqDates.push(d);});
    var keepDates=uniqDates.slice(-2);
    var cutIdx=fullDates.findIndex(function(d){return keepDates.indexOf(d)>=0;});
    if(cutIdx>0){
      fullOpens=fullOpens.slice(cutIdx);fullHighs=fullHighs.slice(cutIdx);fullLows=fullLows.slice(cutIdx);
      fullCloses=fullCloses.slice(cutIdx);fullTimes=fullTimes.slice(cutIdx);fullDates=fullDates.slice(cutIdx);
      if(fullVolumes)fullVolumes=fullVolumes.slice(cutIdx);
    }
  }
  if(hasData&&p.liveTick&&p.liveTick.price!=null){ // 立花証券リアルタイム値を直近の1点として継ぎ足す
    var lv=p.liveTick.price;
    fullOpens=fullOpens.concat([lv]);fullHighs=fullHighs.concat([lv]);fullLows=fullLows.concat([lv]);
    fullCloses=fullCloses.concat([lv]);fullTimes=fullTimes.concat([p.liveTick.time||""]);
    if(fullVolumes)fullVolumes=fullVolumes.concat([0]);
    if(fullDates)fullDates=fullDates.concat([data.date||fullDates[fullDates.length-1]]);
  }
  var candles=aggregateCandles(fullOpens,fullHighs,fullLows,fullCloses,fullVolumes,fullTimes,fullDates,BUCKET);
  var n=candles.length;
  // MAは表示中の足（1分足）の終値ベースで計算する。
  var candleCloses=candles.map(function(c){return c.close;});
  var ma25=trailingSMA(candleCloses,25),ma75=trailingSMA(candleCloses,75);
  var hasVolume=!!fullVolumes;
  // VWAPは日をまたぐとリセットする「その日の累積」出来高加重平均
  var fullVwap=hasVolume?dailyVWAPSeries(fullCloses,fullHighs,fullLows,fullVolumes,fullDates):null;
  var vwapLine=fullVwap?candles.map(function(c){return fullVwap[c.endIndex];}):null;
  var chartWidth=Math.max(n*CANDLE_W,1)+PROJECTION_W;


  // スクロール位置から「今画面に映っている足の範囲」を割り出し、縦軸をその範囲に自動調整する
  function updateVisibleRange(){
    var el=scrollRef.current;if(!el||n===0)return;
    var start=Math.max(0,Math.floor(el.scrollLeft/CANDLE_W)-1);
    var end=Math.min(n-1,Math.ceil((el.scrollLeft+el.clientWidth)/CANDLE_W)+1);
    setVisRange({start:start,end:end});
  }
  useEffect(function(){
    if(!hasData)return;
    var el=scrollRef.current;if(!el)return;
    el.scrollLeft=el.scrollWidth; // 初期表示は一番右＝直近2時間程度
    updateVisibleRange();
  },[data,n]);

  if(data===undefined){
    return <div style={wrapStyle}><span style={{fontSize:9,color:"#2a4060"}}>読込中…</span></div>;
  }
  if(!hasData){
    return <div style={wrapStyle}><span style={{fontSize:9,color:"#2a4060"}}>データなし</span></div>;
  }

  var rangeStart=visRange?Math.min(visRange.start,n-1):Math.max(0,n-24);
  var rangeEnd=visRange?Math.min(visRange.end,n-1):n-1;
  var visCandles=candles.slice(rangeStart,rangeEnd+1);
  var visMa25=ma25.slice(rangeStart,rangeEnd+1),visMa75=ma75.slice(rangeStart,rangeEnd+1);
  var visVwap=vwapLine?vwapLine.slice(rangeStart,rangeEnd+1):null;
  // ── 縦軸レンジ ──
  // 基準は「ローソク足の高値・安値」だけ。MA/VWAP/AIラインが大きく外れていても、
  // そこまで軸を広げるとローソク足が潰れてしまうため、広げる量に上限を設ける。
  var baseVals=visCandles.reduce(function(a,c){return a.concat([c.high,c.low]);},[]);
  if(baseVals.length===0)baseVals=candles.reduce(function(a,c){return a.concat([c.high,c.low]);},[]);
  var mn=Math.min.apply(null,baseVals),mx=Math.max.apply(null,baseVals);
  var rng=mx-mn||1;
  // vals を取り込むために軸を広げる。ただしローソク足の値幅×ratio が上限。
  function expandTo(vals,ratio){
    vals=vals.filter(function(v){return v!=null;});
    if(!vals.length)return;
    var lim=rng*ratio;
    mn=Math.max(mn-lim,Math.min(mn,Math.min.apply(null,vals)));
    mx=Math.min(mx+lim,Math.max(mx,Math.max.apply(null,vals)));
  }
  var lineVals=visMa25.concat(visMa75);
  if(visVwap)lineVals=lineVals.concat(visVwap);
  expandTo(lineVals,0.5);                                                  // MA/VWAPは値幅の50%まで
  if(aiLevels)expandTo([aiLevels.entry,aiLevels.target,aiLevels.stop],1);  // AIラインは100%まで
  rng=mx-mn||1;
  var pad=rng*0.05;
  mn-=pad;mx+=pad;rng=mx-mn||1;
  function toY(v){return H-((v-mn)/rng)*(H-4)-2;}
  function toX(i){return i*CANDLE_W+CANDLE_W/2;} // 全期間を通した絶対px座標
  function toPtsAbs(arr){
    return arr.map(function(v,i){return v==null?null:toX(i)+","+toY(v);}).filter(function(v){return v!=null;}).join(" ");
  }
  var pts25=toPtsAbs(ma25),pts75=toPtsAbs(ma75),ptsVwap=vwapLine?toPtsAbs(vwapLine):null;
  var lastMa25=ma25[ma25.length-1],lastMa75=ma75[ma75.length-1],lastVwap=vwapLine?vwapLine[vwapLine.length-1]:null;
  var priceLevels=[mx, mn+rng*2/3, mn+rng/3, mn];
  var bodyHalf=CANDLE_W*0.35;
  // 複数日ぶんのデータになりうるので、時刻ラベルには常にその足の日付(M/D)を添える。
  // ラベルは"M/D HH:MM"で幅を取るため、見えている幅に対して詰め込みすぎると重なる。
  // 表示中の幅から「重ならずに入る本数」を逆算してから選ぶ。
  var visibleWidthPx=(rangeEnd-rangeStart+1)*CANDLE_W;
  var maxLabels=Math.max(2,Math.min(5,Math.floor(visibleWidthPx/85)));
  var timeLabels=pickTimeLabels(visCandles.map(function(c){return c.time;}),maxLabels)
    .map(function(t){
      var c=visCandles[t.index];
      var sd=c&&c.date?formatShortDate(c.date):"";
      return {label:(sd?sd+" ":"")+t.label,index:t.index+rangeStart};
    });
  return(
    <div>
      <div style={{display:"flex",gap:6}}>
        <div style={{position:"relative",flex:1,minWidth:0}}>
          <div onClick={function(){setMaInfoOpen(true);}} style={{position:"absolute",top:4,left:4,zIndex:2,background:"#03080fd0",border:"1px solid #1a2c44",borderRadius:4,padding:"3px 6px",display:"flex",flexDirection:"column",gap:2,cursor:"pointer"}}>
            <span style={{fontSize:9,color:"#a3e635",whiteSpace:"nowrap"}}>25期MA{lastMa25!=null&&" "+fmtPriceLabel(lastMa25)}</span>
            <span style={{fontSize:9,color:"#f472b6",whiteSpace:"nowrap"}}>75期MA{lastMa75!=null&&" "+fmtPriceLabel(lastMa75)}</span>
            {hasVolume?<span style={{fontSize:9,color:"#38bdf8",whiteSpace:"nowrap"}}>VWAP{lastVwap!=null&&" "+fmtPriceLabel(lastVwap)}</span>:<span style={{fontSize:9,color:"#2a4060",whiteSpace:"nowrap"}}>VWAP未対応</span>}
          </div>
          <span style={{position:"absolute",top:4,right:4,zIndex:2,fontSize:9,color:"#6a90b0",whiteSpace:"nowrap",background:"#03080fd0",border:"1px solid #1a2c44",borderRadius:4,padding:"3px 6px",pointerEvents:"none"}}>1分足</span>
        <div ref={scrollRef} onScroll={updateVisibleRange} style={{overflowX:"auto",WebkitOverflowScrolling:"touch"}}>
          <div style={{width:chartWidth}}>
            <svg width={chartWidth} height={H} style={{display:"block",overflow:"hidden"}}>
              {priceLevels.map(function(v,i){
                var y=toY(v);
                return <line key={i} x1={0} y1={y} x2={chartWidth} y2={y} stroke="#26344a" strokeWidth={0.5} strokeDasharray="2,2"/>;
              })}
              {candles.map(function(c,i){
                var x=toX(i),isUp=c.close>=c.open,col=isUp?"#22d3a0":"#f43f5e";
                var yO=toY(c.open),yC=toY(c.close),yH=toY(c.high),yL=toY(c.low);
                var top=Math.min(yO,yC),bh=Math.max(0.6,Math.abs(yC-yO));
                return(
                  <g key={i}>
                    <line x1={x} y1={yH} x2={x} y2={yL} stroke={col} strokeWidth={1}/>
                    <rect x={x-bodyHalf} y={top} width={bodyHalf*2} height={bh} fill={col}/>
                  </g>
                );
              })}
              {ptsVwap&&<polyline points={ptsVwap} fill="none" stroke="#38bdf8" strokeWidth={1}/>}
              {pts75&&<polyline points={pts75} fill="none" stroke="#f472b6" strokeWidth={1.2}/>}
              {pts25&&<polyline points={pts25} fill="none" stroke="#a3e635" strokeWidth={1.2}/>}
              {/* AI分析：エントリー/利確/損切りの水平線 */}
              {aiLevels&&[
                {v:aiLevels.entry,color:"#fbbf24",label:"エントリー"},
                {v:aiLevels.target,color:"#22d3a0",label:"利確"},
                {v:aiLevels.stop,color:"#f43f5e",label:"損切り"}
              ].map(function(o,i){
                if(o.v==null)return null;
                var y=toY(o.v);
                return(
                  <g key={i}>
                    <line x1={0} y1={y} x2={chartWidth} y2={y} stroke={o.color} strokeWidth={1} strokeDasharray="4,3"/>
                    <text x={chartWidth-4} y={y-3} fontSize={9} fill={o.color} textAnchor="end">{o.label} {fmtPriceLabel(o.v)}</text>
                  </g>
                );
              })}
              {/* AI分析：今後の見通し（forecast）を点線トレンドで表示 */}
              {hasForecast&&(function(){
                var dir=aiLevels.forecast.direction||"",conf=aiLevels.forecast.confidence!=null?aiLevels.forecast.confidence:50;
                var x0=toX(n-1),y0=toY(fullCloses[fullCloses.length-1]);
                var up=dir.indexOf("上昇")>=0,down=dir.indexOf("下落")>=0;
                var dy=(up?-1:down?1:0)*34*(conf/100); // 確信度が高いほど傾きを大きく
                var x1=x0+PROJECTION_W-6,y1=Math.max(4,Math.min(H-4,y0+dy));
                var col=up?"#22d3a0":down?"#f43f5e":"#8a9bb0";
                return(
                  <g>
                    <line x1={x0} y1={y0} x2={x1} y2={y1} stroke={col} strokeWidth={1.6} strokeDasharray="3,3"/>
                    <circle cx={x1} cy={y1} r={2.5} fill={col}/>
                    <text x={x1} y={y1+(dy<=0?-6:12)} fontSize={9} fill={col} textAnchor="middle">AI予想{conf}%</text>
                  </g>
                );
              })()}
            </svg>
            <div style={{position:"relative",height:14,marginTop:3}}>
              {timeLabels.map(function(t,i){
                return <span key={i} style={{position:"absolute",left:toX(t.index)+"px",top:0,fontSize:11,color:"#6a90b0",whiteSpace:"nowrap",transform:"translateX(-50%)"}}>{t.label}</span>;
              })}
            </div>
          </div>
        </div>
        </div>
        <div style={{width:RIGHT_GUTTER,flexShrink:0,display:"flex",flexDirection:"column",justifyContent:"space-between",fontSize:11,color:"#a8c0d8",textAlign:"right",height:H,paddingTop:2,paddingBottom:2,boxSizing:"border-box"}}>
          {priceLevels.map(function(v,i){return <span key={i}>{fmtPriceLabel(v,rng)}</span>;})}
        </div>
      </div>
      <div style={{display:"flex",gap:10,fontSize:10,marginTop:3,flexWrap:"wrap"}}>
        {aiLevels&&<span style={{color:"#fbbf24"}}>┈ AI分析ライン（エントリー/利確/損切り）</span>}
        {hasForecast&&<span style={{color:"#8a9bb0"}}>┈ AI予想トレンド（{aiLevels.forecast.direction}・確信度{aiLevels.forecast.confidence}%）</span>}
      </div>
      {maInfoOpen&&createPortal(
        <div onClick={function(){setMaInfoOpen(false);}} style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:2000,display:"flex",alignItems:"center",justifyContent:isMobile?"center":"flex-end",padding:16,paddingRight:isMobile?16:"56vw"}}>
          <div onClick={function(e){e.stopPropagation();}} style={{background:"#0a1628",border:"1px solid #2a4060",borderRadius:10,maxWidth:420,width:"90%",maxHeight:"85vh",overflowY:"auto",padding:"16px 18px",boxShadow:"0 8px 30px rgba(0,0,0,0.6)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{fontSize:14,fontWeight:800,color:"#d8eeff"}}>📈 MA・VWAPについて</div>
              <button onClick={function(){setMaInfoOpen(false);}} style={{background:"transparent",border:"none",color:"#4a7090",fontSize:18,cursor:"pointer",padding:0}}>✕</button>
            </div>
            <div style={{fontSize:12,color:"#a8c4e0",lineHeight:1.7}}>
              <div>・<b>25期MA</b>：直近25本分の終値をならした短期の移動平均線。直近の値動きの方向感をつかむ目安です</div>
              <div style={{marginTop:6}}>・<b>75期MA</b>：直近75本分の終値をならした中期の移動平均線。25期MAがこの線を上に抜けると上昇トレンド転換（ゴールデンクロス）、下に抜けると下降トレンド転換（デッドクロス）のサインとして意識されます</div>
              <div style={{marginTop:6}}>・<b>VWAP</b>（出来高加重平均価格）：その日の出来高で重み付けした平均取引価格。日が変わるとリセットされ、その日だけの累積値です。価格がVWAPより上なら「その日の平均より高く買われている」＝強い、下なら「弱い」の目安として使えます</div>
            </div>
          </div>
        </div>
      ,document.body)}
    </div>
  );
}

// シグナル詳細の表示順（指定順）。RSIは末尾に実際の数値が付くため前方一致で判定する
// 「寄り付きレンジ」はORB(Opening Range Breakout)判定のことなので、表示名はORBに変換する（displaySignalLabel参照）
var SIGNAL_WEIGHT_ORDER=["コンフルエンス","EMA整列","出来高","OBV","RSI","寄り付きレンジ","BB","BB収束","当日ブレイク","ATR消化率","VWAP傾き","ギャップ"];
function signalWeightRank(label){
  var idx=SIGNAL_WEIGHT_ORDER.findIndex(function(o){return label===o||(o==="RSI"&&label.indexOf("RSI")===0);});
  return idx===-1?SIGNAL_WEIGHT_ORDER.length:idx;
}
// シグナル詳細パネルでの表示名（内部ロジックは「寄り付きレンジ」のまま、見た目だけORBに）
function displaySignalLabel(label){return label==="寄り付きレンジ"?"ORB":label;}

// ── シグナル詳細（カードの展開パネルとチャートモーダルで共通利用）────────
function SignalDetailList(p){
  var isMobile=useIsMobile();
  var labelFs=isMobile?9:11,valFs=isMobile?9:11;
  var rowPad=isMobile?"6px 10px":"3px 8px"; // PC版のみ各項目の上下左右の余白を縮小
  var rowGap=isMobile?4:2; // PC版のみ項目間の間隔を縮小
  var weightOpenS=useState(false);var weightOpen=weightOpenS[0],setWeightOpen=weightOpenS[1];
  var sortedSignals=(p.signals||[])
    .filter(function(sig){return sig.label==="BB"||sig.label==="OBV"||sig.label==="出来高"||sig.label==="ギャップ"||sig.label==="当日ブレイク"||sig.label==="VWAP傾き"||sig.label==="EMA整列"||sig.label==="ATR消化率"||sig.label==="寄り付きレンジ"||sig.label==="コンフルエンス"||sig.label.startsWith("RSI");})
    .slice()
    .sort(function(a,b){return signalWeightRank(a.label)-signalWeightRank(b.label);});
  var volPat=computeVolumeSpikePattern(p.daily); // 出来高急増後の値動き（翌営業日・翌々営業日の平均騰落率）
  function volRow(key,label,val){
    var color=val==null?"#4a7090":val>=0?"#22d3a0":"#f43f5e";
    return(
      <div key={key} style={{background:"#071428",borderRadius:6,padding:rowPad,display:"flex",justifyContent:"space-between",alignItems:"center",border:"1px solid #0f2040"}}>
        <span style={{fontSize:labelFs,color:"#4a7090"}}>{label}</span>
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          <span style={{fontSize:valFs,fontWeight:700,color:color,textAlign:"right"}}>{val==null?"—":(val>=0?"+":"")+val.toFixed(1)+"%"}</span>
        </div>
      </div>
    );
  }
  return(
    <div>
      <div style={{display:"flex",flexDirection:"column",gap:rowGap}}>
        {volPat&&volRow("volNext1","翌日営業日",volPat.avgNext1)}
        {volPat&&volRow("volNext2","翌々日営業日",volPat.avgNext2)}
        {sortedSignals.map(function(sig,i){
          return(
            <div key={i} onClick={function(){setWeightOpen(true);}} style={{background:"#071428",borderRadius:6,padding:rowPad,display:"flex",justifyContent:"space-between",alignItems:"center",border:"1px solid #0f2040",cursor:"pointer"}}>
              <span style={{fontSize:labelFs,color:isSigNegExpectancy(sig)?"#fb923c":"#4a7090"}}>{(isSigNegExpectancy(sig)?"⚠️ ":"")+displaySignalLabel(sig.label)}</span>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                <span style={{fontSize:valFs,fontWeight:700,color:stateColor(sig.state),textAlign:"right"}}>{sig.val}</span>
              </div>
            </div>
          );
        })}
      </div>
      <SignalWeightModal open={weightOpen} onClose={function(){setWeightOpen(false);}}/>
    </div>
  );
}

// シグナル詳細タップ時に表示する、配点の重み説明モーダル（画面左側に表示）
function SignalWeightModal(p){
  var isMobile=useIsMobile();
  if(!p.open) return null;
  return(
    <div onClick={p.onClose} style={{position:"fixed",inset:0,zIndex:1000,display:"flex",alignItems:"center",justifyContent:isMobile?"center":"flex-end",padding:16,paddingRight:isMobile?16:"56vw"}}>
      <div onClick={function(e){e.stopPropagation();}} style={{background:"#0a1628",border:"1px solid #2a4060",borderRadius:10,maxWidth:420,width:"90%",maxHeight:"85vh",overflowY:"auto",padding:"16px 18px",boxShadow:"0 8px 30px rgba(0,0,0,0.6)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div style={{fontSize:14,fontWeight:800,color:"#d8eeff"}}>📊 シグナルの重み付けについて</div>
          <button onClick={p.onClose} style={{background:"transparent",border:"none",color:"#4a7090",fontSize:18,cursor:"pointer",padding:0}}>✕</button>
        </div>
        <div style={{fontSize:12,color:"#a8c4e0",lineHeight:1.7}}>
          <div style={{fontWeight:700,color:"#f87171",marginTop:6,marginBottom:4}}>特に重い項目（±15点前後）</div>
          <div>・<b>コンフルエンス</b>：他の複数シグナルが同じ方向を向いているかをまとめた「シグナルの一致度」。8個中6個以上一致で±15点と、単独では一番配点が大きい項目です。「強気シグナル多数一致」と出ていれば、個別シグナルより信頼度が高いと見なせます</div>

          <div style={{fontWeight:700,color:"#fbbf24",marginTop:14,marginBottom:4}}>次に重い項目（±6〜10点）</div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            <div>・<b>EMA整列</b>：短期・中期・長期の移動平均が順番通りに並んでいるか＝トレンドの方向感</div>
            <div>・<b>BB（ボリンジャーバンド）</b>：下限で反発なら押し目買い、上限突破は過熱のサイン</div>
            <div>・<b>OBV／出来高</b>：値動きに出来高が伴っているか。「価格は動いたが出来高が伴わない」は騙しになりやすいので、出来高とセットで見る価値があります</div>
            <div>・<b>寄り付きレンジ（ORB）</b>：寄り付き後のレンジを上抜け/下抜けした、というデイトレの定番エントリーサイン</div>
            <div>・<b>RSI</b>：買われすぎ・売られすぎを見る指標。30以下は「売られすぎ」で反発を期待して加点、70以上は「買われすぎ」で過熱感として減点</div>
          </div>

          <div style={{fontWeight:700,color:"#94a3b8",marginTop:14,marginBottom:4}}>補助的な項目（±3〜7点）</div>
          <div>・BB収束（値幅が狭まっている＝この後の値動き拡大の予兆）、ATR消化率（すでに値幅を使い切っていないか＝追いかけ買いの危険度）、Pivot、VWAP傾きなど</div>

          <div style={{fontWeight:700,color:"#38bdf8",marginTop:14,marginBottom:4}}>翌日営業日／翌々日営業日について（スコアには含まれません）</div>
          <div>・過去1年の日足から「出来高が直近20営業日平均の1.5倍以上に急増した日」を探し、その翌営業日・翌々営業日の株価が平均何%動いたかを集計した、その銘柄の「値動きの癖」の参考値です。材料に強く反応して伸びやすい銘柄か、逆に急騰後は反落しやすい銘柄かを見る目安になります。過去の統計であり、今後の値動きを保証するものではありません（該当日が3回未満の場合は非表示になります）</div>

          <div style={{fontWeight:700,color:"#fb923c",marginTop:14,marginBottom:4}}>⚠️マークの意味（スコアには含まれません）</div>
          <div>・シグナル名の左に<b style={{color:"#fb923c"}}>⚠️</b>が付いているものは、過去10件以上・5営業日分以上のデータがあるにもかかわらず、そのシグナル通りに動いた場合の<b>翌営業日の平均騰落率がマイナス</b>だったシグナルです。「当たる回数は多いが、勝ちが小さく負けが大きい（勝率の罠）」の可能性があります</div>
          <div style={{marginTop:6}}>・加点の主力に⚠️が並んでいる場合は、スコアを額面通りに受け取らず割り引いて見るのが安全です。ただしこれは<b>翌営業日まで持ち越した場合</b>の統計なので、当日中に手仕舞いするデイトレでは結果が異なる可能性があります</div>

          <div style={{fontWeight:700,color:"#22d3a0",marginTop:14,marginBottom:4}}>実際の見方の目安</div>
          <div>1つの指標だけで判断せず、「コンフルエンスが強気/弱気で一致 → EMA整列やBBの方向も同じ → 出来高も伴っている」という3つが揃ったときが、このアプリの設計上いちばん重視されている状況です。逆に出来高が「低調」なのに他が強気、というときは騙しの可能性を疑う、という使い方が理にかなっています。</div>
        </div>
      </div>
    </div>
  );
}

function ScoreRing(p){
  var raw=Number(p.score);
  var sc=isNaN(raw)?0:Math.round(Math.min(100,Math.max(0,raw)));
  var R=14,C=2*Math.PI*R,col=scoreColor(sc);
  return(
    <svg width={34} height={34} style={{flexShrink:0}}>
      <circle cx={17} cy={17} r={R} fill="none" stroke="#1e3050" strokeWidth={3}/>
      <circle cx={17} cy={17} r={R} fill="none" stroke={col} strokeWidth={3} strokeDasharray={C} strokeDashoffset={C-(sc/100)*C} strokeLinecap="round" transform="rotate(-90 17 17)"/>
      <text x={17} y={21} textAnchor="middle" fill={col} style={{fontSize:8,fontWeight:800,fontFamily:"monospace"}}>{sc}</text>
    </svg>
  );
}

function TabBtn(p){return(<button onClick={p.onClick} style={{background:p.active?p.color+"18":"transparent",border:"1px solid "+(p.active?p.color:"#1e3050"),borderRadius:6,color:p.active?p.color:"#4a6080",padding:"4px 10px",fontSize:12,cursor:"pointer",fontFamily:"monospace",fontWeight:p.active?700:400}}>{p.label}</button>);}

// ── 地合いバナー（TOPIX前日比）─────────────────────────────────────────────
// スコアには一切影響させず「今日は順風か逆風か」という判断材料だけを表示する。
// TOPIXは日本株スキャン時のみ取得されるため、値が無い場合は何も出さない
function MarketRegimeBanner(p){
  var jp=(p.stocks||[]).find(function(s){return s.topixChange!=null;});
  if(!jp) return null;
  var t=jp.topixChange;
  var down=t<=-0.5,up=t>=0.5;
  var col=down?"#f43f5e":up?"#22d3a0":"#fbbf24";
  var head=down?"⚠️ 逆風日":up?"🟢 順風日":"➖ 中立";
  var note=down?"市場全体が下落中。買いシグナルは通りにくい地合いです"
    :up?"市場全体が上昇中。買いシグナルが通りやすい地合いです"
    :"市場全体はほぼ横ばいです";
  return(
    <div style={{background:"#050e1c",border:"1px solid "+col+"55",borderRadius:8,padding:"6px 10px",marginBottom:8,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
      <span style={{fontSize:12,fontWeight:800,color:col}}>{head}</span>
      <span style={{fontSize:11,color:"#8fb0d0",fontFamily:"monospace"}}>TOPIX {(t>=0?"+":"")+t.toFixed(2)}%</span>
      <span style={{fontSize:10,color:"#4a7090"}}>{note}</span>
    </div>
  );
}

// ── StockCard ────────────────────────────────────────────────────────────────
// ── トレード登録モーダル（買い/売り価格を入力し、アプリ予想 or 個人予想へ追加）─────
function TradeAddModal(p){
  var s=p.s;
  var isMobile=useIsMobile();
  var buyS=useState(p.prefill?String(p.prefill.buy):(s.rawPrice!=null?String(s.rawPrice):""));var buyVal=buyS[0],setBuyVal=buyS[1];
  var buyDirS=useState("down");var buyDir=buyDirS[0],setBuyDir=buyDirS[1]; // 指値(down)／逆指値(up)。常に「指値」を初期値にし、必要な時だけ手動で切り替える
  var sellS=useState(p.prefill?String(p.prefill.sell):"");var sellVal=sellS[0],setSellVal=sellS[1];
  var stopS=useState(p.prefill&&p.prefill.stop!=null?String(p.prefill.stop):"");var stopVal=stopS[0],setStopVal=stopS[1];
  var sharesS=useState("100");var sharesVal=sharesS[0],setSharesVal=sharesS[1];
  var riskS=useState(String(loadRiskUnit()));var riskVal=riskS[0],setRiskVal=riskS[1];
  var capS=useState(String(loadCapital()));var capVal=capS[0],setCapVal=capS[1];
  function riskPerShare(){var b=parseFloat(buyVal),sp=parseFloat(stopVal);return(b>0&&sp>0&&sp<b)?b-sp:null;}
  // 1R基準の理想株数と、元手で実際に買える株数の両方を返す
  // （損切りが近い銘柄ほど必要資金が跨ね上がるため、元手で上限をかける）
  function calcSharesInfo(){
    var rps=riskPerShare(),ru=parseFloat(riskVal),b=parseFloat(buyVal),cap=parseFloat(capVal);
    if(!rps||!(ru>0)||!(b>0))return null;
    var unit=isJP?100:1; // 日本株は100株単位
    var ideal=Math.max(unit,Math.floor(ru/rps/unit)*unit);
    // 米国株は1R・元手と通貨単位が揃わないため、元手キャップは日本株のみ適用
    var shares=ideal;
    if(isJP&&cap>0)shares=Math.min(ideal,Math.floor(cap/b/unit)*unit);
    return{unit:unit,ideal:ideal,shares:shares,capped:shares<ideal,ok:shares>=unit,
      idealCost:b*ideal,cost:b*shares,idealRisk:rps*ideal,risk:rps*shares};
  }
  function actualRisk(){var rps=riskPerShare(),sh=parseInt(sharesVal);return(rps&&sh>0)?rps*sh:null;}
  function yen(v){return "¥"+Math.round(v).toLocaleString();}
  var isJP=s.market==="JP";
  var inp={background:"#040c18",border:"1px solid #1e4070",borderRadius:5,color:"#b8cce0",padding:"8px",fontSize:16,fontFamily:"monospace",width:"100%",boxSizing:"border-box"};
  function valid(){
    var b=parseFloat(buyVal),se=parseFloat(sellVal),sh=parseInt(sharesVal);
    if(isNaN(b)||b<=0||isNaN(se)||se<=0||isNaN(sh)||sh<=0)return false;
    var sp=parseFloat(stopVal);
    if(isNaN(sp)||sp<=0||sp>=b)return false; // 損切りは必須・買い価格より下であること
    return true;
  }
  function add(kind){
    if(!valid())return;
    p.onAddTrade(kind,s,parseFloat(buyVal),parseFloat(sellVal),parseInt(sharesVal),stopVal!==""?parseFloat(stopVal):null,buyDir);
    p.onClose();
  }
  return(
    <div onClick={function(e){if(e.target===e.currentTarget)p.onClose();}} style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:2000,display:"flex",alignItems:"center",justifyContent:isMobile?"center":"flex-end",padding:16,paddingRight:isMobile?16:"56vw"}}>
      <div style={{background:"#040c18",border:"1px solid #0ea5e950",borderRadius:16,padding:"16px",width:"100%",maxWidth:420,boxShadow:"0 8px 30px rgba(0,0,0,0.6)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
          <div style={{fontSize:13,fontWeight:700,color:"#0ea5e9"}}>🎯 トレード登録 - {s.ticker.replace(".T","")}</div>
          <button onClick={p.onClose} style={{background:"transparent",border:"none",color:"#4a7090",fontSize:18,cursor:"pointer",lineHeight:1}}>✕</button>
        </div>
        <div style={{fontSize:11,color:"#4a7090",marginBottom:12}}>価格が指定値に到達すると自動で開始・終了します（判定はトレードタブの更新ボタンで反映）</div>
        {p.prefill&&<div style={{fontSize:11,color:"#4a90c0",background:"#0a1a3a",border:"1px solid #4a90c040",borderRadius:6,padding:"6px 8px",marginBottom:10}}>🤖 AI分析の提案値を反映しています。必要に応じて数値を編集してください。</div>}
        {s.profitLoss&&(
          <button onClick={function(){setSellVal(String(s.profitLoss.target));setStopVal(String(s.profitLoss.stop));}} style={{width:"100%",background:"#0a1a3a",border:"1px solid #0ea5e950",borderRadius:8,color:"#0ea5e9",padding:"7px",fontSize:12,fontWeight:700,cursor:"pointer",marginBottom:10}}>📐 標準ライン(ATR)を使う（利確{s.market==="JP"?"¥"+s.profitLoss.target.toLocaleString():"$"+s.profitLoss.target}／損切り{s.market==="JP"?"¥"+s.profitLoss.stop.toLocaleString():"$"+s.profitLoss.stop}）</button>
        )}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:8}}>
          <div>
            <div style={{fontSize:11,color:"#22d3a0",marginBottom:3}}>買い価格</div>
            <input style={inp} type="number" value={buyVal} onChange={function(e){setBuyVal(e.target.value);}}/>
            <div style={{display:"flex",gap:4,marginTop:4}}>
              <button type="button" onClick={function(){setBuyDir("down");}} style={{flex:1,padding:"4px 2px",fontSize:10,fontWeight:700,borderRadius:5,cursor:"pointer",border:"1px solid "+(buyDir==="down"?"#22d3a0":"#1e3050"),background:buyDir==="down"?"#22d3a020":"transparent",color:buyDir==="down"?"#22d3a0":"#4a6080"}}>指値(下値待ち)</button>
              <button type="button" onClick={function(){setBuyDir("up");}} style={{flex:1,padding:"4px 2px",fontSize:10,fontWeight:700,borderRadius:5,cursor:"pointer",border:"1px solid "+(buyDir==="up"?"#f59e0b":"#1e3050"),background:buyDir==="up"?"#f59e0b20":"transparent",color:buyDir==="up"?"#f59e0b":"#4a6080"}}>逆指値(上抜け待ち)</button>
            </div>
          </div>
          <div><div style={{fontSize:11,color:"#f43f5e",marginBottom:3}}>売り価格（利確）</div><input style={inp} type="number" value={sellVal} onChange={function(e){setSellVal(e.target.value);}}/></div>
          <div><div style={{fontSize:11,color:"#4a7090",marginBottom:3}}>株数</div><input style={inp} type="number" value={sharesVal} onChange={function(e){setSharesVal(e.target.value);}}/></div>
        </div>
        <div style={{marginBottom:10}}>
          <div style={{fontSize:11,color:"#fbbf24",marginBottom:3}}>損切り価格（必須・買い価格より低い値）</div>
          <input style={inp} type="number" value={stopVal} onChange={function(e){setStopVal(e.target.value);}} placeholder="必須"/>
        </div>
        <div style={{marginBottom:14,background:"#050e1c",borderRadius:8,padding:"8px 10px"}}>
          <div style={{display:"flex",gap:8}}>
            <div style={{flex:1}}>
              <div style={{fontSize:11,color:"#0ea5e9",marginBottom:3}}>1R（1回の許容損失額）</div>
              <input style={inp} type="number" value={riskVal} onChange={function(e){setRiskVal(e.target.value);saveRiskUnit(parseFloat(e.target.value));}}/>
            </div>
            <div style={{flex:1}}>
              <div style={{fontSize:11,color:"#a78bfa",marginBottom:3}}>想定元手</div>
              <input style={inp} type="number" value={capVal} onChange={function(e){setCapVal(e.target.value);saveCapital(parseFloat(e.target.value));}}/>
            </div>
          </div>
          {(function(){
            var info=calcSharesInfo(),can=info&&info.ok;
            return <button type="button" disabled={!can} onClick={function(){setSharesVal(String(info.shares));}} style={{width:"100%",marginTop:8,padding:"9px 12px",fontSize:12,fontWeight:700,borderRadius:6,cursor:can?"pointer":"not-allowed",border:"1px solid "+(can?"#0ea5e9":"#1e3050"),background:can?"#0a1a3a":"transparent",color:can?"#0ea5e9":"#2a4060"}}>📐 株数を逆算{can?"（"+info.shares+"株）":""}</button>;
          })()}
          {(function(){
            var rps=riskPerShare(),ar=actualRisk(),ru=parseFloat(riskVal),info=calcSharesInfo();
            if(!rps)return <div style={{fontSize:11,color:"#4a7090",marginTop:6}}>買い価格と損切り価格を入れると1株あたりのリスクが出ます</div>;
            var ratio=(ar&&ru>0)?ar/ru:null;
            var warn=ratio!=null&&(ratio>1.2||ratio<0.5);
            return(
              <div style={{fontSize:11,marginTop:6,lineHeight:1.7}}>
                <div style={{color:warn?"#fbbf24":"#4a7090"}}>
                  リスク {Math.round(rps).toLocaleString()}円/株
                  {ar!=null&&" × "+parseInt(sharesVal)+"株 = 実際のリスク "+yen(ar)}
                  {ratio!=null&&"（"+ratio.toFixed(2)+"R）"}
                  {warn&&" ⚠️1Rからズレています"}
                </div>
                {ar!=null&&parseInt(sharesVal)>0&&(
                  <div style={{color:(isJP&&parseFloat(capVal)>0&&parseFloat(buyVal)*parseInt(sharesVal)>parseFloat(capVal))?"#f43f5e":"#4a7090"}}>
                    必要資金 {yen(parseFloat(buyVal)*parseInt(sharesVal))} ／ 元手 {yen(parseFloat(capVal)||0)}
                    {isJP&&parseFloat(capVal)>0&&parseFloat(buyVal)*parseInt(sharesVal)>parseFloat(capVal)&&" ⚠️元手超過"}
                  </div>
                )}
                {info&&info.capped&&info.ok&&(
                  <div style={{color:"#fbbf24"}}>
                    ⚠️ 1R基準なら{info.ideal}株（必要資金{yen(info.idealCost)}）ですが、元手上限のため{info.shares}株に制限（{(info.risk/(parseFloat(riskVal)||1)).toFixed(2)}R）。この銘柄は損切りが近すぎてR基準では戦えません
                  </div>
                )}
                {info&&!info.ok&&(
                  <div style={{color:"#f43f5e"}}>⚠️ 元手では1単元も買えません（必要資金{yen(parseFloat(buyVal)*info.unit)}）</div>
                )}
              </div>
            );
          })()}
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          <button onClick={function(){add("app");}} disabled={!valid()} style={{background:valid()?"linear-gradient(135deg,#0ea5e9,#0369a1)":"#0f2040",border:"none",borderRadius:8,color:valid()?"#fff":"#2a4060",padding:"10px",fontSize:13,fontWeight:700,cursor:valid()?"pointer":"not-allowed"}}>🎯 アプリ予想タブへ追加</button>
          <button onClick={function(){add("personal");}} disabled={!valid()} style={{background:valid()?"linear-gradient(135deg,#a78bfa,#7c3aed)":"#0f2040",border:"none",borderRadius:8,color:valid()?"#fff":"#2a4060",padding:"10px",fontSize:13,fontWeight:700,cursor:valid()?"pointer":"not-allowed"}}>👤 個人予想タブへ追加</button>
        </div>
      </div>
    </div>
  );
}

// ── ⭐ボタンタップ時の保存先選択モーダル：全体(未分類)／グループ1〜5／削除 ─────
function FavPickerModal(p){
  var ticker=p.ticker,favs=p.favs,favGroups=p.favGroups,groupNames=p.groupNames,onSelect=p.onSelect,onRemove=p.onRemove,onClose=p.onClose;
  var isMember=favs.indexOf(ticker)>=0;
  var curGroup=favGroups[ticker]||0;
  function optBtn(val,label){
    var active=isMember&&curGroup===val;
    return(
      <button key={val} onClick={function(){onSelect(val);}} style={{padding:"12px 10px",background:active?"#0ea5e9":"#050f20",border:"1px solid "+(active?"#0ea5e9":"#1e3050"),borderRadius:8,color:active?"#fff":"#b8cce0",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"monospace",textAlign:"left"}}>
        {active?"✓ ":""}{label}
      </button>
    );
  }
  return(
    <div onClick={function(e){if(e.target===e.currentTarget)onClose();}} style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.6)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"flex-end",padding:16,paddingRight:"56vw"}}>
      <div style={{background:"#071428",border:"1px solid #1e3050",borderRadius:10,padding:16,width:"100%",maxWidth:320,display:"flex",flexDirection:"column",gap:8,color:"#b8cce0"}}>
        <div style={{fontSize:13,fontWeight:800,color:"#e0f0ff",marginBottom:4}}>⭐ {ticker.replace(".T","")} の保存先</div>
        {optBtn(0,"全体（未分類）")}
        {[1,2,3,4,5].map(function(n){return optBtn(n,groupNames[n]);})}
        {isMember&&<button onClick={onRemove} style={{padding:"12px 10px",background:"#2a0a12",border:"1px solid #f43f5e60",borderRadius:8,color:"#f43f5e",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"monospace",marginTop:4}}>🗑 お気に入り削除</button>}
        <button onClick={onClose} style={{padding:"8px 0",background:"transparent",border:"1px solid #2a4060",borderRadius:8,color:"#4a7090",fontSize:12,cursor:"pointer",fontFamily:"monospace"}}>キャンセル</button>
      </div>
    </div>
  );
}

function StockCard(p){
  var s=p.s,toggleFav=p.toggleFav,isFav=p.isFav,cross=p.cross,onRescan=p.onRescan,rescanLoading=p.rescanLoading;
  var star=starStyle(s.ticker,isFav,p.appTrades,p.personalTrades);
  var bc=BADGE[s.timing],mc=MKT[s.market]||MKT["US"],isUp=parseFloat(s.change)>=0;
  var isMobile=useIsMobile(); // スマホはカード内チャートを非表示（詳細モーダル側で確認する運用）
  // ── チャート（カードが選択された時だけ取得＝体感速度・API負荷を改善）───
  // cardIntraday: カードのミニチャート用（5分足）。false=未取得, undefined=読込中, null=データなし
  var cardIntradayS=useState(false);var cardIntraday=cardIntradayS[0],setCardIntraday=cardIntradayS[1];

  var borderColor=s.score>=58?"#22d3a0":s.score>=38?"#fbbf24":"#f43f5e";
  var pos52=s.position52!=null?Math.min(98,Math.max(2,s.position52)):null;
  var pos52Color=pos52!=null?(pos52<=25?"#22d3a0":pos52<=75?"#fbbf24":"#f43f5e"):null;
  var fromHighColor=s.fromHigh>=-10?"#f43f5e":s.fromHigh>=-30?"#fbbf24":"#22d3a0";
  var fromLowColor=s.fromLow<=20?"#22d3a0":s.fromLow<=50?"#fbbf24":"#f43f5e";

  function stopProp(e){e.stopPropagation();}
  var isSelected=p.selectedStock&&p.selectedStock.ticker===s.ticker;

  // 選択中の銘柄だけ5分足を取得（スマホはカード内チャートを表示しないため取得自体をスキップ）
  useEffect(function(){
    if(!isSelected) return;
    if(!isMobile&&(cardIntraday===false||cardIntraday===null)){
      setCardIntraday(undefined);
      fetchIntraday(s.ticker).then(function(r){setCardIntraday(r);});
    }
    if(onRescan) onRescan(s.ticker); // 価格・判定バッジもチャートと同様に毎回最新化
  },[isSelected]);

  var cardBorder=isSelected?"#60a5fa":borderColor;

  return(
    <div style={{background:isSelected?"#071e38":"#050e1c",border:"none",borderRadius:10,padding:"10px",display:"flex",flexDirection:"column",gap:7,cursor:"pointer",minWidth:0}}
      onClick={function(){if(p.setSelectedStock)p.setSelectedStock(s);}}>
      <div style={{display:"flex",gap:6,alignItems:"center",justifyContent:"space-between"}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",gap:4,alignItems:"center"}}>
            <div style={{fontSize:15,fontWeight:800,color:borderColor,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.ticker.replace(".T","")}</div>
            <button onClick={function(e){stopProp(e);toggleFav(s.ticker);}} style={{background:"transparent",border:"none",fontSize:15,cursor:"pointer",padding:0,color:star.color,flexShrink:0}}>{star.symbol}</button>
          </div>
          <div style={{fontSize:10,color:"#4a7090",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.name}</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:3,marginTop:2}}>
            {(function(){var ei=earningsInfo(s.earningsDate);return ei&&<span style={bStyle(ei.urgent?"#3a0a0a":"#1c1400","1px solid "+(ei.urgent?"#f43f5e":"#fbbf24"),ei.urgent?"#f87171":"#fbbf24")} title={"決算発表: "+ei.date}>📈決算{ei.label}</span>;})()}
            {(function(){var xi=exRightsInfo(s.exRightsDate);return xi&&<span style={bStyle("#0a1a3a","1px solid #3b82f6","#60a5fa")} title={"権利落ち予想: "+xi.date}>💰権利落ち(予想){xi.label}</span>;})()}
            {(function(){var ri=relStrengthInfo(s.relStrength);return ri&&<span style={bStyle(ri.strong?"#052e16":"#1f0010","1px solid "+(ri.strong?"#22d3a0":"#f43f5e"),ri.strong?"#22d3a0":"#f43f5e")} title={"対TOPIX相対(前日比差): "+ri.label}>{ri.strong?"🔥対TOPIX":"🧊対TOPIX"}{ri.label}</span>;})()}{(function(){var dn=DAYNIGHT[s.ticker];if(!dn)return null;var pos=dn.day>0;return <span style={bStyle(pos?"#052e16":"#101826","1px solid "+(pos?"#22d3a0":"#2a4060"),pos?"#22d3a0":"#4a7090")} title={"過去1年の値動きの分解（"+dn.days+"日分）: 日中(始値→終値)の累積"+(dn.day>=0?"+":"")+dn.day+"% / 夜間(前日終値→始値)の累積"+(dn.night>=0?"+":"")+dn.night+"%。日中分がプラスなら、持ち越さないデイトレと相性が良い日中型"}>{(pos?"☀️日中+":"🌙日中")+dn.day+"%"}</span>;})()}
            {(function(){var si=relStrengthInfo(s.sectorRelStrength);return si&&<span style={bStyle(si.strong?"#052e16":"#1f0010","1px solid "+(si.strong?"#22d3a0":"#f43f5e"),si.strong?"#22d3a0":"#f43f5e")} title={"対"+(s.sectorName||"業種")+"相対(前日比差): "+si.label}>{si.strong?"🔥対業種":"🧊対業種"}{si.label}</span>;})()}
            {(function(){var sf=scalpFitInfo(s);return sf&&<span style={bStyle("#2a1400","1px solid #fb923c","#fb923c")} title={"スキャル・デイトレに不向きな可能性："+sf.label+"（出来高とATR%のみの簡易判定。板情報・スプレッドは考慮していません）"}>⚠️{sf.label}</span>;})()}
          </div>
          {(function(){
            var aw=s.actualWinRate;
            var hasReal=aw&&aw.winRate!==null&&aw.total>=3;
            var dispRate=hasReal?aw.winRate:parseFloat(s.winRate);
            var label=hasReal?"実績":"推定";
            var col=hasReal?(dispRate>=60?"#22d3a0":dispRate>=50?"#fbbf24":"#f43f5e"):"#4a7090";
            var sub=hasReal?"("+aw.total+"回)":"";
            return(
              <div style={{fontSize:9,color:col,marginTop:2}}>
                {label} {dispRate}%<span style={{color:"#2a4060"}}>{sub}</span>
              </div>
            );
          })()}
        </div>
        <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:2,flexShrink:0}}>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:13,color:"#d8eeff",fontWeight:800}}>{s.price}</div>
            {s.real===false&&s.failReason&&<div style={{fontSize:9,color:"#f43f5e",maxWidth:100,textAlign:"right"}}>{s.failReason}</div>}
            {s.real!==false&&<div style={{fontSize:10,color:isUp?"#22d3a0":"#f43f5e"}}>{isUp?"▲":"▼"}{Math.abs(s.change)}%</div>}
          </div>
        </div>
      </div>

      {!isMobile&&(
        <div style={{background:"#03080f",borderRadius:6,padding:"2px 4px"}}>
          <CardMiniChart5m data={cardIntraday}/>
        </div>
      )}

    </div>
  );
}

// 立花証券e支店APIのリアルタイム株価・板情報（選択中の1銘柄のみ）
// tachibana-server(VPS)が裏でRedisに書き込んだ値を、数秒おきにポーリングして表示する
function TachibanaBoard(p){
  var code=p.ticker.replace(".T","");

  useEffect(function(){
    var stopped=false;

    function notifyWatch(){
      fetch(TACHIBANA_WATCH_API,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ticker:code}),signal:AbortSignal.timeout(8000)}).catch(function(){});
    }
    // タップ直後はサーバー側(Redis)にまだ値が無いことが多い。7秒おきのままだと
    // 初回表示まで最大7秒待たされるため、最初の1件が届くまでは1秒おきに取りに行き、
    // 届いた時点で通常の7秒間隔に切り替える（空振りが続く場合も15回で切り替え）。
    var fastTries=0, FAST_MAX=15, gotFirst=false;
    var quoteTimer=null;
    function startPolling(ms){
      if(quoteTimer) clearInterval(quoteTimer);
      quoteTimer=setInterval(pollQuote,ms);
    }
    function pollQuote(){
      fetch(TACHIBANA_QUOTE_API+"&ticker="+encodeURIComponent(code),{signal:AbortSignal.timeout(8000)})
        .then(function(r){return r.json();})
        .then(function(json){
          if(stopped) return;
          if(json&&json.found){
            if(p.onQuote) p.onQuote(json);
            if(!gotFirst){gotFirst=true;startPolling(7*1000);} // 初回取得できたら通常間隔へ
          }
        })
        .catch(function(){})
        .finally(function(){
          if(stopped||gotFirst) return;
          if(++fastTries>=FAST_MAX) startPolling(7*1000); // 空振りが続いたら通常間隔へ
        });
    }

    notifyWatch();
    pollQuote();
    var watchTimer=setInterval(notifyWatch,60*1000); // 監視継続を伝え続ける（5分でタイムアウトするため）
    startPolling(1000); // まずは1秒おきの高速ポーリングで開始

    return function(){
      stopped=true;
      clearInterval(watchTimer);
      if(quoteTimer) clearInterval(quoteTimer);
    };
  },[code]);

  return null; // 画面には出さず、株価タップ時のTachibanaQuoteModalでのみ表示する（チャート等のガタつき防止）
}

// ── 立花証券リアルタイム詳細モーダル：株価タップで開く ─────────────────────
function TachibanaQuoteModal(p){
  var quote=p.quote;
  var stale=!!(quote&&quote.stale);
  var ageSec=quote?Math.round((Date.now()-quote.updatedAt)/1000):null;
  var headerColor=stale?"#fbbf24":"#22d3a0";
  var headerLabel=stale
    ?"⏸ 立花証券（休場中・最終値 "+new Date(quote.updatedAt).toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"})+"時点）"
    :"📡 立花証券リアルタイム"+(ageSec!=null?"（"+ageSec+"秒前）":"");
  return(
    <div onClick={function(e){if(e.target===e.currentTarget)p.onClose();}} style={{position:"fixed",inset:0,zIndex:2000,display:"flex",alignItems:"center",justifyContent:"flex-end",paddingRight:"56vw"}}>
      <div onClick={function(e){e.stopPropagation();}} style={{background:"#040c18",border:"1px solid "+(stale?"#fbbf2450":"#22d3a050"),borderRadius:10,padding:"16px 18px",maxWidth:420,width:"90%",maxHeight:"85vh",overflowY:"auto",WebkitOverflowScrolling:"touch",boxShadow:"0 8px 30px rgba(0,0,0,0.6)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div style={{fontSize:13,fontWeight:700,color:headerColor}}>{headerLabel}</div>
          <button onClick={p.onClose} style={{background:"transparent",border:"none",color:"#4a7090",fontSize:18,cursor:"pointer",lineHeight:1}}>✕</button>
        </div>
        {!quote?(
          <div style={{fontSize:12,color:"#4a7090"}}>取得中…</div>
        ):(
          <div style={{display:"flex",flexDirection:"column",gap:6,opacity:stale?0.55:1}}>
            {Object.keys(quote.fields||{}).map(function(k){
              return(
                <div key={k} style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#a8c4e0",borderBottom:"1px solid #0e2038",paddingBottom:4}}>
                  <span>{k}</span><b style={{color:"#d8eeff"}}>{quote.fields[k]}</b>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 売買傾向（気配値の数量合計から売り・買いの比率を算出）──────────────────
// 立花証券リアルタイム中継の生データ（TachibanaQuoteModalと同じ元データ）から
// 売気配(GAV)・買気配(GBV)の数量を合計し、iSPEEDの「売買傾向」と同じ考え方で
// 比率（%）を出す。板の一覧やグラフは出さず、比率と合計株数だけのシンプル表示。
// 気配値(quote)から板の各段（買い・売り）の値段と株数を取り出す共通処理
function parseOrderBookLevels(quote){
  var result={found:false,sellLevels:[],buyLevels:[],sellVol:0,buyVol:0};
  if(!quote||!quote.fields) return result;
  var f=quote.fields;
  for(var n=1;n<=10;n++){
    var av=f["p_1_GAV"+n],bv=f["p_1_GBV"+n];
    var ap=f["p_1_GAP"+n],bp=f["p_1_GBP"+n];
    if(av!=null){var avn=Number(av)||0;result.sellVol+=avn;result.found=true;result.sellLevels.push({n:n,price:ap!=null?Number(ap):null,vol:avn});}
    if(bv!=null){var bvn=Number(bv)||0;result.buyVol+=bvn;result.found=true;result.buyLevels.push({n:n,price:bp!=null?Number(bp):null,vol:bvn});}
  }
  return result;
}
// 板の中で最も注文量が多い1本を返す（S1/R1の上に「厚い価格帯」として表示する）
function maxLevel(levels){
  var valid=levels.filter(function(l){return l.vol>0&&l.price!=null;});
  if(valid.length===0) return null;
  return valid.reduce(function(best,l){return(!best||l.vol>best.vol)?l:best;},null);
}
// 板の中で「周辺の値段に比べて極端に多い注文」を検出する（平均のTHICK_ORDER_MULTIPLIER倍以上）
var THICK_ORDER_MULTIPLIER=4;
function findThickLevels(levels){
  var valid=levels.filter(function(l){return l.vol>0&&l.price!=null;});
  if(valid.length<2) return [];
  var avg=valid.reduce(function(s,l){return s+l.vol;},0)/valid.length;
  if(avg<=0) return [];
  return valid.filter(function(l){return l.vol>=avg*THICK_ORDER_MULTIPLIER;});
}

// ── ①板の時系列記録＋②見せ板検出 ────────────────────────────────────────
// 板は「今いくら並んでいるか」より「増えているか減っているか」に方向性が出る。
// 7秒おきに届く気配値をticker別に貯めておき、買い比率の推移と、厚い注文が
// 出たり消えたりを繰り返していないか（＝見せ板の疑い）を判定する。
var BOARD_HIST={};              // ticker → [{t,buyPct,tb,ts}]
var BOARD_HIST_MAX=45;          // 7秒×45 ≒ 5分ぶん保持
var BOARD_HIST_GAP=10*60*1000;  // 10分以上あいたら別セッションとみなしリセット
var SPOOF_MIN_SAMPLES=8;        // これだけ記録が貯まってから見せ板判定を始める
var SPOOF_VANISH_RATIO=0.4;     // 厚い注文がピークの4割未満に減ったら「消えた」扱い

// 厚い注文を「値段→株数」の対応表にする（前回スナップショットとの比較用）
function boardThickMap(levels){
  var m={};
  findThickLevels(levels).forEach(function(l){m[l.price]=l.vol;});
  return m;
}
// 気配値1件を履歴に追加する（同じ更新時刻は二重記録しない）
function pushBoardHistory(ticker,quote){
  if(!ticker||!quote||quote.stale) return;
  var ob=parseOrderBookLevels(quote);
  var total=ob.buyVol+ob.sellVol;
  if(!ob.found||total<=0) return;
  var h=BOARD_HIST[ticker]||(BOARD_HIST[ticker]=[]);
  var t=quote.updatedAt||Date.now();
  var last=h[h.length-1];
  if(last){
    if(last.t===t) return;
    if(t-last.t>BOARD_HIST_GAP) h.length=0;
  }
  h.push({t:t,buyPct:ob.buyVol/total*100,tb:boardThickMap(ob.buyLevels),ts:boardThickMap(ob.sellLevels)});
  if(h.length>BOARD_HIST_MAX) h.shift();
}
// 買い比率の推移と、前半→後半の変化量（pt）を返す
function boardTrend(ticker){
  var h=BOARD_HIST[ticker]||[];
  if(h.length<3) return null;
  var ser=h.map(function(x){return x.buyPct;});
  function avg(a){return a.reduce(function(s,v){return s+v;},0)/a.length;}
  var w=Math.min(5,Math.floor(ser.length/2))||1;
  return{
    series:ser,
    now:ser[ser.length-1],
    diff:avg(ser.slice(-w))-avg(ser.slice(0,w)),
    spanSec:Math.round((h[h.length-1].t-h[0].t)/1000)
  };
}
// 厚い注文が出現→消滅を何回繰り返したかを数える（多いほど見せ板の疑いが濃い）
function detectSpoof(ticker){
  var h=BOARD_HIST[ticker]||[];
  if(h.length<SPOOF_MIN_SAMPLES) return null;
  function scan(key){
    var events=0,peak={};
    h.forEach(function(snap){
      var m=snap[key];
      Object.keys(peak).forEach(function(price){
        var p=peak[price];
        if(p.alive&&(m[price]==null||m[price]<p.vol*SPOOF_VANISH_RATIO)){p.alive=false;events++;}
      });
      Object.keys(m).forEach(function(price){
        var p=peak[price];
        if(!p) peak[price]={vol:m[price],alive:true};
        else if(!p.alive){p.alive=true;p.vol=m[price];}
        else if(m[price]>p.vol) p.vol=m[price];
      });
    });
    return events;
  }
  var buy=scan("tb"),sell=scan("ts");
  if(buy===0&&sell===0) return null;
  return{buy:buy,sell:sell};
}

// ── 📈 板の勢いパネル：買い比率の推移グラフ＋見せ板の警告 ────────────────────
function BoardMomentumPanel(p){
  if(!p.isJP) return null;
  var box={background:"#071428",border:"1px solid #2a4060",borderRadius:8,padding:"8px 10px"};
  var title=<div style={{fontSize:11,fontWeight:700,color:"#4a90c0",marginBottom:4}}>📈 板の勢い</div>;
  var tr=boardTrend(p.ticker);
  if(!tr) return <div style={box}>{title}<div style={{fontSize:10,color:"#4a7090"}}>記録中…（20秒ほどで表示）</div></div>;
  var dir=tr.diff>=1.5?{t:"↑ 買い増加中",c:"#22d3a0"}
         :tr.diff<=-1.5?{t:"↓ 売り増加中",c:"#f43f5e"}
         :{t:"→ 横ばい",c:"#fbbf24"};
  var W=100,H=24,ser=tr.series;
  var mn=Math.min.apply(null,ser),mx=Math.max.apply(null,ser);
  if(mx-mn<6){var mid=(mx+mn)/2;mn=mid-3;mx=mid+3;}
  var pts=ser.map(function(v,i){
    return (i/(ser.length-1)*W).toFixed(1)+","+(H-(v-mn)/(mx-mn)*H).toFixed(1);
  }).join(" ");
  var y50=(mn<50&&mx>50)?(H-(50-mn)/(mx-mn)*H):null;
  var sp=detectSpoof(p.ticker);
  return(
    <div style={box}>
      {title}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
        <span style={{fontSize:13,fontWeight:800,color:"#d8eeff"}}>買い {tr.now.toFixed(1)}%</span>
        <span style={{fontSize:10,fontWeight:700,color:dir.c}}>{dir.t}（{tr.diff>=0?"+":""}{tr.diff.toFixed(1)}pt）</span>
      </div>
      <svg width="100%" height={H} viewBox={"0 0 "+W+" "+H} preserveAspectRatio="none" style={{display:"block",marginTop:3}}>
        {y50!=null&&<line x1="0" y1={y50} x2={W} y2={y50} stroke="#2a4060" strokeWidth="0.7" strokeDasharray="2,2"/>}
        <polyline points={pts} fill="none" stroke={dir.c} strokeWidth="1.4" vectorEffect="non-scaling-stroke"/>
      </svg>
      <div style={{fontSize:9,color:"#4a7090",marginTop:2}}>直近{tr.spanSec}秒の買い比率（点線＝50%）</div>
      {sp&&(
        <div style={{marginTop:5,fontSize:10,color:"#fb923c",background:"#2a1400",border:"1px solid #fb923c50",borderRadius:5,padding:"3px 6px"}}>
          ⚠️ 見せ板の疑い（買{sp.buy}回・売{sp.sell}回 出入り）
        </div>
      )}
    </div>
  );
}
// ── サポートゾーン可視化：チャート由来の節目（S1/S2/ATR下限）と、板の厚い買い注文が
// 近い値段で重なっているかを照合する。二階堂式「節目＋厚い買い注文＝支えが強い」の考え方。
var SUPPORT_MATCH_TOLERANCE=0.01; // 節目からこの割合以内に厚い注文があれば「重なり」とみなす（1%）
function findBoardMatch(targetPrice,thickLevels){
  if(targetPrice==null) return null;
  var best=null,bestDiff=Infinity;
  thickLevels.forEach(function(l){
    if(l.price==null) return;
    var diff=Math.abs(l.price-targetPrice)/targetPrice;
    if(diff<=SUPPORT_MATCH_TOLERANCE&&diff<bestDiff){best=l;bestDiff=diff;}
  });
  return best;
}
// ── 板スコア補正：立花証券のリアルタイム気配値からスコアを±調整する ──────────
// 【重要】既存のスコア(s.score)は書き換えず、別枠の「補正値」として表示する。
// 　s.scoreを直接上書きすると、これまで蓄積してきた実績勝率(scoreHist)の
// 　集計基準が変わり、過去データとの比較ができなくなるため。
// 板が取れない銘柄(米国株)・休場中(stale)はnullを返し、パネル自体を非表示にする。
// 板が意味を持つ時間帯かを判定する。範囲外はnullを返しパネルごと非表示にする。
// 8:00〜 9:00 …寄り前気配。注文が積み上がり寄り付きの方向が読めるため最も価値が高い
// 11:30〜12:30 …昼休み。12:05から後場の注文受付が始まり後場寄りの方向が読める
// 15:30〜翌8:00・休場日 …板が引け値で凍結するため採点しない（金曜の板を月曜に使う事故を防ぐ）
function boardSessionLabel(){
  if(!isTradingDay("JP")) return null;
  var jst=new Date(Date.now()+9*60*60*1000);
  var m=jst.getUTCHours()*60+jst.getUTCMinutes();
  if(m<8*60||m>=15*60+30) return null;
  if(m<9*60) return "寄り前気配";
  if(m>=11*60+30&&m<12*60+30) return "昼休み・後場の気配";
  return ""; // 取引時間中は補足ラベルなし
}
function calcBoardScore(quote,price){
  var session=boardSessionLabel();
  if(session==null) return null;
  if(!quote||quote.stale) return null;
  var ob=parseOrderBookLevels(quote);
  var totalVol=ob.buyVol+ob.sellVol;
  if(!ob.found||totalVol<=0) return null;

  var adj=0,items=[];

  // ① 売買比率：板全体の注文のうち買い注文が何%を占めるか
  var buyRatio=ob.buyVol/totalVol*100;
  if(buyRatio>=65){adj+=8;items.push({label:"買い注文が厚い",val:buyRatio.toFixed(0)+"%",state:1});}
  else if(buyRatio>=55){adj+=4;items.push({label:"やや買い優勢",val:buyRatio.toFixed(0)+"%",state:1});}
  else if(buyRatio<=35){adj-=8;items.push({label:"売り注文が厚い",val:buyRatio.toFixed(0)+"%",state:-1});}
  else if(buyRatio<=45){adj-=4;items.push({label:"やや売り優勢",val:buyRatio.toFixed(0)+"%",state:-1});}
  else{items.push({label:"売買は拮抗",val:buyRatio.toFixed(0)+"%",state:0});}

  // ② 現在値のすぐ近く(1%以内)に極端に厚い注文があるか
  // 　買い側にあれば下支え(加点)、売り側にあれば上値の重し(減点)
  if(price>0){
    var nearBuy=findBoardMatch(price,findThickLevels(ob.buyLevels));
    var nearSell=findBoardMatch(price,findThickLevels(ob.sellLevels));
    if(nearBuy){adj+=4;items.push({label:"すぐ下に大口の買い",val:Math.round(nearBuy.price).toLocaleString()+"円",state:1});}
    if(nearSell){adj-=4;items.push({label:"すぐ上に大口の売り",val:Math.round(nearSell.price).toLocaleString()+"円",state:-1});}
  }

  return {adj:adj,items:items,session:session,buyVol:ob.buyVol,sellVol:ob.sellVol};
}

// ── 板スコア補正パネル：元スコアと補正後スコアを並べて表示 ──────────────────
function BoardScorePanel(p){
  var b=p.board;
  if(!b) return null;
  var base=Math.round(p.baseScore||0);
  var adjusted=Math.min(100,Math.max(0,base+b.adj));
  var col=b.adj>0?"#22d3a0":b.adj<0?"#f43f5e":"#6a90b0";
  return(
    <div style={{background:"#071428",borderRadius:8,padding:"8px 12px",display:"flex",flexDirection:"column",gap:4}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <span style={{fontSize:11,fontWeight:700,color:"#4a7090"}}>📡 板スコア補正{b.session?"（"+b.session+"）":""}</span>
        <span style={{fontSize:13,fontWeight:800,color:col}}>{base} → {adjusted}（{b.adj>0?"+":""}{b.adj}）</span>
      </div>
      {b.items.map(function(it,i){
        var c=it.state>0?"#22d3a0":it.state<0?"#f43f5e":"#6a90b0";
        return(
          <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#a8c4e0"}}>
            <span>{it.label}</span><b style={{color:c}}>{it.val}</b>
          </div>
        );
      })}
    </div>
  );
}

function SupportZoneRow(p){
  var c=p.color||"#22d3a0";
  var priceColor=p.priceColor||"#d8eeff";
  return(
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:10,padding:"4px 0",borderBottom:"1px solid #0e2038"}}>
      <span style={{color:"#8aa4c0"}}>{p.label}</span>
      <span style={{display:"flex",alignItems:"center",gap:6}}>
        {p.match&&<span style={{fontSize:9,color:c,background:c+"18",border:"1px solid "+c+"50",borderRadius:4,padding:"1px 5px",whiteSpace:"nowrap"}}>🧱重なり</span>}
        <b style={{color:priceColor,fontSize:11}}>{p.unit}{p.price.toLocaleString()}</b>
      </span>
    </div>
  );
}
// ── 🔮 統計ベース予想パネル（翌営業日＋今日の引けまで）──────────────────────
// AIの推測ではなく、蓄積した実績データ（シグナル別の平均騰落率）だけで目安を算出。
// 「今日の引けまで」版はイントラデイ実績が貯まると自動で数値表示に切り替わる
function StatForecastPanel(p){
  var s=p.s;
  if(!s||!s.signals||s.rawPrice==null) return null;
  var price=s.rawPrice,isJP=s.market==="JP";
  function fmtP(v){return isJP?Math.round(v).toLocaleString():v.toFixed(2);}
  // この銘柄自身の「1日の動きやすさ」＝スコア履歴の日次変化率の平均（レンジ表示用）
  var dailyVol=(function(){
    var h=s.scoreHist||[],sum=0,n=0;
    for(var i=0;i<h.length-1;i++){
      if(h[i].p!=null&&h[i+1].p!=null&&h[i].p>0){sum+=Math.abs((h[i+1].p-h[i].p)/h[i].p*100);n++;}
    }
    return n>=3?sum/n:null;
  })();
  var next=calcStatForecast(s.signals,getUniverseSignalStats());
  var session=currentSessionLabel();
  var today=session!=="時間外"?calcStatForecast(s.signals,getIntradaySignalStats()):null;
  function dirInfo(upRate){
    if(upRate>=55)return{label:"上昇寄り",color:"#22d3a0"};
    if(upRate<=45)return{label:"下落寄り",color:"#f43f5e"};
    return{label:"ほぼ中立",color:"#fbbf24"};
  }
  // 目安価格が手前の抵抗線/支持線を越えていたら注意書きを返す（案3：現実的な天井/床チェック）
  function levelWarn(expPct,target){
    if(expPct>0&&s.resistance){
      var up=[{v:s.resistance.r1,name:"20日高値"},{v:s.resistance.atrCeil,name:"ATR上限"}]
        .filter(function(c){return c.v!=null&&c.v>price;}).sort(function(a,b){return a.v-b.v;});
      if(up.length&&target>up[0].v)return"⚠️ 手前の"+fmtP(up[0].v)+"（"+up[0].name+"）に抵抗 → 目安が頭打ちになる可能性";
    }
    if(expPct<0&&s.support){
      var dn=[{v:s.support.s1,name:"20日安値"},{v:s.support.atrFloor,name:"ATR下限"}]
        .filter(function(c){return c.v!=null&&c.v<price;}).sort(function(a,b){return b.v-a.v;});
      if(dn.length&&target<dn[0].v)return"⚠️ 手前の"+fmtP(dn[0].v)+"（"+dn[0].name+"）に支持 → 下げ止まる可能性";
    }
    return null;
  }
  function renderRow(titleLabel,f,withRange){
    if(!f.ready){
      return(
        <div key={titleLabel} style={{fontSize:10,color:"#4a7090",marginBottom:3}}>{titleLabel}：📥 データ蓄積中（実績が十分＝10件かつ5営業日以上のシグナルが{f.used}/3種類）。スキャンを重ねると自動で表示が始まります</div>
      );
    }
    var d=dirInfo(f.upRate);
    var target=price*(1+f.expPct/100);
    var warn=levelWarn(f.expPct,target);
    var lo=withRange&&dailyVol!=null?price*(1+(f.expPct-dailyVol)/100):null;
    var hi=withRange&&dailyVol!=null?price*(1+(f.expPct+dailyVol)/100):null;
    return(
      <div key={titleLabel} style={{marginBottom:3}}>
        <div style={{display:"flex",alignItems:"baseline",gap:6,flexWrap:"wrap"}}>
          <span style={{fontSize:10,color:"#8aa8c8",whiteSpace:"nowrap"}}>{titleLabel}</span>
          <span style={{fontSize:10,fontWeight:700,color:d.color}}>{d.label}（過去傾向 上昇{f.upRate}%・{f.totalN}件）</span>
        </div>
        <div style={{fontSize:11,color:"#d8eeff",fontWeight:700,marginTop:1}}>
          目安 {(f.expPct>=0?"+":"")+f.expPct.toFixed(1)}%（{fmtP(target)}前後）
          {lo!=null&&<span style={{fontSize:9,color:"#4a7090",fontWeight:400,marginLeft:11}}>レンジ {fmtP(lo)}〜{fmtP(hi)}</span>}
        </div>
        {warn&&<div style={{fontSize:9,color:"#fbbf24",marginTop:1}}>{warn}</div>}
      </div>
    );
  }
  return(
    <div onClick={p.onInfoClick} style={{background:"#071428",border:"1px solid #2a4060",borderRadius:8,padding:"5px 8px",cursor:"pointer"}}>
      <div style={{fontSize:10,fontWeight:700,color:"#4a90c0",marginBottom:3}}>🔮 統計ベースの目安（過去実績のみで算出・AI不使用）</div>
      {/* 左揃えの2段組み（上＝今日の引けまで／下＝翌営業日）。横2列だと幅が狭く折り返すため */}
      <div style={{display:"flex",flexDirection:"column",gap:3,textAlign:"left"}}>
        <div style={{minWidth:0}}>
          {today?renderRow("今日の引けまで",today,false):(
            <div style={{fontSize:9,color:"#2a6090",marginBottom:4}}>「今日の引けまで」版は取引時間中（9:00〜15:30）のみ表示されます</div>
          )}
        </div>
        <div style={{minWidth:0,borderTop:"1px solid #16283f",paddingTop:3}}>
          {renderRow("翌営業日",next,true)}
        </div>
      </div>
    </div>
  );
}
// ── 買値パネル（デイトレ用・エントリー1本／横1行コンパクト表示）──────
function BuyPlanPanel(p){
  var isMobile=useIsMobile();
  var b=p.plan;
  if(!b) return null;
  var isJP=p.isJP;
  var unit=isJP?"\u00a5":"$";
  var f=function(v){return unit+(isJP?Math.round(v).toLocaleString():v.toFixed(2));};
  var MODE={
    now:{label:"\u25b6 今すぐ追随",color:"#22d3a0"},
    "break":{label:"\u2934 上抜け待ち",color:"#0ea5e9"}
  };
  var m=MODE[b.mode]||MODE.now;
  var sub={fontSize:isMobile?12:13,fontWeight:800,lineHeight:1.1};
  return(
    <div style={{background:"#071428",border:"1px solid "+m.color+"70",borderRadius:8,padding:isMobile?"5px 8px":"6px 10px"}}>
      <div style={{display:"flex",alignItems:"center",gap:isMobile?7:10,flexWrap:"nowrap"}}>
        <span style={{fontSize:isMobile?10:11,fontWeight:700,color:m.color,whiteSpace:"nowrap",flexShrink:0}}>💰{m.label}</span>
        <span style={{fontSize:isMobile?20:24,fontWeight:800,color:"#e0f0ff",lineHeight:1,flexShrink:0}}>{f(b.entry)}</span>
        <div style={{display:"flex",gap:6,marginLeft:"auto",flexShrink:0}}>
          <div style={{background:"#052e16",borderRadius:5,padding:"3px 7px",textAlign:"right"}}>
            <div style={{fontSize:9,color:"#22d3a0",lineHeight:1}}>🎯利確 +{b.gainPct}%</div>
            <div style={Object.assign({color:"#22d3a0"},sub)}>{f(b.target)}</div>
          </div>
          <div style={{background:"#1f0010",borderRadius:5,padding:"3px 7px",textAlign:"right"}}>
            <div style={{fontSize:9,color:"#f43f5e",lineHeight:1}}>🛑損切り −{b.lossPct}%</div>
            <div style={Object.assign({color:"#f43f5e"},sub)}>{f(b.stop)}</div>
          </div>
        </div>
      </div>
      <div style={{fontSize:9,color:"#4a7090",marginTop:3,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
        {b.reason}{b.rr!=null&&" ／ リスクリワード 1:"+b.rr}
        {b.atrDaily>0&&" ／ 日足ATR "+(isJP?"\u00a5"+Math.round(b.atrDaily):"$"+b.atrDaily.toFixed(2))}
        {b.warn&&<span style={{color:"#fb923c"}}>{" ／ ⚠️"+b.warn}</span>}
      </div>
    </div>
  );
}
function SupportZonePanel(p){
  var support=p.support,resistance=p.resistance,profitLoss=p.profitLoss;
  if(!support&&!resistance) return null;
  var unit=p.isJP?"¥":"$";
  var ob=parseOrderBookLevels(p.quote);
  var thickBuy=findThickLevels(ob.buyLevels);
  var thickSell=findThickLevels(ob.sellLevels);
  var maxBuy=maxLevel(ob.buyLevels),maxSell=maxLevel(ob.sellLevels);
  var box={background:"#071428",border:"1px solid #2a4060",borderRadius:8,padding:"8px 10px",cursor:"pointer"};
  return(
    <div style={box} onClick={p.onInfoClick}>
      <div style={{fontSize:11,fontWeight:700,color:"#4a90c0",marginBottom:4}}>🎯 サポートゾーン</div>
      {support&&(<>
        {maxBuy&&<SupportZoneRow label="買い厚め" price={maxBuy.price} unit={unit} priceColor="#fbbf24"/>}
        <SupportZoneRow label="S1(20日安値)" price={support.s1} unit={unit} color="#22d3a0" match={findBoardMatch(support.s1,thickBuy)}/>
        <SupportZoneRow label="ATR下限(×1.5)" price={support.atrFloor} unit={unit} color="#22d3a0" match={findBoardMatch(support.atrFloor,thickBuy)}/>
        {profitLoss&&<SupportZoneRow label="ATR損切(×0.75)" price={profitLoss.stop} unit={unit} priceColor="#f43f5e"/>}
      </>)}
      {resistance&&(<>
        <div style={{fontSize:9,color:"#4a7090",margin:"6px 0 2px"}}>▲ レジスタンス（上値目安）</div>
        {maxSell&&<SupportZoneRow label="売り厚め" price={maxSell.price} unit={unit} priceColor="#fbbf24"/>}
        <SupportZoneRow label="R1(20日高値)" price={resistance.r1} unit={unit} color="#f43f5e" match={findBoardMatch(resistance.r1,thickSell)}/>
        {profitLoss
          ?<SupportZoneRow label="ATR利確(×1.5)" price={profitLoss.target} unit={unit} priceColor="#22d3a0"/>
          :<SupportZoneRow label="ATR上限(×1.5)" price={resistance.atrCeil} unit={unit} color="#f43f5e" match={findBoardMatch(resistance.atrCeil,thickSell)}/>
        }
      </>)}
    </div>
  );
}

function StockDetailPanel(p){
  var s=p.s,toggleFav=p.toggleFav,isFav=p.isFav,onRescan=p.onRescan,rescanLoading=p.rescanLoading;
  if(!s){
    return(
      <div style={{textAlign:"center",padding:"60px 20px",color:"#2a6090"}}>
        <div style={{fontSize:32,marginBottom:12}}>👈</div>
        <div style={{fontSize:15,color:"#4a90c0"}}>銘柄を選択してください</div>
      </div>
    );
  }
  var isUp=parseFloat(s.change)>=0;
  var isMobile=useIsMobile();
  var mc=MKT[s.market]||MKT["US"];
  var bc=BADGE[s.timing];
  var borderColor=s.score>=58?"#22d3a0":s.score>=38?"#fbbf24":"#f43f5e";
  var fromHighColor=s.fromHigh>=-10?"#f43f5e":s.fromHigh>=-30?"#fbbf24":"#22d3a0";
  var fromLowColor=s.fromLow<=20?"#22d3a0":s.fromLow<=50?"#fbbf24":"#f43f5e";
  var pos52=s.position52!=null?Math.min(98,Math.max(2,s.position52)):null;
  var pos52Color=pos52!=null?(pos52<=25?"#22d3a0":pos52<=75?"#fbbf24":"#f43f5e"):null;
  var star=starStyle(s.ticker,isFav,p.appTrades,p.personalTrades);

  // チャート（1分足＋25期・75期の短期MA）：この銘柄が選択された時に取得
  // intraday: undefined=読込中, null=データなし, オブジェクト=取得済み
  var intradayS=useState(undefined);var intraday=intradayS[0],setIntraday=intradayS[1];
  var liveTickS=useState(null);var liveTick=liveTickS[0],setLiveTick=liveTickS[1]; // 立花証券リアルタイム値をチャートにも反映
  var tachibanaQuoteS=useState(null);var tachibanaQuote=tachibanaQuoteS[0],setTachibanaQuote=tachibanaQuoteS[1]; // 株価タップ時のモーダル表示用の生データ
  var showTachibanaS=useState(false);var showTachibana=showTachibanaS[0],setShowTachibana=showTachibanaS[1];
  var dailyS=useState(undefined);var daily=dailyS[0],setDaily=dailyS[1]; // 出来高急増後の値動きパターン分析用（過去1年日足）
  var chartModeS=useState("1m");var chartMode=chartModeS[0],setChartMode=chartModeS[1]; // "1m"=1分足 / "1d"=日足6ヶ月
  useEffect(function(){
    setIntraday(undefined);
    setLiveTick(null);
    setTachibanaQuote(null);
    setDaily(undefined);
    fetchIntraday(s.ticker).then(function(r){setIntraday(r);});
    fetchDaily(s.ticker).then(function(r){setDaily(r);});
    if(onRescan) onRescan(s.ticker); // カードの価格・判定バッジもチャートと同様に毎回最新化
  },[s.ticker]);

  var showSimS=useState(false);var showSim=showSimS[0],setShowSim=showSimS[1];
  var showTradeS=useState(false);var showTrade=showTradeS[0],setShowTrade=showTradeS[1];
  var tradePrefillS=useState(null);var tradePrefill=tradePrefillS[0],setTradePrefill=tradePrefillS[1]; // AI提案からトレード登録を開いた時の初期値
  var simSharesS=useState("100");var simShares=simSharesS[0],setSimShares=simSharesS[1];
  var simBuyS=useState(s.rawPrice?s.rawPrice.toFixed(2):"");var simBuy=simBuyS[0],setSimBuy=simBuyS[1];
  useEffect(function(){var isJP=s.market==="JP";setSimBuy(s.rawPrice?(isJP?String(Math.round(s.rawPrice)):s.rawPrice.toFixed(2)):"");},[s.ticker]);
  var simTargetS=useState(3);var simTarget=simTargetS[0],setSimTarget=simTargetS[1];
  var simStopS=useState(-5);var simStop=simStopS[0],setSimStop=simStopS[1];
  var simTargetInputS=useState("3");var simTargetInput=simTargetInputS[0],setSimTargetInput=simTargetInputS[1];
  var simStopInputS=useState("-5");var simStopInput=simStopInputS[0],setSimStopInput=simStopInputS[1];
  var showAiS=useState(false);var showAi=showAiS[0],setShowAi=showAiS[1];
  var showSupportInfoS=useState(false);var showSupportInfo=showSupportInfoS[0],setShowSupportInfo=showSupportInfoS[1];
  var showStatInfoS=useState(false);var showStatInfo=showStatInfoS[0],setShowStatInfo=showStatInfoS[1];
  var aiTextS=useState("");var aiText=aiTextS[0],setAiText=aiTextS[1];
  var aiLoadingS=useState(false);var aiLoading=aiLoadingS[0],setAiLoading=aiLoadingS[1];

  var aiEntryS=useState(null);var aiEntry=aiEntryS[0],setAiEntry=aiEntryS[1];

  async function runAiAnalysis(){
    if(aiLoading) return;
    setShowAi(true);setAiLoading(true);setAiText("");setAiEntry(null);
    await callAiAnalysis(s,setAiText,setAiEntry,setAiLoading);
  }

  var promptCopiedS=useState(false);var promptCopied=promptCopiedS[0],setPromptCopied=promptCopiedS[1];
  function copyTradePrompt(){
    if(!navigator.clipboard) return;
    navigator.clipboard.writeText(buildVolumeRankingPrompt([s],1,false)).then(function(){
      setPromptCopied(true);
      setTimeout(function(){setPromptCopied(false);},2000);
    }).catch(function(){});
  }

  // 板スコア補正（日本株のみ。板が届いていない間はnullでパネル非表示）
  var boardPrice=(liveTick&&liveTick.price!=null)?liveTick.price:s.rawPrice;
  var boardScore=s.market==="JP"?calcBoardScore(tachibanaQuote,boardPrice):null;

  // 板の勢い用：気配値が更新されるたびに履歴へ記録する（日本株のみ）
  useEffect(function(){
    if(s.market==="JP") pushBoardHistory(s.ticker,tachibanaQuote);
  },[tachibanaQuote]);

  return(
    <div style={{background:"#050e1c",border:"none",borderRadius:10,padding:"14px",display:"flex",flexDirection:"column",gap:10}}>
      <div style={{display:"flex",gap:6,alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex",gap:6,alignItems:"center",minWidth:0,flex:1}}>
          <ScoreRing score={s.score}/>
          <div style={{minWidth:0}}>
            <div style={{display:"flex",gap:4,alignItems:"center",flexWrap:"wrap"}}>
              <span style={bStyle(mc.bg,mc.border,mc.text)}>{mc.label}</span>
              <span style={{fontSize:isMobile?12:15,fontWeight:800,color:"#d8eeff"}}>{s.ticker.replace(".T","")}</span>
              {s.tradeLabel&&<span style={bStyle("#0a0a1a","1px solid "+s.tradeColor,s.tradeColor)}>{s.tradeLabel}</span>}
              {(function(){var ei=earningsInfo(s.earningsDate);return ei&&<span style={bStyle(ei.urgent?"#3a0a0a":"#1c1400","1px solid "+(ei.urgent?"#f43f5e":"#fbbf24"),ei.urgent?"#f87171":"#fbbf24")} title={"決算発表: "+ei.date}>📈決算{ei.label}</span>;})()}
              {(function(){var xi=exRightsInfo(s.exRightsDate);return xi&&<span style={bStyle("#0a1a3a","1px solid #3b82f6","#60a5fa")} title={"権利落ち予想: "+xi.date}>💰権利落ち(予想){xi.label}</span>;})()}
          {(function(){var ri=relStrengthInfo(s.relStrength);return ri&&<span style={bStyle(ri.strong?"#052e16":"#1f0010","1px solid "+(ri.strong?"#22d3a0":"#f43f5e"),ri.strong?"#22d3a0":"#f43f5e")} title={"対TOPIX相対(前日比差): "+ri.label}>{ri.strong?"🔥対TOPIX":"🧊対TOPIX"}{ri.label}</span>;})()}{(function(){var dn=DAYNIGHT[s.ticker];if(!dn)return null;var pos=dn.day>0;return <span style={bStyle(pos?"#052e16":"#101826","1px solid "+(pos?"#22d3a0":"#2a4060"),pos?"#22d3a0":"#4a7090")} title={"過去1年の値動きの分解（"+dn.days+"日分）: 日中(始値→終値)の累積"+(dn.day>=0?"+":"")+dn.day+"% / 夜間(前日終値→始値)の累積"+(dn.night>=0?"+":"")+dn.night+"%。日中分がプラスなら、持ち越さないデイトレと相性が良い日中型"}>{(pos?"☀️日中+":"🌙日中")+dn.day+"%"}</span>;})()}
          {(function(){var si=relStrengthInfo(s.sectorRelStrength);return si&&<span style={bStyle(si.strong?"#052e16":"#1f0010","1px solid "+(si.strong?"#22d3a0":"#f43f5e"),si.strong?"#22d3a0":"#f43f5e")} title={"対"+(s.sectorName||"業種")+"相対(前日比差): "+si.label}>{si.strong?"🔥対業種":"🧊対業種"}{si.label}</span>;})()}
          {(function(){var sf=scalpFitInfo(s);return sf&&<span style={bStyle("#2a1400","1px solid #fb923c","#fb923c")} title={"スキャル・デイトレに不向きな可能性："+sf.label+"（出来高とATR%のみの簡易判定。板情報・スプレッドは考慮していません）"}>⚠️{sf.label}</span>;})()}
            </div>
            <div style={{fontSize:13,color:"#4a7090",marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.name}</div>
          </div>
        </div>
        <div style={{display:"flex",gap:4,alignItems:"center"}}>
          <button onClick={function(){toggleFav(s.ticker);}} style={{background:"transparent",border:"none",fontSize:15,cursor:"pointer",padding:0,color:star.color}}>{star.symbol}</button>
          {p.onClose&&<button onClick={p.onClose} style={{background:"transparent",border:"none",fontSize:22,cursor:"pointer",padding:"0 0 0 8px",color:"#4a7090",lineHeight:1}}>✕</button>}
        </div>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",background:"#071428",borderRadius:8,padding:"10px 14px"}}>
        <div onClick={function(){if(s.market==="JP") setShowTachibana(true);}} style={s.market==="JP"?{cursor:"pointer"}:null}>
          <span style={{fontSize:isMobile?14:18,fontWeight:800,color:"#d8eeff"}}>{liveTick&&liveTick.price!=null?fmtMoney(liveTick.price,true):s.price}</span>
          {liveTick&&liveTick.price!=null&&<span style={{fontSize:9,fontWeight:700,color:"#22d3a0",marginLeft:6}}>● LIVE</span>}
          {s.market==="JP"&&<span style={{fontSize:9,color:"#4a7090",marginLeft:6}}>📡詳細</span>}
          {s.market==="US"&&p.usdJpy&&<div style={{fontSize:13,color:"#4a7090"}}>¥{Math.round(s.rawPrice*p.usdJpy).toLocaleString()}</div>}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={bStyle(bc.bg,bc.border,bc.text)}>{bc.label}</span>
          {s.real!==false&&(function(){
            var pct=liveTick&&liveTick.changePct!=null?liveTick.changePct:parseFloat(s.change);
            var up=pct>=0;
            return <span style={{fontSize:isMobile?12:15,fontWeight:700,color:up?"#22d3a0":"#f43f5e"}}>{up?"▲":"▼"}{Math.abs(pct).toFixed(2)}%</span>;
          })()}
        </div>
      </div>


      <BuyPlanPanel plan={s.buyPlan} isJP={s.market==="JP"} intraday={intraday}/>

      {s.market==="JP"&&<TachibanaBoard ticker={s.ticker} onQuote={function(q){
        // 受信イベントには「全項目入り(FD等)」と「価格だけの軽量な更新」があり、
        // 後者を受けた時に丸ごと置き換えると気配値など前回までの情報が消えてしまうため、
        // 既存のfieldsに新しい値を上書きする形でマージする
        setTachibanaQuote(function(prev){
          var merged=Object.assign({},prev&&prev.fields,q.fields);
          return {fields:merged,updatedAt:q.updatedAt,stale:q.stale};
        });
        var f=q.fields||{};
        if(f["p_1_DPP"]!=null) setLiveTick({
          price:parseFloat(f["p_1_DPP"]),
          time:f["p_1_DPP:T"]||"",
          changePct:f["p_1_DYRP"]!=null?parseFloat(f["p_1_DYRP"]):null,
        });
      }}/>}

      <div style={{display:"flex",gap:4,alignItems:"center",overflowX:"auto",WebkitOverflowScrolling:"touch",paddingBottom:2}}>
        <a href={s.yahooUrl} target="_blank" rel="noreferrer" title="Yahoo!ファイナンス" style={{flexShrink:0,background:"#071428",border:"1px solid #4f46e5",borderRadius:6,color:"#a5b4fc",padding:"4px 9px",fontSize:12,fontWeight:700,fontFamily:"monospace",textDecoration:"none"}}>🔗</a>
        <a href="ispeed://" onClick={function(){var code=s.ticker.replace(".T","");if(navigator.clipboard){navigator.clipboard.writeText(code).catch(function(){});}}} title="iSPEED（銘柄コードをコピー）" style={{flexShrink:0,background:"#1a0a0a",border:"1px solid #f87171",borderRadius:6,color:"#fca5a5",padding:"4px 9px",fontSize:12,fontWeight:700,fontFamily:"monospace",textDecoration:"none"}}>📱</a>
        <div style={{flexShrink:0,width:30}}/>
        <button onClick={copyTradePrompt} title="判定プロンプトをコピー" style={{flexShrink:0,background:promptCopied?"#052e16":"transparent",border:"1px solid "+(promptCopied?"#22d3a0":"#2a4060"),borderRadius:6,color:promptCopied?"#22d3a0":"#4a7090",padding:"4px 9px",fontSize:14,cursor:"pointer"}}>{promptCopied?"✓":"📋"}</button>
        <button onClick={function(){if(onRescan&&!rescanLoading)onRescan(s.ticker);}} disabled={rescanLoading} title="再スキャン" style={{flexShrink:0,background:"transparent",border:"1px solid "+(rescanLoading?"#fbbf24":"#2a4060"),borderRadius:6,color:rescanLoading?"#fbbf24":"#4a7090",padding:"4px 9px",fontSize:14,cursor:rescanLoading?"not-allowed":"pointer"}}>{rescanLoading?"⏳":"🔄"}</button>
        <button onClick={runAiAnalysis} disabled={aiLoading} title="AI相談" style={{flexShrink:0,background:"transparent",border:"1px solid "+(aiLoading?"#22d3a0":"#2a4060"),borderRadius:6,color:aiLoading?"#22d3a0":"#4a7090",padding:"4px 9px",fontSize:14,cursor:aiLoading?"not-allowed":"pointer"}}>{aiLoading?"⏳":"🤖"}</button>
        <button onClick={function(){setShowSim(function(v){return !v;});}} title="シミュレーター" style={{flexShrink:0,background:showSim?"#1a0a3a":"transparent",border:"1px solid "+(showSim?"#a78bfa":"#2a4060"),borderRadius:6,color:showSim?"#a78bfa":"#4a7090",padding:"4px 9px",fontSize:14,cursor:"pointer"}}>💹</button>
        <button onClick={function(){setTradePrefill(null);setShowTrade(function(v){return !v;});}} title="トレード登録" style={{flexShrink:0,background:showTrade?"#0a1a3a":"transparent",border:"1px solid "+(showTrade?"#0ea5e9":"#2a4060"),borderRadius:6,color:showTrade?"#0ea5e9":"#4a7090",padding:"4px 9px",fontSize:14,cursor:"pointer"}}>🎯</button>
      </div>

      {/* チャート（1分足／日足6ヶ月＋予測レンジ を切替） */}
      <div style={{background:"#03080f",borderRadius:6,padding:"4px 6px",marginTop:-6}}>
        <div style={{display:"flex",gap:6,padding:"2px 0 4px"}}>
          <TabBtn active={chartMode==="1m"} color="#38bdf8" label="1分足" onClick={function(){setChartMode("1m");}}/>
          <TabBtn active={chartMode==="1d"} color="#38bdf8" label="日足＋予測" onClick={function(){setChartMode("1d");}}/>
        </div>
        {chartMode==="1m"
          ? <IntradayChart1m data={intraday} liveTick={liveTick} height={isMobile?150:250} aiEntry={aiEntry}/>
          : <DailyChartWithBand daily={daily} height={isMobile?150:250}/>}
      </div>

            {/* シグナル詳細（出来高急増後の値動きを内包）／板情報・利確損切りライン（右） */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:isMobile?6:10,alignItems:"start"}}>
        <div style={{minWidth:0,display:"flex",flexDirection:"column",gap:5}}>
          {/* 統計ベースの目安（シグナル詳細と同じ左列・同じ幅） */}
          <StatForecastPanel s={s} onInfoClick={function(){setShowStatInfo(true);}}/>
          <SignalDetailList signals={s.signals} breakdown={s.breakdown} daily={daily}/>
        </div>
        <div style={{minWidth:0,display:"flex",flexDirection:"column",gap:5}}>
          <BoardScorePanel board={boardScore} baseScore={s.score}/>
          <BoardMomentumPanel ticker={s.ticker} isJP={s.market==="JP"} quote={tachibanaQuote}/>
          <SupportZonePanel support={s.support} resistance={s.resistance} profitLoss={s.profitLoss} quote={tachibanaQuote} isJP={s.market==="JP"} onInfoClick={function(){setShowSupportInfo(true);}}/>
        </div>
      </div>

      {showAi&&createPortal(
        <div onClick={function(e){if(e.target===e.currentTarget){setShowAi(false);}}} style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:2000,display:"flex",alignItems:"center",justifyContent:isMobile?"center":"flex-end",padding:16,paddingRight:isMobile?16:"56vw"}}>
          <div style={{background:"#040c18",border:"1px solid #22d3a050",borderRadius:16,padding:"16px",width:"100%",maxWidth:520,maxHeight:"85vh",overflowY:"auto",WebkitOverflowScrolling:"touch",boxShadow:"0 8px 30px rgba(0,0,0,0.6)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                <div style={{fontSize:14,fontWeight:700,color:"#22d3a0"}}>🤖 AI分析</div>
                {s.scoreHist&&(<span style={{fontSize:9,padding:"1px 5px",borderRadius:4,
                  background:s.scoreHist.length>=7?"#052e16":s.scoreHist.length>=3?"#1c1400":"#1f0010",
                  color:s.scoreHist.length>=7?"#22d3a0":s.scoreHist.length>=3?"#fbbf24":"#f43f5e",
                  border:"1px solid "+(s.scoreHist.length>=7?"#22d3a0":s.scoreHist.length>=3?"#fbbf24":"#f43f5e")}}>
                  {s.scoreHist.length>=7?"精度◎":s.scoreHist.length>=3?"精度△("+s.scoreHist.length+"日)":"精度⚠️("+s.scoreHist.length+"日)"}
                </span>)}
              </div>
              <button onClick={function(){setShowAi(false);}} style={{background:"transparent",border:"none",color:"#4a7090",fontSize:18,cursor:"pointer",lineHeight:1}}>✕</button>
            </div>
            {aiLoading&&!aiText?(<div style={{textAlign:"center",padding:"12px 0"}}><div style={{fontSize:18}}>⏳</div><div style={{fontSize:14,color:"#4a90c0",marginTop:4}}>AIが分析中...</div></div>):(<div style={{fontSize:15,color:"#b8cce0",lineHeight:1.7,whiteSpace:"pre-wrap"}}>{aiText}{aiLoading&&<span style={{color:"#22d3a0"}}>▌</span>}</div>)}
            {!aiLoading&&aiEntry&&(
              <div style={{background:"#071428",border:"1px solid #4a90c040",borderRadius:8,padding:"8px 10px",marginTop:8}}>
                <div style={{fontSize:11,fontWeight:700,color:"#4a90c0",marginBottom:6}}>🎯 AIエントリー提案</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
                  <div style={{background:"#052e16",border:"1px solid #22d3a040",borderRadius:6,padding:"5px 8px"}}><div style={{fontSize:10,color:"#22d3a0"}}>📥 エントリー</div><div style={{fontSize:14,fontWeight:800,color:"#22d3a0"}}>{s.market==="JP"?"¥"+Math.round(aiEntry.entry).toLocaleString():"$"+parseFloat(aiEntry.entry).toFixed(2)}</div></div>
                  <div style={{background:"#071e10",border:"1px solid #22d3a040",borderRadius:6,padding:"5px 8px"}}><div style={{fontSize:10,color:"#22d3a0"}}>🎯 利確</div><div style={{fontSize:14,fontWeight:800,color:"#22d3a0"}}>{s.market==="JP"?"¥"+Math.round(aiEntry.target).toLocaleString():"$"+parseFloat(aiEntry.target).toFixed(2)}</div></div>
                  <div style={{background:"#1f0010",border:"1px solid #f43f5e40",borderRadius:6,padding:"5px 8px"}}><div style={{fontSize:10,color:"#f43f5e"}}>🛑 損切り</div><div style={{fontSize:14,fontWeight:800,color:"#f43f5e"}}>{s.market==="JP"?"¥"+Math.round(aiEntry.stop).toLocaleString():"$"+parseFloat(aiEntry.stop).toFixed(2)}</div></div>
                </div>
              </div>
            )}
            {!aiLoading&&aiEntry&&(
              <button onClick={function(){setTradePrefill({buy:aiEntry.entry,sell:aiEntry.target,stop:aiEntry.stop});setShowAi(false);setShowTrade(true);}} style={{width:"100%",marginTop:8,background:"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:8,color:"#fff",padding:"9px",fontSize:13,fontWeight:700,cursor:"pointer"}}>🎯 AI提案でトレード登録</button>
            )}
            {!aiLoading&&aiEntry&&ForecastBox(aiEntry.forecast)}
            {!aiLoading&&aiText&&(<button onClick={runAiAnalysis} style={{marginTop:8,background:"transparent",border:"1px solid #1e4070",borderRadius:6,color:"#4a7090",padding:"4px 10px",fontSize:14,cursor:"pointer",fontFamily:"monospace",width:"100%"}}>🔄 再分析</button>)}
          </div>
        </div>
      ,document.body)}
      {showStatInfo&&createPortal(
        <div onClick={function(e){if(e.target===e.currentTarget)setShowStatInfo(false);}} style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:2000,display:"flex",alignItems:"center",justifyContent:isMobile?"center":"flex-end",padding:16,paddingRight:isMobile?16:"56vw"}}>
          <div style={{background:"#040c18",border:"1px solid #4a90c050",borderRadius:16,padding:"16px",width:"100%",maxWidth:520,maxHeight:"85vh",overflowY:"auto",WebkitOverflowScrolling:"touch",boxShadow:"0 8px 30px rgba(0,0,0,0.6)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <div style={{fontSize:14,fontWeight:700,color:"#4a90c0"}}>🔮 統計ベースの目安の見方</div>
              <button onClick={function(){setShowStatInfo(false);}} style={{background:"transparent",border:"none",color:"#4a7090",fontSize:18,cursor:"pointer",lineHeight:1}}>✕</button>
            </div>
            <div style={{fontSize:13,color:"#b8cce0",lineHeight:1.7}}>
              <div style={{marginBottom:10}}>今この銘柄で点灯しているシグナルについて、<b>過去に同じシグナルが出たあと実際に株価がどう動いたか</b>を集計して算出しています。AIの予測は一切使っていません。</div>
              <div style={{fontWeight:700,color:"#d8eeff",marginTop:12,marginBottom:4}}>算出のしかた</div>
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                <div>① 点灯中のシグナルごとに、過去の記録から「その後の平均騰落率」と「上昇した割合」を取り出す</div>
                <div>② 記録が10件未満、または5営業日分に満たないシグナルは信頼できないので除外する（同じ日に何十銘柄もスキャンした水増しを防ぐため）</div>
                <div>③ 残ったシグナルを<b>記録件数で重み付けして平均</b>する（1つのシグナルだけが効きすぎないよう、重みは30件分で頭打ち）</div>
                <div>④ その平均値を「目安 ±○%」「上昇○%」として表示。現在値に掛けた価格も併記する</div>
              </div>
              <div style={{fontWeight:700,color:"#d8eeff",marginTop:12,marginBottom:4}}>2種類の目安</div>
              <div style={{marginBottom:10}}>「今日の引けまで」は取引時間中（9:00〜15:30）だけ表示され、その日の中での値動きを予想します。「翌営業日」は翌日の終値までの予想で、日々の値幅から求めたレンジも併せて表示します。</div>
              <div style={{background:"#1c1400",border:"1px solid #fbbf2440",borderRadius:8,padding:"8px 10px",marginBottom:10}}>
                <b style={{color:"#fbbf24"}}>📥 データ蓄積中と出る場合</b><br/>信頼できるシグナルが3種類そろっていない状態です。スキャンを重ねて記録が溜まると自動で表示が始まり、続けるほど精度も上がります。
              </div>
              <div style={{color:"#8aa4c0"}}>※ あくまで過去データの統計的な傾向であり、将来の値動きを保証するものではありません。手前に節目（サポート・レジスタンス）がある場合は⚠️で注意書きが出ます。</div>
            </div>
          </div>
        </div>
      ,document.body)}
      {showSupportInfo&&createPortal(
        <div onClick={function(e){if(e.target===e.currentTarget)setShowSupportInfo(false);}} style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:2000,display:"flex",alignItems:"center",justifyContent:isMobile?"center":"flex-end",padding:16,paddingRight:isMobile?16:"56vw"}}>
          <div style={{background:"#040c18",border:"1px solid #4a90c050",borderRadius:16,padding:"16px",width:"100%",maxWidth:520,maxHeight:"85vh",overflowY:"auto",WebkitOverflowScrolling:"touch",boxShadow:"0 8px 30px rgba(0,0,0,0.6)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <div style={{fontSize:14,fontWeight:700,color:"#4a90c0"}}>🎯 サポートゾーンの見方</div>
              <button onClick={function(){setShowSupportInfo(false);}} style={{background:"transparent",border:"none",color:"#4a7090",fontSize:18,cursor:"pointer",lineHeight:1}}>✕</button>
            </div>
            <div style={{fontSize:13,color:"#b8cce0",lineHeight:1.7}}>
              <div style={{marginBottom:10}}>板の厚い注文だけだと分かるのは「今この瞬間、板のどこかに大きな買い注文がある」ということだけです。それが意味のある値段なのか、たまたまそこにあるだけなのかは分かりません。</div>
              <div style={{marginBottom:10}}>サポートゾーンだけだと分かるのは「チャート上でこの値段は過去に何度も意識されてきた節目（S1・ATR下限）」ということだけです。でも今まさに買いたい人がそこにいるかは分かりません。</div>
              <div style={{marginBottom:10}}>レジスタンス（R1・ATR上限）はこの逆で、直近高値やATR上限に、板の厚い<b>売り</b>注文が重なっているかを見ます。上値が重いかどうか＝戻り売りや利確の目安になります。</div>
              <div style={{marginBottom:10,color:"#d8eeff",fontWeight:700}}>この2つを重ねることで、「過去の実績」と「今の需給」が同じ値段で一致しているかどうかが分かります。「下げ止まりそうな場所」の根拠の強さです。</div>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                <div style={{background:"#052e16",border:"1px solid #22d3a040",borderRadius:8,padding:"8px 10px"}}>
                  <b style={{color:"#22d3a0"}}>🧱重なりバッジが出る</b><br/>節目と厚い買い注文が重なっている → 過去にも意識され、今も買いたい人がいる値段。根拠が2つ揃っているので、支えとして信頼度が高い
                </div>
                <div style={{background:"#1c1400",border:"1px solid #fbbf2440",borderRadius:8,padding:"8px 10px"}}>
                  <b style={{color:"#fbbf24"}}>バッジなし</b><br/>節目はあるが厚い注文が重なっていない → チャート的には節目でも、今この瞬間に買いが入っているわけではない。支えとしてはやや弱い、または見せ板の可能性も考慮した方がいい
                </div>
                <div style={{background:"#1f0010",border:"1px solid #f43f5e40",borderRadius:8,padding:"8px 10px"}}>
                  <b style={{color:"#f43f5e"}}>節目と無関係な厚い注文</b><br/>なぜそこに注文があるのか根拠が薄い。理由がわからない厚い注文は警戒対象
                </div>
              </div>
            </div>
          </div>
        </div>
      ,document.body)}
      {showSim&&createPortal((function(){
        var bp=parseFloat(simBuy)||0;var sh=parseFloat(simShares)||0;
        var isJP=s.market==="JP";
        function fmtP(v){return isJP?"¥"+Math.round(v).toLocaleString():"$"+v.toFixed(2);}
        function fmtPnL(v){
          if(isJP) return(v>=0?"+":"")+"¥"+Math.round(Math.abs(v)).toLocaleString();
          var jpy=p.usdJpy?Math.round(Math.abs(v)*p.usdJpy):null;
          return(v>=0?"+":"")+"$"+Math.abs(v).toFixed(2)+(jpy?"  (¥"+jpy.toLocaleString()+")":"");
        }
        var inpSim={background:"#040c18",border:"1px solid #1e4070",borderRadius:5,color:"#b8cce0",padding:"6px 8px",fontSize:16,fontFamily:"monospace",width:"100%",boxSizing:"border-box"};
        var scenarios=[{label:"損切りライン",pct:simStop,color:"#f43f5e"},{label:"-5%",pct:-5,color:"#fb923c"},{label:"+5%",pct:5,color:"#22d3a0"},{label:"+10%",pct:10,color:"#22d3a0"},{label:"+20%",pct:20,color:"#22d3a0"},{label:"目標価格",pct:simTarget,color:"#fbbf24"}];
        return(
          <div onClick={function(e){if(e.target===e.currentTarget)setShowSim(false);}} style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:2000,display:"flex",alignItems:"center",justifyContent:isMobile?"center":"flex-end",padding:16,paddingRight:isMobile?16:"56vw"}}>
            <div style={{background:"#040c18",border:"1px solid #a78bfa50",borderRadius:16,padding:"16px",width:"100%",maxWidth:520,maxHeight:"85vh",overflowY:"auto",WebkitOverflowScrolling:"touch",boxShadow:"0 8px 30px rgba(0,0,0,0.6)"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                <div style={{fontSize:14,fontWeight:700,color:"#a78bfa"}}>💹 損益シミュレーション</div>
                <button onClick={function(){setShowSim(false);}} style={{background:"transparent",border:"none",color:"#4a7090",fontSize:18,cursor:"pointer",lineHeight:1}}>✕</button>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                <div><div style={{fontSize:13,color:"#2a6090",marginBottom:3}}>買値</div><input style={inpSim} type="number" value={simBuy} onChange={function(e){setSimBuy(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter"){e.preventDefault();var v=parseFloat(simBuy);if(!isNaN(v)&&v>0){setSimBuy(String(v));}else{setSimBuy("");}e.target.blur();}}}/></div>
                <div><div style={{fontSize:13,color:"#2a6090",marginBottom:3}}>株数</div><input style={inpSim} type="number" value={simShares} onChange={function(e){setSimShares(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter"){e.preventDefault();var v=parseInt(simShares);if(!isNaN(v)&&v>0){setSimShares(String(v));}else{setSimShares("");}e.target.blur();}}}/></div>
              </div>
              {bp>0&&sh>0&&(
                <div>
                  <div style={{background:"#071428",borderRadius:6,padding:"6px 10px",fontSize:14,color:"#4a7090",marginBottom:8}}>投資総額: <span style={{color:"#d8eeff",fontWeight:700}}>{fmtP(bp*sh)}</span>{(!isJP&&p.usdJpy)&&<span style={{color:"#4a7090",fontSize:12}}>  (¥{Math.round(bp*sh*p.usdJpy).toLocaleString()})</span>}</div>
                  <div style={{marginBottom:6}}>
                    <div style={{fontSize:13,color:"#fbbf24",marginBottom:3}}>{fmtP(bp*(1+simTarget/100))}</div>
                    <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4}}>
                      <span style={{fontSize:13,color:"#4a7090",flexShrink:0}}>目標</span>
                      <input type="number" value={simTargetInput} onChange={function(e){setSimTargetInput(e.target.value);}} onBlur={function(){var v=parseInt(simTargetInput);if(!isNaN(v)&&v>=1&&v<=200){setSimTarget(v);setSimTargetInput(String(v));}else{setSimTargetInput(String(simTarget));}}} onKeyDown={function(e){if(e.key==="Enter"){var v=parseInt(simTargetInput);if(!isNaN(v)&&v>=1&&v<=200){setSimTarget(v);setSimTargetInput(String(v));}else{setSimTargetInput(String(simTarget));}e.target.blur();}}} style={{width:60,background:"#040c18",border:"1px solid #fbbf24",borderRadius:4,color:"#fbbf24",padding:"2px 6px",fontSize:16,fontFamily:"monospace",textAlign:"center"}}/>
                      <span style={{fontSize:13,color:"#fbbf24"}}>%</span>
                      <input type="range" min={1} max={200} value={simTarget} onChange={function(e){var v=parseInt(e.target.value);setSimTarget(v);setSimTargetInput(String(v));}} style={{flex:1,accentColor:"#fbbf24"}}/>
                    </div>
                  </div>
                  <div style={{marginBottom:8}}>
                    <div style={{fontSize:13,color:"#f43f5e",marginBottom:3}}>{fmtP(bp*(1+simStop/100))}</div>
                    <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4}}>
                      <span style={{fontSize:13,color:"#4a7090",flexShrink:0}}>損切り</span>
                      <input type="number" value={simStopInput} onChange={function(e){setSimStopInput(e.target.value);}} onBlur={function(){var v=parseInt(simStopInput);if(!isNaN(v)&&v>=-50&&v<=-1){setSimStop(v);setSimStopInput(String(v));}else{setSimStopInput(String(simStop));}}} onKeyDown={function(e){if(e.key==="Enter"){var v=parseInt(simStopInput);if(!isNaN(v)&&v>=-50&&v<=-1){setSimStop(v);setSimStopInput(String(v));}else{setSimStopInput(String(simStop));}e.target.blur();}}} style={{width:60,background:"#040c18",border:"1px solid #f43f5e",borderRadius:4,color:"#f43f5e",padding:"2px 6px",fontSize:16,fontFamily:"monospace",textAlign:"center"}}/>
                      <span style={{fontSize:13,color:"#f43f5e"}}>%</span>
                      <input type="range" min={-50} max={-1} value={simStop} onChange={function(e){var v=parseInt(e.target.value);setSimStop(v);setSimStopInput(String(v));}} style={{flex:1,accentColor:"#f43f5e"}}/>
                    </div>
                  </div>
                  <div style={{display:"flex",flexDirection:"column",gap:4}}>
                    {scenarios.sort(function(a,b){return a.pct-b.pct;}).map(function(sc,i){var pnl=(bp*(1+sc.pct/100)-bp)*sh;return(<div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",background:"#071428",borderRadius:6,padding:"5px 8px"}}><div><span style={{fontSize:14,color:sc.color,fontWeight:700}}>{sc.label}</span><span style={{fontSize:13,color:"#4a7090",marginLeft:4}}>{sc.pct>=0?"+":""}{sc.pct}%</span></div><span style={{fontSize:15,fontWeight:800,color:pnl>=0?"#22d3a0":"#f43f5e"}}>{fmtPnL(pnl)}</span></div>);})}
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })(),document.body)}

      {showTrade&&createPortal(<TradeAddModal s={s} onAddTrade={p.onAddTrade} prefill={tradePrefill} onClose={function(){setShowTrade(false);setTradePrefill(null);}}/>,document.body)}

      {showTachibana&&createPortal(<TachibanaQuoteModal quote={tachibanaQuote} onClose={function(){setShowTachibana(false);}}/>,document.body)}
    </div>
  );
}

// スマホ用：詳細パネルを全画面モーダルで表示（全銘柄／お気に入りタブ共通）
function MobileStockDetailModal(p){
  if(!p.s) return null;
  return createPortal(
    <div onClick={function(e){if(e.target===e.currentTarget)p.onClose();}} style={{position:"fixed",inset:0,zIndex:1500,background:"#040c18",overflowY:"auto",WebkitOverflowScrolling:"touch",padding:10}}>
      <StockDetailPanel key={p.s&&p.s.ticker} s={p.s} toggleFav={p.toggleFav} isFav={p.isFav} vix={p.vix} usdJpy={p.usdJpy} onRescan={p.onRescan} rescanLoading={p.rescanLoading} allStocks={p.allStocks} onAddTrade={p.onAddTrade} onClose={p.onClose} appTrades={p.appTrades} personalTrades={p.personalTrades}/>
    </div>,
    document.body
  );
}

// ── MarketBar ─────────────────────────────────────────────────────────────────
function MarketBar(){
  var dataS=useState({}); var data=dataS[0],setData=dataS[1];
  var loadingS=useState(true); var loading=loadingS[0],setLoading=loadingS[1];
  var isMobile=useIsMobile();
  var INDICES=[
    {key:"nikkei",  ticker:"^N225",   label:"日経平均",  prefix:"¥", round:true},
    {key:"dow",     ticker:"^DJI",    label:"NYダウ",    prefix:"$", round:true},
    {key:"sp500",   ticker:"^GSPC",   label:"S&P500",   prefix:"",  round:true},
    {key:"usdjpy",  ticker:"USDJPY=X",label:"ドル円",    prefix:"¥", round:false},
    {key:"vix",     ticker:"^VIX",    label:"VIX",      prefix:"",  round:false},
  ];
  useEffect(function(){
    Promise.all(INDICES.map(async function(idx){
      try{
        var res=await fetch("https://daytrade-simulator.vercel.app/api/stock?ticker="+encodeURIComponent(idx.ticker),{signal:AbortSignal.timeout(8000)});
        var json=await res.json();
        var meta=json&&json.chart&&json.chart.result&&json.chart.result[0]&&json.chart.result[0].meta;
        if(!meta) return{key:idx.key,error:true};
        var price=meta.regularMarketPrice||0;
        var prev=meta.chartPreviousClose||price;
        var change=prev?((price-prev)/prev*100).toFixed(2):"0.00";
        return{key:idx.key,price:price,change:change,label:idx.label,prefix:idx.prefix,round:idx.round};
      }catch(e){return{key:idx.key,error:true,label:idx.label};}
    })).then(function(results){
      var obj={};
      results.forEach(function(r){obj[r.key]=r;});
      setData(obj);
      setLoading(false);
    });
  },[]);
  if(loading) return(
    <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"10px 14px",marginBottom:12}}>
      <span style={{fontSize:12,color:"#2a6090"}}>市況取得中...</span>
    </div>
  );
  // ── スマホ：横スクロールのコンパクト表示 ─────────────────────────────
  if(isMobile) return(
    <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"10px",marginBottom:12,display:"flex",gap:6,overflowX:"auto",WebkitOverflowScrolling:"touch"}}>
      {INDICES.map(function(idx){
        var d=data[idx.key];
        if(!d||d.error) return(
          <div key={idx.key} style={{flexShrink:0,minWidth:84,background:"#050e1c",borderRadius:8,padding:"7px 10px"}}>
            <div style={{fontSize:10,color:"#2a6090",whiteSpace:"nowrap"}}>{idx.label}</div>
            <div style={{fontSize:13,color:"#4a7090"}}>─</div>
          </div>
        );
        var isUp=parseFloat(d.change)>=0;
        var price=d.round?Math.round(d.price).toLocaleString():parseFloat(d.price).toFixed(2);
        var isVix=idx.key==="vix";
        var vixAlert=isVix&&d.price>=20;
        return(
          <div key={idx.key} style={{flexShrink:0,minWidth:84,background:vixAlert?"#1f0010":"#050e1c",borderRadius:8,padding:"7px 10px",border:vixAlert?"1px solid #f43f5e50":"1px solid transparent"}}>
            <div style={{fontSize:10,color:vixAlert?"#f43f5e":"#4a7090",fontWeight:700,marginBottom:2,whiteSpace:"nowrap"}}>{idx.label}{vixAlert?" ⚠":""}</div>
            <div style={{fontSize:14,fontWeight:800,color:vixAlert?"#f43f5e":"#d8eeff",whiteSpace:"nowrap"}}>{d.prefix}{price}</div>
            <div style={{fontSize:11,fontWeight:700,color:isUp?"#22d3a0":"#f43f5e",whiteSpace:"nowrap"}}>{isUp?"▲":"▼"}{Math.abs(d.change)}%</div>
          </div>
        );
      })}
    </div>
  );
  // ── PC/iPad：元の大きめグリッド表示 ─────────────────────────────────
  return(
    <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"12px",marginBottom:12,display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8}}>
      {INDICES.map(function(idx){
        var d=data[idx.key];
        if(!d||d.error) return(
          <div key={idx.key} style={{background:"#050e1c",borderRadius:8,padding:"10px 12px"}}>
            <div style={{fontSize:13,color:"#2a6090"}}>{idx.label}</div>
            <div style={{fontSize:15,color:"#4a7090"}}>─</div>
          </div>
        );
        var isUp=parseFloat(d.change)>=0;
        var price=d.round?Math.round(d.price).toLocaleString():parseFloat(d.price).toFixed(2);
        var isVix=idx.key==="vix";
        var vixAlert=isVix&&d.price>=20;
        return(
          <div key={idx.key} style={{background:vixAlert?"#1f0010":"#050e1c",borderRadius:8,padding:"10px 12px",border:vixAlert?"1px solid #f43f5e50":"1px solid transparent"}}>
            <div style={{fontSize:13,color:vixAlert?"#f43f5e":"#4a7090",fontWeight:700,marginBottom:4}}>{idx.label}{vixAlert?" ⚠ 警戒":""}</div>
            <div style={{display:"flex",alignItems:"baseline",gap:8,flexWrap:"wrap"}}>
              <div style={{fontSize:20,fontWeight:800,color:vixAlert?"#f43f5e":"#d8eeff"}}>{d.prefix}{price}</div>
              <div style={{fontSize:14,fontWeight:700,color:isUp?"#22d3a0":"#f43f5e"}}>{isUp?"▲":"▼"}{Math.abs(d.change)}%</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AllStocksPanel(p){
  var stocks=p.stocks,loading=p.loading,toggleFav=p.toggleFav,favs=p.favs,vix=p.vix,onScan=p.onScan,ts=p.ts,progress=p.progress;
  var appTrades=p.appTrades,personalTrades=p.personalTrades;
  var isMobile=useIsMobile();
  var extraH=isMobile?MOBILE_TABBAR_H:0; // スマホ用タブバー分の高さを差し引く

  function isFavRef(t){return favs.indexOf(t)>=0;}

  var sortModeS=useState("score");var sortMode=sortModeS[0],setSortMode=sortModeS[1]; // "score"=スコア順(既定) / "dayType"=日中型順(日中分の累積が高い順)
  var dnProgS=useState(null);var dnProg=dnProgS[0],setDnProg=dnProgS[1]; // 日中型順のための日足取得の進捗
  var displayStocks=sortMode==="dayType"
    ?stocks.slice().sort(function(a,b){
        var ad=DAYNIGHT[a.ticker],bd=DAYNIGHT[b.ticker];
        var av=ad?ad.day:-Infinity,bv=bd?bd.day:-Infinity;
        return bv-av;
      })
    :stocks.slice().sort(function(a,b){return b.score-a.score;});


  if(loading){
    return(
      <div style={{padding:"20px 0"}}>
        <div style={{textAlign:"center",padding:"40px 20px",color:"#4a7090"}}>
          <div style={{fontSize:28,marginBottom:12}}>📡</div>
          <div style={{fontSize:15,color:"#4a90c0",marginBottom:16}}>分析中...</div>
        </div>
        <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:8,padding:"12px 16px",margin:"0 4px"}}>
          <div style={{fontSize:12,color:"#4a7090",marginBottom:6}}>{progress.msg||("分析中... "+progress.done+" / "+progress.total+" 銘柄")}</div>
          <div style={{background:"#0a1828",borderRadius:4,height:4,overflow:"hidden"}}>
            {progress.total>0
              ?<div style={{background:"linear-gradient(90deg,#0ea5e9,#22d3a0)",height:4,borderRadius:4,width:(progress.done/progress.total*100)+"%",transition:"width .3s"}}/>
              :<div style={{position:"relative",height:4,overflow:"hidden",background:"#0ea5e9",opacity:0.3}}><div style={{position:"absolute",top:0,left:0,height:"100%",width:"40%",background:"linear-gradient(90deg,transparent,#22d3a0,transparent)",animation:"loadingSlide 1.4s ease-in-out infinite"}}/></div>
            }
          </div>
          <style>{`@keyframes loadingSlide{0%{transform:translateX(-200%)}100%{transform:translateX(350%)}}`}</style>
        </div>
      </div>
    );
  }

  var cols=2; // 常に2列固定
  var stickyTop=50+extraH;
  var cardGrid=(
    <>
      <MarketRegimeBanner stocks={stocks}/>
      {sortMode==="dayType"&&dnProg&&<div style={{textAlign:"center",padding:"6px 0",color:"#fbbf24",fontSize:11}}>日中/夜間を計算中... {dnProg.d}/{dnProg.t}（日足を取得しています）</div>}
      <div style={{display:"grid",gridTemplateColumns:"repeat("+cols+",1fr)",gap:8}}>
        {displayStocks.map(function(s,i){
          return <div key={s.ticker} style={{display:"contents"}}><StockCard s={s} toggleFav={toggleFav} isFav={isFavRef} vix={vix} usdJpy={p.usdJpy} setSelectedStock={p.setSelectedStock} selectedStock={p.selectedStock} onRescan={p.onRescan} rescanLoading={p.rescanLoading&&p.rescanLoading[s.ticker]} allStocks={stocks} onAddTrade={p.onAddTrade} appTrades={appTrades} personalTrades={personalTrades}/></div>;
        })}
      </div>
    </>
  );
  return(
    <div style={{display:"flex",flexDirection:"column",height:"calc(100vh - "+(50+extraH)+"px)"}}>
      <div style={{position:"sticky",top:stickyTop,zIndex:10,background:"#040c18",paddingBottom:4}}>
        <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"6px 10px",marginBottom:4,display:"flex",gap:4,alignItems:"center",flexWrap:"nowrap",overflowX:"auto",WebkitOverflowScrolling:"touch"}}>
          <span style={{fontSize:10,color:"#4a7090",flexShrink:0}}>
            <span style={{color:"#22d3a0",fontWeight:700}}>{stocks.filter(function(s){return s.real;}).length}</span>
            <span>/{stocks.length}</span>
          </span>
          {ts&&<span style={{fontSize:10,color:"#2a6090",flexShrink:0,whiteSpace:"nowrap"}}>{ts}</span>}
          <button onClick={function(){var next=sortMode==="dayType"?"score":"dayType";setSortMode(next);if(next==="dayType"){fillDayNightFor(stocks,function(d,t){setDnProg(d<t?{d:d,t:t}:null);}).then(function(){setDnProg(null);});}}} title="過去1年で日中（始値→終値）に上がる癖が強い順に並べます。持ち越さないデイトレは日中分しか取れないため、日中型の銘柄ほど相性が良い。日足が未取得の銘柄は自動で取得し、取得できないものは下に並びます" style={{marginLeft:"auto",flexShrink:0,background:sortMode==="dayType"?"#fbbf2420":"transparent",border:"1px solid "+(sortMode==="dayType"?"#fbbf24":"#1e3050"),borderRadius:6,color:sortMode==="dayType"?"#fbbf24":"#4a6080",padding:"4px 8px",fontSize:11,cursor:"pointer",fontFamily:"monospace",fontWeight:sortMode==="dayType"?700:400,whiteSpace:"nowrap"}}>☀️日中型順{sortMode==="dayType"?"✓":""}</button>
          <button onClick={onScan} style={{flexShrink:0,background:"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:6,color:"#fff",padding:"4px 10px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"monospace",whiteSpace:"nowrap"}}>再スキャン</button>
        </div>
      </div>
      <div style={{overflowY:"auto",flex:1,WebkitOverflowScrolling:"touch",paddingTop:8}}>
        <MarketBar/>
        {isMobile?(
          <>
            {cardGrid}
            <MobileStockDetailModal s={p.selectedStock} toggleFav={toggleFav} isFav={isFavRef} vix={vix} usdJpy={p.usdJpy} onRescan={p.onRescan} rescanLoading={p.rescanLoading&&p.selectedStock&&p.rescanLoading[p.selectedStock.ticker]} allStocks={stocks} onAddTrade={p.onAddTrade} onClose={function(){p.setSelectedStock(null);}} appTrades={appTrades} personalTrades={personalTrades}/>
          </>
        ):(
          <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
            <div style={{width:"45%",flexShrink:0}}>{cardGrid}</div>
            <div style={{flex:1,position:"sticky",top:0,maxHeight:"100%",overflowY:"auto",WebkitOverflowScrolling:"touch"}}>
              <StockDetailPanel key={p.selectedStock&&p.selectedStock.ticker} s={p.selectedStock} toggleFav={toggleFav} isFav={isFavRef} vix={vix} usdJpy={p.usdJpy} onRescan={p.onRescan} rescanLoading={p.rescanLoading&&p.selectedStock&&p.rescanLoading[p.selectedStock.ticker]} allStocks={stocks} onAddTrade={p.onAddTrade} appTrades={appTrades} personalTrades={personalTrades}/>
            </div>
          </div>
        )}
        {displayStocks.length===0&&(
          <div style={{textAlign:"center",padding:"40px",color:"#4a7090",fontSize:14}}>該当する銘柄がありません</div>
        )}
      </div>
    </div>
  );
}

function FavPanel(p){
  var stocks=p.stocks,setStocks=p.setStocks,favs=p.favs,toggleFav=p.toggleFav,vix=p.vix;
  var appTrades=p.appTrades,personalTrades=p.personalTrades;
  var favGroups=p.favGroups,groupNames=p.groupNames,renameGroup=p.renameGroup;
  var isMobile=useIsMobile();
  var extraH=isMobile?MOBILE_TABBAR_H:0; // スマホ用タブバー分の高さを差し引く
  // お気に入り登録順（新しく登録した銘柄が先頭）をデフォルト順にする
  var favStocks=favs.slice().reverse().map(function(t){return stocks.find(function(s){return s.ticker===t;});}).filter(Boolean);
  var sortModeS=useState("reg");var sortMode=sortModeS[0],setSortMode=sortModeS[1]; // "reg"=登録順(新しい順) / "dayType"=日中型順(日中分の累積が高い順)
  var searchS=useState("");var searchTicker=searchS[0],setSearchTicker=searchS[1];
  var searchStatusS=useState(null);var searchStatus=searchStatusS[0],setSearchStatus=searchStatusS[1];
  var filterS=useState("ALL");var filterMkt=filterS[0],setFilterMkt=filterS[1];
  var groupFilterS=useState(0);var groupFilter=groupFilterS[0],setGroupFilter=groupFilterS[1]; // 0=全体
  var addGroupS=useState(0);var addGroup=addGroupS[0],setAddGroup=addGroupS[1];
  var showAccS=useState(false);var showAcc=showAccS[0],setShowAcc=showAccS[1];
  var filtersOpenS=useState(false);var filtersOpen=filtersOpenS[0],setFiltersOpen=filtersOpenS[1];
  async function addByTicker(){
    var raw=searchTicker.trim().toUpperCase();if(!raw)return;
    var ticker=(raw.match(/^\d{4}$/)?raw+".T":raw);
    if(favs.indexOf(ticker)>=0){setSearchStatus("already");return;}
    setSearchStatus("loading");
    try{
      var isJP=ticker.endsWith(".T"),code=ticker.replace(".T","");
      var base={ticker:ticker,name:code,market:isJP?"JP":"US",tvSymbol:(isJP?"TSE:":"NASDAQ:")+code};
      var pd=await fetchYahoo(ticker);
      var newStock=analyzeStock(base,pd,vix);
      setStocks(function(prev){return prev.some(function(s){return s.ticker===ticker;})?prev:prev.concat([newStock]);});
      toggleFav(ticker,addGroup);
      setSearchTicker("");setSearchStatus("ok");setTimeout(function(){setSearchStatus(null);},2000);
    }catch(e){setSearchStatus("error");setTimeout(function(){setSearchStatus(null);},2000);}
  }
  var statusMsg=searchStatus==="loading"?"取得中...":searchStatus==="ok"?"追加しました":searchStatus==="error"?"見つかりません":searchStatus==="already"?"登録済みです":null;
  var groupedStocks=groupFilter===0?favStocks:favStocks.filter(function(s){var g=favGroups[s.ticker];return(g==null?0:g)===groupFilter;});
  var mktFiltered=filterMkt==="ALL"?groupedStocks:groupedStocks.filter(function(s){return s.market===filterMkt;});
  var dnProgS=useState(null);var dnProg=dnProgS[0],setDnProg=dnProgS[1]; // 日中型順のための日足取得の進捗
  var displayStocks=sortMode==="dayType"
    ?mktFiltered.slice().sort(function(a,b){
        var ad=DAYNIGHT[a.ticker],bd=DAYNIGHT[b.ticker];
        var av=ad?ad.day:-Infinity,bv=bd?bd.day:-Infinity;
        return bv-av;
      })
    :mktFiltered;
  function fBtn(val,label,activeColor){
    var active=filterMkt===val;
    return(<button onClick={function(){setFilterMkt(val);}} style={{background:active?activeColor+"20":"transparent",border:"1px solid "+(active?activeColor:"#1e3050"),borderRadius:6,color:active?activeColor:"#4a6080",padding:"3px 8px",fontSize:11,cursor:"pointer",fontFamily:"monospace",fontWeight:active?700:400}}>{label}</button>);
  }
  function gBtn(val,label){
    var active=groupFilter===val;
    return(<button onClick={function(){setGroupFilter(val);}} style={{background:active?"#fbbf2420":"transparent",border:"1px solid "+(active?"#fbbf24":"#1e3050"),borderRadius:6,color:active?"#fbbf24":"#4a6080",padding:"3px 8px",fontSize:11,cursor:"pointer",fontFamily:"monospace",fontWeight:active?700:400}}>{label}</button>);
  }
  function editGroupName(num){
    var name=prompt("グループ名を入力",groupNames[num]);
    if(name&&name.trim())renameGroup(num,name.trim());
  }
  function isFavRef(t){return favs.indexOf(t)>=0;}
  var favCols=2; // 常に2列固定
  var cardGrid=(
    <>
      <MarketRegimeBanner stocks={stocks}/>
      {sortMode==="dayType"&&dnProg&&<div style={{textAlign:"center",padding:"6px 0",color:"#fbbf24",fontSize:11}}>日中/夜間を計算中... {dnProg.d}/{dnProg.t}（日足を取得しています）</div>}
      <div style={{display:"grid",gridTemplateColumns:"repeat("+favCols+",1fr)",gap:8}}>
        {displayStocks.map(function(s,i){
          var cross=s.signals&&s.signals.length>0?classifyStockFn(s):null;
          return <div key={s.ticker} style={{display:"contents"}}><StockCard s={s} toggleFav={toggleFav} isFav={isFavRef} cross={cross} vix={vix} usdJpy={p.usdJpy} setSelectedStock={p.setSelectedStock} selectedStock={p.selectedStock} onRescan={p.onRescan} rescanLoading={p.rescanLoading&&p.rescanLoading[s.ticker]} allStocks={stocks} onAddTrade={p.onAddTrade} appTrades={appTrades} personalTrades={personalTrades}/></div>;
        })}
      </div>
    </>
  );
  var stickyTop=50+extraH;
  return(
    <div style={{display:"flex",flexDirection:"column",height:"calc(100vh - "+(50+extraH)+"px)"}}>
      <div style={{position:"sticky",top:stickyTop,zIndex:10,background:"#040c18",paddingBottom:4,paddingLeft:10,paddingRight:10,paddingTop:4}}>
        {isMobile?(
        <>
        <div style={{background:"#050e1c",border:"1px solid #1e3050",borderRadius:10,padding:"6px 14px",marginBottom:8}}>
          <div style={{display:"flex",gap:6,flexWrap:"nowrap"}}>
            <input style={{background:"#071428",border:"1px solid #1e3050",borderRadius:6,color:"#b8cce0",padding:"6px 8px",fontSize:16,fontFamily:"monospace",flex:"1 1 auto",minWidth:0}} value={searchTicker} placeholder="AAPL / 7203" onChange={function(e){setSearchTicker(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter")addByTicker();}}/>
            <select value={addGroup} onChange={function(e){setAddGroup(Number(e.target.value));}} style={{background:"#071428",border:"1px solid #1e3050",borderRadius:6,color:"#fbbf24",padding:"0 2px",fontSize:12,fontFamily:"monospace",flex:"0 0 auto",width:78}}>
              <option value={0}>全体</option>
              {[1,2,3,4,5].map(function(n){return <option key={n} value={n}>{groupNames[n]}</option>;})}
            </select>
            <button onClick={addByTicker} style={{background:"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:6,color:"#fff",padding:"4px 10px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"monospace",flex:"0 0 auto"}}>追加</button>
          </div>
          {statusMsg&&<div style={{fontSize:12,color:searchStatus==="ok"?"#22d3a0":"#f43f5e",marginTop:6}}>{statusMsg}</div>}
        </div>
        <button onClick={function(){setFiltersOpen(function(v){return !v;});}} style={{width:"100%",background:"#071428",border:"1px solid #0f2040",borderRadius:10,color:"#4a90c0",padding:"6px 12px",fontSize:11,cursor:"pointer",fontFamily:"monospace",marginBottom:4,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span>🔍 絞り込み（グループ・市場）</span>
          <span>{filtersOpen?"▲":"▼"}</span>
        </button>
        {filtersOpen&&(
        <div>
        <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"8px 12px",marginBottom:4,display:"flex",gap:4,flexWrap:"wrap",alignItems:"center"}}>
          <span style={{fontSize:11,color:"#2a6090",marginRight:2}}>グループ:</span>
          {gBtn(0,"全体")}
          {[1,2,3,4,5].map(function(n){return <span key={n} style={{display:"flex",alignItems:"center",gap:2}}>{gBtn(n,groupNames[n])}{groupFilter===n&&<span onClick={function(){editGroupName(n);}} style={{cursor:"pointer",fontSize:11,color:"#4a6080"}}>✎</span>}</span>;})}
        </div>
        {showAcc&&createPortal(<SignalAccuracyModal onClose={function(){setShowAcc(false);}}/>,document.body)}
        {favStocks.length>0&&(
          <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"8px 12px",marginBottom:4,display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
            <span style={{fontSize:11,color:"#2a6090",marginRight:2}}>市場:</span>
            {fBtn("ALL","全て","#60a5fa")}
            {fBtn("US","US","#3b82f6")}
            {fBtn("JP","JP","#f87171")}
            <button onClick={function(){var next=sortMode==="dayType"?"reg":"dayType";setSortMode(next);if(next==="dayType"){fillDayNightFor(mktFiltered,function(d,t){setDnProg(d<t?{d:d,t:t}:null);}).then(function(){setDnProg(null);});}}} title="過去1年で日中（始値→終値）に上がる癖が強い順に並べます。持ち越さないデイトレは日中分しか取れないため、日中型の銘柄ほど相性が良い。日足が未取得の銘柄は自動で取得し、取得できないものは下に並びます" style={{marginLeft:"auto",background:sortMode==="dayType"?"#fbbf2420":"transparent",border:"1px solid "+(sortMode==="dayType"?"#fbbf24":"#1e3050"),borderRadius:6,color:sortMode==="dayType"?"#fbbf24":"#4a6080",padding:"3px 8px",fontSize:11,cursor:"pointer",fontFamily:"monospace",fontWeight:sortMode==="dayType"?700:400}}>☀️日中型順{sortMode==="dayType"?"✓":""}</button>
            <button onClick={function(){setShowAcc(true);}} style={{background:"transparent",border:"1px solid #1e3050",borderRadius:6,color:"#0ea5e9",padding:"3px 8px",fontSize:11,cursor:"pointer",fontFamily:"monospace"}}>📊的中率</button>
          </div>
        )}
        </div>
        )}
        </>
        ):(
        <>
        <div style={{background:"#050e1c",border:"1px solid #1e3050",borderRadius:10,padding:"6px 14px",marginBottom:8}}>
          <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
            <input style={{background:"#071428",border:"1px solid #1e3050",borderRadius:6,color:"#b8cce0",padding:"6px 8px",fontSize:16,fontFamily:"monospace",flex:"1 1 auto",minWidth:120}} value={searchTicker} placeholder="AAPL / 7203" onChange={function(e){setSearchTicker(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter")addByTicker();}}/>
            <button onClick={addByTicker} style={{background:"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:6,color:"#fff",padding:"4px 10px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"monospace",flex:"0 0 auto"}}>追加</button>
            <span style={{width:1,alignSelf:"stretch",background:"#1e3050",flexShrink:0}}/>
            <span style={{fontSize:11,color:"#2a6090"}}>グループ:</span>
            {gBtn(0,"全体")}
            {[1,2,3,4,5].map(function(n){return <span key={n} style={{display:"flex",alignItems:"center",gap:2}}>{gBtn(n,groupNames[n])}{groupFilter===n&&<span onClick={function(){editGroupName(n);}} style={{cursor:"pointer",fontSize:11,color:"#4a6080"}}>✎</span>}</span>;})}
            <button onClick={function(){var next=sortMode==="dayType"?"reg":"dayType";setSortMode(next);if(next==="dayType"){fillDayNightFor(mktFiltered,function(d,t){setDnProg(d<t?{d:d,t:t}:null);}).then(function(){setDnProg(null);});}}} title="過去1年で日中（始値→終値）に上がる癖が強い順に並べます。持ち越さないデイトレは日中分しか取れないため、日中型の銘柄ほど相性が良い。日足が未取得の銘柄は自動で取得し、取得できないものは下に並びます" style={{background:sortMode==="dayType"?"#fbbf2420":"transparent",border:"1px solid "+(sortMode==="dayType"?"#fbbf24":"#1e3050"),borderRadius:6,color:sortMode==="dayType"?"#fbbf24":"#4a6080",padding:"3px 8px",fontSize:11,cursor:"pointer",fontFamily:"monospace",fontWeight:sortMode==="dayType"?700:400}}>☀️日中型順{sortMode==="dayType"?"✓":""}</button>
            <button onClick={function(){setShowAcc(true);}} style={{background:"transparent",border:"1px solid #1e3050",borderRadius:6,color:"#0ea5e9",padding:"3px 8px",fontSize:11,cursor:"pointer",fontFamily:"monospace"}}>📊的中率</button>
          </div>
          {statusMsg&&<div style={{fontSize:12,color:searchStatus==="ok"?"#22d3a0":"#f43f5e",marginTop:6}}>{statusMsg}</div>}
        </div>
        {showAcc&&createPortal(<SignalAccuracyModal onClose={function(){setShowAcc(false);}}/>,document.body)}
        </>
        )}
      </div>
      <div style={{overflowY:"auto",flex:1,WebkitOverflowScrolling:"touch",paddingTop:8,paddingLeft:10,paddingRight:10,paddingBottom:120}}>
        {isMobile?(
          <>
            {cardGrid}
            <MobileStockDetailModal s={p.selectedStock} toggleFav={toggleFav} isFav={isFavRef} vix={vix} usdJpy={p.usdJpy} onRescan={p.onRescan} rescanLoading={p.rescanLoading&&p.selectedStock&&p.rescanLoading[p.selectedStock.ticker]} allStocks={stocks} onAddTrade={p.onAddTrade} onClose={function(){p.setSelectedStock(null);}} appTrades={appTrades} personalTrades={personalTrades}/>
          </>
        ):(
          <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
            <div style={{width:"45%",flexShrink:0}}>{cardGrid}</div>
            <div style={{flex:1,position:"sticky",top:0,maxHeight:"calc(100vh - 200px)",overflowY:"auto",WebkitOverflowScrolling:"touch"}}>
              <StockDetailPanel key={p.selectedStock&&p.selectedStock.ticker} s={p.selectedStock} toggleFav={toggleFav} isFav={isFavRef} vix={vix} usdJpy={p.usdJpy} onRescan={p.onRescan} rescanLoading={p.rescanLoading&&p.selectedStock&&p.rescanLoading[p.selectedStock.ticker]} allStocks={stocks} onAddTrade={p.onAddTrade} appTrades={appTrades} personalTrades={personalTrades}/>
            </div>
          </div>
        )}
        {favs.length===0&&<div style={{textAlign:"center",padding:"30px 20px",color:"#4a7090",fontSize:13}}>ティッカーを入力して追加できます</div>}
      </div>
    </div>
  );
}

// ── トレードタブ：アプリ予想／個人予想の一覧・損益集計 ─────────────────────────
function TradePanel(p){
  var stocks=p.stocks,toggleFav=p.toggleFav,favs=p.favs,vix=p.vix;
  var isMobile=useIsMobile();
  var subS=useState("app");var sub=subS[0],setSub=subS[1];
  var selIdS=useState(null);var selId=selIdS[0],setSelId=selIdS[1];
  function isFavRef(t){return favs.indexOf(t)>=0;}
  var list=sub==="app"?p.appTrades:p.personalTrades;
  var waitingList=list.filter(function(t){return t.status==="waiting";});
  var activeList=list.filter(function(t){return t.status==="active";});
  var doneList=list.filter(function(t){return t.status==="done";});
  var totalPnl=doneList.reduce(function(a,t){return a+(t.pnl||0);},0);
  // 勝率：完了トレードのうち損益がプラスだった割合
  var winRate=doneList.length?Math.round(doneList.filter(function(t){return(t.pnl||0)>0;}).length/doneList.length*100):null;
  var rStats=calcRStats(doneList);
  // 的中率の集計対象：アプリ予想／個人予想を合わせた全登録銘柄（お気に入りタブの集計とは分離）
  // ※シグナル的中率は銘柄ごとのスコア履歴（scoreHist）から算出しており、価格設定(アプリ/個人)とは無関係なため
  //   タブでは分けず、両方に登録した銘柄をまとめて1つの集計として表示する
  var tradeTickers=Array.from(new Set(p.appTrades.concat(p.personalTrades).map(function(t){return t.ticker;})));
  // スマホはタップして表示（初期非表示）、PC/iPadは今まで通り常時表示
  var showAccS=useState(!isMobile);var showAccuracy=showAccS[0],setShowAccuracy=showAccS[1];
  var selTrade=selId?list.find(function(t){return t.id===selId;}):null;
  var selStock=selTrade?stocks.find(function(x){return x.ticker===selTrade.ticker;}):null;
  // 「完了」セクションの開閉状態（初期状態は閉じておく）
  var doneOpenS=useState(false);var doneOpen=doneOpenS[0],setDoneOpen=doneOpenS[1];

  function Section(title,items,color,useScoreColor,collapsible){
    if(!items.length)return null;
    var open=collapsible?doneOpen:true;
    return(
      <div>
        <div onClick={collapsible?function(){setDoneOpen(function(v){return !v;});}:undefined} style={{fontSize:11,fontWeight:700,color:color,margin:"2px 0 6px",cursor:collapsible?"pointer":"default",userSelect:"none"}}>
          {collapsible?(open?"▼":"▶"):"●"} {title}（{items.length}）
        </div>
        {open&&<div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:6}}>
          {items.slice().reverse().map(function(t){
            var tickerColor=null;
            if(useScoreColor){
              var st=stocks.find(function(x){return x.ticker===t.ticker;});
              if(st) tickerColor=scoreColor(st.score);
            }
            return <TradeMiniTile key={t.id} t={t} tickerColor={tickerColor} onClick={function(){setSelId(t.id);}}/>;
          })}
        </div>}
      </div>
    );
  }

  return(
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      <div style={{display:"flex",gap:6}}>
        <TabBtn active={sub==="app"} onClick={function(){setSub("app");setSelId(null);}} color="#0ea5e9" label={"🎯 アプリ予想 ("+p.appTrades.length+")"}/>
        <TabBtn active={sub==="personal"} onClick={function(){setSub("personal");setSelId(null);}} color="#a78bfa" label={"👤 個人予想 ("+p.personalTrades.length+")"}/>
      </div>
      <div style={{fontSize:11,color:"#4a7090",background:"#050e1c",borderRadius:8,padding:"8px 10px"}}>
        {sub==="app"?"アプリの買いシグナル判断を忠実に守った場合の検証用":"アプリの判断とは異なる、自分自身の判断を検証するためのタブ"}
      </div>

      <div style={{display:"flex",gap:12,alignItems:"flex-start",flexDirection:isMobile?"column":"row"}}>
        <div style={{width:(!showAccuracy||isMobile)?"100%":"60%",flexShrink:0,display:"flex",flexDirection:"column",gap:10,minWidth:0}}>
          <div style={{background:"#050e1c",borderRadius:10,padding:"12px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",gap:10}}>
            <div>
              <div style={{fontSize:10,color:"#4a7090",whiteSpace:"nowrap"}}>合計損益（完了{doneList.length}件）{rStats.n>0&&<span style={{marginLeft:6,color:rStats.avgR>=0?"#22d3a0":"#f43f5e",fontWeight:700}}>平均{(rStats.avgR>=0?"+":"")+rStats.avgR.toFixed(2)}R ／ 累計{(rStats.totalR>=0?"+":"")+rStats.totalR.toFixed(1)}R ／ PF{rStats.pf!=null?rStats.pf.toFixed(2):"—"} ／ 損益分岐勝率{rStats.beRate!=null?rStats.beRate+"%":"—"}<span style={{color:"#2a6090"}}>（R集計{rStats.n}件）</span></span>}</div>
              <div style={{fontSize:20,fontWeight:800,color:totalPnl>=0?"#22d3a0":"#f43f5e"}}>{doneList.length?fmtPnl(totalPnl,true):"—"}</div>
            </div>
            <div style={{display:"flex",gap:10,alignItems:"center"}}>
              <div style={{textAlign:"center"}}>
                <div style={{fontSize:11,color:"#4a7090"}}>勝率</div>
                <div style={{fontSize:17,fontWeight:800,color:"#fbbf24"}}>{winRate!=null?winRate+"%":"—"}</div>
              </div>
            </div>
            <div style={{display:"flex",gap:6,flexShrink:0}}>
              {isMobile&&<button onClick={function(){setShowAccuracy(function(v){return !v;});}} style={{background:showAccuracy?"#0a1a3a":"transparent",border:"1px solid "+(showAccuracy?"#0ea5e9":"#2a4060"),borderRadius:8,color:showAccuracy?"#0ea5e9":"#4a7090",padding:"8px 10px",fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>📊 的中率</button>}
              <button onClick={p.onRefreshTrades} disabled={p.tradeRefreshing} style={{background:p.tradeRefreshing?"#0f2040":"#0a1a3a",border:"1px solid #0ea5e9",borderRadius:8,color:"#0ea5e9",padding:"8px 12px",fontSize:12,fontWeight:700,cursor:p.tradeRefreshing?"not-allowed":"pointer",whiteSpace:"nowrap"}}>{p.tradeRefreshing?"更新中…":"🔄 価格更新"}</button>
            </div>
          </div>

          {list.length===0&&<div style={{textAlign:"center",padding:"30px 20px",color:"#4a7090",fontSize:13}}>まだトレードが登録されていません。銘柄カードの🎯ボタンから登録してください</div>}

          {Section("進行中",activeList,"#0ea5e9")}
          {Section("待機中",waitingList,"#4a7090",true)}
          {Section("完了",doneList,"#22d3a0",false,true)}
        </div>

        {showAccuracy&&(
          <div style={{flex:1,width:isMobile?"100%":undefined,position:isMobile?"static":"sticky",top:0,background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:16,maxHeight:isMobile?undefined:"calc(100vh - 200px)",overflowY:isMobile?"visible":"auto",WebkitOverflowScrolling:"touch"}}>
            <div style={{fontSize:16,fontWeight:800,color:"#e0f0ff",marginBottom:10}}>📊 シグナル的中率（全トレード銘柄・アプリ/個人共通）</div>
            <SignalAccuracyContent tickers={tradeTickers} label="全トレード"/>
          </div>
        )}
      </div>

      <WeightAdjustVerificationPanel appTrades={p.appTrades} personalTrades={p.personalTrades}/>

      {selTrade&&createPortal(
        <TradeDetailModal t={selTrade} s={selStock} kind={sub} stocks={stocks} toggleFav={toggleFav} isFav={isFavRef}
          vix={vix} usdJpy={p.usdJpy} setSelectedStock={p.setSelectedStock} selectedStock={p.selectedStock}
          onRescan={p.onRescan} rescanLoading={p.rescanLoading} onAddTrade={p.onAddTrade}
          onRemoveTrade={function(kind,id){p.onRemoveTrade(kind,id);setSelId(null);}}
          onEditTrade={p.onEditTrade} onForceComplete={p.onForceComplete} onClose={function(){setSelId(null);}}
          appTrades={p.appTrades} personalTrades={p.personalTrades}/>,
        document.body
      )}
    </div>
  );
}

// ── トレード用コンパクトタイル（横5列グリッド表示）─────────────────────────
function TradeMiniTile(p){
  var t=p.t;
  var isJP=t.market==="JP";
  var STATUS_COLOR={waiting:"#4a7090",active:"#0ea5e9",done:"#22d3a0"};
  var pnlVal=t.status==="done"?t.pnl:((t.status==="active"&&t.lastPrice!=null&&t.startPrice!=null)?(t.lastPrice-t.startPrice)*(t.shares||1):null);
  return(
    <button onClick={p.onClick} style={{background:"#03080f",border:"1px solid "+STATUS_COLOR[t.status],borderRadius:8,padding:"6px 2px",display:"flex",flexDirection:"column",alignItems:"center",gap:2,cursor:"pointer",minWidth:0}}>
      <div style={{fontSize:10,fontWeight:800,color:p.tickerColor||"#d8eeff",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:"100%"}}>{t.ticker.replace(".T","")}</div>
      <div style={{width:5,height:5,borderRadius:"50%",background:STATUS_COLOR[t.status]}}/>
      {pnlVal!=null?(
        <div style={{fontSize:9,fontWeight:700,color:pnlVal>=0?"#22d3a0":"#f43f5e",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:"100%"}}>{fmtPnl(pnlVal,isJP)}</div>
      ):(
        <div style={{fontSize:9,color:"#2a4060"}}>—</div>
      )}
    </button>
  );
}

// ── トレード詳細モーダル：ステータス表示・損益・売買価格/株数の編集 ─────────────
function TradeDetailModal(p){
  var t=p.t,kind=p.kind;
  var isJP=t.market==="JP";
  var editS=useState(false);var editing=editS[0],setEditing=editS[1];
  var buyS=useState(String(t.buyPrice));var buyVal=buyS[0],setBuyVal=buyS[1];
  var sellS=useState(String(t.sellPrice));var sellVal=sellS[0],setSellVal=sellS[1];
  var stopS=useState(t.stopPrice!=null?String(t.stopPrice):"");var stopVal=stopS[0],setStopVal=stopS[1];
  var sharesS=useState(String(t.shares||1));var sharesVal=sharesS[0],setSharesVal=sharesS[1];
  var buyDirS=useState(getBuyDirection(t));var buyDir=buyDirS[0],setBuyDir=buyDirS[1]; // 指値(down)／逆指値(up)。待機中のみ編集可能
  var STATUS_LABEL={waiting:"待機中",active:"進行中",done:"完了"};
  var STATUS_COLOR={waiting:"#4a7090",active:"#0ea5e9",done:"#22d3a0"};
  var EXIT_LABEL={take_profit:"利確で完了",stop_loss:"損切りで完了",time_exit:"引けで強制完了（持ち越しなし）",forced:"強制完了"};
  var unrealized=(t.status==="active"&&t.lastPrice!=null&&t.startPrice!=null)?((t.lastPrice-t.startPrice)*(t.shares||1)):null;
  var editInp={background:"#040c18",border:"1px solid #1e4070",borderRadius:5,color:"#b8cce0",padding:"6px",fontSize:16,fontFamily:"monospace",width:"100%",boxSizing:"border-box"};

  function startEdit(){setBuyVal(String(t.buyPrice));setSellVal(String(t.sellPrice));setStopVal(t.stopPrice!=null?String(t.stopPrice):"");setSharesVal(String(t.shares||1));setBuyDir(getBuyDirection(t));setEditing(true);}
  function saveEdit(){
    var b=parseFloat(buyVal),se=parseFloat(sellVal),sh=parseInt(sharesVal);
    if(isNaN(b)||b<=0||isNaN(se)||se<=0||isNaN(sh)||sh<=0)return;
    var sp=parseFloat(stopVal);
    if(isNaN(sp)||sp<=0||sp>=b){alert("損切り価格は必須です。買い価格より低い値を入力してください（R集計に必要）");return;}
    var updates={buyPrice:b,sellPrice:se,shares:sh,stopPrice:sp};
    if(t.status==="waiting")updates.buyDirection=buyDir; // 待機中のみ手動指定を反映
    p.onEditTrade(kind,t.id,updates);
    setEditing(false);
  }
  function forceComplete(){
    var curPrice=p.s&&p.s.rawPrice!=null?p.s.rawPrice:t.lastPrice;
    if(curPrice==null){alert("現在価格が取得できていません。先に「🔄価格更新」を実行してください。");return;}
    if(!window.confirm("現在価格（"+fmtMoney(curPrice,isJP)+"）で強制的に完了させますか？"))return;
    p.onForceComplete(kind,t.id,curPrice);
  }

  return(
    <div onClick={function(e){if(e.target===e.currentTarget)p.onClose();}} style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.75)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"#040c18",border:"1px solid #0f204090",borderRadius:16,padding:12,width:"100%",maxWidth:480,maxHeight:"85vh",overflowY:"auto",WebkitOverflowScrolling:"touch",display:"flex",flexDirection:"column",gap:6}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontSize:11,fontWeight:700,color:STATUS_COLOR[t.status]}}>● {STATUS_LABEL[t.status]}{t.status==="done"&&t.exitReason?"（"+EXIT_LABEL[t.exitReason]+"）":""}</span>
          <div style={{display:"flex",gap:14,alignItems:"center"}}>
            <button onClick={editing?saveEdit:startEdit} style={{background:"transparent",border:"none",color:editing?"#22d3a0":"#4a5a70",fontSize:13,cursor:"pointer"}}>{editing?"💾 保存":"✏️"}</button>
            {!editing&&<button onClick={function(){if(window.confirm("このトレード記録を削除しますか？"))p.onRemoveTrade(kind,t.id);}} style={{background:"transparent",border:"none",color:"#4a5a70",fontSize:13,cursor:"pointer"}}>🗑</button>}
            <button onClick={p.onClose} style={{background:"transparent",border:"none",color:"#4a7090",fontSize:18,cursor:"pointer",lineHeight:1}}>✕</button>
          </div>
        </div>

        {editing?(
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
              <div><div style={{fontSize:10,color:"#22d3a0",marginBottom:2}}>買い</div><input type="number" value={buyVal} onChange={function(e){setBuyVal(e.target.value);}} style={editInp}/></div>
              <div><div style={{fontSize:10,color:"#f43f5e",marginBottom:2}}>売り（利確）</div><input type="number" value={sellVal} onChange={function(e){setSellVal(e.target.value);}} style={editInp}/></div>
              <div><div style={{fontSize:10,color:"#4a7090",marginBottom:2}}>株数</div><input type="number" value={sharesVal} onChange={function(e){setSharesVal(e.target.value);}} style={editInp}/></div>
            </div>
            <div><div style={{fontSize:10,color:"#fbbf24",marginBottom:2}}>損切り（必須）</div><input type="number" value={stopVal} onChange={function(e){setStopVal(e.target.value);}} style={editInp} placeholder="買い価格より低い値"/></div>
            {t.status==="waiting"&&(
              <div>
                <div style={{fontSize:10,color:"#4a7090",marginBottom:2}}>買い方向</div>
                <div style={{display:"flex",gap:6}}>
                  <button type="button" onClick={function(){setBuyDir("down");}} style={{flex:1,padding:"6px 2px",fontSize:11,fontWeight:700,borderRadius:5,cursor:"pointer",border:"1px solid "+(buyDir==="down"?"#22d3a0":"#1e3050"),background:buyDir==="down"?"#22d3a020":"transparent",color:buyDir==="down"?"#22d3a0":"#4a6080"}}>指値(下値待ち)</button>
                  <button type="button" onClick={function(){setBuyDir("up");}} style={{flex:1,padding:"6px 2px",fontSize:11,fontWeight:700,borderRadius:5,cursor:"pointer",border:"1px solid "+(buyDir==="up"?"#f59e0b":"#1e3050"),background:buyDir==="up"?"#f59e0b20":"transparent",color:buyDir==="up"?"#f59e0b":"#4a6080"}}>逆指値(上抜け待ち)</button>
                </div>
              </div>
            )}
          </div>
        ):(
          <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:6}}>
            <div style={{background:"#052e16",border:"1px solid #22d3a040",borderRadius:6,padding:"6px 8px"}}>
              <div style={{fontSize:10,color:"#22d3a0",marginBottom:2}}>買い</div>
              <div style={{fontSize:15,fontWeight:800,color:"#22d3a0"}}>{fmtMoney(t.buyPrice,isJP)}</div>
            </div>
            <div style={{background:"#1f0010",border:"1px solid #f43f5e40",borderRadius:6,padding:"6px 8px"}}>
              <div style={{fontSize:10,color:"#f43f5e",marginBottom:2}}>売り（利確）</div>
              <div style={{fontSize:15,fontWeight:800,color:"#f43f5e"}}>{fmtMoney(t.sellPrice,isJP)}</div>
            </div>
            {t.stopPrice!=null&&(
              <div style={{background:"#1c1400",border:"1px solid #fbbf2440",borderRadius:6,padding:"6px 8px"}}>
                <div style={{fontSize:10,color:"#fbbf24",marginBottom:2}}>損切り</div>
                <div style={{fontSize:15,fontWeight:800,color:"#fbbf24"}}>{fmtMoney(t.stopPrice,isJP)}</div>
              </div>
            )}
            <div style={{background:"#071428",border:"1px solid #1e3050",borderRadius:6,padding:"6px 8px"}}>
              <div style={{fontSize:10,color:"#4a7090",marginBottom:2}}>株数</div>
              <div style={{fontSize:15,fontWeight:800,color:"#d8eeff"}}>{t.shares||1}株</div>
            </div>
          </div>
        )}

        {t.status==="done"&&<div style={{fontSize:16,fontWeight:800,color:t.pnl>=0?"#22d3a0":"#f43f5e"}}>{fmtPnl(t.pnl,isJP)} <span style={{fontSize:11,fontWeight:400}}>({t.pnlPercent>=0?"+":""}{t.pnlPercent.toFixed(1)}%)</span>{tradeR(t)!=null&&<span style={{fontSize:13,marginLeft:8}}>{(tradeR(t)>=0?"+":"")+tradeR(t).toFixed(2)}R</span>}{tradeRisk(t)!=null&&<span style={{fontSize:10,fontWeight:400,color:"#4a7090",marginLeft:6}}>1R=¥{Math.round(tradeRisk(t)).toLocaleString()}</span>}</div>}
        {t.status==="active"&&unrealized!=null&&<div style={{fontSize:13,color:unrealized>=0?"#22d3a0":"#f43f5e"}}>含み損益 {fmtPnl(unrealized,isJP)}</div>}

        {!editing&&t.status!=="done"&&<button onClick={forceComplete} style={{background:"#2a0a12",border:"1px solid #f43f5e60",borderRadius:8,color:"#f43f5e",padding:"8px",fontSize:12,fontWeight:700,cursor:"pointer"}}>⏹ 現在価格で強制完了</button>}

        {isJP&&<a href="ispeed://" onClick={function(){var code=t.ticker.replace(".T","");if(navigator.clipboard){navigator.clipboard.writeText(code).catch(function(){});}}} style={{background:"#1a0a0a",border:"1px solid #f87171",borderRadius:8,color:"#fca5a5",padding:"10px",fontSize:12,fontWeight:700,fontFamily:"monospace",textDecoration:"none",textAlign:"center",display:"block"}}>📱 iSPEED</a>}

        {p.s?(
          <StockCard s={p.s} toggleFav={p.toggleFav} isFav={p.isFav} vix={p.vix} usdJpy={p.usdJpy} setSelectedStock={p.setSelectedStock} selectedStock={p.selectedStock} onRescan={p.onRescan} rescanLoading={p.rescanLoading&&p.rescanLoading[t.ticker]} allStocks={p.stocks} onAddTrade={p.onAddTrade} appTrades={p.appTrades} personalTrades={p.personalTrades}/>
        ):(
          <div style={{fontSize:11,color:"#2a4060",padding:"6px 0"}}>{t.ticker.replace(".T","")}（データ取得中… 「再スキャン」を実行すると表示されます）</div>
        )}
      </div>
    </div>
  );
}

function MarketPredictionPanel(p){
  var stocks=p.stocks,vix=p.vix,predictionResult=p.predictionResult,setPredictionResult=p.setPredictionResult,predictionLoading=p.predictionLoading,setPredictionLoading=p.setPredictionLoading;
  var toggleFav=p.toggleFav,favs=p.favs||[];
  function isFavRef(t){return favs.indexOf(t)>=0;}
  var lastUpdS=useState(null);var lastUpd=lastUpdS[0],setLastUpd=lastUpdS[1];

  async function runPrediction(){
    if(predictionLoading||stocks.length===0) return;
    setPredictionLoading(true);
    setPredictionResult("");
    var top5=stocks.slice().sort(function(a,b){return b.score-a.score;}).slice(0,5);
    var gcNowList=stocks.filter(function(s){var c=classifyStockFn(s);return c&&c.type==="GC_NOW";}).slice(0,5);
    var gcNearList=stocks.filter(function(s){var c=classifyStockFn(s);return c&&c.type==="GC_NEAR";}).slice(0,5);
    var dcNowList=stocks.filter(function(s){var c=classifyStockFn(s);return c&&c.type==="DC_NOW";}).slice(0,5);
    var jpStocks=stocks.filter(function(s){return s.market==="JP";});
    var jpUp=jpStocks.filter(function(s){return parseFloat(s.change)>=0;}).length;
    var jpUpPct=jpStocks.length>0?Math.round(jpUp/jpStocks.length*100):0;
    var vixNum=vix?parseFloat(vix):null;
    var vixLevel=vixNum==null?"不明":vixNum>=30?"高（警戒）":vixNum>=20?"中（注意）":"低（落ち着き）";
    var userMsg=
      "【現在の市場データ】\n"+
      "VIX: "+(vixNum?vixNum.toFixed(2):"不明")+" （警戒レベル: "+vixLevel+"）\n"+
      "JP市場: 上昇銘柄 "+jpUpPct+"% ("+jpUp+"/"+jpStocks.length+"銘柄)\n\n"+
      "【スコア上位5銘柄】\n"+
      top5.map(function(s){return s.ticker+" スコア:"+s.score+" "+s.tradeLabel+" 騰落:"+s.change+"%";}).join("\n")+"\n\n"+
      "【GC発生中】\n"+(gcNowList.length>0?gcNowList.map(function(s){return s.ticker+"("+s.market+")";}).join(", "):"なし")+"\n"+
      "【GC接近中】\n"+(gcNearList.length>0?gcNearList.map(function(s){return s.ticker+"("+s.market+")";}).join(", "):"なし")+"\n"+
      "【DC発生中】\n"+(dcNowList.length>0?dcNowList.map(function(s){return s.ticker+"("+s.market+")";}).join(", "):"なし")+"\n\n"+
      "以下の6セクション形式で出力してください。各セクションは必ず以下のアイコンで始めてください：📊 今日の相場環境、📈 注目市場・セクター、🔥 注目銘柄、⚠️ リスク要因、🔭 来週の見通し、💡 個人投資家へのアドバイス。\n\n"+
      "📊 今日の相場環境\nVIXの水準・市場の方向感・注意点を含めて3〜4行で説明。\n\n"+
      "📈 注目市場・セクター\nなぜ今注目なのか理由と根拠を含めて3〜4行で説明。\n\n"+
      "🔥 注目銘柄（2〜3銘柄）\n各銘柄について以下を数値で答えること:\n・買うべきか / 見送るべきか\n・entry: 具体的な買いレンジ（例: $182〜$185）\n・target: 利確ライン（例: $192、+5%）\n・stop: 損切りライン（例: $178、-2.2%）\n・根拠: なぜその水準なのか1文で\n\n"+
      "⚠️ リスク要因\n具体的なリスクを2〜3点挙げて、それぞれ影響と対処法を説明。\n\n"+
      "🔭 来週の見通し\n来週の相場展開の予想を3〜4行で説明。注目イベント・経済指標があれば含める。\n\n"+
      "💡 個人投資家へのアドバイス\n今の相場環境でデイトレ・スイングをする際の具体的な注意点を2〜3行で説明。";
    try{
      var res=await fetch("https://daytrade-simulator.vercel.app/api/ai",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          prompt:userMsg,
          system:"必ず自分でWeb検索ツールを使って最新情報を取得してください。ユーザーに質問したり確認を求めたりせず、自律的に分析を完了してください。\n\nあなたは経験豊富な株式市場アナリストです。\n最新ニュースとアプリの市場データをもとに、個人投資家にとって実用的な市場分析を日本語で提供してください。\n\n以下の点を必ず守ってください。\n- 専門用語には簡単な説明を添える\n- 数値や根拠を示して具体的に説明する\n- 良い面だけでなくリスクも正直に伝える\n- 個人投資家の目線で実践的なアドバイスをする\n- 必ず日本語で回答する",
          useWebSearch:true
        }),
        signal:AbortSignal.timeout(60000)
      });
      var data=await res.json();
      if(data.error) throw new Error(typeof data.error==="string"?data.error:JSON.stringify(data.error));
      var text=typeof data.text==="string"?data.text:JSON.stringify(data.text)||"";
      setPredictionResult(text||"分析できませんでした。");
      setLastUpd(new Date().toLocaleTimeString("ja-JP"));
    }catch(e){
      setPredictionResult("エラーが発生しました: "+(e.message||JSON.stringify(e)||"不明なエラー"));
    }
    setPredictionLoading(false);
  }

  return(
    <div>
      <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"14px 16px",marginBottom:12}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
          <div>
            <div style={{fontSize:15,fontWeight:700,color:"#e0f0ff"}}>📡 市場予測</div>
            <div style={{fontSize:11,color:"#4a7090",marginTop:2}}>AIがニュースと市場データを分析します</div>
          </div>
          <button onClick={runPrediction} disabled={predictionLoading||stocks.length===0}
            style={{background:predictionLoading?"#0a1828":"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:6,color:"#fff",padding:"4px 10px",fontSize:11,fontWeight:700,cursor:predictionLoading||stocks.length===0?"not-allowed":"pointer",fontFamily:"monospace",flexShrink:0,whiteSpace:"nowrap"}}>
            {predictionLoading?"分析中...":"📡 市場予測を分析する"}
          </button>
        </div>
        {lastUpd&&<div style={{fontSize:11,color:"#2a6090"}}>最終更新: {lastUpd}</div>}
        {stocks.length===0&&<div style={{fontSize:11,color:"#f43f5e",marginTop:4}}>※ 先にスキャンを実行してください</div>}
      </div>

      {predictionLoading&&(
        <div style={{background:"#040c18",border:"1px solid #0ea5e940",borderRadius:10,padding:"32px",textAlign:"center"}}>
          <div style={{fontSize:28,marginBottom:12}}>⏳</div>
          <div style={{fontSize:14,color:"#4a90c0",marginBottom:6}}>AIがニュースを収集・分析中です...</div>
          <div style={{fontSize:11,color:"#2a6090"}}>Web検索を含むため30〜60秒かかることがあります</div>
        </div>
      )}

      {!predictionLoading&&predictionResult&&(
        <div>
          <textarea readOnly value={predictionResult}
            style={{width:"100%",height:400,background:"#040c18",border:"1px solid #1e3050",borderRadius:6,color:"#b8cce0",padding:10,fontSize:13,lineHeight:1.8,fontFamily:"monospace",resize:"vertical",boxSizing:"border-box"}}/>
          <button onClick={runPrediction} style={{marginTop:12,width:"100%",background:"transparent",border:"1px solid #1e4070",borderRadius:8,color:"#4a7090",padding:"10px",fontSize:12,cursor:"pointer",fontFamily:"monospace",marginBottom:40}}>🔄 再分析</button>
        </div>
      )}

      {!predictionLoading&&!predictionResult&&(
        <div style={{textAlign:"center",padding:"60px 20px",color:"#2a6090"}}>
          <div style={{fontSize:40,marginBottom:16}}>📡</div>
          <div style={{fontSize:14,color:"#4a90c0",marginBottom:8}}>市場予測を実行してください</div>
          <div style={{fontSize:11,color:"#2a6090"}}>AIが最新ニュースと市場データをもとに分析します</div>
        </div>
      )}
    </div>
  );
}

function NewsPanel(){
  var NEWS_API="https://daytrade-simulator.vercel.app/api/news";
  var NEWS_LINKS=[
    {label:"株式ニュース",url:"https://finance.yahoo.co.jp/news",desc:"国内外の最新株式ニュース"},
    {label:"日本株ニュース",url:"https://finance.yahoo.co.jp/news/stocks",desc:"日本株関連ニュース"},
    {label:"米国株ニュース",url:"https://finance.yahoo.co.jp/news/world",desc:"米国株最新情報"},
    {label:"マーケット概況",url:"https://finance.yahoo.co.jp/stocks",desc:"日本株式市場の概況"},
  ];
  var CATS=[
    {key:"金融政策", icon:"🏦", color:"#a78bfa"},
    {key:"決算・業績", icon:"📈", color:"#22d3a0"},
    {key:"経済指標", icon:"🌍", color:"#60a5fa"},
    {key:"相場急変", icon:"⚡", color:"#fbbf24"},
    {key:"セクター動向", icon:"🏭", color:"#fb923c"},
  ];
  var loadingS=useState(false); var loading=loadingS[0],setLoading=loadingS[1];
  var resultS=useState(null); var result=resultS[0],setResult=resultS[1];
  var lastUpdS=useState(""); var lastUpd=lastUpdS[0],setLastUpd=lastUpdS[1];
  var openCatS=useState(null); var openCat=openCatS[0],setOpenCat=openCatS[1];

  async function fetchNews(){
    setLoading(true); setResult(null);
    try{
      var res=await fetch(NEWS_API,{signal:AbortSignal.timeout(60000)});
      var data=await res.json();
      if(data.error) throw new Error(data.error);
      var text=(data.text||"").replace(/```json|```/g,"").trim();
      var start=text.indexOf("{"); var end=text.lastIndexOf("}");
      if(start===-1||end===-1) throw new Error("JSONが見つかりませんでした");
      var parsed=JSON.parse(text.slice(start,end+1));
      setResult(parsed);
      setLastUpd(new Date().toLocaleTimeString("ja-JP"));
      setOpenCat(CATS.find(function(c){return parsed[c.key]&&parsed[c.key].length>0;})||null);
    }catch(e){
      setResult({error:"取得に失敗しました: "+(e.message||"不明なエラー")});
    }
    setLoading(false);
  }

  return(
    <div>
      {/* AIニュース変換エリア */}
      <div style={{background:"#050e1c",border:"1px solid #0f2040",borderRadius:10,overflow:"hidden",marginBottom:10}}>
        <div style={{background:"#071428",borderBottom:"1px solid #0f2040",padding:"12px 16px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <div style={{fontSize:15,fontWeight:700,color:"#e0f0ff"}}>📰 AIニュース変換</div>
            {lastUpd&&<div style={{fontSize:11,color:"#2a6090",marginTop:2}}>更新: {lastUpd}</div>}
          </div>
          <button onClick={fetchNews} disabled={loading}
            style={{background:loading?"#0a1828":"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:6,color:"#fff",padding:"4px 10px",fontSize:11,fontWeight:700,cursor:loading?"not-allowed":"pointer",fontFamily:"monospace",whiteSpace:"nowrap"}}>
            {loading?"取得中...":"🔄 最新ニュース取得"}
          </button>
        </div>

        {/* ローディング */}
        {loading&&(
          <div style={{textAlign:"center",padding:"48px 20px",color:"#4a90c0"}}>
            <div style={{fontSize:32,marginBottom:12}}>🔍</div>
            <div style={{fontSize:13}}>AIがニュースを取得・分類中...</div>
            <div style={{fontSize:11,color:"#2a6090",marginTop:6}}>最新情報をWeb検索しています</div>
          </div>
        )}

        {/* エラー */}
        {!loading&&result&&result.error&&(
          <div style={{padding:"20px",color:"#f43f5e",fontSize:13}}>{result.error}</div>
        )}

        {/* カテゴリ表示 */}
        {!loading&&result&&!result.error&&(
          <div>
            {/* カテゴリタブ */}
            <div style={{display:"flex",gap:6,padding:"10px 12px",overflowX:"auto",WebkitOverflowScrolling:"touch",borderBottom:"1px solid #0a1828"}}>
              {CATS.map(function(cat){
                var items=result[cat.key]||[];
                var active=openCat&&openCat.key===cat.key;
                return(
                  <button key={cat.key} onClick={function(){setOpenCat(active?null:cat);}}
                    style={{background:active?cat.color+"22":"transparent",border:"1px solid "+(active?cat.color:"#1e3050"),borderRadius:6,color:active?cat.color:"#4a6080",padding:"5px 10px",fontSize:11,cursor:"pointer",fontFamily:"monospace",whiteSpace:"nowrap",flexShrink:0,opacity:items.length===0?0.4:1}}>
                    {cat.icon} {cat.key}
                    {items.length>0&&<span style={{marginLeft:4,background:cat.color+"33",borderRadius:10,padding:"0 5px",fontSize:10,color:cat.color}}>{items.length}</span>}
                  </button>
                );
              })}
            </div>

            {/* ニュース一覧 */}
            {openCat&&(function(){
              var items=result[openCat.key]||[];
              if(items.length===0) return <div style={{padding:"20px",color:"#4a7090",fontSize:13,textAlign:"center"}}>該当ニュースなし</div>;
              return(
                <div style={{padding:"10px 12px",display:"flex",flexDirection:"column",gap:8}}>
                  {items.map(function(item,i){
                    return(
                      <div key={i} style={{background:"#071428",border:"1px solid #1e3050",borderRadius:8,padding:"12px 14px"}}>
                        <div style={{fontSize:13,fontWeight:700,color:"#e0f0ff",marginBottom:6}}>{item.headline}</div>
                        <div style={{fontSize:12,color:"#b8cce0",lineHeight:1.7,marginBottom:8}}>{item.summary}</div>
                        <div style={{background:openCat.color+"18",border:"1px solid "+openCat.color+"44",borderRadius:6,padding:"6px 10px",fontSize:11,color:openCat.color}}>
                          💡 {item.impact}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            {!openCat&&(
              <div style={{textAlign:"center",padding:"24px",color:"#2a6090",fontSize:12}}>カテゴリを選択してください</div>
            )}
          </div>
        )}

        {/* 初期状態 */}
        {!loading&&!result&&(
          <div style={{textAlign:"center",padding:"48px 20px",color:"#2a6090"}}>
            <div style={{fontSize:36,marginBottom:12}}>📰</div>
            <div style={{fontSize:13,color:"#4a90c0",marginBottom:6}}>最新ニュースをAIがわかりやすく変換します</div>
            <div style={{fontSize:11}}>カテゴリ別に整理 + 投資家への影響を解説</div>
          </div>
        )}
      </div>

      {/* 既存リンク集 */}
      <div style={{background:"#050e1c",border:"1px solid #0f2040",borderRadius:10,overflow:"hidden"}}>
        <div style={{background:"#071428",borderBottom:"1px solid #0f2040",padding:"10px 16px"}}>
          <div style={{fontSize:13,fontWeight:700,color:"#4a7090"}}>🔗 ニュースサイト</div>
        </div>
        <div style={{padding:"8px"}}>
          {NEWS_LINKS.map(function(item,i){
            return(
              <a key={i} href={item.url} target="_blank" rel="noreferrer"
                style={{display:"flex",flexDirection:"column",padding:"10px 14px",margin:"4px 0",background:"#071428",border:"1px solid #1e3050",borderRadius:8,textDecoration:"none",gap:3}}>
                <span style={{fontSize:14,fontWeight:700,color:"#93c5fd"}}>{item.label}</span>
                <span style={{fontSize:11,color:"#4a7090"}}>{item.desc}</span>
              </a>
            );
          })}
        </div>
      </div>
    </div>
  );
}
// ── 決算/権利落ちイベント一覧パネル ─────────────────────────────────────
function EventPanel(p){
  var stocks=p.stocks||[];
  var earnRows=stocks
    .map(function(s){return{s:s,ei:earningsInfo(s.earningsDate),type:"earn"};})
    .filter(function(x){return x.ei;});
  var xrightRows=stocks
    .map(function(s){return{s:s,ei:exRightsInfo(s.exRightsDate),type:"xright"};})
    .filter(function(x){return x.ei;});
  var rows=earnRows.concat(xrightRows).sort(function(a,b){return a.ei.days-b.ei.days;});

  return(
    <div style={{background:"#050e1c",border:"1px solid #0f2040",borderRadius:10,overflow:"hidden"}}>
      <div style={{background:"#071428",borderBottom:"1px solid #0f2040",padding:"10px 14px"}}>
        <div style={{fontSize:14,fontWeight:700,color:"#e0f0ff"}}>📅 決算・権利落ち予定</div>
        <div style={{fontSize:11,color:"#4a7090",marginTop:2}}>スキャン済み銘柄のうち、日付が判明しているもののみ表示（権利落ちは概算予想）</div>
      </div>
      {rows.length===0?(
        <div style={{padding:"20px 14px",fontSize:13,color:"#4a7090",textAlign:"center"}}>該当する予定はありません</div>
      ):(
        <div>
          {rows.map(function(row){
            var s=row.s,ei=row.ei,isEarn=row.type==="earn";
            var col=isEarn?(ei.urgent?"#f87171":"#fbbf24"):"#60a5fa";
            var bg=isEarn?(ei.urgent?"#3a0a0a":"#1c1400"):"#0a1a3a";
            var border=isEarn?(ei.urgent?"#f43f5e":"#fbbf24"):"#3b82f6";
            var icon=isEarn?"📈決算":"💰権利落ち(予想)";
            return(
              <div key={s.ticker+"-"+row.type} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 14px",borderBottom:"1px solid #0a1828"}}>
                <div style={{minWidth:0}}>
                  <div style={{fontSize:14,fontWeight:700,color:"#d8eeff"}}>{s.ticker.replace(".T","")} <span style={{fontSize:11,color:"#4a7090",fontWeight:400}}>{s.name}</span></div>
                  <div style={{fontSize:11,color:"#4a7090",marginTop:2}}>{icon} ・ {ei.date}</div>
                </div>
                <span style={bStyle(bg,"1px solid "+border,col)}>{ei.label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function IndexPanel(){
  var INDEX_FUNDS=[
    {label:"eMAXIS Slim 全世界株式（オール・カントリー）",url:"https://www.rakuten-sec.co.jp/web/fund/detail/?ID=JP90C000H1T1",desc:"楽天証券 投資信託詳細ページ"},
    {label:"楽天証券 ホーム",url:"https://member.rakuten-sec.co.jp/app/home.do",desc:"保有資産・取引状況の確認"},
     {label:"実質損益",url:"https://member.rakuten-sec.co.jp/app/ass_real_gain_loss.do;BV_SessionID=11B8DED5279E4D6008E75A4ACDAF15EF.c0240dbc?eventType=init&gmn=S&smn=07&lmn=01&fmn=01",desc:"楽天証券 実質損益確認"},
  ];
  return(
    <div style={{background:"#050e1c",border:"1px solid #0f2040",borderRadius:10,overflow:"hidden"}}>
      <div style={{background:"#071428",borderBottom:"1px solid #0f2040",padding:"12px 16px"}}>
                <div style={{fontSize:15,fontWeight:700,color:"#e0f0ff"}}>リンク</div>
      </div>
      <div style={{padding:"8px"}}>
        {INDEX_FUNDS.map(function(item,i){
          return(
            <a key={i} href={item.url} target="_blank" rel="noreferrer" style={{display:"flex",flexDirection:"column",padding:"12px 14px",margin:"4px 0",background:"#071428",border:"1px solid #1e3050",borderRadius:8,textDecoration:"none",gap:4}}>
              <span style={{fontSize:13,fontWeight:700,color:"#93c5fd"}}>{item.label}</span>
              <span style={{fontSize:12,color:"#4a7090"}}>{item.desc}</span>
            </a>
          );
        })}
      </div>
    </div>
  );
}

// 合言葉＋PINから、常に同じデバイスIDを作り出す（サーバーには合言葉自体を送らない）
async function deriveUserId(word,pin){
  var text=(word||"").trim()+":"+(pin||"").trim();
  var buf=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));
  var hex=Array.from(new Uint8Array(buf)).map(function(b){return b.toString(16).padStart(2,"0");}).join("");
  return "u_"+hex.slice(0,16);
}

function SyncPanel(p){
  var userId=p.userId,syncApi=p.syncApi,setUserId=p.setUserId,setFavs=p.setFavs,setFavGroups=p.setFavGroups,setGroupNames=p.setGroupNames,scan=p.scan;
  var copyStatusS=useState(null);var copyStatus=copyStatusS[0],setCopyStatus=copyStatusS[1];
  var inputS=useState("");var input=inputS[0],setInput=inputS[1];
  var syncStatusS=useState(null);var syncStatus=syncStatusS[0],setSyncStatus=syncStatusS[1];
  var wordS=useState("");var word=wordS[0],setWord=wordS[1];
  var pinS=useState("");var pin=pinS[0],setPin=pinS[1];
  // ログイン済みかどうかをlocalStorageに残し、タブを開き直しても表示が消えないようにする
  var loginStatusS=useState(function(){try{return localStorage.getItem("daytrade_login_done")==="1"?"ok":null;}catch(e){return null;}});var loginStatus=loginStatusS[0],setLoginStatus=loginStatusS[1];
  function copyId(){
    if(navigator.clipboard){navigator.clipboard.writeText(userId).then(function(){setCopyStatus("ok");setTimeout(function(){setCopyStatus(null);},2000);});}
    else{prompt("ユーザーID",userId);}
  }
  // サーバーから取得したデータを画面とlocalStorageに反映する共通処理
  function applySyncedData(data,id){
    setFavs(data.favs?data.favs.slice():[]);
    try{localStorage.setItem("fav_tickers",JSON.stringify(data.favs||[]));}catch(e){}
    if(data.groups){setFavGroups(data.groups);try{localStorage.setItem("fav_groups",JSON.stringify(data.groups));}catch(e){}}
    if(data.groupNames){setGroupNames(function(prev){return Object.assign({},prev,data.groupNames);});try{localStorage.setItem("group_names",JSON.stringify(data.groupNames));}catch(e){}}
    if(data.appTrades){saveTrades("app",data.appTrades);p.setAppTrades(data.appTrades);}
    if(data.personalTrades){saveTrades("personal",data.personalTrades);p.setPersonalTrades(data.personalTrades);}
    if(data.scoreHist){try{Object.keys(data.scoreHist).forEach(function(t){localStorage.setItem("sh_"+t,JSON.stringify(data.scoreHist[t]));});}catch(e){}}
    try{localStorage.setItem("daytrade_uid",id);}catch(e){}
    if(setUserId)setUserId(id);
  }
  async function syncById(){
    var id=input.trim();if(!id)return;
    setSyncStatus("loading");
    try{
      var res=await fetch(syncApi+"?userId="+id,{cache:"no-store"});
      var data=await res.json();
      if(!data.found)throw new Error("not found");
      applySyncedData(data,id);
      setSyncStatus("ok");
      setTimeout(function(){setSyncStatus(null);scan();},1500);
    }catch(e){setSyncStatus("error");setTimeout(function(){setSyncStatus(null);},2500);}
  }
  // 合言葉＋PINでログイン（初めての組み合わせなら、今の端末データをそのまま新規登録する）
  async function loginWithPassphrase(){
    if(!word.trim()||!pin.trim())return;
    setLoginStatus("loading");
    try{
      var id=await deriveUserId(word,pin);
      var res=await fetch(syncApi+"?userId="+id,{cache:"no-store"});
      var data=await res.json();
      if(data.found){
        // 既にこの合言葉で登録済み→サーバーのデータで復元
        applySyncedData(data,id);
      }else{
        // 初めての合言葉＋PIN→端末データは消さず、そのままこのIDで新規登録
        try{localStorage.setItem("daytrade_uid",id);}catch(e){}
        if(setUserId)setUserId(id);
        if(p.syncToServer)p.syncToServer(p.favs,p.favGroups,p.groupNames,p.appTrades,p.personalTrades,id);
      }
      setLoginStatus("ok");
      try{localStorage.setItem("daytrade_login_done","1");}catch(e){}
      setTimeout(function(){scan();},1500); // 表示は「ログイン済み」のまま維持し、スキャンだけ行う
    }catch(e){
      setLoginStatus("error");
      setTimeout(function(){try{setLoginStatus(localStorage.getItem("daytrade_login_done")==="1"?"ok":null);}catch(e2){setLoginStatus(null);}},2500);
    }
  }
  var favCount=(function(){try{return JSON.parse(localStorage.getItem("fav_tickers")||"[]").length;}catch(e){return 0;}})();
  var tradeCount=(function(){try{return loadTrades("app").length+loadTrades("personal").length;}catch(e){return 0;}})();
  var loginReady=word.trim()&&pin.trim();
  return(
    <div>
      <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"14px 16px",marginBottom:14}}>
        <div style={{fontSize:14,fontWeight:700,color:"#e0f0ff",marginBottom:10}}>🔐 合言葉でログイン</div>
        <div style={{fontSize:12,color:"#4a7090",marginBottom:10}}>合言葉とPINを覚えておけば、キャッシュを消した後や別端末でも同じデータに戻せます</div>
        <input style={{background:"#040c18",border:"1px solid #1e4070",borderRadius:6,color:"#b8cce0",padding:"10px 12px",fontSize:16,width:"100%",boxSizing:"border-box",marginBottom:8}} value={word} placeholder="合言葉（例：さくら）" onChange={function(e){setWord(e.target.value);}}/>
        <input style={{background:"#040c18",border:"1px solid #1e4070",borderRadius:6,color:"#b8cce0",padding:"10px 12px",fontSize:16,width:"100%",boxSizing:"border-box",marginBottom:10}} value={pin} placeholder="PIN（例：1234）" inputMode="numeric" onChange={function(e){setPin(e.target.value);}}/>
        <button onClick={loginWithPassphrase} disabled={!loginReady||loginStatus==="loading"} style={{width:"100%",background:loginReady?"linear-gradient(135deg,#22d3a0,#059669)":"#0a1828",border:"none",borderRadius:8,color:"#fff",padding:"10px",fontSize:14,fontWeight:700,cursor:loginReady?"pointer":"not-allowed"}}>
          {loginStatus==="loading"?"ログイン中...":loginStatus==="ok"?"✅ ログイン済み":loginStatus==="error"?"❌ 失敗しました":"ログイン / 新規登録"}
        </button>
        <div style={{fontSize:11,color:"#2a6060",marginTop:8}}>※ 初めて使う合言葉＋PINの組み合わせなら、新規データとして自動的に登録されます</div>
      </div>
      <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"14px 16px",marginBottom:14}}>
        <div style={{fontSize:14,fontWeight:700,color:"#e0f0ff",marginBottom:10}}>🔗 デバイスID（上級者向け）</div>
        <div style={{display:"flex",gap:12,marginBottom:14}}>
          <div style={{background:"#050e1c",borderRadius:8,padding:"10px 16px"}}><div style={{fontSize:11,color:"#2a6090"}}>お気に入り</div><div style={{fontSize:18,fontWeight:800,color:"#fbbf24"}}>{favCount}銘柄</div></div>
          <div style={{background:"#050e1c",borderRadius:8,padding:"10px 16px"}}><div style={{fontSize:11,color:"#2a6090"}}>トレード</div><div style={{fontSize:18,fontWeight:800,color:"#0ea5e9"}}>{tradeCount}件</div></div>
        </div>
        <div style={{fontSize:12,color:"#4a7090",marginBottom:8}}>あなたのデバイスID</div>
        <div style={{background:"#040c18",border:"1px solid #1e4070",borderRadius:8,padding:"10px 12px",fontFamily:"monospace",fontSize:15,color:"#b8cce0",wordBreak:"break-all",marginBottom:10}}>{userId}</div>
        <button onClick={copyId} style={{width:"100%",background:"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:8,color:"#fff",padding:"10px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"monospace",marginBottom:8}}>
          {copyStatus==="ok"?"✅ コピーしました！":"📋 IDをコピー"}
        </button>
        <a href="pushover://" style={{display:"block",width:"100%",background:"linear-gradient(135deg,#1a1a2e,#16213e)",border:"1px solid #4a4a8a",borderRadius:8,color:"#a0a0ff",padding:"10px",fontSize:14,fontWeight:700,fontFamily:"monospace",textDecoration:"none",textAlign:"center",boxSizing:"border-box"}}>
          📱 Pushoverを開く
        </a>
      </div>
      <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"14px 16px",marginBottom:14}}>
        <div style={{fontSize:14,fontWeight:700,color:"#e0f0ff",marginBottom:4}}>別デバイスのIDで同期</div>
        <div style={{fontSize:12,color:"#4a7090",marginBottom:10}}>他のデバイスのIDを入力するとお気に入り・トレードが引き継がれます</div>
        <input style={{background:"#040c18",border:"1px solid #1e4070",borderRadius:6,color:"#b8cce0",padding:"10px 12px",fontSize:16,fontFamily:"monospace",width:"100%",boxSizing:"border-box",marginBottom:10}} value={input} placeholder="別デバイスのIDを貼り付け" onChange={function(e){setInput(e.target.value);}}/>
        <button onClick={syncById} disabled={!input.trim()||syncStatus==="loading"} style={{width:"100%",background:input.trim()?"linear-gradient(135deg,#22d3a0,#059669)":"#0a1828",border:"none",borderRadius:8,color:"#fff",padding:"10px",fontSize:14,fontWeight:700,cursor:input.trim()?"pointer":"not-allowed",fontFamily:"monospace"}}>
          {syncStatus==="loading"?"同期中...":syncStatus==="ok"?"✅ 同期完了！":syncStatus==="error"?"❌ IDが見つかりません":"このIDで同期する"}
        </button>
      </div>
      <div style={{background:"#050e1c",border:"1px solid #0f2040",borderRadius:10,padding:"14px 16px"}}>
        <div style={{fontSize:13,fontWeight:700,color:"#4a90c0",marginBottom:10}}>使い方</div>
        {[["1","🔐で合言葉＋PINを決めてログイン"],["2","別端末でも同じ合言葉＋PINでログイン"],["3","キャッシュを消してしまっても、同じ合言葉＋PINで元に戻せる"]].map(function(row){
          return(<div key={row[0]} style={{display:"flex",gap:10,marginBottom:8,alignItems:"flex-start"}}>
            <span style={{background:"#0ea5e9",color:"#fff",borderRadius:"50%",width:18,height:18,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,flexShrink:0}}>{row[0]}</span>
            <span style={{fontSize:13,color:"#b8cce0"}}>{row[1]}</span>
          </div>);
        })}
        <div style={{fontSize:11,color:"#2a6060",marginTop:8}}>※ お気に入り・トレードの登録・変更時に自動でサーバーに保存されます</div>
      </div>
    </div>
  );
}

// シグナルキー("トレンド#1"等)を人が読める表記に変換
function formatSigKeyLabel(key){
  var parts=key.split("#");
  var label=parts[0],state=parts[1];
  var stateLabel=state==="1"?"↑優勢":state==="-1"?"↓優勢":"中立";
  return label+" "+stateLabel;
}

// ── 実績反映調整の効果検証パネル ─────────────────────────────────────────
// 登録時点の重み補正(weightAdjustAtAdd)の向きごとに完了トレードを3グループに分け、
// 実際の勝率・平均損益を比較する（アプリ予想／個人予想を合算・タブ切替に関わらず常時表示）
// ※このパネル追加より前に登録されたトレードにはweightAdjustAtAdd記録がないため集計対象外
function WeightAdjustVerificationPanel(p){
  var doneAll=(p.appTrades||[]).concat(p.personalTrades||[]).filter(function(t){return t.status==="done"&&t.weightAdjustAtAdd!=null;});
  function bucket(filterFn){
    var arr=doneAll.filter(filterFn);
    var win=arr.length?Math.round(arr.filter(function(t){return(t.pnl||0)>0;}).length/arr.length*100):null;
    var avgPct=arr.length?arr.reduce(function(a,t){return a+(t.pnlPercent||0);},0)/arr.length:null;
    return{count:arr.length,winRate:win,avgPct:avgPct};
  }
  var rows=[
    {label:"補正プラス（強気側に加点）",d:bucket(function(t){return t.weightAdjustAtAdd>0;}),color:"#22d3a0"},
    {label:"補正マイナス（弱気側に減点）",d:bucket(function(t){return t.weightAdjustAtAdd<0;}),color:"#f43f5e"},
    {label:"補正なし",d:bucket(function(t){return t.weightAdjustAtAdd===0;}),color:"#4a7090"}
  ];
  return(
    <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:16}}>
      <div style={{fontSize:16,fontWeight:800,color:"#e0f0ff",marginBottom:6}}>🧪 実績反映調整の効果検証</div>
      <div style={{fontSize:11,color:"#4a7090",marginBottom:10}}>登録時点の重み補正の向きごとに完了トレードを分け、実際の勝率・平均損益を比較します（アプリ予想・個人予想を合算）</div>
      {doneAll.length===0?(
        <div style={{fontSize:13,color:"#4a7090",textAlign:"center",padding:"20px 0"}}>まだ検証対象データがありません。トレードを登録・完了させると溜まっていきます。</div>
      ):(
        rows.map(function(r,i){
          return(
            <div key={i} style={{padding:"8px 0",borderBottom:i<rows.length-1?"1px solid #0a1830":"none"}}>
              <div style={{fontSize:12,color:"#b8cce0",marginBottom:4}}>{r.label}（{r.d.count}件）</div>
              <div style={{display:"flex",gap:16,fontSize:13}}>
                <span style={{color:r.color,fontWeight:700}}>勝率 {r.d.winRate!=null?r.d.winRate+"%":"—"}</span>
                <span style={{color:r.color,fontWeight:700}}>平均損益 {r.d.avgPct!=null?(r.d.avgPct>=0?"+":"")+r.d.avgPct.toFixed(1)+"%":"—"}</span>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// シグナル的中率の中身（お気に入りタブ／トレードタブ両方から使う）
// tickers省略時はお気に入り銘柄で集計。指定時はそのtickerだけで集計（トレードタブ用・お気に入りとは分離）
function SignalAccuracyContent(p){
  var tickers=p&&p.tickers;
  var label=(p&&p.label)||"アプリ予想";
  var data=tickers?calcSignalAccuracyMulti(tickers):calcFavSignalAccuracyMulti();
  var bandData=getUniverseBandStats();
  var emptyLabel=tickers?(label+"の登録銘柄"):"お気に入り銘柄";
  var horizons=[{k:"d1",h:"1日後"},{k:"d3",h:"3日後"},{k:"d5",h:"5日後"}];
  var aiAcc=calcAiForecastAccuracy();
  var intradayAcc=calcIntradayAccuracy();
  var regime=getRegimeSignalStats();
  var tradeSig=calcTradeSignalStats();
  var thrCheck=calcThresholdCheck();
  // 地合い別：両方の地合いで5件以上あるシグナルを、差が大きい順に最大12件
  var regimeRows=(function(){
    var keys={};
    Object.keys(regime.up).forEach(function(k){keys[k]=1;});
    Object.keys(regime.down).forEach(function(k){keys[k]=1;});
    return Object.keys(keys).map(function(k){
      var u=regime.up[k],d=regime.down[k];
      return{signal:k,
        up:u&&u.t>=5?Math.round(signalQuality(u,k)*100):null,upT:u?u.t:0,
        down:d&&d.t>=5?Math.round(signalQuality(d,k)*100):null,downT:d?d.t:0};
    }).filter(function(r){return r.up!=null&&r.down!=null;})
      .sort(function(a,b){return Math.abs(b.up-b.down)-Math.abs(a.up-a.down);})
      .slice(0,12);
  })();
  // スコア帯の逆転検知（隣り合う帯が両方20件以上あるのに、上の帯の的中率が下回る）
  var bandInv=(function(){
    var inv=[];
    for(var bi=0;bi<bandData.length-1;bi++){
      var lo=bandData[bi],hb=bandData[bi+1];
      if(lo.total>=20&&hb.total>=20&&lo.winRate!=null&&hb.winRate!=null&&hb.winRate<lo.winRate)
        inv.push("スコア"+hb.band+"("+hb.winRate+"%) が "+lo.band+"("+lo.winRate+"%) を下回っています");
    }
    return inv;
  })();
  function cellColor(wr){return wr==null?"#4a7090":wr>=60?"#22d3a0":wr>=50?"#fbbf24":"#f43f5e";}
  return(
    <div>
      <div style={{fontSize:11,color:"#4a7090",marginBottom:10}}>{(tickers?(label+"で登録した銘柄"):"お気に入り登録銘柄")+"の過去データを集計。各シグナルの予想方向（強気なら上昇/弱気なら下落）が何営業日後に当たったかを表示します。%の下の小さい数字は、そのシグナル通りに動いた場合の平均騰落率です。並び順は勝率ではなく「1日後の平均騰落率（期待値）が高い順」です"}</div>
      {data.length===0?(
        <div style={{fontSize:13,color:"#4a7090",textAlign:"center",padding:"20px 0"}}>まだデータがありません。{emptyLabel}を毎日スキャンすると溜まっていきます。</div>
      ):(
        <div>
          <div style={{display:"flex",fontSize:11,color:"#2a6090",padding:"4px 8px",borderBottom:"1px solid #0f2040"}}>
            <div style={{flex:1,minWidth:0}}>シグナル</div>
            {horizons.map(function(hz){return <div key={hz.k} style={{width:48,flexShrink:0,textAlign:"right"}}>{hz.h}</div>;})}
          </div>
          {data.map(function(row,i){
            // 🔄反転観測：50件以上あるのに的中率40%未満＝外れ方が安定しているシグナル。
            // 逆に読んだ場合の的中率を目安として表示する（観測のみ・スコアには反映しない）
            var rev=row.d1&&row.d1.total>=50&&row.d1.winRate!=null&&row.d1.winRate<40;
            return(
              <div key={i} style={{display:"flex",alignItems:"center",fontSize:13,padding:"6px 8px",borderBottom:"1px solid #0a1830"}}>
                <div title={isNegExpectancy(row.d1)?"件数十分だが1日後の平均騰落率がマイナス。小さく勝って大きく負ける傾向のシグナルです":""} style={{flex:1,minWidth:0,color:isNegExpectancy(row.d1)?"#fb923c":"#b8cce0",fontFamily:"monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{(isNegExpectancy(row.d1)?"⚠️ ":"")+formatSigKeyLabel(row.signal)}{rev?<span style={{color:"#a78bfa"}} title={"50件以上あるのに的中率"+row.d1.winRate+"%と低く、外れ方が安定しています。逆に読むと"+(100-row.d1.winRate)+"%相当（観測中・スコアには反映していません）"}>{" 🔄逆"+(100-row.d1.winRate)+"%"}</span>:null}</div>
                {horizons.map(function(hz){
                  var c=row[hz.k],reliable=c.total>=5;
                  var avgLabel=c.avgPct!=null?((c.avgPct>=0?"+":"")+c.avgPct.toFixed(1)+"%"):null;
                  return(
                    <div key={hz.k} title={c.total+"件"} style={{width:48,flexShrink:0,textAlign:"right",opacity:reliable?1:0.5}}>
                      <div style={{color:cellColor(c.winRate),fontWeight:700}}>{c.winRate!=null?c.winRate+"%":"-"}</div>
                      {avgLabel&&<div style={{fontSize:9,color:c.avgPct>=0?"#2a8a68":"#b04a5a"}}>{avgLabel}</div>}
                    </div>
                  );
                })}
              </div>
            );
          })}
          <div style={{fontSize:11,color:"#2a6090",marginTop:10}}>※薄字は件数5件未満（参考値）。数値をタップ/ホバーで件数を確認できます</div>
          <div style={{fontSize:11,color:"#fb923c",marginTop:4}}>※<b>⚠️</b>＝10件以上あるのに1日後の平均騰落率がマイナスのシグナル。勝率が高くても「小さく勝って大きく負ける」ため、スコアの主力がこれなら額面通り受け取らない方が安全です</div>
          <div style={{fontSize:11,color:"#a78bfa",marginTop:4}}>※<b>🔄</b>＝50件以上あるのに1日後の的中率が40%未満のシグナル。外れ方が安定しているため「逆に読むと◯%」の目安を表示しています。まだ観測段階で、スコア計算は変えていません</div>
        </div>
      )}
      <div style={{marginTop:16,paddingTop:12,borderTop:"1px solid #0f2040"}}>
        <div style={{fontSize:13,fontWeight:700,color:"#e0f0ff",marginBottom:4}}>📈 スコア帯別 的中率（全スキャン銘柄）</div>
        <div style={{fontSize:11,color:"#4a7090",marginBottom:8}}>タブに関わらず、これまでスキャンした全銘柄のスコアと翌営業日の値動きを集計。スコアが高いほど的中率が高いかの目安になります</div>
        {bandData.every(function(b){return b.total===0;})?(
          <div style={{fontSize:13,color:"#4a7090",textAlign:"center",padding:"12px 0"}}>まだデータがありません。スキャンを重ねると溜まっていきます。</div>
        ):(
          bandData.map(function(b,i){
            var reliable=b.total>=5;
            return(
              <div key={i} style={{display:"flex",alignItems:"center",fontSize:13,padding:"6px 8px",borderBottom:i<bandData.length-1?"1px solid #0a1830":"none",opacity:reliable?1:0.5}}>
                <div style={{flex:1,color:"#b8cce0",fontFamily:"monospace"}}>{"スコア "+b.band}</div>
                <div style={{width:52,textAlign:"right",color:cellColor(b.winRate),fontWeight:700}}>{b.winRate!=null?b.winRate+"%":"-"}</div>
                <div style={{width:40,textAlign:"right",color:"#4a7090"}}>{b.total}</div>
              </div>
            );
          })
        )}
      </div>
      <div style={{marginTop:16,paddingTop:12,borderTop:"1px solid #0f2040"}}>
        <div style={{fontSize:13,fontWeight:700,color:"#e0f0ff",marginBottom:4}}>🤖 AI予想 的中率</div>
        <div style={{fontSize:11,color:"#4a7090",marginBottom:8}}>個別銘柄のAI分析で出た予想方向（上昇/下落）が、実際に当たったかを集計。「中立」予想は対象外です</div>
        {aiAcc.byHorizon.every(function(h){return h.total===0;})?(
          <div style={{fontSize:13,color:"#4a7090",textAlign:"center",padding:"12px 0"}}>まだデータがありません。銘柄詳細でAI分析を実行すると溜まっていきます。</div>
        ):(
          <div>
            <div style={{display:"flex",fontSize:11,color:"#2a6090",padding:"4px 8px",borderBottom:"1px solid #0f2040"}}>
              <div style={{flex:1}}>ホライズン</div>
              <div style={{width:52,textAlign:"right"}}>的中率</div>
              <div style={{width:40,textAlign:"right"}}>件数</div>
            </div>
            {aiAcc.byHorizon.map(function(h,i){
              var reliable=h.total>=5;
              return(
                <div key={i} style={{display:"flex",alignItems:"center",fontSize:13,padding:"6px 8px",borderBottom:"1px solid #0a1830",opacity:reliable?1:0.5}}>
                  <div style={{flex:1,color:"#b8cce0",fontFamily:"monospace"}}>{h.h+"日後"}</div>
                  <div style={{width:52,textAlign:"right",color:cellColor(h.winRate),fontWeight:700}}>{h.winRate!=null?h.winRate+"%":"-"}</div>
                  <div style={{width:40,textAlign:"right",color:"#4a7090"}}>{h.total}</div>
                </div>
              );
            })}
            <div style={{fontSize:11,color:"#2a6090",marginTop:10,marginBottom:4}}>確信度帯別（1日後判定）</div>
            {aiAcc.byConfidence.map(function(c,i){
              var reliable=c.total>=5;
              return(
                <div key={i} style={{display:"flex",alignItems:"center",fontSize:13,padding:"6px 8px",borderBottom:i<aiAcc.byConfidence.length-1?"1px solid #0a1830":"none",opacity:reliable?1:0.5}}>
                  <div style={{flex:1,color:"#b8cce0",fontFamily:"monospace"}}>{"確信度 "+c.band}</div>
                  <div style={{width:52,textAlign:"right",color:cellColor(c.winRate),fontWeight:700}}>{c.winRate!=null?c.winRate+"%":"-"}</div>
                  <div style={{width:40,textAlign:"right",color:"#4a7090"}}>{c.total}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div style={{marginTop:16,paddingTop:12,borderTop:"1px solid #0f2040"}}>
        <div style={{fontSize:13,fontWeight:700,color:"#e0f0ff",marginBottom:4}}>⏰ 時間帯別 的中率（当日終値との比較）</div>
        <div style={{fontSize:11,color:"#4a7090",marginBottom:8}}>その時間帯にスコア60点以上だった銘柄が、記録されたその日最後の時点までに上がっていたかを集計。翌営業日ではなく“当日中”の答え合わせです</div>
        {intradayAcc.every(function(s){return s.total===0;})?(
          <div style={{fontSize:13,color:"#4a7090",textAlign:"center",padding:"12px 0"}}>まだデータがありません。1日に複数回スキャンすると溜まっていきます</div>
        ):(
          intradayAcc.map(function(s,i){
            var reliable=s.total>=5;
            return(
              <div key={i} style={{display:"flex",alignItems:"center",fontSize:13,padding:"6px 8px",borderBottom:i<intradayAcc.length-1?"1px solid #0a1830":"none",opacity:reliable?1:0.5}}>
                <div style={{flex:1,color:"#b8cce0",fontFamily:"monospace"}}>{s.session}</div>
                <div style={{width:52,textAlign:"right",color:cellColor(s.winRate),fontWeight:700}}>{s.winRate!=null?s.winRate+"%":"-"}</div>
                <div style={{width:40,textAlign:"right",color:"#4a7090"}}>{s.total}</div>
              </div>
            );
          })
        )}
      </div>
      {bandInv.length>0&&(
        <div style={{marginTop:16,padding:"10px 12px",background:"#1c1400",border:"1px solid #fbbf2450",borderRadius:8}}>
          <div style={{fontSize:13,fontWeight:700,color:"#fbbf24",marginBottom:4}}>⚠️ スコア帯の逆転を検知</div>
          {bandInv.map(function(msg,i){return <div key={i} style={{fontSize:12,color:"#e0d0a0"}}>{msg}</div>;})}
          <div style={{fontSize:11,color:"#8a7850",marginTop:4}}>「スコアが高いほど当たる」が崩れています。スコア設計（配点・キャップ）の見直しサインです</div>
        </div>
      )}
      <div style={{marginTop:16,paddingTop:12,borderTop:"1px solid #0f2040"}}>
        <div style={{fontSize:13,fontWeight:700,color:"#e0f0ff",marginBottom:4}}>🌤 地合い別 シグナル的中率</div>
        <div style={{fontSize:11,color:"#4a7090",marginBottom:8}}>TOPIXプラスの日とマイナスの日で、シグナルの効き方がどう変わるかを比較します（差が大きい順）</div>
        {regimeRows.length===0?(
          <div style={{fontSize:12,color:"#4a7090",textAlign:"center",padding:"10px 0"}}>📥 データ蓄積中。地合いの記録は最近始まったばかりのため、スキャンを重ねると自動で表示が始まります</div>
        ):(
          <div>
            <div style={{display:"flex",fontSize:11,color:"#2a6090",padding:"4px 8px",borderBottom:"1px solid #0f2040"}}>
              <div style={{flex:1,minWidth:0}}>シグナル</div>
              <div style={{width:64,flexShrink:0,textAlign:"right"}}>TOPIX↑日</div>
              <div style={{width:64,flexShrink:0,textAlign:"right"}}>TOPIX↓日</div>
            </div>
            {regimeRows.map(function(r,i){
              return(
                <div key={i} style={{display:"flex",alignItems:"center",fontSize:13,padding:"6px 8px",borderBottom:"1px solid #0a1830"}}>
                  <div style={{flex:1,minWidth:0,color:"#b8cce0",fontFamily:"monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{formatSigKeyLabel(r.signal)}</div>
                  <div title={r.upT+"件"} style={{width:64,flexShrink:0,textAlign:"right",color:cellColor(r.up),fontWeight:700}}>{r.up+"%"}</div>
                  <div title={r.downT+"件"} style={{width:64,flexShrink:0,textAlign:"right",color:cellColor(r.down),fontWeight:700}}>{r.down+"%"}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div style={{marginTop:16,paddingTop:12,borderTop:"1px solid #0f2040"}}>
        <div style={{fontSize:13,fontWeight:700,color:"#e0f0ff",marginBottom:4}}>💰 実トレード×シグナル（自分の成績）</div>
        <div style={{fontSize:11,color:"#4a7090",marginBottom:8}}>完了したトレードの損益と、登録時に点灯していたシグナルの関係。「自分が実際に勝てているシグナル」が見えてきます</div>
        {tradeSig.filter(function(r){return r.total>=3;}).length===0?(
          <div style={{fontSize:12,color:"#4a7090",textAlign:"center",padding:"10px 0"}}>📥 データ蓄積中。今後登録するトレードから記録が始まり、完了トレードが貯まると自動で表示されます（シグナルごとに3件以上で表示）</div>
        ):(
          <div>
            <div style={{display:"flex",fontSize:11,color:"#2a6090",padding:"4px 8px",borderBottom:"1px solid #0f2040"}}>
              <div style={{flex:1,minWidth:0}}>シグナル</div>
              <div style={{width:48,flexShrink:0,textAlign:"right"}}>勝率</div>
              <div style={{width:56,flexShrink:0,textAlign:"right"}}>平均損益</div>
              <div style={{width:36,flexShrink:0,textAlign:"right"}}>件数</div>
            </div>
            {tradeSig.filter(function(r){return r.total>=3;}).map(function(r,i){
              return(
                <div key={i} style={{display:"flex",alignItems:"center",fontSize:13,padding:"6px 8px",borderBottom:"1px solid #0a1830"}}>
                  <div style={{flex:1,minWidth:0,color:"#b8cce0",fontFamily:"monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{formatSigKeyLabel(r.signal)}</div>
                  <div style={{width:48,flexShrink:0,textAlign:"right",color:cellColor(r.winRate),fontWeight:700}}>{r.winRate+"%"}</div>
                  <div style={{width:56,flexShrink:0,textAlign:"right",color:r.avgPct>=0?"#22d3a0":"#f43f5e",fontWeight:700}}>{(r.avgPct>=0?"+":"")+r.avgPct.toFixed(1)+"%"}</div>
                  <div style={{width:36,flexShrink:0,textAlign:"right",color:"#4a7090"}}>{r.total}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div style={{marginTop:16,paddingTop:12,borderTop:"1px solid #0f2040"}}>
        <div style={{fontSize:13,fontWeight:700,color:"#e0f0ff",marginBottom:4}}>⚙️ 勝敗しきい値の検証</div>
        <div style={{fontSize:11,color:"#4a7090",marginBottom:8}}>スコア60点以上の記録を対象に、「何%以上動いたら勝敗として数えるか」を変えた場合の的中率を比較。現在は0.3%を採用中です</div>
        {thrCheck.map(function(r,i){
          var isCurrent=r.thr===WIN_THRESHOLD_PCT;
          return(
            <div key={i} style={{display:"flex",alignItems:"center",fontSize:13,padding:"5px 8px",borderBottom:i<thrCheck.length-1?"1px solid #0a1830":"none",background:isCurrent?"#0a1e3a":"transparent",borderRadius:isCurrent?6:0}}>
              <div style={{flex:1,color:isCurrent?"#8ac0e8":"#b8cce0",fontFamily:"monospace"}}>{"±"+r.thr+"%以上"+(isCurrent?"（採用中）":"")}</div>
              <div style={{width:52,textAlign:"right",color:cellColor(r.winRate),fontWeight:700}}>{r.winRate!=null?r.winRate+"%":"-"}</div>
              <div style={{width:40,textAlign:"right",color:"#4a7090"}}>{r.total}</div>
            </div>
          );
        })}
      </div>
      <div style={{marginTop:16,paddingTop:12,borderTop:"1px solid #0f2040"}}>
        <div style={{fontSize:13,fontWeight:700,color:"#e0f0ff",marginBottom:4}}>💾 データ管理</div>
        <div style={{fontSize:11,color:"#4a7090",marginBottom:8}}>学習データ（スコア履歴・地合い・トレード記録）はこの端末に保存されています。Safariの仕様で消えることがあるため、週1回の書き出しをおすすめします</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <button onClick={exportAllData} style={{fontSize:12,padding:"8px 12px",borderRadius:6,border:"1px solid #2a4060",background:"#0a1e3a",color:"#8ac0e8",cursor:"pointer"}}>📤 書き出し</button>
          <label style={{fontSize:12,padding:"8px 12px",borderRadius:6,border:"1px solid #2a4060",background:"#0a1e3a",color:"#8ac0e8",cursor:"pointer"}}>
            📂 復元
            <input type="file" accept=".json,application/json" style={{display:"none"}} onChange={function(ev){var f=ev.target.files&&ev.target.files[0];if(f)importAllData(f);ev.target.value="";}}/>
          </label>
          <button onClick={cleanupOldData} style={{fontSize:12,padding:"8px 12px",borderRadius:6,border:"1px solid #2a4060",background:"#0a1e3a",color:"#8ac0e8",cursor:"pointer"}}>🧹 古いデータ掃除</button>
        </div>
      </div>
    </div>
  );
}

function SignalAccuracyModal(p){
  var onClose=p.onClose;
  return(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:500,background:"#000000cc",display:"flex",alignItems:"center",justifyContent:"center",padding:16}}
      onTouchEnd={function(e){if(e.target===e.currentTarget){e.preventDefault();onClose();}}}
      onClick={function(e){if(e.target===e.currentTarget)onClose();}}>
      <div style={{background:"#071428",border:"1px solid #1e4070",borderRadius:14,padding:20,width:"100%",maxWidth:480,maxHeight:"88vh",overflowY:"scroll",WebkitOverflowScrolling:"touch"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <div style={{fontSize:16,fontWeight:800,color:"#e0f0ff"}}>📊 シグナル的中率</div>
          <button onClick={onClose} style={{background:"transparent",border:"1px solid #2a4060",borderRadius:8,color:"#4a7090",padding:"4px 12px",fontSize:14,cursor:"pointer",fontFamily:"monospace"}}>✕</button>
        </div>
        <SignalAccuracyContent tickers={p.tickers} label={p.label}/>
      </div>
    </div>
  );
}

function GuidePanel(){
  var openS=useState("all");var openKey=openS[0],setOpenKey=openS[1];
  var CATS=[
    {key:"all",icon:"📋",label:"全銘柄",sections:[
      {title:null,items:["銘柄カードをタップ → 詳細シグナル表示"]},
      {title:"📊 データ取得の方法",items:["米国株：Yahoo Finance・15分足（直近30日）","日本株：Yahoo Finance・15分足（直近30日）","1分足チャート：Yahoo Finance・1分足（直近5営業日／15〜20分程度の遅延あり）","現在値・板情報のリアルタイム表示：立花証券e支店API（WebSocket中継）","日本株ランキング：立花証券API（出来高上位＋値上がり率上位のハイブリッド）","米国株ランキング：Yahoo Finance 出来高上位50","TOPIX・PER/PBR・配当利回り：立花証券API","市況指数（日経・ダウ等）：Yahoo Finance・15分遅延"]},
      {title:"📈 実績勝率について",items:[
        "カード左側に表示される勝率の見方",
        "具体的には：①スコアが60点以上になった日＝アプリが「これは買いシグナルが強い」と判断した日",
        "②その翌日に実際に株価が上がっていたら「当たり（win）」、下がっていたら「外れ」",
        "③これを繰り返し記録して「当たった回数 ÷ 判定した回数」を計算 → それが「実績勝率」",
        "【推定】スコア×0.72で算出した暫定値。グレー表示。データ不足中に表示されます",
        "【実績】スコア60以上を記録した翌日に実際に価格が上昇したかを集計した実績値。3回以上のデータが溜まると自動で切り替わります",
        "スコア帯は60〜79 / 80〜99 / 100の3段階で集計。毎日スキャンするほど精度が上がります",
        "色の見方：緑=60%以上、黄=50〜59%、赤=50%未満"
      ]},
      {title:"🔥🧊 対TOPIX／対業種バッジの見方（日本株限定）",items:[
        "どちらも「個別銘柄の当日騰落率 − 比較対象の当日騰落率」の差分を表示する補助シグナル。市場全体（または同業他社）の値動きを差し引いた「銘柄固有の強さ・弱さ」を見るためのもの",
        "🔥（緑）＝比較対象より強い、🧊（青緑〜赤）＝比較対象より弱い。差が±0.5%未満の場合は誤差レベルとみなし非表示",
        "対TOPIX：比較対象は東証株価指数（TOPIX）。市場全体に対して強いか弱いかを見る。スコアにも反映され、差が大きいほど最大±6点まで加減算される",
        "対業種：比較対象はその銘柄が属する東証33業種の当日平均騰落率（同業他社の値動き）。同じ業種の中で出遅れている／先行しているかを見る。こちらは参考表示のみでスコアには影響しない",
        "内部の仕組み（対TOPIX）：TOPIXの日足データから前日比%を算出し、全銘柄共通の値として1時間キャッシュ",
        "内部の仕組み（対業種）：その日の全上場銘柄の騰落率を立花証券APIの業種コードで33業種に分類し、業種ごとの平均値を1回だけ集計。同じく1時間キャッシュして使い回す（銘柄ごとに毎回集計し直すと重いため）",
        "どちらも前日比ベースの参考値であり、将来の値動きを保証するものではない"
      ]},
      {title:"🔘 銘柄詳細のアイコン行",items:[
        "🔗：Yahoo!ファイナンスの銘柄ページを新しいタブで開く",
        "📱：銘柄コードをコピーしてiSPEEDアプリを開く（日本株向け）",
        "📋：AI判定用のプロンプトをクリップボードにコピー（claude.aiなどに貼り付けて使う用）",
        "🔄：この銘柄だけを最新データで再スキャン",
        "🤖：AIによる分析・上昇予測をポップアップ表示",
        "💹：損益シミュレーターをポップアップ表示（買値・株数から利確/損切りラインの損益を試算）",
        "🎯：この銘柄をトレード登録（買い価格・売り価格＝利確ライン・株数を入力）"
      ]},
    ]},
    {key:"fav",icon:"⭐",label:"お気に入り",sections:[
      {title:null,items:[
        "★/☆ボタンでお気に入りの登録・解除",
        "グループ1〜5に分類可能（グループ名は選択中に表示される✎アイコンで編集）",
        "「全体」フィルターで登録済みお気に入りを全件表示",
        "検索欄にティッカーコード（例：AAPL、7203）を入力すると新規銘柄を追加登録できる（登録グループも指定可）",
        "市場（US/JP）で絞り込み表示可能（スコアの高い順に並びます）",
        "「📊的中率」ボタンでお気に入り銘柄のシグナル的中率を確認"
      ]},
    ]},
    {key:"trade",icon:"🎯",label:"トレード",sections:[
      {title:null,items:[
        "銘柄カードの🎯ボタンからトレード登録（買い価格・売り価格＝利確ライン・株数を入力。損切り価格は必須）",
        "「🎯アプリ予想」：アプリの買いシグナル判断を忠実に守った場合の検証用タブ",
        "「👤個人予想」：アプリの判断とは別に、自分自身の判断を検証するためのタブ",
        "価格が指定値に到達すると自動で「待機中→進行中→完了」に遷移（判定は🔄価格更新ボタンで反映）",
        "完了したトレードの合計損益・勝率を集計表示",
        "「📊的中率」でアプリ予想／個人予想それぞれに登録した銘柄のシグナル的中率を確認",
        "詳細モーダルの📱iSPEEDボタンで銘柄コードをコピーし、iSPEEDアプリへ遷移（日本株のみ）"
      ]},
    ]},
    {key:"event",icon:"📅",label:"決算・権利落ち",sections:[
      {title:null,items:[
        "スキャン済み銘柄のうち、決算発表予定日・権利落ち予定日が判明しているものだけを一覧表示",
        "日付が近い順に自動でソート",
        "権利落ち予定日は財務情報から算出した概算予想（確定値ではない点に注意）"
      ]},
    ]},
    {key:"index",icon:"🌍",label:"リンク",sections:[
      {title:null,items:[
        "投資信託の詳細ページや証券会社のホーム画面など、よく使う外部サイトへのショートカット一覧",
        "タップすると該当ページを新しいタブで開く"
      ]},
    ]},
    {key:"market",icon:"📡",label:"市場予測",sections:[
      {title:null,items:[
        "「🔄分析実行」でAIがWeb検索を使って最新ニュースを取得し、アプリ内の市場データ（VIX・日本市場の上昇銘柄比率・スコア上位銘柄・ゴールデンクロス/デッドクロスの発生状況）と合わせて分析",
        "出力は「今日の相場環境／注目市場・セクター／注目銘柄／リスク要因／来週の見通し／個人投資家へのアドバイス」の6セクション構成",
        "注目銘柄については、具体的なエントリー・利確・損切りの目安価格まで提示"
      ]},
    ]},
    {key:"news",icon:"📰",label:"ニュース",sections:[
      {title:null,items:[
        "「🔄最新ニュース取得」でTDnet適時開示とYahooファイナンスの見出しを取得し、AIが「金融政策／決算・業績／経済指標／相場急変／セクター動向」の5カテゴリに要約",
        "実際に取得したデータのみを要約対象とし、Web検索やAIの独自知識は使用しない",
        "画面下部には外部ニュースサイトへのリンクも用意"
      ]},
    ]},
  ];
  return(
    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      {CATS.map(function(cat){
        var open=openKey===cat.key;
        return(
          <div key={cat.key} style={{background:"#050e1c",border:"1px solid #0f2040",borderRadius:10,overflow:"hidden"}}>
            <button onClick={function(){setOpenKey(open?null:cat.key);}} style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",background:"#071428",border:"none",padding:"12px 14px",cursor:"pointer",color:"#e0f0ff",fontSize:14,fontWeight:700,fontFamily:"monospace"}}>
              <span>{cat.icon} {cat.label}</span>
              <span style={{color:"#4a7090",fontSize:12}}>{open?"▲":"▼"}</span>
            </button>
            {open&&(
              <div style={{padding:"12px 14px"}}>
                {cat.sections.map(function(sec,i){
                  return(
                    <div key={i} style={{marginBottom:12}}>
                      {sec.title&&<div style={{fontSize:13,fontWeight:700,color:"#4a90c0",marginBottom:6,borderBottom:"1px solid #0f2040",paddingBottom:4}}>{sec.title}</div>}
                      {sec.items.map(function(item,j){
                        return(
                          <div key={j} style={{display:"flex",gap:8,marginBottom:5,alignItems:"flex-start"}}>
                            <span style={{color:"#22d3a0",fontSize:12,marginTop:1,flexShrink:0}}>•</span>
                            <span style={{fontSize:13,color:"#b8cce0"}}>{item}</span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MarketHours(){
  var nowS=useState(new Date());var now=nowS[0],setNow=nowS[1];
  useEffect(function(){
    var t=setInterval(function(){setNow(new Date());},60000);
    return function(){clearInterval(t);};
  },[]);
  var jst=new Date(now.getTime()+9*60*60*1000);
  var h=jst.getUTCHours(),m=jst.getUTCMinutes(),dow=jst.getUTCDay();
  var isWeekday=dow>=1&&dow<=5;
  var timeMin=h*60+m;
  var jpOpen=isWeekday&&((timeMin>=540&&timeMin<690)||(timeMin>=750&&timeMin<930));
  var month=jst.getUTCMonth()+1;
  var day=jst.getUTCDate();
  var isSummer=(month>3&&month<11)||(month===3&&day>=8)||(month===11&&day<=7);
  var usStartMin=isSummer?22*60+30:23*60+30;
  var usEndMin=isSummer?5*60:6*60;
  // 月曜早朝(0:00〜usEndMin)は日曜夜の続きなので閉場
  var usOpen=isWeekday&&(timeMin>=usStartMin||timeMin<usEndMin)&&!(dow===1&&timeMin<usEndMin);
  if(dow===6&&timeMin<usEndMin) usOpen=true;
  if(dow===0&&timeMin>=usStartMin) usOpen=false;
  return(
    <div style={{display:"flex",gap:5,alignItems:"center",flexDirection:"row"}}>
      <div style={{display:"flex",flexDirection:"column",gap:1}}>
        <span style={{fontSize:10,fontWeight:jpOpen?700:400,color:jpOpen?"#22d3a0":"#4a7090",whiteSpace:"nowrap"}}>🇯🇵 9:00〜11:30</span>
        <span style={{fontSize:10,fontWeight:jpOpen?700:400,color:jpOpen?"#22d3a0":"#4a7090",whiteSpace:"nowrap"}}>🇯🇵 12:30〜15:30</span>
      </div>
      <span style={{fontSize:10,color:"#1e3050"}}>|</span>
      <div style={{display:"flex",flexDirection:"column",gap:1}}>
        <span style={{fontSize:10,fontWeight:usOpen?700:400,color:usOpen?"#22d3a0":"#4a7090",whiteSpace:"nowrap"}}>🇺🇸 22:30〜翌5:00<span style={{fontSize:9,color:usOpen?"#22d3a0":"#2a6090"}}>[夏]</span></span>
        <span style={{fontSize:10,fontWeight:usOpen?700:400,color:usOpen?"#22d3a0":"#4a7090",whiteSpace:"nowrap"}}>🇺🇸 23:30〜翌6:00<span style={{fontSize:9,color:usOpen?"#22d3a0":"#2a6090"}}>[冬]</span></span>
      </div>
    </div>
  );
}

// タブアイコン1個分（PCサイドバー・スマホ横並びの両方から使う共通部品）
function TabIconBtn(p){
  var active=p.active;
  return(
    <button onClick={p.onClick} title={p.title} style={{width:p.size,height:p.size,flexShrink:0,background:active?"#0ea5e9":"transparent",border:"1px solid "+(active?"#0ea5e9":"transparent"),borderRadius:8,color:active?"#fff":"#4a6080",fontSize:p.size>=40?17:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
      {p.icon}
    </button>
  );
}

export default function App(){
  var a=useState([]);var stocks=a[0],setStocks=a[1];
  var b=useState(false);var loading=b[0],setLoading=b[1];
  var c=useState({done:0,total:0,msg:null});var progress=c[0],setProgress=c[1];
  var g=useState(null);var ts=g[0],setTs=g[1];
  var vixS=useState(null);var vix=vixS[0],setVix=vixS[1];
  var usdJpyS=useState(null);var usdJpy=usdJpyS[0],setUsdJpy=usdJpyS[1];
  var predResS=useState("");var predictionResult=predResS[0],setPredictionResult=predResS[1];
  var predLoadS=useState(false);var predictionLoading=predLoadS[0],setPredictionLoading=predLoadS[1];
  var selStockS=useState(null);var selectedStock=selStockS[0],setSelectedStock=selStockS[1];
  var k=useState("all");var activeTab=k[0],setActiveTab=k[1];
  var isMobile=useIsMobile(); // スマホ幅（768px未満）判定

  // ── 起動時の業種選択（おまかせ／業種一覧／前回の業種） ──────────────────────
  var JP_33_SECTORS=["水産・農林業","鉱業","建設業","食料品","繊維製品","パルプ・紙","化学","医薬品","石油・石炭製品","ゴム製品","ガラス・土石製品","鉄鋼","非鉄金属","金属製品","機械","電気機器","輸送用機器","精密機器","その他製品","電気・ガス業","陸運業","海運業","空運業","倉庫・運輸関連業","情報・通信業","卸売業","小売業","銀行業","証券、商品先物取引業","保険業","その他金融業","不動産業","サービス業"];
  // 業種ごとの値動きの速さ・材料の効き方から3区分に分類（一般的な傾向の目安・固定値）
  var SECTOR_STYLE={"水産・農林業":"swing","鉱業":"scalp","建設業":"day","食料品":"swing","繊維製品":"swing","パルプ・紙":"swing","化学":"day","医薬品":"swing","石油・石炭製品":"swing","ゴム製品":"day","ガラス・土石製品":"day","鉄鋼":"scalp","非鉄金属":"scalp","金属製品":"day","機械":"day","電気機器":"scalp","輸送用機器":"day","精密機器":"scalp","その他製品":"day","電気・ガス業":"swing","陸運業":"swing","海運業":"scalp","空運業":"swing","倉庫・運輸関連業":"swing","情報・通信業":"scalp","卸売業":"day","小売業":"day","銀行業":"day","証券、商品先物取引業":"scalp","保険業":"swing","その他金融業":"swing","不動産業":"swing","サービス業":"day"};
  var SECTOR_STYLE_GROUPS=[["scalp","⚡ スキャル向き（値動き速い）"],["day","☀️ デイトレ向き"],["swing","📈 スイング向き（トレンド持続）"]];
  var startModeS=useState(null);var startMode=startModeS[0],setStartMode=startModeS[1]; // null=未選択（選択画面表示中）
  var pickerOpenS=useState(false);var sectorPickerOpen=pickerOpenS[0],setSectorPickerOpen=pickerOpenS[1];
  var pickedS=useState([]);var pickedSectors=pickedS[0],setPickedSectors=pickedS[1];
  var rescanMenuOpenS=useState(false);var rescanMenuOpen=rescanMenuOpenS[0],setRescanMenuOpen=rescanMenuOpenS[1]; // 全銘柄タブの再スキャンボタン用メニュー
  function toggleSectorPick(name){
    setPickedSectors(function(prev){
      if(prev.indexOf(name)>=0)return prev.filter(function(n){return n!==name;});
      if(prev.length>=3)return prev; // AIと同じく最大3業種まで
      return prev.concat([name]);
    });
  }
  function startOmakase(){setStartMode("omakase");scan();}
  function confirmManualSectors(){
    if(!pickedSectors.length)return;
    setSectorPickerOpen(false);
    setStartMode("manual");
    scan(pickedSectors);
  }
  function startLastSectors(){
    var last=(function(){try{return JSON.parse(localStorage.getItem("last_sectors")||"[]");}catch(e){return[];}})();
    setStartMode("last");
    if(!last.length){scan(null,true);return;} // 前回データなし→AIは呼ばず通常ランキング
    scan(last);
  }

  var userIdS=useState(function(){try{var id=localStorage.getItem("daytrade_uid");if(!id){id="u_"+Math.random().toString(36).slice(2,10);localStorage.setItem("daytrade_uid",id);}return id;}catch(e){return"u_default";}});var userId=userIdS[0],setUserId=userIdS[1];
  var SYNC_API="https://daytrade-simulator.vercel.app/api/sync";
  function getAllScoreHist(){var result={};try{Object.keys(localStorage).forEach(function(k){if(k.startsWith("sh_"))result[k.slice(3)]=JSON.parse(localStorage.getItem(k)||"[]");});}catch(e){}return result;}
  var fvS=useState(function(){try{var v=localStorage.getItem("fav_tickers");return v?JSON.parse(v):[];}catch(e){return[];}});var favs=fvS[0],setFavs=fvS[1];
  var DEFAULT_GROUP_NAMES={1:"グループ1",2:"グループ2",3:"グループ3",4:"グループ4",5:"グループ5"};
  var fgS=useState(function(){try{var v=localStorage.getItem("fav_groups");return v?JSON.parse(v):{};}catch(e){return{};}});var favGroups=fgS[0],setFavGroups=fgS[1];
  var gnS=useState(function(){try{var v=localStorage.getItem("group_names");return v?Object.assign({},DEFAULT_GROUP_NAMES,JSON.parse(v)):Object.assign({},DEFAULT_GROUP_NAMES);}catch(e){return Object.assign({},DEFAULT_GROUP_NAMES);}});var groupNames=gnS[0],setGroupNames=gnS[1];
  var NOTIFY_API="https://daytrade-simulator.vercel.app/api/notify";
  // 起動時のサーバー読み込みが終わるまでtrueにならない。falseの間は保存を止めて、
  // 「読み込み前の古いデータで上書きしてしまう」事故を防ぐ
  var syncLoadedS=useState(false);var syncLoaded=syncLoadedS[0],setSyncLoaded=syncLoadedS[1];
  function syncToServer(nextFavs,nextGroups,nextGroupNames,nextAppTrades,nextPersonalTrades,targetId){
    if(!syncLoaded)return; // 起動時の読み込み完了前は保存しない
    fetch(SYNC_API+"?userId="+(targetId||userId),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
      favs:nextFavs,
      scoreHist:getAllScoreHist(),
      forecasts:fcLoad(),
      groups:nextGroups,
      groupNames:nextGroupNames,
      appTrades:nextAppTrades!==undefined?nextAppTrades:appTrades,
      personalTrades:nextPersonalTrades!==undefined?nextPersonalTrades:personalTrades
    })}).catch(function(){});
  }
  var favPickerS=useState(null);var favPickerTicker=favPickerS[0],setFavPickerTicker=favPickerS[1];
  // groupNum: 0=全体(未分類) / 1〜5=グループ / null=お気に入り削除
  function applyFav(ticker,groupNum){setFavs(function(prev){
    var isMember=prev.indexOf(ticker)>=0;
    if(groupNum===null){
      if(!isMember)return prev;
      var next=prev.filter(function(t){return t!==ticker;});
      try{localStorage.setItem("fav_tickers",JSON.stringify(next));}catch(e){}
      var nextGroups=Object.assign({},favGroups);delete nextGroups[ticker];
      setFavGroups(nextGroups);
      try{localStorage.setItem("fav_groups",JSON.stringify(nextGroups));}catch(e){}
      syncToServer(next,nextGroups,groupNames);
      return next;
    }
    var isAdding=!isMember;
    var next=isAdding?prev.concat([ticker]):prev;
    if(isAdding){try{localStorage.setItem("fav_tickers",JSON.stringify(next));}catch(e){}}
    var nextGroups=Object.assign({},favGroups);nextGroups[ticker]=groupNum;
    setFavGroups(nextGroups);
    try{localStorage.setItem("fav_groups",JSON.stringify(nextGroups));}catch(e){}
    syncToServer(next,nextGroups,groupNames);
    if(isAdding){
      fetch(NOTIFY_API,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:" ",message:userId})}).catch(function(){});
    }
    return next;
  });}
  // ⭐ボタンからの呼び出し(引数1つ)は保存先選択モーダルを開く。groupNum指定時（addByTicker等）は直接反映
  function toggleFav(ticker,groupNum){
    if(groupNum===undefined){setFavPickerTicker(ticker);return;}
    applyFav(ticker,groupNum);
  }
  function isFav(ticker){return favs.indexOf(ticker)>=0;}
  function renameGroup(groupNum,name){
    var nextNames=Object.assign({},groupNames);nextNames[groupNum]=name;
    setGroupNames(nextNames);
    try{localStorage.setItem("group_names",JSON.stringify(nextNames));}catch(e){}
    syncToServer(favs,favGroups,nextNames);
  }

  // ── トレードシミュレーター：状態管理・登録・削除・価格判定 ───────────────────
  var atS=useState(function(){return loadTrades("app");});var appTrades=atS[0],setAppTrades=atS[1];
  var ptS=useState(function(){return loadTrades("personal");});var personalTrades=ptS[0],setPersonalTrades=ptS[1];
  var tradeRefreshingS=useState(false);var tradeRefreshing=tradeRefreshingS[0],setTradeRefreshing=tradeRefreshingS[1];
  function addTradeHandler(kind,s,buyPrice,sellPrice,shares,stopPrice,buyDirection){
    var next=addTradeRecord(kind,s,buyPrice,sellPrice,shares,stopPrice,buyDirection);
    if(kind==="app"){setAppTrades(next);syncToServer(favs,favGroups,groupNames,next,undefined);}
    else{setPersonalTrades(next);syncToServer(favs,favGroups,groupNames,undefined,next);}
  }
  function removeTradeHandler(kind,id){
    var next=removeTradeRecord(kind,id);
    if(kind==="app"){setAppTrades(next);syncToServer(favs,favGroups,groupNames,next,undefined);}
    else{setPersonalTrades(next);syncToServer(favs,favGroups,groupNames,undefined,next);}
  }
  function editTradeHandler(kind,id,updates){
    var next=editTradeRecord(kind,id,updates);
    if(kind==="app"){setAppTrades(next);syncToServer(favs,favGroups,groupNames,next,undefined);}
    else{setPersonalTrades(next);syncToServer(favs,favGroups,groupNames,undefined,next);}
  }
  function forceCompleteHandler(kind,id,curPrice){
    var next=forceCompleteTradeRecord(kind,id,curPrice);
    if(kind==="app"){setAppTrades(next);syncToServer(favs,favGroups,groupNames,next,undefined);}
    else{setPersonalTrades(next);syncToServer(favs,favGroups,groupNames,undefined,next);}
  }
  // 保有中（waiting/active）のトレード銘柄の価格を手動で更新（🔄ボタン）。自動の定期更新は行わない
  // 日本株は立花証券のリアルタイム値を最優先。取れない場合のみYahoo（約20分遅れ）を使う
  function refreshTradePrices(){
    var tickers=[];
    appTrades.concat(personalTrades).forEach(function(t){
      if(t.status!=="done"&&tickers.indexOf(t.ticker)<0)tickers.push(t.ticker);
    });
    if(!tickers.length)return;
    setTradeRefreshing(true);
    tickers.forEach(function(ticker){delete CACHE[ticker];}); // キャッシュを無視して必ず最新価格を取得
    Promise.all(tickers.map(function(ticker){
      return fetchTachibanaPrice(ticker).then(function(live){
        if(live!=null) return{ticker:ticker,price:live};                       // 立花のリアルタイム値
        return fetchYahoo(ticker).then(function(pd){return{ticker:ticker,price:pd.currentPrice};}); // 取れなければYahoo
      }).catch(function(){return{ticker:ticker,price:null};});
    })).then(function(results){
      var priceMap={};results.forEach(function(r){if(r.price!=null)priceMap[r.ticker]=r.price;});
      if(Object.keys(priceMap).length>0){
        var nextApp=applyPricesToTrades("app",priceMap);
        var nextPersonal=applyPricesToTrades("personal",priceMap);
        setAppTrades(nextApp);
        setPersonalTrades(nextPersonal);
        syncToServer(favs,favGroups,groupNames,nextApp,nextPersonal);
      }
    }).finally(function(){setTradeRefreshing(false);});
  }

  var scan=useCallback(async function(manualSectors,skipAI){
    setLoading(true);
    CACHE={}; // 再スキャン時は必ず最新データを取得（古いキャッシュ流用を防止）
    setProgress({done:0,total:0,msg:skipAI?"前回データなし・通常ランキング取得中...":(manualSectors&&manualSectors.length?"指定業種の銘柄取得中...":"AI業種選定中...")});
    try{
      // 立花証券メンテナンス時間帯（3:00〜8:30）でも、サーバー側（Redis）に前回成功データが
      // あればそれを使えるため、以前のように問い合わせ自体をスキップすることはしない
      var uResult=await buildStockUniverse(manualSectors,skipAI);
      var universe=uResult.stocks.slice();
      var jpCount=universe.length;
      var sectorLabel=uResult.sectors&&uResult.sectors.length?uResult.sectors.map(function(s){return s.name;}).join("/"):"通常ランキング";
      // メンテナンス時間帯かつ0件（＝保存データも無かった）の場合だけ、その旨を伝える
      var maintenance=isTachibanaMaintenance();
      // メンテナンス時間外なのに0件＝2回試しても通信が失敗したということなので、はっきり警告を出す
      var rankingFailed=(!maintenance&&jpCount===0);
      var progressMsg=(maintenance&&jpCount===0)
        ?"⏰ 立花証券システムメンテナンス中(3:00〜8:30)。保存データも無いためお気に入り銘柄のみ表示します"
        :rankingFailed
        ?"⚠️ ランキング取得に失敗しました（通信エラー）。お気に入り銘柄のみ表示しています。再スキャンをお試しください"
        :("JP:"+jpCount+"銘柄（"+sectorLabel+"）取得完了 分析開始...");
      setProgress({done:0,total:0,msg:progressMsg});
      await new Promise(function(r){setTimeout(r,rankingFailed?2500:800);}); // 警告時は気づけるよう長めに表示
      // 次回「前回の業種を表示」で使えるよう、実際に読み込んだ業種を保存
      if(uResult.sectors&&uResult.sectors.length){
        try{localStorage.setItem("last_sectors",JSON.stringify(uResult.sectors.map(function(s){return s.name;})));}catch(e){}
      }
      var favList=(function(){try{var v=localStorage.getItem("fav_tickers");return v?JSON.parse(v):[];}catch(e){return[];}})();
      var uTickers=universe.map(function(s){return s.ticker;});
      favList.forEach(function(ticker){if(uTickers.indexOf(ticker)<0){var isJP=ticker.endsWith(".T"),code=ticker.replace(".T","");universe.push({ticker:ticker,name:code,market:isJP?"JP":"US",tvSymbol:(isJP?"TSE:":"NASDAQ:")+code});}});
      // トレード登録中（待機中・進行中）の銘柄も、カード表示のため必ずuniverseに含める
      loadTrades("app").concat(loadTrades("personal")).forEach(function(t){
        if(t.status==="done")return;
        if(!universe.some(function(u){return u.ticker===t.ticker;})){
          var isJP=t.ticker.endsWith(".T"),code=t.ticker.replace(".T","");
          universe.push({ticker:t.ticker,name:t.name||code,market:isJP?"JP":"US",tvSymbol:(isJP?"TSE:":"NASDAQ:")+code});
        }
      });
      setProgress({done:0,total:universe.length,msg:null});
      // 実際の同時実行制御はSTOCK_QUEUE側で行うため、ここでは
      // 全銘柄分をまとめて呼び出すだけでよい（バッチ分割・待機は不要）
      var results=[];
      await Promise.all(universe.map(async function(stock){
        var pd=await fetchYahooSafe(stock.ticker);
        try{results.push(analyzeStock(stock,pd,vix));}catch(e){console.error("analyzeStock error",stock.ticker,e);}
        setProgress(function(p){return{done:p.done+1,total:p.total,msg:null};});
      }));
      results.sort(function(x,y){return y.score-x.score;});
      setStocks(results);
      setTs(new Date().toLocaleTimeString("ja-JP"));
    }catch(err){
      setProgress({done:0,total:0,msg:"❌ エラー: "+err.message});
    }finally{
      setLoading(false);
    }
  },[]);
  var rescanLoadingS=useState({});var rescanLoading=rescanLoadingS[0],setRescanLoading=rescanLoadingS[1];
  var rescanOne=useCallback(async function(ticker){
    setRescanLoading(function(prev){var n=Object.assign({},prev);n[ticker]=true;return n;});
    delete CACHE[ticker];
    try{
      var existing=stocks.find(function(s){return s.ticker===ticker;});
      if(!existing) return;
      var pd=await fetchYahooSafe(ticker);
      var updated=analyzeStock(existing,pd,vix);
      setStocks(function(prev){return prev.map(function(s){return s.ticker===ticker?updated:s;});});
    }finally{
      setRescanLoading(function(prev){var n=Object.assign({},prev);delete n[ticker];return n;});
    }
  },[stocks]);
  // 「今の銘柄でリロード」：業種の再選定は行わず、現在表示中の銘柄だけ最新データで再分析
  var reloadCurrentUniverse=useCallback(async function(){
    setLoading(true);
    CACHE={};
    var universe=stocks.map(function(s){return{ticker:s.ticker,name:s.name,market:s.market,tvSymbol:s.tvSymbol};});
    setProgress({done:0,total:universe.length,msg:null});
    try{
      // 実際の同時実行制御はSTOCK_QUEUE側で行うため、ここでは
      // 全銘柄分をまとめて呼び出すだけでよい（バッチ分割・待機は不要）
      var results=[];
      await Promise.all(universe.map(async function(stock){
        var pd=await fetchYahooSafe(stock.ticker);
        try{results.push(analyzeStock(stock,pd,vix));}catch(e){console.error("analyzeStock error",stock.ticker,e);}
        setProgress(function(p){return{done:p.done+1,total:p.total,msg:null};});
      }));
      results.sort(function(x,y){return y.score-x.score;});
      setStocks(results);
      setTs(new Date().toLocaleTimeString("ja-JP"));
    }catch(err){
      setProgress({done:0,total:0,msg:"❌ エラー: "+err.message});
    }finally{
      setLoading(false);
    }
  },[stocks,vix]);
  useEffect(function(){
    fetch(VERCEL_API+"?ticker="+encodeURIComponent("^VIX")+"&range=5d")
      .then(function(r){return r.json();})
      .then(function(json){
        var meta=json&&json.chart&&json.chart.result&&json.chart.result[0]&&json.chart.result[0].meta;
        if(meta) setVix(meta.regularMarketPrice||null);
      }).catch(function(){});
  },[]);
  useEffect(function(){
    fetch(VERCEL_API+"?ticker="+encodeURIComponent("USDJPY=X")+"&range=5d")
      .then(function(r){return r.json();})
      .then(function(json){
        var meta=json&&json.chart&&json.chart.result&&json.chart.result[0]&&json.chart.result[0].meta;
        if(meta) setUsdJpy(meta.regularMarketPrice||null);
      }).catch(function(){});
  },[]);
  useEffect(function(){
    // cache:"no-store"→ブラウザのキャッシュを使わず必ずサーバーから最新を取得
    // AbortSignal.timeout→通信が固まった場合でも8秒で諦めて保存ロックを解除する
    fetch(SYNC_API+"?userId="+userId,{cache:"no-store",signal:AbortSignal.timeout(8000)})
      .then(function(r){return r.json();})
      .then(function(data){
        if(data.favs&&data.favs.length>0){setFavs(data.favs.slice());try{localStorage.setItem("fav_tickers",JSON.stringify(data.favs));}catch(e){}}
        if(data.groups){setFavGroups(data.groups);try{localStorage.setItem("fav_groups",JSON.stringify(data.groups));}catch(e){}}
        if(data.groupNames){setGroupNames(function(prev){return Object.assign({},prev,data.groupNames);});try{localStorage.setItem("group_names",JSON.stringify(data.groupNames));}catch(e){}}
        if(data.appTrades){saveTrades("app",data.appTrades);setAppTrades(data.appTrades);}
        if(data.personalTrades){saveTrades("personal",data.personalTrades);setPersonalTrades(data.personalTrades);}
        if(data.scoreHist){try{Object.keys(data.scoreHist).forEach(function(ticker){localStorage.setItem("sh_"+ticker,JSON.stringify(data.scoreHist[ticker]));});}catch(e){}}
        if(data.forecasts){try{fcMerge(data.forecasts);}catch(e){}}
      })
      .catch(function(){})
      .finally(function(){setSyncLoaded(true);}); // 成功・失敗どちらでも保存ロックを解除
  },[]);
  // お気に入りが揃ったら、その日ぶんの予測をまとめて記録する（1日1回だけ動く）
  useEffect(function(){
    if(!syncLoaded)return;
    recordFavForecasts(favs);
  },[syncLoaded,favs]);
  var TABS=[["all","📋"],["fav","⭐"],["trade","🎯"],["event","📅"],["index","🌍"],["market","📡"],["news","📰"],["sync","🔗"],["guide","📘"]];
  var TAB_LABELS={"all":"全銘柄","fav":"お気に入り","trade":"トレード","event":"決算・権利落ち","index":"リンク","market":"市場予測","news":"ニュース","sync":"デバイス同期","guide":"使い方"};

  var sectorPickerModal=sectorPickerOpen&&createPortal(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.6)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"#071428",border:"1px solid #1e3050",borderRadius:10,padding:16,width:"100%",maxWidth:520,maxHeight:"80vh",display:"flex",flexDirection:"column",color:"#b8cce0"}}>
        <div style={{fontSize:13,fontWeight:800,color:"#e0f0ff",marginBottom:8}}>業種を選択（{pickedSectors.length}/3）</div>
        <div style={{overflowY:"auto",marginBottom:10}}>
          {SECTOR_STYLE_GROUPS.map(function(g){
            var key=g[0],label=g[1];
            var list=JP_33_SECTORS.filter(function(name){return SECTOR_STYLE[name]===key;});
            return(
              <div key={key} style={{marginBottom:10}}>
                <div style={{fontSize:11,fontWeight:700,color:"#4a90c0",margin:"4px 0 4px"}}>{label}</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px 10px"}}>
                  {list.map(function(name){
                    var checked=pickedSectors.indexOf(name)>=0;
                    return(
                      <label key={name} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 8px",background:checked?"#0ea5e930":"transparent",borderRadius:6,cursor:"pointer",fontSize:12,color:"#b8cce0"}}>
                        <input type="checkbox" checked={checked} onChange={function(){toggleSectorPick(name);}}/>
                        {name}
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={function(){setSectorPickerOpen(false);}} style={{flex:1,padding:"10px 0",background:"transparent",border:"1px solid #2a4060",borderRadius:8,color:"#4a7090",fontSize:12,cursor:"pointer",fontFamily:"monospace"}}>キャンセル</button>
          <button onClick={confirmManualSectors} disabled={!pickedSectors.length} style={{flex:1,padding:"10px 0",background:pickedSectors.length?"#0ea5e9":"#1e3050",border:"none",borderRadius:8,color:"#fff",fontSize:12,fontWeight:700,cursor:pickedSectors.length?"pointer":"default",fontFamily:"monospace"}}>この業種で読み込む</button>
        </div>
      </div>
    </div>,
    document.body
  );

  // 再スキャンメニュー（全銘柄タブの「再スキャン」ボタンから開く：起動時と同じ3択＋現在の銘柄でリロード）
  var rescanMenu=rescanMenuOpen&&createPortal(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.6)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"#071428",border:"1px solid #1e3050",borderRadius:10,padding:16,width:"100%",maxWidth:320,display:"flex",flexDirection:"column",gap:8,color:"#b8cce0"}}>
        <div style={{fontSize:13,fontWeight:800,color:"#e0f0ff",marginBottom:4}}>🔄 再スキャン方法を選択</div>
        <button onClick={function(){setRescanMenuOpen(false);startOmakase();}} style={{padding:"12px 10px",background:"#0ea5e9",border:"none",borderRadius:8,color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>🤖 おまかせ（AIがトレンド業種を選定）</button>
        <button onClick={function(){setRescanMenuOpen(false);setPickedSectors([]);setSectorPickerOpen(true);}} style={{padding:"12px 10px",background:"#050f20",border:"1px solid #1e3050",borderRadius:8,color:"#b8cce0",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>📋 業種コード一覧から選ぶ</button>
        <button onClick={function(){setRescanMenuOpen(false);reloadCurrentUniverse();}} style={{padding:"12px 10px",background:"#050f20",border:"1px solid #1e3050",borderRadius:8,color:"#b8cce0",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>🔁 今の銘柄でリロード</button>
        <button onClick={function(){setRescanMenuOpen(false);}} style={{padding:"8px 0",background:"transparent",border:"1px solid #2a4060",borderRadius:8,color:"#4a7090",fontSize:12,cursor:"pointer",fontFamily:"monospace"}}>キャンセル</button>
      </div>
    </div>,
    document.body
  );

  var favPickerModal=favPickerTicker&&createPortal(
    <FavPickerModal ticker={favPickerTicker} favs={favs} favGroups={favGroups} groupNames={groupNames}
      onSelect={function(g){applyFav(favPickerTicker,g);setFavPickerTicker(null);}}
      onRemove={function(){applyFav(favPickerTicker,null);setFavPickerTicker(null);}}
      onClose={function(){setFavPickerTicker(null);}}/>,
    document.body
  );

  if(startMode===null){
    return(
      <div style={{minHeight:"100vh",background:"#040c18",fontFamily:"monospace",color:"#b8cce0",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:20,gap:14}}>
        <div style={{fontSize:15,fontWeight:800,color:"#e0f0ff",marginBottom:6}}>📊 どの業種で始めますか？</div>
        <button onClick={startOmakase} style={{width:260,padding:"14px 12px",background:"#0ea5e9",border:"none",borderRadius:8,color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>
          🤖 おまかせ（AIがトレンド業種を選定）
        </button>
        <button onClick={function(){setPickedSectors([]);setSectorPickerOpen(true);}} style={{width:260,padding:"14px 12px",background:"#050f20",border:"1px solid #1e3050",borderRadius:8,color:"#b8cce0",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>
          📋 業種コード一覧から選ぶ（最大3業種）
        </button>
        <button onClick={startLastSectors} style={{width:260,padding:"14px 12px",background:"#050f20",border:"1px solid #1e3050",borderRadius:8,color:"#b8cce0",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>
          🔁 前回の業種を表示
        </button>
        {sectorPickerModal}
      </div>
    );
  }

  return(
    <div style={{minHeight:"100vh",background:"#040c18",backgroundAttachment:"fixed",fontFamily:"monospace",color:"#b8cce0"}}>
      <div style={{background:"linear-gradient(180deg,#071428,#050f20)",borderBottom:"1px solid #0f2040",padding:"8px 12px",marginLeft:isMobile?0:50}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div style={{fontSize:14,fontWeight:800,color:"#e0f0ff"}}>
            DaySimulator <span style={{fontSize:12,color:"#4a7090",fontWeight:400}}>/ {TAB_LABELS[activeTab]}</span>
          </div>
          <MarketHours/>
        </div>
        {sectorPickerModal}
        {rescanMenu}
        {favPickerModal}
      </div>
      {isMobile&&(
        <div style={{display:"flex",gap:4,padding:"4px 8px",background:"#050f20",borderBottom:"1px solid #0f2040",overflowX:"auto",WebkitOverflowScrolling:"touch",height:MOBILE_TABBAR_H,boxSizing:"border-box",alignItems:"center"}}>
          {TABS.map(function(tab){return <TabIconBtn key={tab[0]} active={activeTab===tab[0]} onClick={function(){setActiveTab(tab[0]);}} title={TAB_LABELS[tab[0]]} icon={tab[1]} size={36}/>;})}
        </div>
      )}
      <div>
        {!isMobile&&(
          <div style={{width:50,background:"#050f20",borderRight:"1px solid #0f2040",display:"flex",flexDirection:"column",alignItems:"center",paddingTop:10,gap:4,flexShrink:0,position:"fixed",top:0,left:0,height:"100vh",overflowY:"auto",zIndex:15}}>
            {TABS.map(function(tab){return <TabIconBtn key={tab[0]} active={activeTab===tab[0]} onClick={function(){setActiveTab(tab[0]);}} title={TAB_LABELS[tab[0]]} icon={tab[1]} size={40}/>;})}
          </div>
        )}
        <div style={{marginLeft:isMobile?0:50,padding:isMobile?"6px 6px 100px":"10px 10px 120px"}}>
          {activeTab==="all"&&<AllStocksPanel stocks={stocks} loading={loading} toggleFav={toggleFav} favs={favs} vix={vix} usdJpy={usdJpy} onScan={function(){setRescanMenuOpen(true);}} ts={ts} progress={progress} selectedStock={selectedStock} setSelectedStock={setSelectedStock} onRescan={rescanOne} rescanLoading={rescanLoading} onAddTrade={addTradeHandler} appTrades={appTrades} personalTrades={personalTrades}/>}
          {activeTab==="fav"&&<FavPanel stocks={stocks} setStocks={setStocks} favs={favs} toggleFav={toggleFav} favGroups={favGroups} groupNames={groupNames} renameGroup={renameGroup} vix={vix} usdJpy={usdJpy} selectedStock={selectedStock} setSelectedStock={setSelectedStock} onRescan={rescanOne} rescanLoading={rescanLoading} onAddTrade={addTradeHandler} appTrades={appTrades} personalTrades={personalTrades}/>}
          {activeTab==="trade"&&<TradePanel stocks={stocks} appTrades={appTrades} personalTrades={personalTrades} toggleFav={toggleFav} favs={favs} vix={vix} usdJpy={usdJpy} selectedStock={selectedStock} setSelectedStock={setSelectedStock} onRescan={rescanOne} rescanLoading={rescanLoading} onAddTrade={addTradeHandler} onRemoveTrade={removeTradeHandler} onEditTrade={editTradeHandler} onForceComplete={forceCompleteHandler} onRefreshTrades={refreshTradePrices} tradeRefreshing={tradeRefreshing}/>}
          {activeTab==="index"&&<IndexPanel/>}
          {activeTab==="market"&&<MarketPredictionPanel stocks={stocks} vix={vix} predictionResult={predictionResult} setPredictionResult={setPredictionResult} predictionLoading={predictionLoading} setPredictionLoading={setPredictionLoading} favs={favs} toggleFav={toggleFav}/>}
          {activeTab==="news"&&<NewsPanel/>}
          {activeTab==="event"&&<EventPanel stocks={stocks}/>}
          {activeTab==="sync"&&<SyncPanel userId={userId} setUserId={setUserId} syncApi={SYNC_API} favs={favs} favGroups={favGroups} groupNames={groupNames} appTrades={appTrades} personalTrades={personalTrades} syncToServer={syncToServer} setFavs={setFavs} setFavGroups={setFavGroups} setGroupNames={setGroupNames} setAppTrades={setAppTrades} setPersonalTrades={setPersonalTrades} scan={scan}/>}
          {activeTab==="guide"&&<GuidePanel/>}
        </div>
      </div>
    </div>
  );
}
