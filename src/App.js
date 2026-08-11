import { useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
// ── スコア計算の共有モジュール（フロント／サーバー共通）─────────────────────
// 指標の計算・スコアリングは src/lib/analyze.js に切り出してある。
// あちらは localStorage / window / document を一切参照しない純粋なJSなので、
// 将来 api/ 配下（Vercel Functions）からも同じ計算をそのまま呼べる
import {
  analyzeStock as analyzeStockCore,
  JP_HOLIDAYS, jstInfo, findPrevClose, TRADE_STYLES,
  WIN_THRESHOLD_PCT, priceMoveState, bizDayDiff, sigStatDays,
  baseSigLabel, signalQuality, INTRADAY_SESSIONS, currentSessionLabel
} from "./lib/analyze";

// ── スマホ幅判定（768px未満をスマホ扱い。画面回転・分割表示にも追従）─────────
// iPadのSafariは「デスクトップ用Webサイトを表示」が既定のため、画面を半分にしても
// 広いレイアウト幅（≈980px）のまま縮小表示される。そのため window.innerWidth だけでは
// 「実際は狭い」ことを判定できない。iOS端末では devicePixelRatio から縮小率を逆算し、
// 画面上で実際に見えている幅に換算してスマホ判定する。
var MOBILE_BP=768; // この幅未満（見た目換算）をスマホ表示にする

// ── レイアウトの手動切替（自動 / スマホ版固定 / PC版固定）─────────────────────
// ホーム画面から「Webアプリ」として開くと、画面を左右に寄せても横幅が正しく伝わらず
// 自動判定がPC版のままになることがある。そのため一番上の帯のボタンで手動指定できるようにする。
var LAYOUT_KEY="layout_mode"; // "auto"（自動）/ "sp"（スマホ版固定）/ "pc"（PC版固定）
function getLayoutMode(){try{return localStorage.getItem(LAYOUT_KEY)||"auto";}catch(e){return "auto";}}
function setLayoutMode(m){
  try{localStorage.setItem(LAYOUT_KEY,m);}catch(e){}
  window.dispatchEvent(new Event("layoutmodechange")); // 画面全体に切替を知らせる
}

// ── 端末に記憶する状態（useStateと同じ使い方）─────────────────────────────
// タブを切り替えると部品が一度消えて状態がリセットされるため、選んだ内容を
// localStorageに保存しておき、戻ってきた時・アプリを開き直した時に復元する。
function usePersistedState(key,initial){
  var s=useState(function(){try{var v=localStorage.getItem(key);return v==null?initial:JSON.parse(v);}catch(e){return initial;}});
  useEffect(function(){try{localStorage.setItem(key,JSON.stringify(s[0]));}catch(e){}},[s[0]]);
  return s;
}
function isIOSDevice(){
  var ua=navigator.userAgent||"";
  if(/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13以降のSafariはMacintoshを名乗るのでタッチ数で判別
  return /Macintosh/.test(ua)&&(navigator.maxTouchPoints||0)>1;
}
function calcIsMobile(){
  var mode=getLayoutMode();
  if(mode==="sp") return true;   // 手動でスマホ版を選択中
  if(mode==="pc") return false;  // 手動でPC版を選択中
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
    window.addEventListener("layoutmodechange",onResize); // 手動切替ボタンからの通知
    if(vv&&vv.addEventListener) vv.addEventListener("resize",onResize);
    onResize(); // マウント直後にも一度判定（分割表示で開いた場合の取りこぼし防止）
    return function(){
      window.removeEventListener("resize",onResize);
      window.removeEventListener("orientationchange",onResize);
      window.removeEventListener("layoutmodechange",onResize);
      if(vv&&vv.removeEventListener) vv.removeEventListener("resize",onResize);
    };
  },[]);
  return isMobile;
}
var MOBILE_HEADER_H=50,MOBILE_TABBAR_H=44; // ヘッダー高さ・スマホ用タブバー高さ（sticky位置計算に使用）

// 一番上の帯に置くレイアウト切替ボタン（押すたびに 自動→スマホ版→PC版→自動 と一巡）
function LayoutModeBtn(){
  var s=useState(getLayoutMode);var mode=s[0],setMode=s[1];
  var NEXT={auto:"sp",sp:"pc",pc:"auto"};
  var LABEL={auto:"🔄自動",sp:"📱スマホ",pc:"💻PC"};
  var COLOR={auto:"#4a7090",sp:"#22d3a0",pc:"#0ea5e9"};
  return(
    <button onClick={function(){var n=NEXT[mode];setMode(n);setLayoutMode(n);}} title="表示レイアウトの切替（自動→スマホ版→PC版）"
      style={{flexShrink:0,background:"transparent",border:"1px solid "+COLOR[mode],borderRadius:6,color:COLOR[mode],padding:"3px 8px",fontSize:11,cursor:"pointer",fontFamily:"monospace",whiteSpace:"nowrap"}}>
      {LABEL[mode]}
    </button>
  );
}

var BADGE = {
  BUY:   { bg:"#052e16", border:"#22d3a0", text:"#22d3a0", label:"買い"   },
  TRY:   { bg:"#0d2438", border:"#0ea5e9", text:"#38bdf8", label:"打診買い" },
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
var NAMES_API="https://daytrade-simulator.vercel.app/api/ipo";

// ── 銘柄コード→会社名の対応表 ──────────────────────────────────────────
// /api/ipo（立花証券の銘柄マスタ）から一括で取得し、端末内に24時間キャッシュする。
// これが無いと「8308」のようにコードのままAIに渡ってしまい、AIがWeb検索で
// 別銘柄と取り違える原因になる。取得に失敗した場合はコード表示のまま動く。
var JP_NAME_MAP=null;                    // メモリ上のキャッシュ
var JP_NAME_TTL=24*60*60*1000;           // 24時間
function loadCachedNameMap(){
  try{
    var v=JSON.parse(localStorage.getItem("jp_name_map")||"null");
    if(v&&v.names&&Date.now()-(v.ts||0)<JP_NAME_TTL) return v.names;
  }catch(e){}
  return null;
}
async function fetchJPNameMap(){
  if(JP_NAME_MAP) return JP_NAME_MAP;
  var cached=loadCachedNameMap();
  if(cached){JP_NAME_MAP=cached;return cached;}
  try{
    var res=await fetch(NAMES_API,{signal:AbortSignal.timeout(15000)});
    var json=await res.json();
    JP_NAME_MAP=json.names||{};
    try{localStorage.setItem("jp_name_map",JSON.stringify({ts:Date.now(),names:JP_NAME_MAP}));}catch(e){}
    return JP_NAME_MAP;
  }catch(e){ return {}; } // 失敗はキャッシュせず、次の機会に再取得する
}
// universe内の「会社名がコードのままの日本株」に正式名称を当てはめる（AIの銘柄取り違え防止）
async function fillJPNames(universe){
  await fetchJPNameMap();
  (universe||[]).forEach(function(u){
    if(!u||u.market!=="JP") return;
    var c=u.ticker.replace(".T","");
    if(!u.name||u.name===c||u.name===u.ticker) u.name=jpNameOf(u.ticker,c);
  });
  return universe;
}
// ticker("8308.T")から会社名を引く。見つからなければfallback（通常はコード）を返す
function jpNameOf(ticker,fallback){
  var code=String(ticker||"").replace(".T","");
  var m=JP_NAME_MAP||loadCachedNameMap();
  return (m&&m[code])||fallback||code;
}
var SECTOR_API="https://daytrade-simulator.vercel.app/api/sector";
var INTRADAY_API="https://daytrade-simulator.vercel.app/api/intraday";
var DAILY_API="https://daytrade-simulator.vercel.app/api/daily";
var TACHIBANA_WATCH_API="https://daytrade-simulator.vercel.app/api/sync?resource=tachibana-watch";
var TACHIBANA_QUOTE_API="https://daytrade-simulator.vercel.app/api/sync?resource=tachibana-quote";

// ── 東証33業種コード（業種名 → 4桁コード）─────────────────────────────
// ニュースに出てきた業種にコードを添えて表示する用途と、業種まとめ登録の表示に使う
var SECTOR_CODES={"水産・農林業":"0050","鉱業":"1050","建設業":"2050","食料品":"3050","繊維製品":"3100","パルプ・紙":"3150","化学":"3200","医薬品":"3250","石油・石炭製品":"3300","ゴム製品":"3350","ガラス・土石製品":"3400","鉄鋼":"3450","非鉄金属":"3500","金属製品":"3550","機械":"3600","電気機器":"3650","輸送用機器":"3700","精密機器":"3750","その他製品":"3800","電気・ガス業":"4050","陸運業":"5050","海運業":"5100","空運業":"5150","倉庫・運輸関連業":"5200","情報・通信業":"5250","卸売業":"6050","小売業":"6100","銀行業":"7050","証券、商品先物取引業":"7100","保険業":"7150","その他金融業":"7200","不動産業":"8050","サービス業":"9050"};
// ニュース記事でよく使われる呼び方 → 正式な業種名（例：「半導体関連が上昇」→ 電気機器）
var SECTOR_ALIASES={"半導体":"電気機器","電機":"電気機器","自動車":"輸送用機器","商社":"卸売業","総合商社":"卸売業","電力":"電気・ガス業","ガス":"電気・ガス業","通信":"情報・通信業","銀行":"銀行業","証券":"証券、商品先物取引業","保険":"保険業","不動産":"不動産業","小売":"小売業","建設":"建設業","海運":"海運業","空運":"空運業","鉄道":"陸運業","医薬":"医薬品","製薬":"医薬品","食品":"食料品","非鉄":"非鉄金属","繊維":"繊維製品","石油":"石油・石炭製品","精密":"精密機器","倉庫":"倉庫・運輸関連業"};
// 文章の中から業種を見つけてコード付きで返す（最大3件・重複なし）
function detectSectors(text){
  var t=String(text||""),found=[],names={};
  function push(name){if(!name||names[name]||!SECTOR_CODES[name])return;names[name]=true;found.push({name:name,code:SECTOR_CODES[name]});}
  Object.keys(SECTOR_CODES).forEach(function(name){if(t.indexOf(name)>=0)push(name);});
  Object.keys(SECTOR_ALIASES).forEach(function(word){if(t.indexOf(word)>=0)push(SECTOR_ALIASES[word]);});
  return found.slice(0,3);
}

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
    var stocks=(json.stocks||[]).map(function(s){return{ticker:s.ticker,name:s.name,market:s.market,tvSymbol:s.tvSymbol,volume:s.volume||0};});
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
    var stocks=(json.stocks||[]).map(function(s){return{ticker:s.ticker,name:s.name,market:s.market,tvSymbol:s.tvSymbol,volume:s.volume||0};});
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
  if(CACHE[ticker]&&now-CACHE[ticker].ts<CACHE_TTL){var cached=CACHE[ticker].data;return{closes:cached.closes.slice(),highs:cached.highs.slice(),lows:cached.lows.slice(),volumes:cached.volumes?cached.volumes.slice():[],opens:cached.opens?cached.opens.slice():[],dates:cached.dates?cached.dates.slice():[],currentPrice:cached.currentPrice,previousClose:cached.previousClose,officialPrevClose:cached.officialPrevClose,officialVolume:cached.officialVolume,real:cached.real,per:cached.per,pbr:cached.pbr,analystTarget:cached.analystTarget,earningsDate:cached.earningsDate,exRightsDate:cached.exRightsDate,topixChange:cached.topixChange};}
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
  // 価格のnullは直前の値で埋める（先頭がnullの場合は0ではなく最初の有効値で埋める。
  // 0だとcalcEMAが0起点になり指標が長く歪むため）
  function fill(arr){
    var out=(arr||[]).slice(),first=null;
    for(var k=0;k<out.length;k++){if(out[k]!=null){first=out[k];break;}}
    for(var j=0;j<out.length;j++){if(out[j]==null)out[j]=(j>0&&out[j-1]!=null)?out[j-1]:first;}
    return out;
  }
  // 出来高のnullは「その時間帯に約定が無かった」という意味なので必ず0で埋める。
  // 価格と同じく直前の値をコピーすると、閑散時間や昼休みの出来高が水増しされる
  function fillVol(arr){var out=(arr||[]).slice();for(var j=0;j<out.length;j++)if(out[j]==null)out[j]=0;return out;}
  var per=result.per||null,pbr=result.pbr||null,analystTarget=result.analystTarget||null,earningsDate=result.earningsDate||null,exRightsDate=result.exRightsDate||null,topixChange=result.topixChange!=null?result.topixChange:null;
  var filledClose=fill(q.close);
  var data={closes:filledClose,highs:fill(q.high),lows:fill(q.low),volumes:fillVol(q.volume),opens:fill(q.open),dates:q.date||[],currentPrice:meta.regularMarketPrice||filledClose[filledClose.length-1],previousClose:meta.chartPreviousClose||0,officialPrevClose:(meta.regularMarketPreviousClose!=null?meta.regularMarketPreviousClose:null),officialVolume:(meta.regularMarketVolume!=null?meta.regularMarketVolume:null),real:true,per:per,pbr:pbr,analystTarget:analystTarget,earningsDate:earningsDate,exRightsDate:exRightsDate,topixChange:topixChange};
  CACHE[ticker]={ts:now,data:data};
  return{closes:data.closes.slice(),highs:data.highs.slice(),lows:data.lows.slice(),volumes:data.volumes.slice(),opens:data.opens.slice(),dates:data.dates.slice(),currentPrice:data.currentPrice,previousClose:data.previousClose,officialPrevClose:data.officialPrevClose,officialVolume:data.officialVolume,real:data.real,per:data.per,pbr:data.pbr,analystTarget:data.analystTarget,earningsDate:data.earningsDate,exRightsDate:data.exRightsDate,topixChange:data.topixChange};
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

// ── スキャン処理全体の自動リトライ ────────────────────────────────────────
// 個々の取得（fetchYahoo・fetchRanking等）は内部で2回まで試すが、それでも
// スキャン処理そのものが例外で落ちることがある（AI業種選定の失敗、通信断など）。
// その場合に画面へ「❌エラー」を出して終わるのではなく、少し待って最初から
// やり直す。混雑・一時的な通信不良が原因のことが多く、待ってから試すと成功する
// ケースが大半のため、待ち時間は2秒→4秒と伸ばしていく。
var SCAN_MAX_RETRY=2;          // 初回のあと最大2回リトライ（合計3回試行）
var SCAN_RETRY_BASE_WAIT=2000; // 1回目のリトライ前に待つ時間(ms)。以降は倍々
// fn(attempt) を成功するまで実行する。全て失敗した場合は最後のエラーを投げる。
// onRetry(次の試行回, 最大リトライ回数, 発生したエラー, 待ち時間ms) で画面表示を更新する
async function runScanWithRetry(fn,onRetry){
  var lastErr=null;
  for(var attempt=0;attempt<=SCAN_MAX_RETRY;attempt++){
    try{return await fn(attempt);}
    catch(err){
      lastErr=err;
      if(attempt>=SCAN_MAX_RETRY)break;
      var wait=SCAN_RETRY_BASE_WAIT*Math.pow(2,attempt);
      console.warn("[scan] "+(attempt+1)+"回目失敗、"+(wait/1000)+"秒後に再試行します: "+err.message);
      if(onRetry)onRetry(attempt+1,SCAN_MAX_RETRY,err,wait);
      await new Promise(function(r){setTimeout(r,wait);});
    }
  }
  console.error("[scan] "+(SCAN_MAX_RETRY+1)+"回試行しても失敗: "+(lastErr&&lastErr.message));
  throw lastErr;
}

function genSim(ticker,errMsg){
  var h=0;for(var i=0;i<ticker.length;i++)h=(Math.imul(31,h)+ticker.charCodeAt(i))|0;
  var s=Math.abs(h);function rng(){s=(s*1664525+1013904223)&0x7fffffff;return s/0x7fffffff;}
  var price=rng()*400+60,closes=[],highs=[],lows=[];
  for(var d=0;d<63;d++){var v=rng()*0.025;price=Math.max(5,price*(1+rng()*0.006-0.003+(rng()-0.5)*v));closes.push(price);highs.push(price*(1+rng()*0.008));lows.push(price*(1-rng()*0.008));}
  return{closes:closes,highs:highs,lows:lows,currentPrice:price,previousClose:closes[closes.length-2],real:false,error:errMsg||null};
}

// ── トレードシミュレーター（仮想売買の記録・検証）───────────────────────────
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
function tradeStorageKey(){return "trade_personal_v1";}
// 「アプリ予想」機能は廃止（トレードは1本化）。旧データが残っていれば起動時に削除する
try{localStorage.removeItem("trade_app_v1");}catch(e){}
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
    styleAtAdd:s.tradeType||null, // 登録時点の手法バッジ（short=スキャル/mid=デイトレ/stable=スイング）
    sigKeysAtAdd:sigKeysAtAdd, // 登録時点で点灯していたシグナル一覧
    forecastAtAdd:forecastAtAdd, // 登録時点の🔮翌営業日予想（期待変化率・上昇確率）
    lastPrice:curPrice,
    addedAt:new Date().toISOString()
  });
  saveTrades(kind,list);
  return list;
}
// 指定銘柄が進行中(waiting/active)のトレードを持っているかどうか
function hasActiveTrade(ticker,trades){
  var list=trades||[];
  for(var i=0;i<list.length;i++){
    var t=list[i];
    if(t.ticker===ticker&&(t.status==="waiting"||t.status==="active")) return true;
  }
  return false;
}
// ★ボタンの見た目：進行中トレードがあれば赤、無ければ従来通りお気に入り色分け
function starStyle(ticker,isFav,trades){
  if(hasActiveTrade(ticker,trades)) return {symbol:"★",color:"#f43f5e"};
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
      // 決済価格(endPrice)は「実際にどこで終わったか」で決まる。利確で終わったトレードは
      // 売り価格、損切りで終わったトレードは損切り価格を反映し、それ以外（引け決済・強制完了）は
      // 記録済みの決済価格をそのまま残す。※以前は常に売り価格で上書きしていたため、
      // 損切りで終わったトレードを編集すると損益が「利確した場合の数字」に化けていた
      if(t.exitReason==="take_profit"&&updates.sellPrice!=null)next.endPrice=updates.sellPrice;
      else if(t.exitReason==="stop_loss"&&updates.stopPrice!=null)next.endPrice=updates.stopPrice;
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
    // status==="active"：損切り → 利確の順で判定する。
    // 更新の合間の値動きは見えないため、両方に到達し得る場合は必ず不利な側（損切り）を採る。
    // 損切りの約定価格は「損切り価格」ではなく実際の現在値を使う。損切りは逆指値＝成行注文
    // なので、急落やギャップで飛んだ場合は損切り価格では約定せず、より下で約定するため。
    // （損切り価格ちょうどで約定したことにすると、成績が実際より良く出てしまう）
    if(t.stopPrice!=null&&cur<=t.stopPrice){
      changed=true;
      var exitStop=Math.min(t.stopPrice,cur);
      var pnlPerShare2=exitStop-t.startPrice,pnl2=pnlPerShare2*(t.shares||1),pnlPercent2=t.startPrice?(pnlPerShare2/t.startPrice*100):0;
      return Object.assign({},t,{status:"done",endPrice:exitStop,endAt:new Date().toISOString(),pnl:pnl2,pnlPercent:pnlPercent2,exitReason:"stop_loss",lastPrice:cur});
    }
    // 利確は指値注文なので、飛んでも約定は売り価格ちょうど（控えめな見積もり）のままでよい
    if(cur>=t.sellPrice){
      changed=true;
      var pnlPerShare=t.sellPrice-t.startPrice,pnl=pnlPerShare*(t.shares||1),pnlPercent=t.startPrice?(pnlPerShare/t.startPrice*100):0;
      return Object.assign({},t,{status:"done",endPrice:t.sellPrice,endAt:new Date().toISOString(),pnl:pnl,pnlPercent:pnlPercent,exitReason:"take_profit",lastPrice:cur});
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
  // 的中率50%前後はコイン投げと同じで判断材料にならないうえトークンを食うだけなので、
  // 「55%以上(信頼できる)」か「45%以下(逆張り材料になる)」に偏ったものだけをAIに渡す
  (signals||[]).forEach(function(sig){
    var key=baseSigLabel(sig.label)+"#"+sig.state;
    var s=stats[key];
    if(!s||s.t<10) return;
    var pct=Math.round(signalQuality(s,key)*100);
    if(pct<55&&pct>45) return;
    lines.push("  "+sig.label+": 過去的中率"+pct+"%("+s.t+"件)"+(pct<=45?" ←当たらない傾向。逆方向のヒントとして扱う":""));
  });
  var out=lines.length?("過去のシグナル的中率(スキャン銘柄全体の集計。この銘柄固有の実績ではない／50%前後の項目は省略):\n"+lines.join("\n")+"\n"):"";
  var fc=calcStatForecast(signals,stats);
  if(fc.ready) out+="🔮統計ベース翌営業日予想(スキャン銘柄全体の集計であり、この銘柄の予想ではない): 期待変化率"+(fc.expPct>=0?"+":"")+fc.expPct.toFixed(1)+"% / 上昇した割合"+fc.upRate+"%("+fc.totalN+"件)\n";
  if(score!=null){
    var band=getUniverseBandStats().find(function(b){return b.band===bandLabelFor(score);});
    if(band&&band.total>=5) out+="スコア帯"+band.band+"点の過去実績: 翌営業日的中率"+band.winRate+"%("+band.total+"件)\n";
  }
  return out;
}
function buildAiPrompt(s,daily){
  var isJP=s.market==="JP";
  var relPart=(isJP&&s.relStrength!=null)?("対TOPIX相対: "+(s.relStrength>=0?"+":"")+s.relStrength.toFixed(1)+"%（個別銘柄騰落率−TOPIX騰落率。市場全体を除いた銘柄固有の強さの目安）\n"):"";
  var histPart="";
  // 休場中・寄り付き前のスキャンはVWAP等の場中指標が算出できず、スコアの土俵が場中と変わる。
  // 混ぜて比較すると「測り方の変化」を値動きと誤認するため、取引日の記録だけで推移を出す
  var histTD=tradingDayHist(s.scoreHist,isJP);
  if(histTD.length>=2){
    var days=s.tradeType==="short"?5:s.tradeType==="mid"?7:10;
    var slice=histTD.slice(-days);
    var trend=slice[slice.length-1].s-slice[0].s;
    var atrTrend=slice[slice.length-1].atr-slice[0].atr;
    histPart="スコア推移(直近"+slice.length+"日):\n"+
      slice.map(function(x){return"  "+x.d+": "+x.s+"点 ATR:"+x.atr;}).join("\n")+"\n"+
      "スコアトレンド: "+(trend>10?"↑上昇中(+"+trend+")":trend<-10?"↓下落中("+trend+")":"→横ばい")+"\n"+
      "ATRトレンド: "+(atrTrend>0?"↑拡大中(ボラ増)":"↓縮小中(ボラ減)")+"\n";
  }
  var accPart=buildAccuracyPart(s.signals,s.score);
  // 銘柄の書き方：AIがWeb検索で別銘柄と取り違えないよう、会社名を主・証券コードを従にする。
  // 会社名が取得できていない場合は「コードのままでは検索しない」ことを明示する。
  var codeOnly=s.ticker.replace(".T","");
  var hasName=!!(s.name&&s.name!==codeOnly&&s.name!==s.ticker);
  var idLine=isJP
    ?("銘柄: "+(hasName
        ?(s.name+"（東京証券取引所・証券コード "+codeOnly+"）")
        :("東京証券取引所 証券コード "+codeOnly+"（会社名が不明なため、まず「"+codeOnly+" 株価」等のWeb検索で日本の上場企業名を特定してから分析してください）")))
    :("銘柄: "+s.ticker+(hasName?" ("+s.name+")":""));
  // 52週レンジ：日足があれば本物の52週、無ければ「直近1ヶ月」と正直に明記する
  var w52=calc52w(daily,s.rawPrice);
  var rangePart=w52
    ?("52週高値比: "+w52.fromHigh.toFixed(1)+"%\n52週安値比: "+(w52.fromLow>=0?"+":"")+w52.fromLow.toFixed(1)+"%\n"+
      "52週ポジション: "+w52.position.toFixed(0)+"% (0%=安値圏 100%=高値圏。高いほど上値に戻り売りが少ない)\n")
    :("直近1ヶ月高値比: "+s.fromHigh.toFixed(1)+"%\n直近1ヶ月安値比: "+(s.fromLow>=0?"+":"")+s.fromLow.toFixed(1)+"%\n"+
      "直近1ヶ月ポジション: "+s.position52.toFixed(0)+"% (0%=安値圏 100%=高値圏。※52週ではなく直近1ヶ月のレンジ)\n");
  return "あなたは株式トレードのアナリストです。以下の銘柄データを分析して、日本語で簡潔に解説してください。\n\n"+
    idLine+"\n市場: "+s.market+"\n現在値: "+s.price+"\n前日比: "+s.change+"%\n"+
    "総合スコア: "+s.score+"/100\nトレードタイプ: "+s.tradeLabel+"\n"+
    rangePart+
    "ATR(14日): "+(isJP?"¥":"$")+s.atr+" / 想定値幅: "+(isJP?"¥":"$")+s.atrLower+"〜"+(isJP?"¥":"$")+s.atrUpper+"\n"+
    relPart+
    histPart+
    accPart+
    "シグナル:\n"+s.signals.map(function(sig){return"  "+sig.label+": "+sig.val;}).join("\n")+"\n\n"+
    "まず最初の1行に、次の形式のタグで数値データだけを出力してください（前後に説明や```を付けないこと。これが最優先です）:\n"+
    "<AI_DATA>{\"entry\":"+(isJP?"整数":"小数")+",\"target\":"+(isJP?"整数":"小数")+",\"stop\":"+(isJP?"整数":"小数")+",\"forecast\":{\"direction\":\"上昇 or 下落 or 中立\",\"confidence\":整数0〜100,\"timeframe\":\"文字列\",\"reason\":\"文字列\"}}</AI_DATA>\n\n"+
    "その後で、以下のトレード判断を日本語で分かりやすく解説してください:\n1. 📌 今日中に買うべきか / 見送るべきか（理由を2文で）\n2. 💰 entry: 具体的な買いレンジ（買いを検討すべき価格帯）\n3. 🎯 target: 利確ライン（ATR比での根拠も添えて）\n4. 🛑 stop: 損切りライン（サポートやBB下限など根拠も添えて）\n5. 🔮 今後の見通し: 必ずWeb検索でこの銘柄の最新ニュース・決算・材料を調べた上で、今後数日〜1週間程度で上昇/下落/中立のどれに向かいやすいかを予想し、確信度と根拠を1〜2文で述べてください"+
    (isJP?"\n\n※Web検索は上記の会社名で行ってください。「"+codeOnly+".T」のようなコード単体での検索は、別の銘柄の情報を拾ってしまう原因になります。銘柄が特定しきれない場合も、ユーザーに質問や確認を求めず、手元のデータだけで分析を完了してください。":"");
}
// 上位N件 → claude.ai貼り付け用プロンプトを生成
// jpLimited(既定true): 日本株限定で「出来高急増率」×「ボラティリティ」の合成ランキングで上位N件を選出
// jpLimited=falseを渡すと市場フィルタ・並べ替えをせず渡された銘柄をそのまま出力する（個別銘柄コピー用）
var SURGE_WEIGHT=0.5, VOLATILITY_WEIGHT=0.5; // 出来高急増率/ボラティリティの重み（合計1.0）
// ── 本物の52週高安（詳細画面で取得済みの日足を流用）─────────────────────────
// スコア計算のhigh52/low52は15分足20営業日ぶん＝実質「直近1ヶ月」でしかない。
// 銘柄詳細では過去1年の日足(fetchDaily)を既に取得しているので、追加通信ゼロで
// 本物の52週レンジを出せる。AIに渡す情報だけをこちらに差し替える（スコアは不変）。
function calc52w(daily,price){
  if(!daily||!daily.closes||!(price>0)) return null;
  var c=daily.closes,n=c.length;
  if(n<60) return null; // 3ヶ月未満しか無い場合は52週とは呼べないので使わない
  var st=Math.max(0,n-252); // 直近252営業日＝約1年
  var hs=(daily.highs&&daily.highs.length===n)?daily.highs:c;
  var ls=(daily.lows&&daily.lows.length===n)?daily.lows:c;
  var h=-Infinity,l=Infinity;
  for(var i=st;i<n;i++){
    if(hs[i]!=null&&hs[i]>h) h=hs[i];
    if(ls[i]!=null&&ls[i]<l) l=ls[i];
  }
  if(!(h>l)) return null;
  // 中期(直近60営業日)の高安も同じ日足から算出。15分足の"全期間"は日本株だと
  // 約20営業日しかなくS1と重複するため、中期の節目は必ず日足側から出す。
  var st60=Math.max(0,n-60),h60=-Infinity,l60=Infinity;
  for(var k=st60;k<n;k++){
    if(hs[k]!=null&&hs[k]>h60) h60=hs[k];
    if(ls[k]!=null&&ls[k]<l60) l60=ls[k];
  }
  return{high:h,low:l,fromHigh:(price-h)/h*100,fromLow:(price-l)/l*100,
    position:(price-l)/(h-l)*100,days:n-st,
    high60:h60>l60?h60:null,low60:h60>l60?l60:null};
}

function buildVolumeRankingPrompt(stocks,topN,jpLimited,dailyByTicker){
  var n=topN||10;
  var top;
  if(jpLimited===false){
    top=stocks.slice(0,n);
  }else{
    var pool=stocks.filter(function(s){return s.market==="JP";});
    var metrics=pool.map(function(s){
      var surge=s.volSurge||1; // 出来高急増率＝直近5日出来高÷過去20日平均（自分比の"今の勢い"）
      var volatility=s.rawPrice?((s.atrRawVal!=null?s.atrRawVal:(s.atr||0))/s.rawPrice):0; // ATR%（丸め前の値を使用）
      return{s:s,surge:surge,volatility:volatility};
    });
    var maxSurge=Math.max.apply(null,metrics.map(function(m){return m.surge;}).concat([1]));
    var maxVol=Math.max.apply(null,metrics.map(function(m){return m.volatility;}).concat([1e-9]));
    metrics.forEach(function(m){
      m.rankScore=(m.surge/maxSurge)*SURGE_WEIGHT+(m.volatility/maxVol)*VOLATILITY_WEIGHT;
    });
    top=metrics.sort(function(a,b){return b.rankScore-a.rankScore;}).slice(0,n).map(function(m){return m.s;});
  }
  var hasStale52=false; // 日足未取得で52週が出せない銘柄が1つでもあるか
  var lines=top.map(function(s,i){
    var isJPmkt=s.market==="JP";
    var unit=isJPmkt?"¥":"$";
    var w52=calc52w(dailyByTicker&&dailyByTicker[s.ticker],s.rawPrice);
    if(!w52) hasStale52=true;
    var trendLine="";
    // 履歴2件だと「初回スコア→今日」の差がそのまま出て +97 のような極端な値になる。
    // 3件以上に限定し、何日分の推移かも添えてAIが過大評価しないようにする
    // 休場中の記録はスコアの土俵が違うため、取引日の記録だけで推移を出す
    var histTD=tradingDayHist(s.scoreHist,isJPmkt);
    if(histTD.length>=3){
      var slice=histTD.slice(-5);
      var trend=Math.round(slice[slice.length-1].s-slice[0].s); // 小数のまま出すと桁が汚れるので丸める
      trendLine="  スコア推移: "+(trend>10?"↑上昇中(+"+trend+")":trend<-10?"↓下落中("+trend+")":"→横ばい")+"（"+slice.length+"日分）\n";
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
    // アプリが算出済みの節目（チャート由来）。AIに自力計算させず同じ数値を使わせて画面と揃える。
    // ATR利確とATR上限、ATR損切とATR下限は元が同じ計算なので重複させない（AIが別物と誤認するため）
    // S2/R2は日足、S1/R1は15分足と取得元が違うため、まれに内外が逆転する。
    // 「S2はS1より安い / R2はR1より高い」が成立する時だけ出す（矛盾した数値をAIに渡さない）
    var s2v=(w52&&w52.low60!=null)?(isJPmkt?Math.round(w52.low60):parseFloat(w52.low60.toFixed(2))):null;
    var r2v=(w52&&w52.high60!=null)?(isJPmkt?Math.round(w52.high60):parseFloat(w52.high60.toFixed(2))):null;
    var zoneArr=[];
    if(s.support) zoneArr.push("S1(20日安値) "+unit+s.support.s1);
    if(s2v!=null&&s.support&&s2v<s.support.s1) zoneArr.push("S2(60日安値) "+unit+s2v);
    if(s.support) zoneArr.push("ATR下限(×1.5) "+unit+s.support.atrFloor);
    if(s.resistance) zoneArr.push("R1(20日高値) "+unit+s.resistance.r1);
    if(r2v!=null&&s.resistance&&r2v>s.resistance.r1) zoneArr.push("R2(60日高値) "+unit+r2v);
    if(s.profitLoss) zoneArr.push("ATR上限(×1.5) "+unit+s.profitLoss.target);
    var zoneLine=zoneArr.length?"  サポート/レジスタンス(アプリ算出): "+zoneArr.join(" / ")+"\n":"";
    // アプリが算出済みの買いプラン（呼値丸め・最低値幅1.0%済み）。あればAIにそのまま使わせる
    var planLine=s.buyPlan
      ?"  買いプラン(アプリ算出・呼値丸め済み): エントリー "+unit+s.buyPlan.entry+
        " / 利確 "+unit+s.buyPlan.target+"(+"+s.buyPlan.gainPct+"%)"+
        " / 損切 "+unit+s.buyPlan.stop+"(-"+s.buyPlan.lossPct+"%)"+
        " / RR 1:"+s.buyPlan.rr+"　根拠: "+s.buyPlan.reason+"\n"
      :"  買いプラン(アプリ算出): なし（理由: "+(s.planSkip||"条件未達")+"）\n";
    // 統計ベースの過去実績（AI不使用・実データのみ）。指標から推論できない独立情報として渡す
    var acc=buildAccuracyPart(s.signals,s.score);
    var accPart=acc?acc.replace(/\n+$/,"").split("\n").map(function(l){return"  "+l;}).join("\n")+"\n":"";
    // 52週は日足がある時だけ表示する。日足が無い銘柄で15分足由来の「直近1ヶ月」を
    // 混ぜると、同じリスト内で基準の違う数値が並んでAIが横並び比較を誤るため出さない
    var pos52=w52
      ?w52.position.toFixed(0)+"%（52週高値比 "+w52.fromHigh.toFixed(1)+"%・上値のしこりの目安）"
      :"─（日足未取得のため算出不可。この銘柄は52週情報なしとして判断すること）";
    var idLine=isJPmkt
      ?(s.name||s.ticker)+"（東京証券取引所・証券コード "+s.ticker.replace(".T","")+"）"
      :s.ticker+(s.name?" ("+s.name+")":"");
    return((i+1)+". "+idLine+"\n"+
      "  現在値: "+s.price+"  前日比: "+s.change+"%\n"+
      "  当日出来高: "+(s.volume||0).toLocaleString()+"（急増率: "+(s.volSurge?s.volSurge.toFixed(1)+"倍":"─")+"）\n"+
      "  総合スコア: "+s.score+"/100  トレードタイプ: "+s.tradeLabel+"\n"+
      trendLine+
      "  ATR: "+unit+s.atr+"  想定値幅: "+unit+s.atrLower+"〜"+unit+s.atrUpper+"\n"+
      "  52週ポジション: "+pos52+"\n"+
      "  PER: "+per+"  PBR: "+pbr+"  アナリスト目標株価: "+target+"\n"+
      "  前日高値/安値: "+prevH+"〜"+prevL+"  週足高値/安値(直近5営業日): "+wH+"〜"+wL+"\n"+
      zoneLine+
      planLine+
      signalsLine+
      accPart).replace(/\n+$/,""); // 末尾の余分な改行を落として無駄なトークンを減らす
  }).join("\n\n");
  var kw=top.length>1?"各銘柄":"この銘柄"; // 1件コピー時に「各銘柄」と書かないための切替
  var note=jpLimited===false?"":"（日本株限定・出来高急増率×ボラティリティ順）";
  var head=top.length===1?"以下は対象銘柄1件のデータです":"以下はスコア上位"+top.length+"銘柄のデータです"+note;
  var tickRule=top.some(function(s){return s.market==="JP";})
    ?"日本株の価格は1円単位、米国株は0.01ドル単位に丸めること。"
    :"価格は0.01ドル単位に丸めること。";
  // 休場中・寄り付き前はVWAP等の場中指標が算出できない。AIが「指標が消えた＝弱い」と
  // 誤読しないよう、データの前提を明示する（1銘柄でも該当すれば出す）
  var closedNote=top.some(function(s){return s.sessionStarted===false;})
    ?"※このデータは休場中（または寄り付き前）に取得したものです。VWAP・VWAP傾き・当日ブレイク・ATR消化率などの場中指標は算出できないため、シグナル一覧に含まれていません。総合スコアも場中に算出した値とは土俵が違うので単純比較しないでください。「買いプラン(アプリ算出)」も場中専用のため出ません。\n\n"
    :"";
  return"あなたは株式トレードのアナリストです。"+head+"。\n"+
    "データ取得時刻: "+new Date().toLocaleString("ja-JP")+"（この時刻を「今」として判断してください）\n\n"+
    closedNote+

    "【手順1】"+kw+"の直近1週間のニュース（決算、業績修正、適時開示など）をWeb検索で確認し、判定に反映してください。\n"+
    "・検索は下記の会社名で行ってください。「7203.T」のような証券コード単体の検索は、別の銘柄の情報を拾う原因になります。\n"+
    "・材料が見つからない場合は「材料なし」と明記し、推測で材料を作らないでください。\n"+
    "・ユーザーに質問や確認を求めず、下記のデータとWeb検索の結果だけで判定を完結させてください。\n\n"+

    lines+"\n\n"+

    "【手順2】"+kw+"を「買い」「売り」「見送り」のいずれかで判定し、理由を1〜2文で書いてください。迷ったら「見送り」にしてください。\n\n"+

    "【手順3】価格の決め方（買い/売りと判定した場合のみ）\n"+
    "① 「買いプラン(アプリ算出)」がある銘柄を「買い」と判定した場合は、その3つの価格をそのまま使ってください。\n"+
    "② それ以外は次の式で算出してください。\n"+
    "　　買い: エントリー=現在値 ／ 利確=エントリー＋max(ATR×1.5, 現在値の1.0%) ／ 損切り=エントリー−max(ATR×0.75, 現在値の0.5%)\n"+
    "　　売り: エントリー=現在値 ／ 利確=エントリー−max(ATR×1.5, 現在値の1.0%) ／ 損切り=エントリー＋max(ATR×0.75, 現在値の0.5%)\n"+
    "③ 「サポート/レジスタンス(アプリ算出)」の水準は、次の場合に②より優先して使ってかまいません（使った場合は理由に一言添える）。\n"+
    "　　利確: ②の利確より手前に、買いならレジスタンス、売りならサポートがある場合はその水準を利確にする。\n"+
    "　　損切り: ②の損切りのすぐ外側に、買いならサポート、売りならレジスタンスがある場合はその1円（米国株は0.01ドル）外側を損切りにする。\n"+
    "④ "+tickRule+"\n"+
    "⑤ リスクリワードは「リスク : リワード」の順で 1:○.○ と書いてください。○.○ ＝ |利確−エントリー| ÷ |エントリー−損切り|。\n"+
    "⑥ リスクリワードが1.5未満になる場合は、割に合わないので「見送り」に切り替えてください。\n"+
    "⑦ 買い前提で無理に価格を出さないこと。「見送り」なら価格は一切書かないこと。\n\n"+

    "【出力形式】\n"+
    "◆買い/売りの場合\n"+
    "銘柄コード: 判定（買い/売り） — 理由\n"+
    "　材料: 直近ニュースの要約（なければ「材料なし」）\n"+
    "　想定保有期間: ○営業日（トレードタイプに合わせる。デイトレ=当日中、スイング=2〜5営業日）\n"+
    "　エントリー: 価格\n"+
    "　利確: 価格\n"+
    "　損切り: 価格\n"+
    "　リスクリワード: 1:○.○\n\n"+
    "◆見送りの場合（材料行は必ず書く。価格は書かない）\n"+
    "銘柄コード: 見送り — 理由\n"+
    "　材料: 直近ニュースの要約（なければ「材料なし」）"+
    (hasStale52?"\n\n※一部の銘柄は52週情報が「─」です。その銘柄は52週の位置を推測せず、無い前提で判断してください。":"");
}
// ────────────────────────────────────────────────────────────────────────────

function calcSMA(arr,p){return arr.map(function(_,i){if(i<p-1)return null;var s=0;for(var j=i-p+1;j<=i;j++)s+=arr[j];return s/p;});}

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
    if(sg>0){
      var rec={t:ticker,d:today,p:d.closes[n-1],s:Math.round(sg*100000)/100000};
      var cx=CHRONOS&&CHRONOS.items?CHRONOS.items[ticker]:null;
      // cr = Chronosが見込む「5営業日後の倍率」。基準価格が違っても比較できるよう倍率で持つ
      if(cx&&cx.p>0&&cx.q50&&cx.q50.length>=BAND_DAYS)rec.cr=Math.round(cx.q50[BAND_DAYS-1]/cx.p*10000)/10000;
      list.push(rec);changed=true;
    }
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

// ── Chronos予測の答え合わせ ────────────────────────────────────────────────
// fc_log_v1に貯まった cr(予測倍率) と a(5営業日後の実績終値) を突き合わせ、
// 「Chronosの予測が実際に当たっているか」を集計する。
// 単独の的中率だけでは相場の地合いに引きずられるため、必ず基準線と並べて表示する。
var CHR_NEUTRAL=0.003; // 予測幅が±0.3%未満は「横ばい予測」とみなし方向判定から除外
var CHR_BANDS=[{min:0.003,max:0.01,label:"±0.3〜1%"},{min:0.01,max:0.03,label:"±1〜3%"},{min:0.03,max:99,label:"±3%以上"}];
var CHR_ACC_CACHE=null,CHR_ACC_TS=0;
function calcChronosAccuracy(){
  var now=Date.now();
  if(CHR_ACC_CACHE&&now-CHR_ACC_TS<60000)return CHR_ACC_CACHE;
  var rows=fcLoad().filter(function(r){return r.cr>0&&r.a>0&&r.p>0;});
  var win=0,tot=0,up=0,upTot=0;   // up/upTot = 常に「上昇」と予測した場合の的中率（基準線）
  var errC=[],errFlat=[];         // 予測倍率の誤差 / 横ばい(1.0倍)と置いた場合の誤差
  var bands=CHR_BANDS.map(function(b){return{label:b.label,w:0,t:0};});
  rows.forEach(function(r){
    var pred=r.cr,act=r.a/r.p;
    errC.push(Math.abs(pred-act));errFlat.push(Math.abs(1-act));
    upTot++;if(act>1)up++;
    var mag=Math.abs(pred-1);
    if(mag<CHR_NEUTRAL)return;
    var hit=(pred>1)===(act>1);
    tot++;if(hit)win++;
    for(var i=0;i<CHR_BANDS.length;i++){
      if(mag>=CHR_BANDS[i].min&&mag<CHR_BANDS[i].max){bands[i].t++;if(hit)bands[i].w++;break;}
    }
  });
  function med(a){if(!a.length)return null;a.sort(function(x,y){return x-y;});return a[Math.floor(a.length/2)];}
  var mc=med(errC),mf=med(errFlat);
  CHR_ACC_CACHE={
    total:tot,winRate:tot?Math.round(win/tot*100):null,
    baseRate:upTot?Math.round(up/upTot*100):null,baseTotal:upTot,
    maeC:mc!=null?Math.round(mc*1000)/10:null,      // %表示に変換
    maeFlat:mf!=null?Math.round(mf*1000)/10:null,
    bands:bands.map(function(b){return{label:b.label,winRate:b.t?Math.round(b.w/b.t*100):null,total:b.t};})
  };
  CHR_ACC_TS=now;return CHR_ACC_CACHE;
}
// 集計結果を「スコアに統合してよいか」の一言コメントに変換する
function chronosVerdict(a){
  if(a.total<20)return{msg:"判定にはあと"+(20-a.total)+"件必要です（方向判定20件以上で評価）",col:"#4a7090"};
  if(a.winRate==null||a.baseRate==null)return{msg:"データ不足",col:"#4a7090"};
  var d=a.winRate-a.baseRate;
  if(d>=5)return{msg:"✅ 基準線を"+d+"ポイント上回っています。スコアへの統合（アンサンブル）を検討する価値があります",col:"#22d3a0"};
  if(d<=-5)return{msg:"⚠️ 基準線を"+Math.abs(d)+"ポイント下回っています。今のままスコアに反映するのは避けたほうが無難です",col:"#f43f5e"};
  return{msg:"→ 基準線とほぼ同等（差"+(d>=0?"+":"")+d+"ポイント）。もう少しデータを溜めてから判断してください",col:"#fbbf24"};
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

// GitHub Actionsが毎晩作る予測ファイルを1回だけ読む（無い場合はnullのまま動く）
var CHRONOS=null, CHRONOS_P=null;
function loadChronos(){
  if(CHRONOS_P)return CHRONOS_P;
  CHRONOS_P=fetch("/forecasts.json",{cache:"no-store"})
    .then(function(r){return r.ok?r.json():null;})
    .then(function(j){CHRONOS=j;return j;})
    .catch(function(){return null;});
  return CHRONOS_P;
}

// お気に入り全銘柄の予測を1日1回まとめて記録する（1銘柄ずつ開かなくても貯まるように）
var FC_RUN_KEY="fc_last_run";
function fcTodayJST(){return new Date(Date.now()+9*3600000).toISOString().slice(0,10);}
async function recordFavForecasts(favs){
  if(!favs||!favs.length)return;
  var today=fcTodayJST();
  try{if(localStorage.getItem(FC_RUN_KEY)===today)return;}catch(e){} // その日すでに実行済みなら何もしない
  await loadChronos(); // 記録にChronosの予測も含めたいので先に読む
  for(var i=0;i<favs.length;i++){
    await fetchDaily(favs[i]); // この中で updateForecastLog が走る
    await new Promise(function(r){setTimeout(r,400);}); // Yahooに負担をかけない間隔
  }
  try{localStorage.setItem(FC_RUN_KEY,today);}catch(e){}
}

// "YYYY-MM-DD"がその市場の取引日かどうか（土日・東証の祝日を除く）。
// 休場中に記録された古いscoreHistを、スコア推移の集計から除くために使う
function isTradingDayStr(dStr,isJP){
  var d=new Date(dStr+"T00:00:00");
  if(isNaN(d.getTime())) return true; // 日付が壊れている記録は判定せずそのまま通す
  var dw=d.getDay();
  if(dw===0||dw===6) return false;
  return !(isJP&&JP_HOLIDAYS[dStr]);
}
// scoreHistから休場日の記録を除いた配列を返す（スコア推移の比較用）
function tradingDayHist(hist,isJP){
  if(!hist||!hist.length) return [];
  return hist.filter(function(x){return x&&x.d&&isTradingDayStr(x.d,isJP);});
}

// ── シグナル別的中率の検証 ─────────────────────────────────────────────

// 1銘柄分のscoreHistから、シグナルごとの勝敗数をstatsに積算する
// daysAfter: 何営業日後の価格と比較するか(scoreHistの記録間隔=1エントリ想定)
function accumulateSignalStats(hist,daysAfter,stats,isJP){
  for(var i=0;i<hist.length-daysAfter;i++){
    var cur=hist[i],nxt=hist[i+daysAfter];
    if(cur.p==null||nxt.p==null||!cur.sig) continue;
    if(bizDayDiff(cur.d,nxt.d,isJP)!==daysAfter) continue; // 記録が飛んだペアは「◯日後」の実績として不正確なので除外
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
    accumulateSignalStats(hist,1,stats,/\.T$/.test(ticker));
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
    ACCURACY_HORIZONS.forEach(function(h){accumulateSignalStats(hist,h,statsByH[h],/\.T$/.test(ticker));});
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
      accumulateSignalStats(hist,1,stats,true); // 上でJP銘柄のみに絞り込み済み
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
        if(bizDayDiff(cur.d,nxt.d,true)!==1) continue; // 記録が飛んだペアは翌日実績に含めない（上でJP銘柄のみに絞り込み済み）
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
        var entries=byDate[d],ei=entries.length-1;
        if(ei<1) return;
        // 終点はその日の最後の記録。ただし後場後半か引け後で終わっていない日は「当日終値」と呼べない
        var closeEntry=entries[ei],endRank=sessionRankAt(entries,ei);
        if(closeEntry.p==null||endRank==null||endRank<SESSION_RANK["後場後半"]) return;
        entries.forEach(function(e,idx){
          if(idx>=ei||e.p==null||e.s<60) return;
          if(INTRADAY_SESSIONS.indexOf(e.session)===-1) return;
          if(!isFarEnoughPair(e,closeEntry,sessionRankAt(entries,idx),endRank)) return; // 近すぎる比較は除外
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
        if(bizDayDiff(cur.d,nxt.d,true)!==1) continue; // 上でJP銘柄のみに絞り込み済み
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
// ── トレンド局面別（初動 / 過熱）シグナル的中率 ────────────────────────────
// 直近3回分の対TOPIX相対(ctx.rel)を合計し、上げ始めたばかり（初動）か、
// すでに市場を大きく上回った後（過熱）かでシグナルの効き方の違いを見る。
// 相対で負けている状態（合計マイナス＝トレンドに乗っていない）は対象外。
// ctx.relを記録し始めた新しい記録だけが対象なので、貯まると自動で表示が始まる
var TREND_PHASE_LOOKBACK=3; // 何回分の記録をさかのぼって累積するか
var TREND_PHASE_HOT=3;      // 累積相対が何%以上なら「過熱」とみなすか
var PHASE_STATS_CACHE=null,PHASE_STATS_TS=0;
function getTrendPhaseSignalStats(){
  var now=Date.now();
  if(PHASE_STATS_CACHE&&now-PHASE_STATS_TS<UNIVERSE_STATS_TTL) return PHASE_STATS_CACHE;
  var stats={early:{},hot:{}};
  try{
    Object.keys(localStorage).forEach(function(k){
      if(k.indexOf("sh_")!==0||k.indexOf("sh_intraday_")===0) return;
      if(!/\.T$/.test(k.slice(3))) return; // 対TOPIX相対のためJP銘柄のみ
      var hist;try{hist=JSON.parse(localStorage.getItem(k)||"[]");}catch(e){hist=[];}
      for(var i=0;i<hist.length-1;i++){
        var cur=hist[i],nxt=hist[i+1];
        if(cur.p==null||nxt.p==null||!cur.sig||!cur.ctx||cur.ctx.rel==null) continue;
        if(bizDayDiff(cur.d,nxt.d,true)!==1) continue; // 上でJP銘柄のみに絞り込み済み
        var sum=0,n=0;
        for(var j=Math.max(0,i-TREND_PHASE_LOOKBACK+1);j<=i;j++){
          var e=hist[j];
          if(e&&e.ctx&&e.ctx.rel!=null){sum+=e.ctx.rel;n++;}
        }
        if(n<2||sum<0) continue;
        var move=priceMoveState(cur.p,nxt.p);
        if(move===0) continue;
        var bucket=sum>=TREND_PHASE_HOT?stats.hot:stats.early;
        cur.sig.forEach(function(key){
          if(!bucket[key])bucket[key]={w:0,t:0};
          bucket[key].t++;
          if(move>0)bucket[key].w++;
        });
      }
    });
  }catch(e){}
  PHASE_STATS_CACHE=stats;PHASE_STATS_TS=now;
  return stats;
}
// ── 実トレード×シグナル：完了トレードの損益と、登録時に点灯していたシグナルの関係 ──
// sigKeysAtAddを保存し始めた新しいトレードだけが対象。完了トレードが貯まると自動で表示される
function calcTradeSignalStats(){
  var all=loadTrades("personal");
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
// ── 手法別（⚡スキャル/📈デイトレ/🌊スイング）成績 ────────────────────────
// 手法は登録時に記録したstyleAtAddを優先。まだ記録の無い過去のトレードは、
// その銘柄の現在のバッジ（tradeType）で補完する
function tradeStyleOf(t,stocks){
  if(t.styleAtAdd) return t.styleAtAdd;
  var st=(stocks||[]).find(function(x){return x.ticker===t.ticker;});
  return(st&&st.tradeType)||null;
}
// 完了トレードを手法別に集計。R系（平均R・PF）は既存のcalcRStatsをバケットごとに呼ぶ
function calcTradeStyleStats(stocks){
  var done=loadTrades("personal").filter(function(t){return t.status==="done";});
  return TRADE_STYLES.map(function(st){
    var rows=done.filter(function(t){return tradeStyleOf(t,stocks)===st.key;});
    var pctRows=rows.filter(function(t){return t.pnlPercent!=null;});
    var wins=rows.filter(function(t){return(t.pnl||0)>0;});
    return{
      key:st.key,label:st.label,color:st.color,total:rows.length,
      winRate:rows.length?Math.round(wins.length/rows.length*100):null,
      avgPct:pctRows.length?pctRows.reduce(function(a,t){return a+t.pnlPercent;},0)/pctRows.length:null,
      totalPnl:rows.reduce(function(a,t){return a+(t.pnl||0);},0),
      r:calcRStats(rows)
    };
  });
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
        if(bizDayDiff(cur.d,nxt.d,true)!==1) continue; // 上でJP銘柄のみに絞り込み済み
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

// ── 🚦 総合判定（デイトレ前提・標準しきい値）──────────────────────────────
// スコア／統計ベース予想／スコア帯実績／シグナル一致度／日中型／対TOPIX／
// リスクリワード／流動性 の8項目をすべて点数化し、合計点で1つの結論に集約する。
// 否決条件（これが出たら無条件で見送り）は設けず、すべて加点・減点として扱う
function clampPt(v,lim){return Math.max(-lim,Math.min(lim,v));}
function judgeOverall(a){
  var P=0,R=[];
  // ord＝表示の並び順。スコアは常に先頭(0)、それ以外(1)は点数の大きい順に並べる
  function add(pt,label,ord){pt=Math.round(pt);if(pt===0)return;P+=pt;R.push({pt:pt,label:label,ord:ord||0});}

  // 1. 総合スコア（判定の主軸。50点を境に±）
  add(a.score-50,"スコア"+Math.round(a.score),0);

  // 2. 統計ベース予想（デイトレなので「今日の引けまで」を優先。無ければ翌営業日）
  var todayReady=a.todayF&&a.todayF.ready;
  var f=todayReady?a.todayF:(a.nextF&&a.nextF.ready?a.nextF:null);
  if(f) add(clampPt((f.upRate-50)*0.6+f.expPct*4,20),
    "統計"+(todayReady?"当日":"翌日")+" 上昇"+f.upRate+"%・"+(f.expPct>=0?"+":"")+f.expPct.toFixed(1)+"%",1);

  // 3. 同じスコア帯の実測勝率（件数が少ないうちは効きを半分に）
  if(a.band&&a.band.winRate!=null&&a.band.total>=10)
    add(clampPt((a.band.winRate-50)*(a.band.total>=20?0.4:0.2),12),
      "同スコア帯の実績 "+a.band.winRate+"%("+a.band.total+"件)",1);

  // 4. シグナルの一致度（強気の数－弱気の数）
  var up=0,dn=0;
  (a.signals||[]).forEach(function(x){if(x.state===1)up++;else if(x.state===-1)dn++;});
  add(clampPt((up-dn)*3,12),"シグナル 強気"+up+"／弱気"+dn,1);

  // 5. 日中型／夜間型（持ち越さないデイトレでは日中の値動きが直接効く）
  if(a.dayNight) add(a.dayNight.day>0?8:-8,(a.dayNight.day>0?"☀️日中型 +":"🌙夜間型 ")+a.dayNight.day+"%",1);

  // 6. 対TOPIX相対（地合いより強いか弱いか）
  if(a.relInfo) add(a.relInfo.strong?5:-5,"対TOPIX "+a.relInfo.label,1);

  // 7. リスクリワード（利確幅 ÷ 損切り幅）
  if(a.rr!=null) add(a.rr>=2?8:a.rr>=1.5?4:a.rr>=1?0:-6,"リスクリワード 1:"+a.rr,1);

  R.sort(function(x,y){return x.ord!==y.ord?x.ord-y.ord:Math.abs(y.pt)-Math.abs(x.pt);});
  return{key:P>=25?"BUY":P>=10?"TRY":P>=-10?"WATCH":"SKIP",points:Math.round(P),reasons:R,statReady:!!f};
}
// スキャン結果1件分から総合判定を作るラッパー（analyze内・再スキャン後の両方から呼ぶ）
function buildVerdict(o){
  try{
    var bands=getUniverseBandStats(),bl=bandLabelFor(o.score),bandRow=null;
    for(var i=0;i<bands.length;i++){if(bands[i].band===bl)bandRow=bands[i];}
    return judgeOverall({
      score:o.score,signals:o.signals,
      nextF:calcStatForecast(o.signals,getUniverseSignalStats()),
      todayF:currentSessionLabel()!=="時間外"?calcStatForecast(o.signals,getIntradaySignalStats()):null,
      band:bandRow,dayNight:DAYNIGHT[o.ticker]||null,
      relInfo:relStrengthInfo(o.relStrength),
      rr:o.buyPlan?o.buyPlan.rr:null
    });
  }catch(e){return null;}
}

// ── 🚦 総合判定そのものの的中率（後からの答え合わせ用）──────────────────────
// scoreHist(sh_*)とイントラデイ履歴(sh_intraday_*)に残した判定キー(v)を使い、
// 「買い」と出た時に実際に上がったかを集計する。翌営業日版と当日引け版の2本立て
var VERDICT_ACC_CACHE=null,VERDICT_ACC_TS=0;
var VERDICT_ORDER=["BUY","TRY","WATCH","SKIP"];
// ── 当日集計（引けまで）の時間帯ルール ──────────────────────────────────
// 記録の"session"は場中4区分＋"時間外"。"時間外"は昼休み(11:30-12:30)と引け後(15:30〜)の
// 両方を含むため、時刻または前後の並びから「引け後」だけを見分けて終点として使う
var SESSION_RANK={"寄り付き":0,"前場":1,"後場前半":2,"後場後半":3};
var AFTER_CLOSE_RANK=4;      // 引け後（15:30以降）＝終値そのもの。終点として最良
var MIN_PAIR_GAP_MIN=60;     // 時刻がある記録：これ未満しか離れていないペアは除外
var MIN_PAIR_GAP_RANK=2;     // 時刻がない古い記録：時間帯がこれ以上離れていること
function hhmmToMin(t){var m=/^(\d{1,2}):(\d{2})$/.exec(t||"");return m?parseInt(m[1],10)*60+parseInt(m[2],10):null;}
// 同じ日の記録リストのidx番目が、1日の中でどの位置にあたるかを返す（判定不能ならnull）
function sessionRankAt(entries,idx){
  var e=entries[idx];
  if(SESSION_RANK[e.session]!=null) return SESSION_RANK[e.session];
  var mi=hhmmToMin(e.t);
  if(mi!=null) return mi>=15*60+30?AFTER_CLOSE_RANK:null; // 時刻があれば引け後か直接わかる
  for(var i=idx-1;i>=0;i--){                              // 時刻がない古い記録は並び順で推定
    var r=SESSION_RANK[entries[i].session];
    if(r!=null) return r>=SESSION_RANK["後場前半"]?AFTER_CLOSE_RANK:null;
  }
  return null;
}
// 2点が十分離れているか（数分差の比較を「当日の値動き」と誤解しないための番人）
function isFarEnoughPair(a,b,ra,rb){
  var ma=hhmmToMin(a.t),mb=hhmmToMin(b.t);
  if(ma!=null&&mb!=null) return (mb-ma)>=MIN_PAIR_GAP_MIN;
  return (ra!=null&&rb!=null)&&(rb-ra)>=MIN_PAIR_GAP_RANK;
}
function calcVerdictAccuracy(){
  var now=Date.now();
  if(VERDICT_ACC_CACHE&&now-VERDICT_ACC_TS<UNIVERSE_STATS_TTL) return VERDICT_ACC_CACHE;
  var nx={},td={};
  // move: priceMoveState の戻り値（1=上昇 / -1=下落 / 0=横ばい / null=計算不可）
  // 横ばい（±WIN_THRESHOLD_PCT未満）は勝敗の分母に入れず「引き分け」として件数だけ数える
  // → 他の集計（スコア帯別など）と条件を揃えるための処理
  function tally(box,key,move,pct){
    if(move==null) return;
    if(!box[key])box[key]={w:0,t:0,sum:0,draw:0};
    if(move===0){box[key].draw++;return;}
    box[key].t++;if(move>0)box[key].w++;box[key].sum+=pct;
  }
  try{
    Object.keys(localStorage).forEach(function(k){
      if(k.indexOf("sh_")!==0) return;
      var hist=JSON.parse(localStorage.getItem(k)||"[]");
      if(k.indexOf("sh_intraday_")===0){
        // 当日版：日ごとにまとめ、その日の最後の記録（後場後半 or 引け後）を終点として比べる。
        // 終点が昼前で終わっている日、始点と終点が近すぎるペアは集計しない
        var byDate={};
        hist.forEach(function(e){if(e&&e.d)(byDate[e.d]=byDate[e.d]||[]).push(e);});
        Object.keys(byDate).forEach(function(dk){
          var es=byDate[dk],ei=es.length-1;
          if(ei<1) return;
          var end=es[ei],endRank=sessionRankAt(es,ei);
          if(end.p==null||endRank==null||endRank<SESSION_RANK["後場後半"]) return;
          for(var i=0;i<ei;i++){
            var c=es[i];
            if(!c.v||c.p==null) continue;
            if(!isFarEnoughPair(c,end,sessionRankAt(es,i),endRank)) continue;
            tally(td,c.v,priceMoveState(c.p,end.p),(end.p-c.p)/c.p*100);
          }
        });
      }else{
        // 翌営業日版：次の記録の価格と比べる
        if(!/\.T$/.test(k.slice(3))) return; // 日本株のみ（他集計と条件を揃える）
        for(var m=0;m<hist.length-1;m++){
          var cur=hist[m],nt=hist[m+1];
          if(!cur.v||cur.p==null||nt.p==null) continue;
          if(bizDayDiff(cur.d,nt.d,true)!==1) continue; // 記録が飛んだペアは「翌営業日」に含めない
          tally(nx,cur.v,priceMoveState(cur.p,nt.p),(nt.p-cur.p)/cur.p*100);
        }
      }
    });
  }catch(e){}
  function rows(box){
    return VERDICT_ORDER.map(function(k){
      var st=box[k]||{w:0,t:0,sum:0,draw:0};
      return{key:k,label:BADGE[k].label,winRate:st.t?Math.round(st.w/st.t*100):null,
        avgPct:st.t?st.sum/st.t:null,total:st.t,draw:st.draw};
    });
  }
  VERDICT_ACC_CACHE={next:rows(nx),today:rows(td)};VERDICT_ACC_TS=now;
  return VERDICT_ACC_CACHE;
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
// ブラウザのコンソールから確認できるように公開（例: getSignalAccuracy()）
if(typeof window!=="undefined"){
  window.getSignalAccuracy=function(){return calcFavSignalAccuracy();};
}
// ──────────────────────────────────────────────────────────────────────

// 初動スコアの表示色。60点以上＝候補、40〜59＝一応見る、それ未満は非表示
function momentumInfo(m){
  if(!m||m.score<40) return null;
  return{score:m.score,color:m.score>=60?"#22d3a0":"#fbbf24",
    bg:m.score>=60?"#052e16":"#1c1400",relSum:m.relSum};
}

// ── スコア計算の呼び出し口 ────────────────────────────────────────────────
// 計算そのものは src/lib/analyze.js が持つ。localStorage の読み書きだけを
// こちら側に残し、必要な値は opts で渡す／戻り値の save で受け取る形にしている
function loadScoreHist(ticker){
  try{return JSON.parse(localStorage.getItem("sh_"+ticker)||"[]");}catch(e){return[];}
}
function loadIntradayHist(ticker){
  try{return JSON.parse(localStorage.getItem("sh_intraday_"+ticker)||"[]");}catch(e){return[];}
}
// analyzeStock が返した save の内容をlocalStorageへ書き込む（従来と同じキー・同じ形式）
//   sh_<ticker>          … 1日1件のスコア履歴（最大40日分）
//   sh_intraday_<ticker> … 時間帯別のスコア履歴（JP銘柄のみ・最大200件）
// 休場中・寄り付き前・取得失敗（疑似データ）の時は統計が汚れるため書き込まない。
// その判定は analyze.js 側で済んでおり、save.daily / save.intraday に入っている
function saveScoreHistory(ticker,save){
  if(!save) return;
  if(save.daily){
    try{localStorage.setItem("sh_"+ticker,JSON.stringify(save.dailyHist));}catch(e){}
  }
  if(save.intraday){
    try{localStorage.setItem("sh_intraday_"+ticker,JSON.stringify(save.intradayHist));}catch(e){}
  }
}
// 1銘柄分のスコア計算。analyze.js を呼び、その直後にスコア履歴を保存する
function analyzeStock(stock,pd,vixVal){
  var s=analyzeStockCore(stock,pd,vixVal,{
    signalStats:getUniverseSignalStats(),        // 実績による重み補正（sh_* から集計した統計）
    scoreHist:loadScoreHist(stock.ticker),       // 既存のスコア履歴
    intradayHist:loadIntradayHist(stock.ticker), // 既存の時間帯別履歴
    resolveEventDate:resolveEventDate,           // 決算日・権利落ち日のローカル記憶
    buildVerdict:buildVerdict                    // 🚦総合判定（統計がlocalStorage由来のため注入）
  });
  saveScoreHistory(stock.ticker,s.save);
  return s;
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
  var chS=useState(null);var ch=chS[0],setCh=chS[1]; // この銘柄のChronos予測
  useEffect(function(){
    var alive=true;
    loadChronos().then(function(j){
      if(alive)setCh(j&&j.items&&p.ticker?(j.items[p.ticker]||null):null);
    });
    return function(){alive=false;};
  },[p.ticker]);
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
  // Chronosの予測は「予測時点の株価」を基準にしているので、現在値に合わせて倍率で寄せる
  var chScale=(ch&&ch.p>0)?last/ch.p:1;
  var chQ50=(ch&&ch.q50&&ch.q50.length>=BAND_DAYS)?ch.q50.map(function(v){return v*chScale;}):null;
  if(chQ50)chQ50.forEach(function(v){vals.push(v);});
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
  // Chronosの5日後が、簡易版の帯の内側か外側かを見る（外側＝平常の値動きを超える動き）
  var chLine=null,chJudge=null;
  if(chQ50&&b68.length){
    var cp=[FX+","+toY(last)];
    for(var ct=1;ct<=BAND_DAYS;ct++)cp.push(toXf(ct)+","+toY(chQ50[ct-1]));
    chLine=cp.join(" ");
    var ce=chQ50[BAND_DAYS-1];
    var lv=(ce>b90[BAND_DAYS-1].u||ce<b90[BAND_DAYS-1].l)?2:(ce>b68[BAND_DAYS-1].u||ce<b68[BAND_DAYS-1].l)?1:0;
    chJudge={v:ce,up:ce>last,pct:(ce/last-1)*100,lv:lv,
             txt:lv===2?"平常を大きく超える":lv===1?"平常よりやや大きい":"平常の範囲内",
             col:lv===2?"#fbbf24":lv===1?"#a3e635":"#6a90b0"};
  }
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
          {chLine&&<polyline points={chLine} fill="none" stroke="#fbbf24" strokeWidth={1.3} strokeDasharray="4,2" vectorEffect="non-scaling-stroke"/>}
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
          {chJudge&&<span style={{color:chJudge.col}} title="毎晩の自動予測(Chronos)。黄色い点線がその中心線">
            ┈AI予測 {fmt(chJudge.v)} {chJudge.up?"↑":"↓"}{(chJudge.pct>0?"+":"")+chJudge.pct.toFixed(1)}%・{chJudge.txt}
          </span>}
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

  var PROJECTION_W=0; // 右側の余白（現在は使用しない）
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
  return(
    <div title={down?"市場全体が下落中。買いシグナルは通りにくい地合いです":up?"市場全体が上昇中。買いシグナルが通りやすい地合いです":"市場全体はほぼ横ばいです"}
      style={{background:"#050e1c",border:"1px solid "+col+"55",borderRadius:6,padding:"2px 8px",display:"flex",alignItems:"center",gap:6,flexShrink:0,whiteSpace:"nowrap"}}>
      <span style={{fontSize:11,fontWeight:800,color:col}}>{head}</span>
      <span style={{fontSize:10,color:"#8fb0d0",fontFamily:"monospace"}}>TOPIX {(t>=0?"+":"")+t.toFixed(2)}%</span>
    </div>
  );
}

// ── StockCard ────────────────────────────────────────────────────────────────
// ── トレード登録モーダル（買い/売り価格を入力してトレードへ追加）─────
function TradeAddModal(p){
  var s=p.s;
  var isMobile=useIsMobile();
  var buyS=useState(s.rawPrice!=null?String(s.rawPrice):"");var buyVal=buyS[0],setBuyVal=buyS[1];
  var buyDirS=useState("down");var buyDir=buyDirS[0],setBuyDir=buyDirS[1]; // 指値(down)／逆指値(up)。常に「指値」を初期値にし、必要な時だけ手動で切り替える
  var sellS=useState("");var sellVal=sellS[0],setSellVal=sellS[1];
  var stopS=useState("");var stopVal=stopS[0],setStopVal=stopS[1];
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
    if(se<=b)return false; // 利確は買い価格より上であること（下だと約定した瞬間に損失で完了してしまう）
    var sp=parseFloat(stopVal);
    if(isNaN(sp)||sp<=0||sp>=b)return false; // 損切りは必須・買い価格より下であること
    return true;
  }
  // 入力が揃っているのにボタンが押せない理由を1行で示す（原因が分からず詰まらないように）
  function validMsg(){
    var b=parseFloat(buyVal),se=parseFloat(sellVal),sp=parseFloat(stopVal);
    if(b>0&&se>0&&se<=b)return "⚠️ 売り価格（利確）は買い価格より高い値にしてください";
    if(b>0&&sp>0&&sp>=b)return "⚠️ 損切り価格は買い価格より低い値にしてください";
    return null;
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
        {validMsg()&&<div style={{fontSize:11,color:"#f43f5e",marginBottom:8}}>{validMsg()}</div>}
        <button onClick={function(){add("personal");}} disabled={!valid()} style={{width:"100%",background:valid()?"linear-gradient(135deg,#0ea5e9,#0369a1)":"#0f2040",border:"none",borderRadius:8,color:valid()?"#fff":"#2a4060",padding:"10px",fontSize:13,fontWeight:700,cursor:valid()?"pointer":"not-allowed"}}>🎯 トレードに登録</button>
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
        {[1,2,3,4].map(function(n){return optBtn(n,groupNames[n]);})}
        {isMember&&<button onClick={onRemove} style={{padding:"12px 10px",background:"#2a0a12",border:"1px solid #f43f5e60",borderRadius:8,color:"#f43f5e",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"monospace",marginTop:4}}>🗑 お気に入り削除</button>}
        <button onClick={onClose} style={{padding:"8px 0",background:"transparent",border:"1px solid #2a4060",borderRadius:8,color:"#4a7090",fontSize:12,cursor:"pointer",fontFamily:"monospace"}}>キャンセル</button>
      </div>
    </div>
  );
}

function StockCard(p){
  var s=p.s,toggleFav=p.toggleFav,isFav=p.isFav,cross=p.cross,onRescan=p.onRescan,rescanLoading=p.rescanLoading;
  var star=starStyle(s.ticker,isFav,p.personalTrades);
  var bc=BADGE[s.verdict||s.timing]||BADGE[s.timing],mc=MKT[s.market]||MKT["US"],isUp=parseFloat(s.change)>=0;
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
            {(function(){var mi=momentumInfo(s.momentum);return mi&&<span style={bStyle(mi.bg,"1px solid "+mi.color,mi.color)} title={"初動スコア "+mi.score+"/100（対TOPIX累積"+(mi.relSum>=0?"+":"")+mi.relSum+"%）。これから数日で動き出しそうな銘柄を、総合スコアとは別の観点で評価した点数。60点以上が候補"}>🌱初動{mi.score}</span>;})()}
            {(function(){var ri=relStrengthInfo(s.relStrength);return ri&&<span style={bStyle(ri.strong?"#052e16":"#1f0010","1px solid "+(ri.strong?"#22d3a0":"#f43f5e"),ri.strong?"#22d3a0":"#f43f5e")} title={"対TOPIX相対(前日比差): "+ri.label}>{ri.strong?"🔥対TOPIX":"🧊対TOPIX"}{ri.label}</span>;})()}{(function(){var dn=DAYNIGHT[s.ticker];if(!dn)return null;var pos=dn.day>0;return <span style={bStyle(pos?"#052e16":"#101826","1px solid "+(pos?"#22d3a0":"#2a4060"),pos?"#22d3a0":"#4a7090")} title={"過去1年の値動きの分解（"+dn.days+"日分）: 日中(始値→終値)の累積"+(dn.day>=0?"+":"")+dn.day+"% / 夜間(前日終値→始値)の累積"+(dn.night>=0?"+":"")+dn.night+"%。日中分がプラスなら、持ち越さないデイトレと相性が良い日中型"}>{(pos?"☀️日中+":"🌙日中")+dn.day+"%"}</span>;})()}
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
// ── 🚦 総合判定パネル（各機能をまとめた最終結論＋根拠）─────────────────
function VerdictPanel(p){
  var v=p.v;
  if(!v) return null;
  var b=BADGE[v.key]||BADGE.WATCH;
  var NOTE={BUY:"材料が揃っています",TRY:"やや優勢。小さめの枚数で",WATCH:"決め手不足。無理に入らない",SKIP:"不利な材料が優勢"};
  return(
    <div style={{background:b.bg,border:"2px solid "+b.border,borderRadius:8,padding:"6px 10px"}}>
      <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
        <span style={{fontSize:10,fontWeight:700,color:"#8aa8c8"}}>🚦総合判定</span>
        <span style={{fontSize:12,fontWeight:800,color:b.text,lineHeight:1}}>{b.label}</span>
        <span style={{fontSize:10,color:"#8aa8c8"}}>{NOTE[v.key]}</span>
        <span style={{fontSize:10,color:"#4a7090",marginLeft:"auto"}}>合計 {(v.points>=0?"+":"")+v.points}点</span>
      </div>
      <div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:4}}>
        {v.reasons.slice(0,5).map(function(r,i){
          var pos=r.pt>0;
          return(<span key={i} style={{fontSize:9,fontWeight:700,color:pos?"#22d3a0":"#f43f5e",background:pos?"#052e16":"#1f0010",borderRadius:4,padding:"2px 5px"}}>{(pos?"+":"")+r.pt+" "+r.label}</span>);
        })}
      </div>
      {!v.statReady&&<div style={{fontSize:9,color:"#4a7090",marginTop:3}}>※統計ベース予想はデータ蓄積中。今はスコアとシグナル中心の判定です</div>}
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
  var bc=BADGE[s.verdict||s.timing]||BADGE[s.timing];
  var borderColor=s.score>=58?"#22d3a0":s.score>=38?"#fbbf24":"#f43f5e";
  var fromHighColor=s.fromHigh>=-10?"#f43f5e":s.fromHigh>=-30?"#fbbf24":"#22d3a0";
  var fromLowColor=s.fromLow<=20?"#22d3a0":s.fromLow<=50?"#fbbf24":"#f43f5e";
  var pos52=s.position52!=null?Math.min(98,Math.max(2,s.position52)):null;
  var pos52Color=pos52!=null?(pos52<=25?"#22d3a0":pos52<=75?"#fbbf24":"#f43f5e"):null;
  var star=starStyle(s.ticker,isFav,p.personalTrades);

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
  var simSharesS=useState("100");var simShares=simSharesS[0],setSimShares=simSharesS[1];
  var simBuyS=useState(s.rawPrice?s.rawPrice.toFixed(2):"");var simBuy=simBuyS[0],setSimBuy=simBuyS[1];
  useEffect(function(){var isJP=s.market==="JP";setSimBuy(s.rawPrice?(isJP?String(Math.round(s.rawPrice)):s.rawPrice.toFixed(2)):"");},[s.ticker]);
  var simTargetS=useState(3);var simTarget=simTargetS[0],setSimTarget=simTargetS[1];
  var simStopS=useState(-5);var simStop=simStopS[0],setSimStop=simStopS[1];
  var simTargetInputS=useState("3");var simTargetInput=simTargetInputS[0],setSimTargetInput=simTargetInputS[1];
  var simStopInputS=useState("-5");var simStopInput=simStopInputS[0],setSimStopInput=simStopInputS[1];
  var showSupportInfoS=useState(false);var showSupportInfo=showSupportInfoS[0],setShowSupportInfo=showSupportInfoS[1];
  var showStatInfoS=useState(false);var showStatInfo=showStatInfoS[0],setShowStatInfo=showStatInfoS[1];

  // 判定プロンプトをClaudeアプリに直接渡す（プロンプト欄に事前入力された状態で開く）
  // ※qに渡せるのは約14,000文字までのため、余裕をみて13,000文字で切る
  // ※念のためクリップボードにも同時コピー（アプリが開かなかった時の保険）
  function openInClaude(){
    var dmap={};dmap[s.ticker]=daily; // 詳細画面では日足取得済み→本物の52週をプロンプトに載せる
    // 立花証券のリアルタイム値が届いている時は、画面表示（● LIVE）と食い違わないよう
    // sのコピーに現在値・前日比を上書きしてから渡す（s本体は書き換えない）
    var ps=s;
    if(liveTick&&liveTick.price!=null){
      ps=Object.assign({},s,{
        price:fmtMoney(liveTick.price,s.market==="JP"), // 表示形式（通貨記号付き文字列）はs.priceと揃える
        rawPrice:liveTick.price,
        change:liveTick.changePct!=null?liveTick.changePct.toFixed(2):s.change
      });
    }
    var text=buildVolumeRankingPrompt([ps],1,false,dmap);
    if(text.length>13000) text=text.slice(0,13000);
    if(navigator.clipboard) navigator.clipboard.writeText(text).catch(function(){});
    window.location.href="claude://claude.ai/new?q="+encodeURIComponent(text);
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


      <VerdictPanel v={s.verdictInfo}/>

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
        <button onClick={openInClaude} title="Claudeアプリで判定" style={{flexShrink:0,background:"#2a1206",border:"1px solid #d97757",borderRadius:6,color:"#f0a583",padding:"4px 9px",fontSize:14,cursor:"pointer"}}>⚡</button>
        <button onClick={function(){if(onRescan&&!rescanLoading)onRescan(s.ticker);}} disabled={rescanLoading} title="再スキャン" style={{flexShrink:0,background:"transparent",border:"1px solid "+(rescanLoading?"#fbbf24":"#2a4060"),borderRadius:6,color:rescanLoading?"#fbbf24":"#4a7090",padding:"4px 9px",fontSize:14,cursor:rescanLoading?"not-allowed":"pointer"}}>{rescanLoading?"⏳":"🔄"}</button>
        <button onClick={function(){setShowSim(function(v){return !v;});}} title="シミュレーター" style={{flexShrink:0,background:showSim?"#1a0a3a":"transparent",border:"1px solid "+(showSim?"#a78bfa":"#2a4060"),borderRadius:6,color:showSim?"#a78bfa":"#4a7090",padding:"4px 9px",fontSize:14,cursor:"pointer"}}>💹</button>
        <button onClick={function(){setShowTrade(function(v){return !v;});}} title="トレード登録" style={{flexShrink:0,background:showTrade?"#0a1a3a":"transparent",border:"1px solid "+(showTrade?"#0ea5e9":"#2a4060"),borderRadius:6,color:showTrade?"#0ea5e9":"#4a7090",padding:"4px 9px",fontSize:14,cursor:"pointer"}}>🎯</button>
      </div>

      {/* チャート（1分足／日足6ヶ月＋予測レンジ を切替） */}
      <div style={{background:"#03080f",borderRadius:6,padding:"4px 6px",marginTop:-6}}>
        <div style={{display:"flex",gap:6,padding:"2px 0 4px",alignItems:"center"}}>
          <TabBtn active={chartMode==="1m"} color="#38bdf8" label="1分足" onClick={function(){setChartMode("1m");}}/>
          <TabBtn active={chartMode==="1d"} color="#38bdf8" label="日足＋予測" onClick={function(){setChartMode("1d");}}/>
          {/* 今表示しているチャートの種類（もとはチャート内の右上にあった表示） */}
          <span style={{marginLeft:"auto",flexShrink:0,fontSize:9,color:"#6a90b0",whiteSpace:"nowrap",background:"#03080fd0",border:"1px solid #1a2c44",borderRadius:4,padding:"3px 6px"}}>{chartMode==="1m"?"1分足":"日足6ヶ月"}</span>
        </div>
        {chartMode==="1m"
          ? <IntradayChart1m data={intraday} liveTick={liveTick} height={isMobile?150:250}/>
          : <DailyChartWithBand daily={daily} ticker={s.ticker} height={isMobile?150:250}/>}
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
        // 目標％・損切り％は0.1刻みで指定できる（+1.5%のような細かい設定に対応）。
        // 小数計算の誤差桁（3.0000000000000004等）が表示に出ないよう、確定時に必ず0.1単位へ丸める
        function roundPct(v){return Math.round(v*10)/10;}
        function fmtPct(v){return String(roundPct(v));}
        // 入力欄の確定処理（blur・Enterで共通）。範囲外・数値でない場合は直前の確定値に戻す
        function commitPct(text,min,max,cur,setNum,setText){
          var v=roundPct(parseFloat(text));
          if(!isNaN(v)&&v>=min&&v<=max){setNum(v);setText(fmtPct(v));}
          else{setText(fmtPct(cur));}
        }
        var scenarios=[{label:"損切りライン",pct:simStop,color:"#f43f5e"},{label:"-5%",pct:-5,color:"#fb923c"},{label:"+5%",pct:5,color:"#22d3a0"},{label:"+10%",pct:10,color:"#22d3a0"},{label:"+20%",pct:20,color:"#22d3a0"},{label:"目標価格",pct:simTarget,color:"#fbbf24"}];
        return(
          <div onClick={function(e){if(e.target===e.currentTarget)setShowSim(false);}} style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:2000,display:"flex",alignItems:"center",justifyContent:isMobile?"center":"flex-end",padding:16,paddingRight:isMobile?16:"56vw"}}>
            <div style={{background:"#040c18",border:"1px solid #a78bfa50",borderRadius:16,padding:"16px",width:"100%",maxWidth:520,maxHeight:"85vh",overflowY:"auto",WebkitOverflowScrolling:"touch",boxShadow:"0 8px 30px rgba(0,0,0,0.6)"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                <div style={{fontSize:14,fontWeight:700,color:"#a78bfa"}}>💹 損益シミュレーション</div>
                <button onClick={function(){setShowSim(false);}} style={{background:"transparent",border:"none",color:"#4a7090",fontSize:18,cursor:"pointer",lineHeight:1}}>✕</button>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                <div><div style={{fontSize:13,color:"#2a6090",marginBottom:3}}>買値</div><input style={inpSim} type="number" step={isJP?1:0.01} value={simBuy} onChange={function(e){setSimBuy(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter"){e.preventDefault();var v=parseFloat(simBuy);if(!isNaN(v)&&v>0){setSimBuy(String(v));}else{setSimBuy("");}e.target.blur();}}}/></div>
                <div><div style={{fontSize:13,color:"#2a6090",marginBottom:3}}>株数</div><input style={inpSim} type="number" value={simShares} onChange={function(e){setSimShares(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter"){e.preventDefault();var v=parseInt(simShares);if(!isNaN(v)&&v>0){setSimShares(String(v));}else{setSimShares("");}e.target.blur();}}}/></div>
              </div>
              {bp>0&&sh>0&&(
                <div>
                  <div style={{background:"#071428",borderRadius:6,padding:"6px 10px",fontSize:14,color:"#4a7090",marginBottom:8}}>投資総額: <span style={{color:"#d8eeff",fontWeight:700}}>{fmtP(bp*sh)}</span>{(!isJP&&p.usdJpy)&&<span style={{color:"#4a7090",fontSize:12}}>  (¥{Math.round(bp*sh*p.usdJpy).toLocaleString()})</span>}</div>
                  <div style={{marginBottom:6}}>
                    <div style={{fontSize:13,color:"#fbbf24",marginBottom:3}}>{fmtP(bp*(1+simTarget/100))}</div>
                    <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4}}>
                      <span style={{fontSize:13,color:"#4a7090",flexShrink:0}}>目標</span>
                      <input type="number" step={0.1} value={simTargetInput} onChange={function(e){setSimTargetInput(e.target.value);}} onBlur={function(){commitPct(simTargetInput,1,200,simTarget,setSimTarget,setSimTargetInput);}} onKeyDown={function(e){if(e.key==="Enter"){commitPct(simTargetInput,1,200,simTarget,setSimTarget,setSimTargetInput);e.target.blur();}}} style={{width:60,background:"#040c18",border:"1px solid #fbbf24",borderRadius:4,color:"#fbbf24",padding:"2px 6px",fontSize:16,fontFamily:"monospace",textAlign:"center"}}/>
                      <span style={{fontSize:13,color:"#fbbf24"}}>%</span>
                      <input type="range" min={1} max={200} step={0.1} value={simTarget} onChange={function(e){var v=roundPct(parseFloat(e.target.value));setSimTarget(v);setSimTargetInput(fmtPct(v));}} style={{flex:1,accentColor:"#fbbf24"}}/>
                    </div>
                  </div>
                  <div style={{marginBottom:8}}>
                    <div style={{fontSize:13,color:"#f43f5e",marginBottom:3}}>{fmtP(bp*(1+simStop/100))}</div>
                    <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4}}>
                      <span style={{fontSize:13,color:"#4a7090",flexShrink:0}}>損切り</span>
                      <input type="number" step={0.1} value={simStopInput} onChange={function(e){setSimStopInput(e.target.value);}} onBlur={function(){commitPct(simStopInput,-50,-0.1,simStop,setSimStop,setSimStopInput);}} onKeyDown={function(e){if(e.key==="Enter"){commitPct(simStopInput,-50,-0.1,simStop,setSimStop,setSimStopInput);e.target.blur();}}} style={{width:60,background:"#040c18",border:"1px solid #f43f5e",borderRadius:4,color:"#f43f5e",padding:"2px 6px",fontSize:16,fontFamily:"monospace",textAlign:"center"}}/>
                      <span style={{fontSize:13,color:"#f43f5e"}}>%</span>
                      <input type="range" min={-50} max={-0.1} step={0.1} value={simStop} onChange={function(e){var v=roundPct(parseFloat(e.target.value));setSimStop(v);setSimStopInput(fmtPct(v));}} style={{flex:1,accentColor:"#f43f5e"}}/>
                    </div>
                  </div>
                  <div style={{display:"flex",flexDirection:"column",gap:4}}>
                    {scenarios.sort(function(a,b){return a.pct-b.pct;}).map(function(sc,i){var pnl=(bp*(1+sc.pct/100)-bp)*sh;return(<div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",background:"#071428",borderRadius:6,padding:"5px 8px"}}><div><span style={{fontSize:14,color:sc.color,fontWeight:700}}>{sc.label}</span><span style={{fontSize:13,color:"#4a7090",marginLeft:4}}>{sc.pct>=0?"+":""}{fmtPct(sc.pct)}%</span></div><span style={{fontSize:15,fontWeight:800,color:pnl>=0?"#22d3a0":"#f43f5e"}}>{fmtPnL(pnl)}</span></div>);})}
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })(),document.body)}

      {showTrade&&createPortal(<TradeAddModal s={s} onAddTrade={p.onAddTrade} onClose={function(){setShowTrade(false);}}/>,document.body)}

      {showTachibana&&createPortal(<TachibanaQuoteModal quote={tachibanaQuote} onClose={function(){setShowTachibana(false);}}/>,document.body)}
    </div>
  );
}

// スマホ用：詳細パネルを全画面モーダルで表示（全銘柄／お気に入りタブ共通）
function MobileStockDetailModal(p){
  if(!p.s) return null;
  return createPortal(
    <div onClick={function(e){if(e.target===e.currentTarget)p.onClose();}} style={{position:"fixed",inset:0,zIndex:1500,background:"#040c18",overflowY:"auto",WebkitOverflowScrolling:"touch",padding:10}}>
      <StockDetailPanel key={p.s&&p.s.ticker} s={p.s} toggleFav={p.toggleFav} isFav={p.isFav} vix={p.vix} usdJpy={p.usdJpy} onRescan={p.onRescan} rescanLoading={p.rescanLoading} allStocks={p.allStocks} onAddTrade={p.onAddTrade} onClose={p.onClose} personalTrades={p.personalTrades}/>
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
        var r0=json&&json.chart&&json.chart.result&&json.chart.result[0];
        var meta=r0&&r0.meta;
        if(!meta) return{key:idx.key,error:true};
        var price=meta.regularMarketPrice||0;
        // 指数も個別銘柄と同じ15分足データのため、chartPreviousCloseではなく実測値を使う
        var q0=(r0.indicators&&r0.indicators.quote&&r0.indicators.quote[0])||{};
        var prev=meta.regularMarketPreviousClose||findPrevClose(q0.close,q0.date)||meta.chartPreviousClose||price;
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

// ── ⭐お気に入り／📋全銘柄 一覧パネル ────────────────────────────────────────
// 旧「全銘柄タブ」はこのパネルに統合済み。グループ絞り込みの -1 を
// 「📋全銘柄（スキャン結果すべて）」として扱う
function FavPanel(p){
  var stocks=p.stocks,setStocks=p.setStocks,favs=p.favs,toggleFav=p.toggleFav,vix=p.vix;
  var personalTrades=p.personalTrades;
  var favGroups=p.favGroups,groupNames=p.groupNames,renameGroup=p.renameGroup;
  var loading=p.loading,progress=p.progress||{done:0,total:0,msg:null},ts=p.ts;
  var isMobile=useIsMobile();
  var extraH=isMobile?MOBILE_TABBAR_H:0; // スマホ用タブバー分の高さを差し引く

  // groupFilter: -1=📋全銘柄 / 0=⭐全体 / 1〜4=グループ。タブを移動しても保持される
  var groupFilterS=usePersistedState("fav_group_filter",0);var groupFilter=groupFilterS[0],setGroupFilter=groupFilterS[1];
  // sortMode: "reg"=既定順（お気に入り=登録順・全銘柄=スキャン順）/ "score"=スコア順 / "momentum"=初動順
  var sortModeS=usePersistedState("fav_sort_mode","reg");var sortMode=sortModeS[0],setSortMode=sortModeS[1];
  var mode=(sortMode==="score"||sortMode==="momentum")?sortMode:"reg"; // 旧"dayType"の保存値は既定順に読み替え
  var searchS=useState("");var searchTicker=searchS[0],setSearchTicker=searchS[1];
  var searchStatusS=useState(null);var searchStatus=searchStatusS[0],setSearchStatus=searchStatusS[1];
  var addGroupS=useState(0);var addGroup=addGroupS[0],setAddGroup=addGroupS[1];
  var showAccS=useState(false);var showAcc=showAccS[0],setShowAcc=showAccS[1];
  var isAll=groupFilter===-1;
  // 銘柄名マスタ（コード→会社名）。会社名でも検索できるようにするため保持する。
  // 端末に24時間キャッシュされているので、通常は通信せずそのまま使える
  var nameMapS=useState(function(){return loadCachedNameMap();});var nameMap=nameMapS[0],setNameMap=nameMapS[1];
  var hitsOpenS=useState(false);var hitsOpen=hitsOpenS[0],setHitsOpen=hitsOpenS[1];
  useEffect(function(){
    var alive=true;
    fetchJPNameMap().then(function(m){if(alive&&m)setNameMap(m);}).catch(function(){});
    return function(){alive=false;};
  },[]);

  // 入力に一致する銘柄の候補（コードの前方一致・会社名の部分一致）。
  // ①スキャンで読込済みの銘柄（スコアや手法バッジも一緒に出せる）を優先し、
  // ②続けてキャッシュ済みの銘柄名マスタ（未読込の銘柄もここから探せる）を並べる
  var searchHits=(function(){
    var q=searchTicker.trim();
    if(!q) return[];
    var qU=q.toUpperCase(),LIMIT=20;
    var byCode=[],byName=[],seen={};
    stocks.forEach(function(s){
      var code=s.ticker.replace(".T","");
      var nm=String(s.name||"");
      var hit={ticker:s.ticker,code:code,name:nm,stock:s};
      if(code.toUpperCase().indexOf(qU)===0){seen[s.ticker]=true;byCode.push(hit);}
      else if(nm.toUpperCase().indexOf(qU)>=0){seen[s.ticker]=true;byName.push(hit);}
    });
    if(nameMap){
      Object.keys(nameMap).forEach(function(code){
        if(byCode.length+byName.length>=LIMIT*3) return; // 明らかに多すぎる場合は打ち切り
        var tk=code+".T";
        if(seen[tk]) return;
        var nm=String(nameMap[code]||"");
        var hit={ticker:tk,code:code,name:nm,stock:null};
        if(code.toUpperCase().indexOf(qU)===0){seen[tk]=true;byCode.push(hit);}
        else if(nm.toUpperCase().indexOf(qU)>=0){seen[tk]=true;byName.push(hit);}
      });
    }
    return byCode.concat(byName).slice(0,LIMIT);
  })();

  // tickerを指定するとその銘柄を、省略すると入力欄の内容を追加する
  async function addByTicker(tickerArg){
    var raw=String(tickerArg!=null?tickerArg:searchTicker).trim().toUpperCase();if(!raw)return;
    // 日本株判定：数字4桁(7203)に加え、数字3桁＋英数字1桁の新形式コード(285A等)にも対応
    var ticker=(/^\d{3}[0-9A-Z]$/.test(raw)?raw+".T":raw);
    if(favs.indexOf(ticker)>=0){setSearchStatus("already");return;}
    setSearchStatus("loading");
    try{
      var isJP=ticker.endsWith(".T"),code=ticker.replace(".T","");
      if(isJP) await fetchJPNameMap(); // 会社名の対応表を用意（キャッシュ済みなら即返る）
      var base={ticker:ticker,name:isJP?jpNameOf(ticker,code):code,market:isJP?"JP":"US",tvSymbol:(isJP?"TSE:":"NASDAQ:")+code};
      var pd=await fetchYahoo(ticker);
      var newStock=analyzeStock(base,pd,vix);
      setStocks(function(prev){return prev.some(function(s){return s.ticker===ticker;})?prev:prev.concat([newStock]);});
      toggleFav(ticker,addGroup);
      setSearchTicker("");setSearchStatus("ok");setTimeout(function(){setSearchStatus(null);},2000);
    }catch(e){setSearchStatus("error");setTimeout(function(){setSearchStatus(null);},2000);}
  }
  var statusMsg=searchStatus==="loading"?"取得中...":searchStatus==="ok"?"追加しました":searchStatus==="error"?"見つかりません":searchStatus==="already"?"登録済みです":null;

  // ── 表示対象の銘柄リスト ───────────────────────────────────────────
  var favStocks=favs.slice().reverse().map(function(t){return stocks.find(function(s){return s.ticker===t;});}).filter(Boolean);
  var baseList=isAll?stocks.slice()
    :groupFilter===0?favStocks
    :favStocks.filter(function(s){var g=favGroups[s.ticker];return(g==null?0:g)===groupFilter;});
  var displayStocks=mode==="score"
    ?baseList.slice().sort(function(a,b){return(b.score||0)-(a.score||0);})
    :mode==="momentum"
    ?baseList.slice().sort(function(a,b){
        // 初動スコア順。判定不可（米国株・履歴3日未満）は末尾にまとめる
        var av=a.momentum?a.momentum.score:-1,bv=b.momentum?b.momentum.score:-1;
        return bv-av;
      })
    :baseList;

  function isFavRef(t){return favs.indexOf(t)>=0;}

  // ── スキャン中の進捗表示（旧・全銘柄タブから移植）─────────────────────
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

  // ── 上部バーの部品（横スクロール1行に並べるため全てflexShrink:0）──────────
  var TIP_SCORE="アプリのスコア（0〜100点）が高い順に並べます。もう一度押すと既定の並びに戻ります";
  var TIP_MOM="これから数日で動き出しそうな銘柄（初動スコア）の高い順に並べます。対TOPIX相対の3日累積を主軸に、出来高の立ち上がりとBB収束を加味した点数です。日本株のみ・スキャン履歴が3日分たまると表示されます";
  function sBtn(m,label,title,color){
    var active=mode===m;
    return(<button onClick={function(){setSortMode(active?"reg":m);}} title={title} style={{flexShrink:0,background:active?color+"20":"transparent",border:"1px solid "+(active?color:"#1e3050"),borderRadius:6,color:active?color:"#4a6080",padding:"3px 8px",fontSize:11,cursor:"pointer",fontFamily:"monospace",fontWeight:active?700:400,whiteSpace:"nowrap"}}>{label}{active?"✓":""}</button>);
  }
  function gBtn(val,label){
    var active=groupFilter===val;
    var color=val===-1?"#0ea5e9":"#fbbf24";
    return(<button key={val} onClick={function(){setGroupFilter(val);}} style={{flexShrink:0,background:active?color+"20":"transparent",border:"1px solid "+(active?color:"#1e3050"),borderRadius:6,color:active?color:"#4a6080",padding:"3px 8px",fontSize:11,cursor:"pointer",fontFamily:"monospace",fontWeight:active?700:400,whiteSpace:"nowrap"}}>{label}</button>);
  }
  function editGroupName(num){
    var name=prompt("グループ名を入力",groupNames[num]);
    if(name&&name.trim())renameGroup(num,name.trim());
  }
  var divider=<span style={{flexShrink:0,width:1,alignSelf:"stretch",background:"#1e3050"}}/>;
  // PC版だけ、区切りの位置に余白を足して見やすくする（スマホは横スクロールのため余白なし）
  var pcGap=isMobile?null:<span style={{flexShrink:0,width:14}}/>;
  var realCount=stocks.filter(function(s){return s.real;}).length;

  var cardGrid=(
    <>
      <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:8}}>
        {displayStocks.map(function(s,i){
          var cross=s.signals&&s.signals.length>0?classifyStockFn(s):null;
          return <div key={s.ticker} style={{display:"contents"}}><StockCard s={s} toggleFav={toggleFav} isFav={isFavRef} cross={cross} vix={vix} usdJpy={p.usdJpy} setSelectedStock={p.setSelectedStock} selectedStock={p.selectedStock} onRescan={p.onRescan} rescanLoading={p.rescanLoading&&p.rescanLoading[s.ticker]} allStocks={stocks} onAddTrade={p.onAddTrade} personalTrades={personalTrades}/></div>;
        })}
      </div>
    </>
  );
  var stickyTop=50+extraH;
  return(
    <div style={{display:"flex",flexDirection:"column",height:"calc(100vh - "+(50+extraH)+"px)"}}>
      <div style={{position:"sticky",top:stickyTop,zIndex:10,background:"#040c18",paddingBottom:4,paddingLeft:10,paddingRight:10,paddingTop:4}}>
        {/* 件数 / 検索 / グループ / 初動順 / スコア順 / 業種まとめ登録 / 的中率 ／ 右端に再スキャン（PC版）*/}
        <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"6px 10px",display:"flex",gap:4,alignItems:"center",flexWrap:"nowrap",overflowX:"auto",WebkitOverflowScrolling:"touch"}}>
          <span style={{fontSize:10,color:"#4a7090",flexShrink:0,whiteSpace:"nowrap"}} title={"取得できた銘柄数／スキャンした銘柄数（表示中は"+displayStocks.length+"件）"}>
            <span style={{color:"#22d3a0",fontWeight:700}}>{realCount}</span>/{stocks.length}
            <span style={{color:"#2a6090"}}>　表示{displayStocks.length}</span>
          </span>
          {ts&&<span style={{fontSize:10,color:"#2a6090",flexShrink:0,whiteSpace:"nowrap"}}>{ts}</span>}
          {divider}
          <input style={{background:"#050f20",border:"1px solid #1e3050",borderRadius:6,color:"#b8cce0",padding:"4px 6px",fontSize:16,fontFamily:"monospace",flexShrink:0,width:120}} value={searchTicker} placeholder="7203 / トヨタ" onChange={function(e){setSearchTicker(e.target.value);setHitsOpen(true);}} onFocus={function(){setHitsOpen(true);}} onKeyDown={function(e){if(e.key==="Enter"){setHitsOpen(false);addByTicker();}else if(e.key==="Escape"){setHitsOpen(false);}}}/>
          <select value={addGroup} onChange={function(e){setAddGroup(Number(e.target.value));}} title="追加先のグループ" style={{background:"#050f20",border:"1px solid #1e3050",borderRadius:6,color:"#fbbf24",padding:"0 2px",fontSize:12,fontFamily:"monospace",flexShrink:0,width:74}}>
            <option value={0}>全体</option>
            {[1,2,3,4].map(function(n){return <option key={n} value={n}>{groupNames[n]}</option>;})}
          </select>
          <button onClick={function(){setHitsOpen(false);addByTicker();}} style={{flexShrink:0,background:"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:6,color:"#fff",padding:"4px 10px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"monospace",whiteSpace:"nowrap"}}>追加</button>
          {divider}
          {pcGap}
          {gBtn(-1,"📋全銘柄")}
          {gBtn(0,"⭐全体")}
          {[1,2,3,4].map(function(n){return <span key={n} style={{flexShrink:0,display:"flex",alignItems:"center",gap:2}}>{gBtn(n,groupNames[n])}{groupFilter===n&&<span onClick={function(){editGroupName(n);}} style={{cursor:"pointer",fontSize:11,color:"#4a6080"}}>✎</span>}</span>;})}
          {divider}
          {pcGap}
          {sBtn("momentum","🌱初動順",TIP_MOM,"#22d3a0")}
          {sBtn("score","🏆スコア順",TIP_SCORE,"#fbbf24")}
          {p.onBulkSector&&<button onClick={p.onBulkSector} style={{flexShrink:0,background:"transparent",border:"1px solid #0ea5e955",borderRadius:6,color:"#7dd3fc",padding:"3px 8px",fontSize:11,cursor:"pointer",fontFamily:"monospace",whiteSpace:"nowrap"}}>🏭業種まとめ登録</button>}
          {pcGap}
          <button onClick={function(){setShowAcc(true);}} style={{flexShrink:0,background:"transparent",border:"1px solid #1e3050",borderRadius:6,color:"#0ea5e9",padding:"3px 8px",fontSize:11,cursor:"pointer",fontFamily:"monospace",whiteSpace:"nowrap"}}>📊的中率</button>
          {p.onScan&&<button onClick={p.onScan} style={{flexShrink:0,marginLeft:isMobile?0:"auto",background:"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:6,color:"#fff",padding:"4px 10px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"monospace",whiteSpace:"nowrap"}}>再スキャン</button>}
        </div>
        {statusMsg&&<div style={{fontSize:12,color:searchStatus==="ok"?"#22d3a0":"#f43f5e",marginTop:4}}>{statusMsg}</div>}
        {/* 検索候補：クリックでその銘柄を追加。ツールバーは横スクロールするため、内側ではなくこの位置に出す */}
        {hitsOpen&&searchHits.length>0&&(
          <div style={{marginTop:4,background:"#071428",border:"1px solid #1e4070",borderRadius:8,maxHeight:260,overflowY:"auto",WebkitOverflowScrolling:"touch"}}>
            {searchHits.map(function(h){
              var already=favs.indexOf(h.ticker)>=0;
              return(
                <div key={h.ticker} onClick={function(){setHitsOpen(false);addByTicker(h.ticker);}} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderBottom:"1px solid #0a1830",cursor:"pointer"}}>
                  <span style={{fontSize:12,fontWeight:700,color:"#7dd3fc",fontFamily:"monospace",width:54,flexShrink:0}}>{h.code}</span>
                  <span style={{flex:1,minWidth:0,fontSize:12,color:"#b8cce0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{h.name}</span>
                  {h.stock&&h.stock.tradeLabel&&<span style={{fontSize:10,fontWeight:700,color:h.stock.tradeColor,flexShrink:0}}>{h.stock.tradeLabel}</span>}
                  {h.stock&&h.stock.score!=null&&<span style={{fontSize:11,fontWeight:700,color:scoreColor(h.stock.score),flexShrink:0}}>{h.stock.score}</span>}
                  <span style={{fontSize:11,color:already?"#fbbf24":"#2a4060",flexShrink:0}}>{already?"⭐":"＋"}</span>
                </div>
              );
            })}
            <div style={{display:"flex",alignItems:"center",gap:8,fontSize:10,color:"#2a6090",padding:"5px 10px"}}>
              <span style={{flex:1,minWidth:0}}>コード・会社名で検索できます（読込済みの銘柄を上に表示）</span>
              <span onClick={function(){setHitsOpen(false);}} style={{color:"#4a7090",cursor:"pointer",flexShrink:0}}>✕ 閉じる</span>
            </div>
          </div>
        )}
        {showAcc&&createPortal(<SignalAccuracyModal onClose={function(){setShowAcc(false);}} stocks={stocks}/>,document.body)}
      </div>
      <div style={{overflowY:"auto",flex:1,WebkitOverflowScrolling:"touch",paddingTop:8,paddingLeft:10,paddingRight:10,paddingBottom:120}}>
        <MarketBar/>
        {isMobile?(
          <>
            {cardGrid}
            <MobileStockDetailModal s={p.selectedStock} toggleFav={toggleFav} isFav={isFavRef} vix={vix} usdJpy={p.usdJpy} onRescan={p.onRescan} rescanLoading={p.rescanLoading&&p.selectedStock&&p.rescanLoading[p.selectedStock.ticker]} allStocks={stocks} onAddTrade={p.onAddTrade} onClose={function(){p.setSelectedStock(null);}} personalTrades={personalTrades}/>
          </>
        ):(
          <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
            <div style={{width:"45%",flexShrink:0}}>{cardGrid}</div>
            <div style={{flex:1,position:"sticky",top:0,maxHeight:"calc(100vh - 200px)",overflowY:"auto",WebkitOverflowScrolling:"touch"}}>
              <StockDetailPanel key={p.selectedStock&&p.selectedStock.ticker} s={p.selectedStock} toggleFav={toggleFav} isFav={isFavRef} vix={vix} usdJpy={p.usdJpy} onRescan={p.onRescan} rescanLoading={p.rescanLoading&&p.selectedStock&&p.rescanLoading[p.selectedStock.ticker]} allStocks={stocks} onAddTrade={p.onAddTrade} personalTrades={personalTrades}/>
            </div>
          </div>
        )}
        {displayStocks.length===0&&(
          <div style={{textAlign:"center",padding:"30px 20px",color:"#4a7090",fontSize:13}}>
            {isAll?"該当する銘柄がありません。再スキャンをお試しください":"ティッカーを入力して追加できます"}
          </div>
        )}
      </div>
    </div>
  );
}

// ── トレードタブ：登録トレードの一覧・損益集計 ─────────────────────────────
function TradePanel(p){
  var stocks=p.stocks,toggleFav=p.toggleFav,favs=p.favs,vix=p.vix;
  var isMobile=useIsMobile();
  var selIdS=useState(null);var selId=selIdS[0],setSelId=selIdS[1];
  function isFavRef(t){return favs.indexOf(t)>=0;}
  var list=p.personalTrades;
  var waitingList=list.filter(function(t){return t.status==="waiting";});
  var activeList=list.filter(function(t){return t.status==="active";});
  var doneList=list.filter(function(t){return t.status==="done";});
  var totalPnl=doneList.reduce(function(a,t){return a+(t.pnl||0);},0);
  // 勝率：完了トレードのうち損益がプラスだった割合
  var winRate=doneList.length?Math.round(doneList.filter(function(t){return(t.pnl||0)>0;}).length/doneList.length*100):null;
  var rStats=calcRStats(doneList);
  // 的中率の集計対象：登録している全トレード銘柄（お気に入りタブの集計とは分離）
  var tradeTickers=Array.from(new Set(list.map(function(t){return t.ticker;})));
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
      <div style={{display:"flex",gap:12,alignItems:"flex-start",flexDirection:isMobile?"column":"row"}}>
        <div style={{width:(!showAccuracy||isMobile)?"100%":"60%",flexShrink:0,display:"flex",flexDirection:"column",gap:10,minWidth:0}}>
          <div style={{background:"#050e1c",borderRadius:10,padding:"12px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",gap:10}}>
            <div style={{minWidth:0,flex:1}}>
              <div style={{fontSize:10,color:"#4a7090",whiteSpace:isMobile?"normal":"nowrap",lineHeight:1.6,wordBreak:"break-word"}}>合計損益（完了{doneList.length}件）{rStats.n>0&&<span style={{marginLeft:6,color:rStats.avgR>=0?"#22d3a0":"#f43f5e",fontWeight:700}}>平均{(rStats.avgR>=0?"+":"")+rStats.avgR.toFixed(2)}R ／ 累計{(rStats.totalR>=0?"+":"")+rStats.totalR.toFixed(1)}R ／ PF{rStats.pf!=null?rStats.pf.toFixed(2):"—"} ／ 損益分岐勝率{rStats.beRate!=null?rStats.beRate+"%":"—"}<span style={{color:"#2a6090"}}>（R集計{rStats.n}件）</span></span>}</div>
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
            <div style={{fontSize:16,fontWeight:800,color:"#e0f0ff",marginBottom:10}}>📊 シグナル的中率（全トレード銘柄）</div>
            <SignalAccuracyContent tickers={tradeTickers} label="全トレード" stocks={stocks}/>
          </div>
        )}
      </div>

      {selTrade&&createPortal(
        <TradeDetailModal t={selTrade} s={selStock} kind="personal" stocks={stocks} toggleFav={toggleFav} isFav={isFavRef}
          vix={vix} usdJpy={p.usdJpy} setSelectedStock={p.setSelectedStock} selectedStock={p.selectedStock}
          onRescan={p.onRescan} rescanLoading={p.rescanLoading} onAddTrade={p.onAddTrade}
          onRemoveTrade={function(kind,id){p.onRemoveTrade(kind,id);setSelId(null);}}
          onEditTrade={p.onEditTrade} onForceComplete={p.onForceComplete} onClose={function(){setSelId(null);}}
          personalTrades={p.personalTrades}/>,
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
    if(se<=b){alert("売り価格（利確）は買い価格より高い値を入力してください");return;}
    // 損切りは任意。空欄ならnull（＝損切りなし）として保存する。
    // 入力がある場合だけ「買い価格より低い正の数」かを確認する
    var sp=String(stopVal).trim()===""?null:parseFloat(stopVal);
    if(sp!=null&&(isNaN(sp)||sp<=0||sp>=b)){alert("損切り価格は買い価格より低い値を入力してください（空欄のままにすると損切りなしで保存します）");return;}
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
            <div><div style={{fontSize:10,color:"#fbbf24",marginBottom:2}}>損切り（任意）</div><input type="number" value={stopVal} onChange={function(e){setStopVal(e.target.value);}} style={editInp} placeholder="空欄可／買い価格より低い値"/></div>
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
          <StockCard s={p.s} toggleFav={p.toggleFav} isFav={p.isFav} vix={p.vix} usdJpy={p.usdJpy} setSelectedStock={p.setSelectedStock} selectedStock={p.selectedStock} onRescan={p.onRescan} rescanLoading={p.rescanLoading&&p.rescanLoading[t.ticker]} allStocks={p.stocks} onAddTrade={p.onAddTrade} personalTrades={p.personalTrades}/>
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
                    // 見出し・要約・影響の文章から業種を拾い、東証33業種コードを添えて表示
                    var secs=detectSectors((item.headline||"")+" "+(item.summary||"")+" "+(item.impact||""));
                    return(
                      <div key={i} style={{background:"#071428",border:"1px solid #1e3050",borderRadius:8,padding:"12px 14px"}}>
                        <div style={{fontSize:13,fontWeight:700,color:"#e0f0ff",marginBottom:6}}>{item.headline}</div>
                        <div style={{fontSize:12,color:"#b8cce0",lineHeight:1.7,marginBottom:8}}>{item.summary}</div>
                        {secs.length>0&&(
                          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>
                            {secs.map(function(sec){
                              return <span key={sec.code} title="東証33業種コード" style={{background:"#0ea5e918",border:"1px solid #0ea5e955",borderRadius:6,padding:"3px 8px",fontSize:11,color:"#7dd3fc",fontFamily:"monospace"}}>🏭 {sec.code} {sec.name}</span>;
                            })}
                          </div>
                        )}
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
        if(p.syncToServer)p.syncToServer(p.favs,p.favGroups,p.groupNames,p.personalTrades,id);
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
  var tradeCount=(function(){try{return loadTrades("personal").length;}catch(e){return 0;}})();
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
      <div style={{background:"#050e1c",border:"1px solid #0f2040",borderRadius:10,padding:"14px 16px",marginBottom:14}}>
        <div style={{fontSize:13,fontWeight:700,color:"#4a90c0",marginBottom:10}}>使い方</div>
        {[["1","🔐で合言葉＋PINを決めてログイン"],["2","別端末でも同じ合言葉＋PINでログイン"],["3","キャッシュを消してしまっても、同じ合言葉＋PINで元に戻せる"]].map(function(row){
          return(<div key={row[0]} style={{display:"flex",gap:10,marginBottom:8,alignItems:"flex-start"}}>
            <span style={{background:"#0ea5e9",color:"#fff",borderRadius:"50%",width:18,height:18,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,flexShrink:0}}>{row[0]}</span>
            <span style={{fontSize:13,color:"#b8cce0"}}>{row[1]}</span>
          </div>);
        })}
        <div style={{fontSize:11,color:"#2a6060",marginTop:8}}>※ お気に入り・トレードの登録・変更時に自動でサーバーに保存されます</div>
      </div>
      <div style={{background:"#2a1400",border:"1px solid #fb923c",borderRadius:10,padding:"14px 16px"}}>
        <div style={{fontSize:14,fontWeight:700,color:"#fbbf24",marginBottom:4}}>🗑️ 的中率データのリセット</div>
        <div style={{fontSize:12,color:"#c99a5a",marginBottom:10}}>スコア推移・AI予想の記録をすべて消去します。お気に入り・トレード記録・ログイン情報は消えません</div>
        <button onClick={function(){
          if(!confirm("スコア推移・AI予想の記録をすべて削除します。元に戻せません。よろしいですか？"))return;
          try{
            var removed=0;
            Object.keys(localStorage).forEach(function(k){
              if(k.indexOf("sh_")===0||k.indexOf("aipred_")===0){localStorage.removeItem(k);removed++;}
            });
            alert(removed+"件のデータを削除しました");
          }catch(e){alert("削除に失敗しました: "+e.message);}
        }} style={{width:"100%",background:"#3a1a00",border:"1px solid #fb923c",borderRadius:8,color:"#fbbf24",padding:"10px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>
          スコア推移・AI予想の記録を削除
        </button>
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

// シグナル的中率の中身（お気に入りタブ／トレードタブ両方から使う）
// tickers省略時はお気に入り銘柄で集計。指定時はそのtickerだけで集計（トレードタブ用・お気に入りとは分離）
function SignalAccuracyContent(p){
  var tickers=p&&p.tickers;
  var label=(p&&p.label)||"トレード";
  var data=tickers?calcSignalAccuracyMulti(tickers):calcFavSignalAccuracyMulti();
  var bandData=getUniverseBandStats();
  var emptyLabel=tickers?(label+"の登録銘柄"):"お気に入り銘柄";
  var horizons=[{k:"d1",h:"1日後"},{k:"d3",h:"3日後"},{k:"d5",h:"5日後"}];
  var chrAcc=calcChronosAccuracy(),chrV=chronosVerdict(chrAcc);
  var intradayAcc=calcIntradayAccuracy();
  var verdictAcc=calcVerdictAccuracy();
  var regime=getRegimeSignalStats();
  var phase=getTrendPhaseSignalStats();
  // トレンド局面別：初動・過熱の両方で5件以上あるシグナルを、差が大きい順に最大12件
  var phaseRows=(function(){
    var keys={};
    Object.keys(phase.early).forEach(function(k){keys[k]=1;});
    Object.keys(phase.hot).forEach(function(k){keys[k]=1;});
    return Object.keys(keys).map(function(k){
      var e=phase.early[k],h=phase.hot[k];
      return{signal:k,
        early:e&&e.t>=5?Math.round(signalQuality(e,k)*100):null,earlyT:e?e.t:0,
        hot:h&&h.t>=5?Math.round(signalQuality(h,k)*100):null,hotT:h?h.t:0};
    }).filter(function(r){return r.early!=null&&r.hot!=null;})
      .sort(function(a,b){return Math.abs(b.early-b.hot)-Math.abs(a.early-a.hot);})
      .slice(0,12);
  })();
  var tradeSig=calcTradeSignalStats();
  // 手法別成績（stocksが渡されていれば、手法未記録の過去トレードも現在のバッジで補完できる）
  var styleStats=calcTradeStyleStats(p&&p.stocks);
  var styleTotal=styleStats.reduce(function(a,r){return a+r.total;},0);
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
  // 的中率セル：的中率（上段）と、平均で何%動いたか（下段・小さく）
  // 勝率だけでは「小さく勝って大きく負ける」が見抜けないため平均騰落率を併記する
  function rateCell(r){
    return(
      <div style={{width:52,textAlign:"right"}}>
        <div style={{color:cellColor(r.winRate),fontWeight:700}}>{r.winRate!=null?r.winRate+"%":"-"}</div>
        {r.avgPct!=null?<div style={{color:r.avgPct>=0?"#22d3a0":"#f43f5e",fontSize:9}}>{(r.avgPct>=0?"+":"")+r.avgPct.toFixed(2)+"%"}</div>:null}
      </div>
    );
  }
  // 的中率の誤差の目安（95%信頼区間の半分・±ポイント）。件数が少ないほど大きくなる
  function marginOfError(r){
    if(!r.total||r.winRate==null) return null;
    var p=r.winRate/100;
    return Math.round(196*Math.sqrt(p*(1-p)/r.total));
  }
  // 件数セル：勝敗に使った件数（上段）と、横ばいで除外した引き分け件数（下段・小さく）
  function cntCell(r){
    var moe=marginOfError(r);
    return(
      <div style={{width:46,textAlign:"right"}}>
        <div style={{color:"#4a7090"}}>{r.total}</div>
        {r.draw>0?<div style={{color:"#2a6090",fontSize:9}}>{"引分"+r.draw}</div>:null}
        {moe!=null?<div style={{color:"#2a6090",fontSize:9}}>{"±"+moe+"pt"}</div>:null}
      </div>
    );
  }
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
        <div style={{fontSize:13,fontWeight:700,color:"#e0f0ff",marginBottom:4}}>🚦 総合判定 的中率</div>
        <div style={{fontSize:11,color:"#4a7090",marginBottom:8}}>総合判定が出た後、実際に価格が上がったかを集計（日本株のみ）。左＝当日の引けまで（デイトレ向け・終点はその日の最後のスキャンで、14時以降か引け後のみ／始点と1時間以上離れたペアのみ）／右＝翌営業日。値動きが±0.3%未満のほぼ横ばいは勝敗に数えず「引分」として件数だけ表示します</div>
        {verdictAcc.today.every(function(r){return r.total===0&&r.draw===0;})&&verdictAcc.next.every(function(r){return r.total===0&&r.draw===0;})?(
          <div style={{fontSize:13,color:"#4a7090",textAlign:"center",padding:"12px 0"}}>まだデータがありません。スキャンを重ねると溜まっていきます。</div>
        ):(
          <div>
            <div style={{display:"flex",fontSize:11,color:"#2a6090",padding:"4px 8px",borderBottom:"1px solid #0f2040"}}>
              <div style={{flex:1}}>判定</div>
              <div style={{width:52,textAlign:"right"}}>当日</div>
              <div style={{width:46,textAlign:"right"}}>件数</div>
              <div style={{width:52,textAlign:"right"}}>翌営業日</div>
              <div style={{width:46,textAlign:"right"}}>件数</div>
            </div>
            {verdictAcc.today.map(function(r,i){
              var nxr=verdictAcc.next[i];
              return(
                <div key={r.key} style={{display:"flex",alignItems:"center",fontSize:13,padding:"6px 8px",borderBottom:"1px solid #0a1830"}}>
                  <div style={{flex:1,color:(BADGE[r.key]||{}).text,fontWeight:700}}>{r.label}</div>
                  {rateCell(r)}
                  {cntCell(r)}
                  {rateCell(nxr)}
                  {cntCell(nxr)}
                </div>
              );
            })}
            <div style={{fontSize:11,color:"#2a6090",marginTop:8}}>※小さい数字は上から「平均騰落率」「引分（±0.3%未満で除外）」「誤差の目安」。<br/>※判定どうしの差が誤差の目安（±◯pt）より小さいうちは、まだ優劣を判断できません<br/>※勝率が低くても平均騰落率がプラスなら「たまに大きく勝つ」型で、期待値はプラスです</div>
          </div>
        )}
      </div>
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
        <div style={{fontSize:13,fontWeight:700,color:"#e0f0ff",marginBottom:4}}>🌙 Chronos予測 的中率（5営業日後）</div>
        <div style={{fontSize:11,color:"#4a7090",marginBottom:8}}>毎晩自動生成される予測が、5営業日後に実際に当たったかを集計（お気に入り銘柄が対象）。予測幅±0.3%未満は「横ばい」とみなし方向判定から除きます</div>
        {chrAcc.baseTotal===0?(
          <div style={{fontSize:13,color:"#4a7090",textAlign:"center",padding:"12px 0"}}>まだ答え合わせ済みのデータがありません。お気に入り銘柄を毎日スキャンし、5営業日経つと溜まっていきます。</div>
        ):(
          <div>
            <div style={{display:"flex",fontSize:11,color:"#2a6090",padding:"4px 8px",borderBottom:"1px solid #0f2040"}}>
              <div style={{flex:1}}>項目</div>
              <div style={{width:52,textAlign:"right"}}>的中率</div>
              <div style={{width:40,textAlign:"right"}}>件数</div>
            </div>
            <div style={{display:"flex",alignItems:"center",fontSize:13,padding:"6px 8px",borderBottom:"1px solid #0a1830",opacity:chrAcc.total>=5?1:0.5}}>
              <div style={{flex:1,color:"#b8cce0",fontFamily:"monospace"}}>Chronos 方向的中率</div>
              <div style={{width:52,textAlign:"right",color:cellColor(chrAcc.winRate),fontWeight:700}}>{chrAcc.winRate!=null?chrAcc.winRate+"%":"-"}</div>
              <div style={{width:40,textAlign:"right",color:"#4a7090"}}>{chrAcc.total}</div>
            </div>
            <div style={{display:"flex",alignItems:"center",fontSize:13,padding:"6px 8px",borderBottom:"1px solid #0a1830"}}>
              <div style={{flex:1,color:"#6a8aa8",fontFamily:"monospace"}}>基準線：常に「上昇」</div>
              <div style={{width:52,textAlign:"right",color:"#6a8aa8",fontWeight:700}}>{chrAcc.baseRate!=null?chrAcc.baseRate+"%":"-"}</div>
              <div style={{width:40,textAlign:"right",color:"#4a7090"}}>{chrAcc.baseTotal}</div>
            </div>
            <div style={{fontSize:11,color:"#2a6090",marginTop:10,marginBottom:4}}>予測幅別（予測の強さごと）</div>
            {chrAcc.bands.map(function(b,i){
              return(
                <div key={i} style={{display:"flex",alignItems:"center",fontSize:13,padding:"6px 8px",borderBottom:"1px solid #0a1830",opacity:b.total>=5?1:0.5}}>
                  <div style={{flex:1,color:"#b8cce0",fontFamily:"monospace"}}>{b.label}</div>
                  <div style={{width:52,textAlign:"right",color:cellColor(b.winRate),fontWeight:700}}>{b.winRate!=null?b.winRate+"%":"-"}</div>
                  <div style={{width:40,textAlign:"right",color:"#4a7090"}}>{b.total}</div>
                </div>
              );
            })}
            <div style={{fontSize:11,color:"#2a6090",marginTop:10,marginBottom:4}}>値幅の誤差（中央値・小さいほど良い）</div>
            <div style={{display:"flex",alignItems:"center",fontSize:13,padding:"6px 8px"}}>
              <div style={{flex:1,color:"#b8cce0",fontFamily:"monospace"}}>Chronos予測</div>
              <div style={{width:92,textAlign:"right",color:(chrAcc.maeC!=null&&chrAcc.maeFlat!=null&&chrAcc.maeC<chrAcc.maeFlat)?"#22d3a0":"#f43f5e",fontWeight:700}}>{chrAcc.maeC!=null?chrAcc.maeC+"%":"-"}</div>
            </div>
            <div style={{display:"flex",alignItems:"center",fontSize:13,padding:"6px 8px"}}>
              <div style={{flex:1,color:"#6a8aa8",fontFamily:"monospace"}}>基準線：横ばい予測</div>
              <div style={{width:92,textAlign:"right",color:"#6a8aa8",fontWeight:700}}>{chrAcc.maeFlat!=null?chrAcc.maeFlat+"%":"-"}</div>
            </div>
            <div style={{marginTop:10,padding:"8px 10px",background:chrV.col+"14",border:"1px solid "+chrV.col+"44",borderRadius:6,fontSize:12,color:chrV.col,lineHeight:1.6}}>{chrV.msg}</div>
          </div>
        )}
      </div>
      <div style={{marginTop:16,paddingTop:12,borderTop:"1px solid #0f2040"}}>
        <div style={{fontSize:13,fontWeight:700,color:"#e0f0ff",marginBottom:4}}>⏰ 時間帯別 的中率（当日終値との比較）</div>
        <div style={{fontSize:11,color:"#4a7090",marginBottom:8}}>その時間帯にスコア60点以上だった銘柄が、その日の引け（後場後半か引け後の最後のスキャン）までに上がっていたかを集計。始点と1時間以上離れたペアのみ対象です。翌営業日ではなく“当日中”の答え合わせです</div>
        {intradayAcc.every(function(s){return s.total===0;})?(
          <div style={{fontSize:13,color:"#4a7090",textAlign:"center",padding:"12px 0"}}>まだデータがありません。1日に複数回スキャンすると溜まっていきます</div>
        ):(
          intradayAcc.map(function(s,i){
            var reliable=s.total>=5;
            return(
              <div key={i} style={{display:"flex",alignItems:"center",fontSize:13,padding:"6px 8px",borderBottom:i<intradayAcc.length-1?"1px solid #0a1830":"none",opacity:reliable?1:0.5}}>
                <div style={{flex:1,color:"#b8cce0",fontFamily:"monospace"}}>{s.session}</div>
                <div style={{width:52,textAlign:"right",color:cellColor(s.winRate),fontWeight:700}}>{s.winRate!=null?s.winRate+"%":"-"}</div>
                {cntCell(s)}
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
        <div style={{fontSize:13,fontWeight:700,color:"#e0f0ff",marginBottom:4}}>🚀 トレンド局面別 シグナル的中率</div>
        <div style={{fontSize:11,color:"#4a7090",marginBottom:8}}>直近3回分の対TOPIX相対の合計で、まだ上げ始め（初動）か、すでに市場を大きく上回った後（過熱）かに分けて比較します（差が大きい順）</div>
        {phaseRows.length===0?(
          <div style={{fontSize:12,color:"#4a7090",textAlign:"center",padding:"10px 0"}}>📥 データ蓄積中。対TOPIX相対の記録は最近始まったばかりのため、スキャンを重ねると自動で表示が始まります</div>
        ):(
          <div>
            <div style={{display:"flex",fontSize:11,color:"#2a6090",padding:"4px 8px",borderBottom:"1px solid #0f2040"}}>
              <div style={{flex:1,minWidth:0}}>シグナル</div>
              <div style={{width:64,flexShrink:0,textAlign:"right"}}>初動</div>
              <div style={{width:64,flexShrink:0,textAlign:"right"}}>過熱</div>
            </div>
            {phaseRows.map(function(r,i){
              return(
                <div key={i} style={{display:"flex",alignItems:"center",fontSize:13,padding:"6px 8px",borderBottom:"1px solid #0a1830"}}>
                  <div style={{flex:1,minWidth:0,color:"#b8cce0",fontFamily:"monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{formatSigKeyLabel(r.signal)}</div>
                  <div title={r.earlyT+"件"} style={{width:64,flexShrink:0,textAlign:"right",color:cellColor(r.early),fontWeight:700}}>{r.early+"%"}</div>
                  <div title={r.hotT+"件"} style={{width:64,flexShrink:0,textAlign:"right",color:cellColor(r.hot),fontWeight:700}}>{r.hot+"%"}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div style={{marginTop:16,paddingTop:12,borderTop:"1px solid #0f2040"}}>
        <div style={{fontSize:13,fontWeight:700,color:"#e0f0ff",marginBottom:4}}>🎯 手法別 成績（銘柄バッジで分類）</div>
        <div style={{fontSize:11,color:"#4a7090",marginBottom:8}}>完了したトレードを、銘柄カードの⚡スキャル／📈デイトレ／🌊スイングのバッジごとに集計。どの値動きの銘柄で勝てているかが見えてきます</div>
        {styleTotal===0?(
          <div style={{fontSize:12,color:"#4a7090",textAlign:"center",padding:"10px 0"}}>📥 データ蓄積中。トレードが完了すると手法ごとの成績が表示されます</div>
        ):(
          <div>
            <div style={{display:"flex",fontSize:10,color:"#2a6090",padding:"4px 6px",borderBottom:"1px solid #0f2040"}}>
              <div style={{flex:1,minWidth:0}}>手法</div>
              <div style={{width:30,flexShrink:0,textAlign:"right"}}>件数</div>
              <div style={{width:40,flexShrink:0,textAlign:"right"}}>勝率</div>
              <div style={{width:48,flexShrink:0,textAlign:"right"}}>平均</div>
              <div style={{width:62,flexShrink:0,textAlign:"right"}}>合計損益</div>
              <div style={{width:46,flexShrink:0,textAlign:"right"}}>平均R</div>
            </div>
            {styleStats.map(function(r,i){
              return(
                <div key={i} style={{display:"flex",alignItems:"center",fontSize:12,padding:"6px 6px",borderBottom:"1px solid #0a1830"}}>
                  <div style={{flex:1,minWidth:0,color:r.color,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.label}</div>
                  <div style={{width:30,flexShrink:0,textAlign:"right",color:"#4a7090"}}>{r.total}</div>
                  <div style={{width:40,flexShrink:0,textAlign:"right",color:cellColor(r.winRate),fontWeight:700}}>{r.winRate!=null?r.winRate+"%":"-"}</div>
                  <div style={{width:48,flexShrink:0,textAlign:"right",color:r.avgPct==null?"#4a7090":r.avgPct>=0?"#22d3a0":"#f43f5e",fontWeight:700}}>{r.avgPct!=null?(r.avgPct>=0?"+":"")+r.avgPct.toFixed(1)+"%":"-"}</div>
                  <div style={{width:62,flexShrink:0,textAlign:"right",color:r.total===0?"#4a7090":r.totalPnl>=0?"#22d3a0":"#f43f5e",fontWeight:700}}>{r.total?fmtPnl(r.totalPnl,true):"-"}</div>
                  <div style={{width:46,flexShrink:0,textAlign:"right",color:r.r.n?(r.r.avgR>=0?"#22d3a0":"#f43f5e"):"#4a7090"}}>{r.r.n?(r.r.avgR>=0?"+":"")+r.r.avgR.toFixed(2)+"R":"-"}</div>
                </div>
              );
            })}
            <div style={{fontSize:10,color:"#2a6090",marginTop:6}}>※手法は登録時のバッジを記録します。それ以前のトレードは銘柄の現在のバッジで分類しています。平均Rは損切りを設定したトレードのみが対象です</div>
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
  var isMobile=useIsMobile();
  return(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:500,display:"flex",alignItems:"center",justifyContent:isMobile?"center":"flex-end",padding:16,paddingRight:isMobile?16:"56vw"}}
      onTouchEnd={function(e){if(e.target===e.currentTarget){e.preventDefault();onClose();}}}
      onClick={function(e){if(e.target===e.currentTarget)onClose();}}>
      <div style={{background:"#071428",border:"1px solid #1e4070",borderRadius:14,padding:20,width:"100%",maxWidth:520,maxHeight:"85vh",overflowY:"scroll",WebkitOverflowScrolling:"touch",boxShadow:"0 8px 30px rgba(0,0,0,0.6)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <div style={{fontSize:16,fontWeight:800,color:"#e0f0ff"}}>📊 シグナル的中率</div>
          <button onClick={onClose} style={{background:"transparent",border:"1px solid #2a4060",borderRadius:8,color:"#4a7090",padding:"4px 12px",fontSize:14,cursor:"pointer",fontFamily:"monospace"}}>✕</button>
        </div>
        <SignalAccuracyContent tickers={p.tickers} label={p.label} stocks={p.stocks}/>
      </div>
    </div>
  );
}

function GuidePanel(){
  var openS=useState("fav");var openKey=openS[0],setOpenKey=openS[1];
  var CATS=[
    {key:"fav",icon:"⭐",label:"メイン（お気に入り／全銘柄）",sections:[
      {title:"📋 一覧の使い方",items:[
        "銘柄カードをタップ → 詳細シグナル表示",
        "上部バーは横スクロールします（件数／銘柄検索／グループ／🌱初動順／🏆スコア順／🏭業種まとめ登録／📊的中率／再スキャン。PC版では再スキャンが右端に並びます）",
        "「📋全銘柄」＝今回スキャンした全銘柄を表示。「⭐全体」＝お気に入り登録銘柄をすべて表示",
        "★/☆ボタンでお気に入りの登録・解除",
        "グループ1〜4に分類可能（グループ名は選択中に表示される✎アイコンで編集）",
        "検索欄にティッカーコード（例：AAPL、7203）か会社名（例：トヨタ）を入力すると候補が並び、タップでそのまま追加登録できる（隣のプルダウンで登録先グループも指定可）",
        "並び順：既定は「📋全銘柄＝スキャン順／⭐お気に入り＝登録順（新しい順）」。🌱初動順・🏆スコア順を押すと切り替わり、同じボタンをもう一度押すと既定に戻る",
        "「🏭業種まとめ登録」ボタン：業種を1つ選ぶと、その業種の出来高上位50銘柄を選んだグループへ一括登録（取得できた件数が50未満の場合はその分だけ登録）。登録した銘柄の株価は自動で取得され、そのままお気に入り一覧に並ぶ（取得中は「銘柄データを取得中... 12/50」と表示）",
        "同じ画面の下部にある「🗑 一括解除」で、保存先（全体・グループ1〜4）ごとにまとめてお気に入りから外せる",
        "「📊的中率」ボタンでお気に入り銘柄のシグナル的中率を確認"
      ]},
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
      {title:"🔥🧊 対TOPIXバッジの見方（日本株限定）",items:[
        "「個別銘柄の当日騰落率 − TOPIXの当日騰落率」の差分を表示する補助シグナル。市場全体の値動きを差し引いた「銘柄固有の強さ・弱さ」を見るためのもの",
        "🔥（緑）＝TOPIXより強い、🧊（青緑〜赤）＝TOPIXより弱い。差が±0.5%未満の場合は誤差レベルとみなし非表示",
        "比較対象は東証株価指数（TOPIX）。市場全体に対して強いか弱いかを見る。スコアにも反映され、差が大きいほど最大±6点まで加減算される",
        "内部の仕組み：TOPIXの日足データから前日比%を算出し、全銘柄共通の値として1時間キャッシュ",
        "前日比ベースの参考値であり、将来の値動きを保証するものではない"
      ]},
      {title:"☀️🌙 日中/夜間バッジの見方（日本株限定）",items:[
        "過去1年の値動きを「日中分（始値→終値）」と「夜間分（前日終値→翌朝の始値）」に分解し、日中分の累積を表示する補助バッジ。詳細を開いて日足を取得すると表示されます（長押しで夜間分も確認可）",
        "☀️（緑）＝日中分の累積がプラス。「朝買って引けまでに売る」で値幅が取れてきた日中型の銘柄。持ち越さないデイトレと相性が良い",
        "🌙（灰）＝日中分の累積がマイナス。上昇のほとんどが夜間（閉場中の窓）で発生しており、日中に買っても取り分がなかった夜間型の銘柄",
        "使い方の基本：🌙は「夜に買え」というサインではなく「デイトレの対象から外す」サイン。スコアが高くても🌙なら見送る、という消去法で使うのが安全",
        "🌙の値幅を取るには引け前に買って翌朝売る持ち越しが必要になるが、夜間に悪材料が出ると逆指値が効かず大きな損失になり得るため、このアプリでは推奨していない",
        "検証の背景：登録銘柄50・のべ23,105日分の検証で、上昇銘柄でも寄り→引けの平均はマイナス（上昇の大半は夜間に発生）と判明。日中に上がる癖のある銘柄を選ぶこと自体が優位性になる、という結果に基づく機能",
        "スキャンすると、一覧が表示された直後から裏側で日足を1銘柄ずつ取得し、☀️バッジが自動で埋まっていく（ヘッダーに「☀️日中型を取得中... 3/50」と進捗を表示）。アプリ内でタブを移動しても止まらず、ブラウザを裏に回して止まった場合も画面に戻った時点で続きから再開する",
        "数字は過去1年の癖であり将来の保証ではない。銘柄の性質が変われば数字も変わる"
      ]},
      {title:"🔘 銘柄詳細のアイコン行",items:[
        "🔗：Yahoo!ファイナンスの銘柄ページを新しいタブで開く",
        "📱：銘柄コードをコピーしてiSPEEDアプリを開く（日本株向け）",
        "⚡：判定プロンプトをClaudeアプリに直接渡して開く（同時にクリップボードにもコピーされます。回答はチャット側に表示され、アプリのエントリー提案・的中率には記録されません）",
        "🔄：この銘柄だけを最新データで再スキャン",
        "💹：損益シミュレーターをポップアップ表示（買値・株数から利確/損切りラインの損益を試算）",
        "🎯：この銘柄をトレード登録（買い価格・売り価格＝利確ライン・株数を入力）"
      ]},
    ]},
    {key:"trade",icon:"🎯",label:"トレード",sections:[
      {title:null,items:[
        "銘柄カードの🎯ボタンからトレード登録（買い価格・売り価格＝利確ライン・株数を入力。損切り価格は登録時のみ必須。後から✏️編集で空欄にすると損切りなしにできます／その場合はR集計の対象外）",
        "価格が指定値に到達すると自動で「待機中→進行中→完了」に遷移（判定は🔄価格更新ボタンで反映）",
        "完了したトレードの合計損益・勝率を集計表示",
        "「📊的中率」で登録した銘柄のシグナル的中率を確認",
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
        "記事の中に業種（セクター）が出てきた場合は、🏭バッジで東証33業種コードを一緒に表示（例：🏭 3650 電気機器）。そのコードを「🏭業種まとめ登録」で使えば、該当業種の出来高上位50銘柄をまとめてお気に入りに入れられる",
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

// ══════════════════════════════════════════════════════════════════════════
// 🌅 寄り付きギャップ予想
// 前日終値に対して翌朝の始値が上か下か・何%かを予想し、実際の始値と照合して
// 的中率を貯める仕組み。既存の0〜100点スコア（calcScore内のsc）とsignals配列には
// 一切関与しない完全に独立したスコアとして持つ（sh_*の的中率データとの連続性を
// 壊さないため）。対象はお気に入り登録銘柄（fav_tickers）の日本株のみ。
//
// 材料は3つ:
//   (a) 地合い（api/premarket.js）× その銘柄のTOPIXに対するベータ
//   (b) 過去のギャップ実績分布（ばらつきが大きい銘柄ほど確信度を下げる）
//   (c) 前日大引けの強さ（高値引け/安値引けで予想ギャップを加減算）
//
// 日足の始値・終値は立花証券API経由では取得できない（/ranking-dataは当日の
// 現在値・前日終値のみで履歴も始値も無い）ため、既存のYahoo日足（api/daily.js →
// fetchDaily）をそのまま使う。新規のサーバーレス関数は api/premarket.js の1本のみ。
// ══════════════════════════════════════════════════════════════════════════

// ── 調整可能な定数（重み・しきい値・日数はすべてここにまとめる）─────────────
var PM_API="https://daytrade-simulator.vercel.app/api/premarket";
var PM_BENCH_TICKER="1306.T";        // ベータの基準（TOPIX連動ETF。指数そのものより日足が安定して取れる）
var PM_BETA_DAYS=60;                 // ベータ算出に使う営業日数
var PM_GAP_DAYS=60;                  // ギャップ実績分布の集計日数
var PM_MIN_SAMPLES=20;               // ベータ・分布の計算に必要な最低サンプル数
var PM_BETA_MIN=0.2,PM_BETA_MAX=2.5; // ベータの丸め範囲（外れ値で予想が暴れないように）
var PM_CLOSE_STRONG=0.8;             // 前日終値が日中レンジのこの位置以上なら「高値引け」
var PM_CLOSE_WEAK=0.2;               // この位置以下なら「安値引け」
var PM_CLOSE_ADJ=0.15;               // 高値引け/安値引けで予想ギャップに加減算する%
var PM_CONF_BASE=70;                 // 確信度の基準値(%)
var PM_CONF_SD_PENALTY=18;           // ギャップの標準偏差1%につき確信度から引く点
var PM_CONF_DIR=12;                  // 予想方向が過去の偏りと一致/不一致の時の増減（最大点）
var PM_CONF_R2_BASE=0.3;             // ベータの当てはまり(r²)がこの値なら確信度の増減なし
var PM_CONF_R2_GAIN=20;              // r²がPM_CONF_R2_BASEから1離れるごとの増減点
var PM_CONF_MIN=5,PM_CONF_MAX=95;    // 確信度の下限・上限(%)
var PM_DIR_DEADBAND=0.05;            // 予想ギャップがこの幅未満なら方向判定の対象外にする(%)
var PM_HIST_MAX=90;                  // pm_<ticker> に残す件数
                                     // ※「件数」の上限なので、srcが2種類（beta/quote）になると
                                     // 　保持できる日数は実質半分（45営業日）になる。
                                     // 　Phase 2でquoteを併走させる時点で引き上げを検討すること
var PM_STATS_TTL=15*60*1000;         // 的中率集計のキャッシュ(15分)
var PM_OPEN_MIN=9*60;                // 9:00 JST（これ以降は「答え合わせ」表示に自動で切り替える）
var PM_BIAS_TTL=3*60*1000;           // 地合いの端末側キャッシュ(3分・サーバー側と同じ長さ)
var PM_TODAY_TTL=5*60*1000;          // 答え合わせ用の当日日足キャッシュ(5分)
var PM_FETCH_CONCURRENCY=4;          // 日足まとめ取得の同時実行数（Yahooに負担をかけない）
// 予想の出どころ。今はベータ推定のみ。Phase 2で寄り前気配ベースに切り替えたら "quote" を記録する
var PM_SRC_BETA="beta";
var PM_SRC_LABELS={beta:"ベータ推定",quote:"寄り前気配"};
var PM_SRC_PRIORITY=["quote","beta"];// 同じ日に複数srcの予想がある時、画面に出す優先順

// ── 時刻・日付まわり ──────────────────────────────────────────────────
function pmSign(v){return v>0?"+":"";}                       // 表示用の符号（マイナスはtoFixedが付ける）
function pmIsJP(t){return /\.T$/.test(String(t||""));}       // 日本株のみ対象（米国株は対象外）
function pmNowJstMin(){
  var jst=new Date(Date.now()+9*3600000);
  return jst.getUTCHours()*60+jst.getUTCMinutes();
}
function pmIsAfterOpen(){return pmNowJstMin()>=PM_OPEN_MIN;} // 9:00以降か
// 予想の対象日。9:00より前ならその日、9:00以降なら翌営業日ぶんの予想になる。
// （土日は次の月曜へ送る。祝日は判定できないので、その日の記録は答え合わせされずに残る）
function pmTargetDate(){
  var ms=Date.now()+9*3600000;
  if(pmIsAfterOpen())ms+=24*3600000;
  var d=new Date(ms);
  while(d.getUTCDay()===0||d.getUTCDay()===6)d=new Date(d.getTime()+24*3600000);
  return d.toISOString().slice(0,10);
}

// ── (a) ベータ算出 ────────────────────────────────────────────────────
// 日足から「日付 → 前日比%」の対応表を作る
function pmDailyReturns(d){
  var map={};
  if(!d||!d.closes||!d.dates)return map;
  for(var i=1;i<d.closes.length;i++){
    var pc=d.closes[i-1],c=d.closes[i];
    if(!(pc>0&&c>0))continue;
    map[d.dates[i]]=(c-pc)/pc*100;
  }
  return map;
}
// 過去PM_BETA_DAYS営業日ぶんの日次騰落率で、TOPIXに対する感応度を単回帰で求める。
// 傾き＝Σ(x-x̄)(y-ȳ) / Σ(x-x̄)²、当てはまりの良さr²＝相関係数の2乗。
function pmCalcBeta(stockDaily,benchDaily){
  var sm=pmDailyReturns(stockDaily),bm=pmDailyReturns(benchDaily);
  var days=Object.keys(bm).sort().slice(-PM_BETA_DAYS);
  var xs=[],ys=[],i;
  for(i=0;i<days.length;i++){
    var y=sm[days[i]];
    if(y==null)continue;
    xs.push(bm[days[i]]);ys.push(y);
  }
  var n=xs.length;
  if(n<PM_MIN_SAMPLES)return null;
  var mx=0,my=0;
  for(i=0;i<n;i++){mx+=xs[i];my+=ys[i];}
  mx/=n;my/=n;
  var sxy=0,sxx=0,syy=0;
  for(i=0;i<n;i++){var dx=xs[i]-mx,dy=ys[i]-my;sxy+=dx*dy;sxx+=dx*dx;syy+=dy*dy;}
  if(!(sxx>0)||!(syy>0))return null;
  var raw=sxy/sxx;
  return {
    beta:Math.max(PM_BETA_MIN,Math.min(PM_BETA_MAX,raw)),
    rawBeta:raw,
    r2:(sxy*sxy)/(sxx*syy),
    n:n
  };
}

// ── (b) ギャップ実績分布 ──────────────────────────────────────────────
// 過去PM_GAP_DAYS営業日の (始値 ÷ 前日終値 - 1) を集計し、平均・標準偏差・上ギャップ率を出す
function pmGapStats(d){
  if(!d||!d.closes||!d.opens)return null;
  var arr=[],i;
  for(i=1;i<d.closes.length;i++){
    var o=d.opens[i],pc=d.closes[i-1];
    if(!(o>0&&pc>0))continue;
    arr.push((o/pc-1)*100);
  }
  arr=arr.slice(-PM_GAP_DAYS);
  var n=arr.length;
  if(n<PM_MIN_SAMPLES)return null;
  var mean=0,up=0;
  for(i=0;i<n;i++){mean+=arr[i];if(arr[i]>0)up++;}
  mean/=n;
  var v=0;
  for(i=0;i<n;i++)v+=(arr[i]-mean)*(arr[i]-mean);
  return {mean:mean,sd:Math.sqrt(v/n),upRate:up/n,n:n};
}

// ── (c) 前日大引けの強さ ──────────────────────────────────────────────
// 予想対象日より前の最後の日足（＝前営業日）の位置を返す
function pmPrevBarIndex(d,targetDate){
  if(!d||!d.dates)return -1;
  for(var i=d.dates.length-1;i>=0;i--){if(d.dates[i]<targetDate)return i;}
  return -1;
}
// 前日終値が前日の日中レンジのどの位置にあったか（0=安値引け 〜 1=高値引け）
function pmCloseStrength(d,idx){
  if(!d||idx<0||!d.highs||!d.lows)return null;
  var h=d.highs[idx],l=d.lows[idx],c=d.closes[idx];
  if(!(h>l))return null;
  return (c-l)/(h-l);
}

// ── 最終的な予想（(a)(b)(c)をまとめる）───────────────────────────────
// 戻り値: { expectedGapPct, confidence, reasons[], ... }
function pmPredictGap(ticker,daily,benchDaily,marketBias,targetDate){
  if(!daily||marketBias==null)return null;
  var beta=pmCalcBeta(daily,benchDaily);
  var gap=pmGapStats(daily);
  if(!beta||!gap)return null;

  var idx=pmPrevBarIndex(daily,targetDate);
  var pos=pmCloseStrength(daily,idx);
  var reasons=[];

  // (a) 予想ギャップ ＝ 地合い（marketBias）× ベータ
  var exp=marketBias*beta.beta;
  reasons.push({label:"ベータ",val:"×"+beta.beta.toFixed(2)+"（地合い"+pmSign(marketBias)+marketBias.toFixed(2)+"%）",state:exp>0?1:(exp<0?-1:0)});

  // (c) 前日大引けの強さで加減算
  if(pos!=null){
    if(pos>=PM_CLOSE_STRONG){
      exp+=PM_CLOSE_ADJ;
      reasons.push({label:"高値引け",val:"レンジ上位"+Math.round(pos*100)+"%で引け",state:1});
    }else if(pos<=PM_CLOSE_WEAK){
      exp-=PM_CLOSE_ADJ;
      reasons.push({label:"安値引け",val:"レンジ下位"+Math.round(pos*100)+"%で引け",state:-1});
    }else{
      reasons.push({label:"引け位置",val:"レンジ中位"+Math.round(pos*100)+"%",state:0});
    }
  }

  // (b) ギャップ実績分布から確信度を出す。ばらつき（標準偏差）が大きいほど下げる
  var conf=PM_CONF_BASE-gap.sd*PM_CONF_SD_PENALTY;
  // 過去の上下の偏り（上ギャップ率が0.5からどれだけ離れているか）と予想方向が
  // 一致していれば上げ、逆行していれば下げる
  var dirStrength=Math.abs(gap.upRate-0.5)*2;
  if(Math.abs(exp)>=PM_DIR_DEADBAND)conf+=((exp>0)===(gap.upRate>=0.5)?1:-1)*PM_CONF_DIR*dirStrength;
  // 地合いとの連動性が弱い銘柄（r²が低い）は「地合い×ベータ」自体が当てにならない
  conf+=(beta.r2-PM_CONF_R2_BASE)*PM_CONF_R2_GAIN;
  // 日足のサンプルが規定日数に満たない場合は比例して割り引く
  conf*=Math.min(1,gap.n/PM_GAP_DAYS);
  conf=Math.max(PM_CONF_MIN,Math.min(PM_CONF_MAX,Math.round(conf)));

  reasons.push({label:"ギャップ分布",val:"平均"+pmSign(gap.mean)+gap.mean.toFixed(2)+"% / 標準偏差"+gap.sd.toFixed(2)+"% / 上ギャップ"+Math.round(gap.upRate*100)+"%",state:0});
  reasons.push({label:"連動性",val:"r²"+beta.r2.toFixed(2)+"（"+beta.n+"日）",state:beta.r2>=PM_CONF_R2_BASE?1:0});
  if(gap.n<PM_GAP_DAYS)reasons.push({label:"サンプル",val:"日足"+gap.n+"日分のみ（参考値）",state:0});

  return {
    ticker:ticker,
    expectedGapPct:Math.round(exp*100)/100,
    confidence:conf,
    reasons:reasons,
    beta:beta.beta,
    r2:beta.r2,
    gap:gap,
    closePos:pos,
    prevClose:idx>=0?daily.closes[idx]:null,
    prevDate:idx>=0?daily.dates[idx]:null
  };
}

// ── 答え合わせの記録（localStorage: pm_<ticker>）───────────────────────
// 1件の形式: { d:"YYYY-MM-DD", exp:予想ギャップ%, conf:確信度, act:実際のギャップ%, prevClose:前日終値, src:"beta" }
// srcは予想の出どころ。同じ日・同じ銘柄でもsrcが違えば別レコードとして並存させ、
// 同じ実績(act)に対して手法どうしを同条件で比較できるようにしている。
var PM_STATS_CACHE=null,PM_STATS_TS=0;
function pmHistKey(t){return "pm_"+t;}
function pmLoadHist(t){
  try{
    var list=JSON.parse(localStorage.getItem(pmHistKey(t))||"[]");
    // src導入前に貯めた記録はベータ推定なので、読み込み時に補う（次の保存で書き戻る）
    for(var i=0;i<list.length;i++){if(list[i]&&list[i].src==null)list[i].src=PM_SRC_BETA;}
    return list;
  }catch(e){return[];}
}
function pmSaveHist(t,list){
  try{
    localStorage.setItem(pmHistKey(t),JSON.stringify(list.slice(-PM_HIST_MAX))); // 直近90件だけ残す
    PM_STATS_CACHE=null;                                                          // 集計キャッシュを捨てる
  }catch(e){}
}
// 日付とsrcの両方が一致する1件を探す（同じ日でもsrcが違えば別レコード）
function pmFindRec(list,dateStr,src){
  for(var i=0;i<list.length;i++){if(list[i].d===dateStr&&list[i].src===src)return list[i];}
  return null;
}
// 同じ日に複数srcの予想がある時、PM_SRC_PRIORITYの順で1件だけ選ぶ（画面の重複を防ぐため）
function pmPickRec(list,dateStr){
  for(var i=0;i<PM_SRC_PRIORITY.length;i++){
    var hit=pmFindRec(list,dateStr,PM_SRC_PRIORITY[i]);
    if(hit)return hit;
  }
  // 未知のsrcしか無い場合はその日の先頭を返す
  for(var k=0;k<list.length;k++){if(list[k].d===dateStr)return list[k];}
  return null;
}
// 予想時点で exp/conf を記録（同じ日・同じsrcで何度開いても1件にまとまる）
function pmRecordPrediction(ticker,dateStr,exp,conf,prevClose,src){
  src=src||PM_SRC_BETA;
  var list=pmLoadHist(ticker),rec=pmFindRec(list,dateStr,src);
  if(rec){
    if(rec.act!=null)return;   // 答え合わせ済みの記録は上書きしない
    rec.exp=exp;rec.conf=conf;rec.prevClose=prevClose;
  }else{
    list.push({d:dateStr,exp:exp,conf:conf,act:null,prevClose:prevClose,src:src});
    // 日付の昇順。同じ日はsrc名で並べて順序を固定する
    list.sort(function(a,b){
      if(a.d!==b.d)return a.d<b.d?-1:1;
      var as=a.src||"",bs=b.src||"";
      return as<bs?-1:(as>bs?1:0);
    });
  }
  pmSaveHist(ticker,list);
}
// 9:00以降に始値が取れた時点で act を埋める（予想を記録していない日は対象外）。
// 実績は手法によらず同じ値なので、その日の全srcのレコードに同じ値を入れる
function pmRecordActual(ticker,dateStr,actPct){
  var list=pmLoadHist(ticker),hit=false;
  for(var i=0;i<list.length;i++){
    if(list[i].d===dateStr&&list[i].act==null){list[i].act=actPct;hit=true;}
  }
  if(!hit)return false;
  pmSaveHist(ticker,list);
  return true;
}

// ── 的中率の集計（calcSignalAccuracy系と同じ作り）─────────────────────
// 全体・銘柄別・src別で同じ積み方をするので、accumulateSignalStats と同じ発想で小さくまとめる
function pmAccNew(){return {total:0,dirTotal:0,dirHit:0,sumErr:0,sumConf:0};}
function pmAccAdd(a,r){
  a.total++;a.sumErr+=Math.abs(r.exp-r.act);a.sumConf+=r.conf||0;
  // 予想がほぼゼロの日は「どちらに賭けたか」が無いので方向判定から外す
  if(Math.abs(r.exp)>=PM_DIR_DEADBAND){a.dirTotal++;if((r.exp>0)===(r.act>0))a.dirHit++;}
}
function pmAccDone(a){
  return {
    total:a.total,
    dirTotal:a.dirTotal,
    dirRate:a.dirTotal>0?Math.round(a.dirHit/a.dirTotal*100):null,
    avgErr:a.total>0?Math.round(a.sumErr/a.total*100)/100:null,
    avgConf:a.total>0?Math.round(a.sumConf/a.total):null
  };
}
// 戻り値: {total, dirRate（方向一致率%）, avgErr（平均誤差%）, byTicker[], bySrc[]}
// srcFilterを渡すとそのsrcの記録だけを集計する（省略時は全src）。
// ※ total は予想の「延べ件数」。同じ日・同じ銘柄でもsrcが違えば別に数えるので、
// 　日数×銘柄数とは一致しない。bySrcの件数を全部足すと total になる。
function calcPremarketAccuracy(tickers,srcFilter){
  var all=pmAccNew(),srcAcc={},byTicker=[];
  (tickers||[]).forEach(function(ticker){
    var hist=pmLoadHist(ticker).filter(function(r){
      if(!r||r.act==null||r.exp==null)return false;
      return srcFilter?r.src===srcFilter:true;
    });
    if(!hist.length)return;
    var one=pmAccNew();
    hist.forEach(function(r){
      pmAccAdd(all,r);pmAccAdd(one,r);
      var s=r.src||PM_SRC_BETA;
      if(!srcAcc[s])srcAcc[s]=pmAccNew();
      pmAccAdd(srcAcc[s],r);
    });
    var d=pmAccDone(one);
    byTicker.push({ticker:ticker,total:d.total,dirRate:d.dirRate,avgErr:d.avgErr});
  });
  // src別の内訳（件数の多い順）
  var bySrc=Object.keys(srcAcc).map(function(s){
    var d=pmAccDone(srcAcc[s]);
    d.src=s;d.label=PM_SRC_LABELS[s]||s;
    return d;
  }).sort(function(a,b){return b.total-a.total;});

  var out=pmAccDone(all);
  out.byTicker=byTicker.sort(function(a,b){return(b.dirRate||0)-(a.dirRate||0);});
  out.bySrc=bySrc;
  return out;
}
// お気に入り登録銘柄全体で集計（15分キャッシュ）
function calcFavPremarketAccuracy(){
  var now=Date.now();
  if(PM_STATS_CACHE&&now-PM_STATS_TS<PM_STATS_TTL)return PM_STATS_CACHE;
  var favList=(function(){try{return JSON.parse(localStorage.getItem("fav_tickers")||"[]");}catch(e){return[];}})();
  PM_STATS_CACHE=calcPremarketAccuracy(favList.filter(pmIsJP));
  PM_STATS_TS=now;
  return PM_STATS_CACHE;
}

// ── データ取得 ────────────────────────────────────────────────────────
// 地合い（api/premarket.js）。取得に失敗したら直前の結果をそのまま使い続ける
var PM_BIAS_CACHE=null,PM_BIAS_TS=0;
async function pmFetchMarketBias(force){
  var now=Date.now();
  if(!force&&PM_BIAS_CACHE&&now-PM_BIAS_TS<PM_BIAS_TTL)return PM_BIAS_CACHE;
  try{
    var res=await fetch(PM_API,{signal:AbortSignal.timeout(20000)});
    if(!res.ok)throw new Error("premarket "+res.status);
    var json=await res.json();
    if(json.error)throw new Error(json.error);
    PM_BIAS_CACHE=json;PM_BIAS_TS=now;
    return json;
  }catch(e){
    return PM_BIAS_CACHE||{marketBias:null,indicators:[],missing:[],error:e.message||"取得に失敗しました"};
  }
}

// 答え合わせ用に「当日を含む直近5日ぶんの日足」を取り直す。
// fetchDailyのキャッシュ(30分)は寄り付き前のデータを掴んだままのことがあるため、
// 始値の確認だけは別枠・短いキャッシュで取得する（_tはCDNキャッシュ避けの時刻バケット）
var PM_TODAY_CACHE={};
async function pmFetchRecentDaily(ticker,force){
  var now=Date.now(),c=PM_TODAY_CACHE[ticker];
  if(!force&&c&&now-c.ts<PM_TODAY_TTL)return c.data;
  try{
    var bucket=Math.floor(now/PM_TODAY_TTL);
    var res=await fetch(DAILY_API+"?ticker="+encodeURIComponent(ticker)+"&interval=1d&range=5d&_t="+bucket,{signal:AbortSignal.timeout(10000),cache:"no-store"});
    if(!res.ok)throw new Error("daily "+res.status);
    var json=await res.json();
    if(!json||!json.closes||!json.closes.length)return null;
    var data={closes:json.closes,dates:json.dates||[],opens:json.opens||[],highs:json.highs||[],lows:json.lows||[]};
    PM_TODAY_CACHE[ticker]={ts:now,data:data};
    return data;
  }catch(e){return null;}
}
// 実際のギャップ%（対象日の始値 ÷ 前営業日終値 - 1）。まだ寄っていなければnull
function pmActualGap(recent,dateStr){
  if(!recent||!recent.dates)return null;
  var i=recent.dates.indexOf(dateStr);
  if(i<1)return null;
  var o=recent.opens[i],pc=recent.closes[i-1];
  if(!(o>0&&pc>0))return null;
  return {actPct:(o/pc-1)*100,open:o,prevClose:pc};
}
// 同時実行数を絞って順に処理する（Yahooへの一斉アクセスを避ける）
async function pmMapLimit(items,limit,worker){
  var out=new Array(items.length),idx=0;
  async function run(){
    while(idx<items.length){var i=idx++;out[i]=await worker(items[i]);}
  }
  var runners=[];
  for(var k=0;k<Math.min(limit,items.length);k++)runners.push(run());
  await Promise.all(runners);
  return out;
}

// お気に入り日本株ぶんの予想をまとめて作り、予想内容をlocalStorageに記録する
async function pmBuildPredictions(favTickers,force){
  var tickers=(favTickers||[]).filter(pmIsJP);
  var targetDate=pmTargetDate();
  var market=await pmFetchMarketBias(force);
  var bias=market?market.marketBias:null;
  var benchDaily=await fetchDaily(PM_BENCH_TICKER); // ベータの基準となるTOPIX連動ETFの日足

  var rows=await pmMapLimit(tickers,PM_FETCH_CONCURRENCY,async function(ticker){
    var daily=await fetchDaily(ticker);
    var pred=pmPredictGap(ticker,daily,benchDaily,bias,targetDate);
    if(pred)pmRecordPrediction(ticker,targetDate,pred.expectedGapPct,pred.confidence,pred.prevClose,PM_SRC_BETA);
    return {ticker:ticker,name:jpNameOf(ticker,ticker.replace(".T","")),pred:pred};
  });

  // 予想ギャップ%の降順（計算できなかった銘柄は末尾へ）
  rows.sort(function(a,b){
    if(!a.pred&&!b.pred)return 0;
    if(!a.pred)return 1;
    if(!b.pred)return -1;
    return b.pred.expectedGapPct-a.pred.expectedGapPct;
  });
  return {targetDate:targetDate,market:market,bias:bias,benchOk:!!benchDaily,rows:rows};
}

// 9:00以降：実際の始値を取り直して答え合わせし、actを埋める
async function pmBuildResults(favTickers,force){
  var tickers=(favTickers||[]).filter(pmIsJP);
  var today=fcTodayJST(); // 既存のJST日付ヘルパーを再利用
  var rows=await pmMapLimit(tickers,PM_FETCH_CONCURRENCY,async function(ticker){
    // 同じ日に複数srcの予想があっても、画面には優先順の1件だけを出す
    var rec=pmPickRec(pmLoadHist(ticker),today);
    var recent=await pmFetchRecentDaily(ticker,force);
    var act=pmActualGap(recent,today);
    var actPct=act?Math.round(act.actPct*100)/100:null;
    // 答え合わせは表示に選ばれなかったsrcのレコードにも入る（画面は1行でも集計は全srcぶん貯まる）
    if(actPct!=null)pmRecordActual(ticker,today,actPct);
    return {
      ticker:ticker,
      name:jpNameOf(ticker,ticker.replace(".T","")),
      src:rec?rec.src:null,
      exp:rec?rec.exp:null,
      conf:rec?rec.conf:null,
      act:actPct!=null?actPct:(rec?rec.act:null),
      open:act?act.open:null,
      prevClose:act?act.prevClose:(rec?rec.prevClose:null)
    };
  });
  // 実際のギャップ%の降順（まだ寄っていない銘柄は末尾へ）
  rows.sort(function(a,b){
    if(a.act==null&&b.act==null)return 0;
    if(a.act==null)return 1;
    if(b.act==null)return -1;
    return b.act-a.act;
  });
  return {date:today,rows:rows};
}

// ── 🌅 寄り予想タブ ───────────────────────────────────────────────────
function PremarketPanel(p){
  var favKey=(p.favs||[]).filter(pmIsJP).join(",");
  var loadS=useState(false);var loading=loadS[0],setLoading=loadS[1];
  var dataS=useState(null);var data=dataS[0],setData=dataS[1];        // 予想（中段・上段）
  var resS=useState(null);var results=resS[0],setResults=resS[1];      // 答え合わせ（中段）
  var statsS=useState(null);var stats=statsS[0],setStats=statsS[1];    // 的中率（下段）
  var errS=useState("");var err=errS[0],setErr=errS[1];
  var updS=useState("");var lastUpd=updS[0],setLastUpd=updS[1];
  var afterS=useState(pmIsAfterOpen());var afterOpen=afterS[0],setAfterOpen=afterS[1];

  // 9:00をまたいだら自動で「答え合わせ」表示へ切り替える（1分ごとに確認）
  useEffect(function(){
    var t=setInterval(function(){setAfterOpen(pmIsAfterOpen());},60000);
    return function(){clearInterval(t);};
  },[]);

  // お気に入りが変わった時・9:00をまたいだ時に読み込み直す
  useEffect(function(){
    var alive=true;
    var list=favKey?favKey.split(","):[];
    if(!list.length){setData(null);setResults(null);setStats(calcFavPremarketAccuracy());return;}
    setLoading(true);setErr("");
    (async function(){
      try{
        var d=await pmBuildPredictions(list,false);
        if(!alive)return;
        setData(d);
        if(afterOpen){
          var r=await pmBuildResults(list,false);
          if(!alive)return;
          setResults(r);
        }else setResults(null);
        setStats(calcFavPremarketAccuracy());
        setLastUpd(new Date().toLocaleTimeString("ja-JP"));
      }catch(e){if(alive)setErr(e.message||"取得に失敗しました");}
      if(alive)setLoading(false);
    })();
    return function(){alive=false;};
  },[favKey,afterOpen]);

  async function refresh(){
    var list=favKey?favKey.split(","):[];
    if(!list.length)return;
    setLoading(true);setErr("");
    try{
      var d=await pmBuildPredictions(list,true);
      setData(d);
      if(pmIsAfterOpen()){
        var r=await pmBuildResults(list,true);
        setResults(r);
      }else setResults(null);
      setStats(calcFavPremarketAccuracy());
      setLastUpd(new Date().toLocaleTimeString("ja-JP"));
    }catch(e){setErr(e.message||"取得に失敗しました");}
    setLoading(false);
  }

  var market=data&&data.market?data.market:null;
  var bias=data?data.bias:null;
  var biasCol=bias==null?"#4a7090":(bias>0?"#22d3a0":(bias<0?"#f87171":"#4a7090"));
  var cardStyle={background:"#050e1c",border:"1px solid #0f2040",borderRadius:10,overflow:"hidden",marginBottom:10};
  var headStyle={background:"#071428",borderBottom:"1px solid #0f2040",padding:"10px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",gap:8};
  function pctCol(v){return v==null?"#4a7090":(v>0?"#22d3a0":(v<0?"#f87171":"#4a7090"));}
  function fmtPm(v){return v==null?"—":pmSign(v)+v.toFixed(2)+"%";}

  return(
    <div>
      {/* ── 上段：今朝の地合いサマリー ───────────────────────────── */}
      <div style={cardStyle}>
        <div style={headStyle}>
          <div style={{minWidth:0}}>
            <div style={{fontSize:14,fontWeight:700,color:"#e0f0ff"}}>🌅 今朝の地合い</div>
            <div style={{fontSize:11,color:"#4a7090",marginTop:2}}>
              {data?("予想対象日: "+data.targetDate):"読み込み中..."}{lastUpd?" ・ 更新 "+lastUpd:""}
            </div>
          </div>
          <button onClick={refresh} disabled={loading}
            style={{background:loading?"#0a1828":"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:6,color:"#fff",padding:"4px 10px",fontSize:11,fontWeight:700,cursor:loading?"not-allowed":"pointer",fontFamily:"monospace",whiteSpace:"nowrap"}}>
            {loading?"取得中...":"🔄 更新"}
          </button>
        </div>
        <div style={{padding:"12px 14px"}}>
          <div style={{display:"flex",alignItems:"baseline",gap:8,marginBottom:10}}>
            <span style={{fontSize:11,color:"#4a7090"}}>総合（想定ギャップ）</span>
            <span style={{fontSize:24,fontWeight:700,color:biasCol,fontFamily:"monospace"}}>{fmtPm(bias)}</span>
          </div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
            {(market&&market.indicators?market.indicators:[]).map(function(x){
              return(
                <div key={x.key} style={{background:"#071428",border:"1px solid #0f2040",borderRadius:6,padding:"5px 8px",minWidth:88}}>
                  <div style={{fontSize:10,color:"#4a7090"}}>{x.label}</div>
                  <div style={{fontSize:13,fontWeight:700,color:pctCol(x.changePct),fontFamily:"monospace"}}>{fmtPm(x.changePct)}</div>
                  <div style={{fontSize:9,color:"#2a6090",fontFamily:"monospace"}}>寄与 {fmtPm(x.contribution)}</div>
                </div>
              );
            })}
            {market&&(!market.indicators||!market.indicators.length)&&
              <div style={{fontSize:12,color:"#f87171"}}>地合いの指標が取得できませんでした{market.error?"（"+market.error+"）":""}</div>}
          </div>
          {market&&market.missing&&market.missing.length>0&&
            <div style={{fontSize:10,color:"#4a7090",marginTop:8}}>取得できず除外: {market.missing.map(function(m){return m.label;}).join(" / ")}</div>}
        </div>
      </div>

      {err&&<div style={{background:"#3a0a0a",border:"1px solid #f43f5e",borderRadius:8,padding:"8px 12px",fontSize:12,color:"#fca5a5",marginBottom:10}}>{err}</div>}
      {data&&!data.benchOk&&
        <div style={{background:"#1c1400",border:"1px solid #fbbf24",borderRadius:8,padding:"8px 12px",fontSize:12,color:"#fbbf24",marginBottom:10}}>
          ベータの基準（{PM_BENCH_TICKER}）の日足が取得できないため、予想を算出できません
        </div>}

      {/* ── 中段：予想一覧 / 9:00以降は答え合わせ ─────────────────── */}
      <div style={cardStyle}>
        <div style={{background:"#071428",borderBottom:"1px solid #0f2040",padding:"10px 14px"}}>
          <div style={{fontSize:14,fontWeight:700,color:"#e0f0ff"}}>
            {afterOpen?"✅ 予想 vs 実際の始値":"📋 お気に入りの寄り予想"}
          </div>
          <div style={{fontSize:11,color:"#4a7090",marginTop:2}}>
            {afterOpen
              ? "9:00を過ぎたため答え合わせを表示中（実際の始値が取れた銘柄から順に記録されます）"
              : "お気に入り登録した日本株のみ・予想ギャップ%の降順"}
          </div>
        </div>

        {!favKey?(
          <div style={{padding:"20px 14px",fontSize:13,color:"#4a7090",textAlign:"center"}}>お気に入りに日本株が登録されていません</div>
        ):loading&&!data?(
          <div style={{padding:"24px 14px",fontSize:13,color:"#4a90c0",textAlign:"center"}}>日足とベータを計算中...</div>
        ):afterOpen?(
          /* 答え合わせ表示 */
          <div>
            {(results&&results.rows?results.rows:[]).map(function(r){
              var diff=(r.exp!=null&&r.act!=null)?r.act-r.exp:null;
              var hit=(r.exp!=null&&r.act!=null&&Math.abs(r.exp)>=PM_DIR_DEADBAND)?((r.exp>0)===(r.act>0)):null;
              return(
                <div key={r.ticker} style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,padding:"10px 14px",borderBottom:"1px solid #0a1828"}}>
                  <div style={{minWidth:0}}>
                    <div style={{fontSize:14,fontWeight:700,color:"#d8eeff"}}>
                      {r.ticker.replace(".T","")} <span style={{fontSize:11,color:"#4a7090",fontWeight:400}}>{r.name}</span>
                    </div>
                    <div style={{fontSize:10,color:"#2a6090",marginTop:2,fontFamily:"monospace"}}>
                      {r.prevClose?("前日終値 "+r.prevClose):""}{r.open?" → 始値 "+r.open:""}
                    </div>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:10,whiteSpace:"nowrap"}}>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:9,color:"#4a7090"}}>予想</div>
                      <div style={{fontSize:12,fontWeight:700,color:pctCol(r.exp),fontFamily:"monospace"}}>{fmtPm(r.exp)}</div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:9,color:"#4a7090"}}>実際</div>
                      <div style={{fontSize:14,fontWeight:700,color:pctCol(r.act),fontFamily:"monospace"}}>{r.act==null?"待機中":fmtPm(r.act)}</div>
                    </div>
                    <div style={{textAlign:"right",minWidth:52}}>
                      <div style={{fontSize:9,color:"#4a7090"}}>誤差</div>
                      <div style={{fontSize:11,color:"#7ab0d8",fontFamily:"monospace"}}>{diff==null?"—":(Math.abs(diff).toFixed(2)+"%")}</div>
                    </div>
                    <span style={hit==null?bStyle("#0a1828","#1e3050","#4a7090"):(hit?bStyle("#04241a","#22d3a0","#22d3a0"):bStyle("#3a0a0a","#f43f5e","#f87171"))}>
                      {hit==null?"—":(hit?"方向◯":"方向✕")}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ):(
          /* 予想一覧 */
          <div>
            {(data&&data.rows?data.rows:[]).map(function(r){
              var pred=r.pred;
              return(
                <div key={r.ticker} style={{padding:"10px 14px",borderBottom:"1px solid #0a1828"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
                    <div style={{minWidth:0}}>
                      <div style={{fontSize:14,fontWeight:700,color:"#d8eeff"}}>
                        {r.ticker.replace(".T","")} <span style={{fontSize:11,color:"#4a7090",fontWeight:400}}>{r.name}</span>
                      </div>
                      {pred&&pred.prevClose&&
                        <div style={{fontSize:10,color:"#2a6090",marginTop:2,fontFamily:"monospace"}}>前日終値 {pred.prevClose}（{pred.prevDate}）</div>}
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:12,whiteSpace:"nowrap"}}>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontSize:9,color:"#4a7090"}}>予想ギャップ</div>
                        <div style={{fontSize:16,fontWeight:700,color:pctCol(pred?pred.expectedGapPct:null),fontFamily:"monospace"}}>
                          {pred?fmtPm(pred.expectedGapPct):"—"}
                        </div>
                      </div>
                      <div style={{textAlign:"right",minWidth:44}}>
                        <div style={{fontSize:9,color:"#4a7090"}}>確信度</div>
                        <div style={{fontSize:13,fontWeight:700,color:pred?(pred.confidence>=60?"#22d3a0":(pred.confidence>=40?"#fbbf24":"#4a7090")):"#4a7090",fontFamily:"monospace"}}>
                          {pred?pred.confidence+"%":"—"}
                        </div>
                      </div>
                    </div>
                  </div>
                  {pred?(
                    <div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:6}}>
                      {pred.reasons.map(function(rs,i){
                        var st=rs.state;
                        var sty=st>0?bStyle("#04241a","#22d3a0","#22d3a0"):(st<0?bStyle("#3a0a0a","#f43f5e","#f87171"):bStyle("#0a1828","#1e3050","#7ab0d8"));
                        return <span key={i} style={sty}>{rs.label}: {rs.val}</span>;
                      })}
                    </div>
                  ):(
                    <div style={{fontSize:11,color:"#4a7090",marginTop:4}}>
                      日足のサンプルが足りないか、地合いが取得できないため算出できません
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── 下段：過去の的中率サマリー ────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{background:"#071428",borderBottom:"1px solid #0f2040",padding:"10px 14px"}}>
          <div style={{fontSize:14,fontWeight:700,color:"#e0f0ff"}}>📊 寄り予想の的中率</div>
          <div style={{fontSize:11,color:"#4a7090",marginTop:2}}>お気に入り銘柄の記録（pm_*）を集計。既存のスコア的中率とは別枠で貯まります</div>
          <div style={{fontSize:10,color:"#2a6090",marginTop:2}}>件数は予想の延べ数（同じ日でも出どころが違えば別に数えます）</div>
        </div>
        {!stats||!stats.total?(
          <div style={{padding:"20px 14px",fontSize:13,color:"#4a7090",textAlign:"center"}}>
            まだ答え合わせ済みの記録がありません（寄り付き前に予想を作り、9:00以降にこのタブを開くと貯まります）
          </div>
        ):(
          <div>
            <div style={{display:"flex",flexWrap:"wrap",gap:6,padding:"12px 14px"}}>
              <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:6,padding:"6px 10px",minWidth:92}}>
                <div style={{fontSize:10,color:"#4a7090"}}>方向一致率</div>
                <div style={{fontSize:18,fontWeight:700,color:stats.dirRate>=50?"#22d3a0":"#f87171",fontFamily:"monospace"}}>
                  {stats.dirRate==null?"—":stats.dirRate+"%"}
                </div>
                <div style={{fontSize:9,color:"#2a6090"}}>判定 {stats.dirTotal}件</div>
              </div>
              <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:6,padding:"6px 10px",minWidth:92}}>
                <div style={{fontSize:10,color:"#4a7090"}}>平均誤差</div>
                <div style={{fontSize:18,fontWeight:700,color:"#7ab0d8",fontFamily:"monospace"}}>{stats.avgErr==null?"—":stats.avgErr+"%"}</div>
                <div style={{fontSize:9,color:"#2a6090"}}>予想と実際の差</div>
              </div>
              <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:6,padding:"6px 10px",minWidth:92}}>
                <div style={{fontSize:10,color:"#4a7090"}}>件数</div>
                <div style={{fontSize:18,fontWeight:700,color:"#d8eeff",fontFamily:"monospace"}}>{stats.total}</div>
                <div style={{fontSize:9,color:"#2a6090"}}>平均確信度 {stats.avgConf==null?"—":stats.avgConf+"%"}</div>
              </div>
            </div>
            {/* 出どころ（src）ごとの内訳。今はベータ推定だけだが、Phase 2で寄り前気配が増えると行が増える */}
            <div style={{borderTop:"1px solid #0a1828"}}>
              {(stats.bySrc||[]).map(function(b){
                return(
                  <div key={b.src} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 14px",borderBottom:"1px solid #0a1828"}}>
                    <div style={{fontSize:12,color:"#a8c4e0"}}>{b.label}</div>
                    <div style={{display:"flex",gap:10,fontSize:11,fontFamily:"monospace",color:"#7ab0d8"}}>
                      <span style={{color:b.dirRate==null?"#4a7090":(b.dirRate>=50?"#22d3a0":"#f87171")}}>方向 {b.dirRate==null?"—":b.dirRate+"%"}</span>
                      <span>誤差 {b.avgErr==null?"—":b.avgErr+"%"}</span>
                      <span style={{color:"#2a6090"}}>{b.total}件</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{borderTop:"1px solid #0a1828"}}>
              {stats.byTicker.map(function(b){
                return(
                  <div key={b.ticker} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 14px",borderBottom:"1px solid #0a1828"}}>
                    <div style={{fontSize:12,color:"#d8eeff"}}>
                      {b.ticker.replace(".T","")} <span style={{fontSize:10,color:"#4a7090"}}>{jpNameOf(b.ticker,"")}</span>
                    </div>
                    <div style={{display:"flex",gap:10,fontSize:11,fontFamily:"monospace",color:"#7ab0d8"}}>
                      <span style={{color:b.dirRate==null?"#4a7090":(b.dirRate>=50?"#22d3a0":"#f87171")}}>方向 {b.dirRate==null?"—":b.dirRate+"%"}</span>
                      <span>誤差 {b.avgErr}%</span>
                      <span style={{color:"#2a6090"}}>{b.total}件</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
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
  var k=useState("fav");var activeTab=k[0],setActiveTab=k[1];
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
  function syncToServer(nextFavs,nextGroups,nextGroupNames,nextPersonalTrades,targetId){
    if(!syncLoaded)return; // 起動時の読み込み完了前は保存しない
    fetch(SYNC_API+"?userId="+(targetId||userId),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
      favs:nextFavs,
      scoreHist:getAllScoreHist(),
      forecasts:fcLoad(),
      groups:nextGroups,
      groupNames:nextGroupNames,
      appTrades:[], // アプリ予想は廃止（サーバー側の旧データも空で上書きする）
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

  // ── 🏭 業種まとめ登録：出来高上位50銘柄を一括でお気に入りに入れる／保存先ごとに一括解除 ──
  var bulkOpenS=useState(false);var bulkOpen=bulkOpenS[0],setBulkOpen=bulkOpenS[1];
  var bulkSecS=useState(null);var bulkSector=bulkSecS[0],setBulkSector=bulkSecS[1];   // 選んだ業種名（1つだけ）
  var bulkGrpS=useState(0);var bulkGroup=bulkGrpS[0],setBulkGroup=bulkGrpS[1];        // 保存先 0=全体 / 1〜4=グループ
  var bulkMsgS=useState("");var bulkMsg=bulkMsgS[0],setBulkMsg=bulkMsgS[1];           // 処理中・結果のメッセージ
  function groupLabel(n){return n===0?"全体（未分類）":groupNames[n];}
  // 複数銘柄をまとめて登録（保存とサーバー同期は最後に1回だけ＝通信を節約）
  function applyFavBulk(tickers,groupNum){
    var next=favs.slice(),nextGroups=Object.assign({},favGroups);
    tickers.forEach(function(t){if(next.indexOf(t)<0)next.push(t);nextGroups[t]=groupNum;});
    setFavs(next);setFavGroups(nextGroups);
    try{localStorage.setItem("fav_tickers",JSON.stringify(next));localStorage.setItem("fav_groups",JSON.stringify(nextGroups));}catch(e){}
    syncToServer(next,nextGroups,groupNames);
  }
  async function bulkAddSector(){
    if(!bulkSector||bulkMsg)return;
    setBulkMsg("「"+bulkSector+"」の出来高上位を取得中...");
    var r=await fetchSectorRanking([bulkSector]);
    var list=(r.stocks||[]).filter(function(s){return s.market==="JP";})
      .sort(function(a,b){return (b.volume||0)-(a.volume||0);}).slice(0,50);
    if(!list.length){setBulkMsg("");window.alert("⚠️ 銘柄を取得できませんでした。時間をおいて再度お試しください");return;}
    var tickers=list.map(function(s){return s.ticker;});
    var added=tickers.filter(function(t){return favs.indexOf(t)<0;}).length;
    setBulkMsg("");
    if(!window.confirm(bulkSector+"（"+SECTOR_CODES[bulkSector]+"）の出来高上位 "+tickers.length+"銘柄を\n「"+groupLabel(bulkGroup)+"」に登録します。\n\n新規 "+added+"件 / 登録済み "+(tickers.length-added)+"件（保存先を変更）\n\nよろしいですか？"))return;
    applyFavBulk(tickers,bulkGroup);
    // 登録した銘柄をその場で取得し、お気に入り一覧にすぐ並ぶようにする
    setBulkMsg("銘柄データを取得中... 0/"+tickers.length);
    var loaded=await loadStocksFor(list,function(d,t){setBulkMsg("銘柄データを取得中... "+d+"/"+t);});
    if(loaded.length)startDayNightFill(loaded); // 続けて☀️日中型も裏で取得
    setBulkMsg("");
    setBulkOpen(false);setBulkSector(null);
    window.alert("✅ "+tickers.length+"銘柄を「"+groupLabel(bulkGroup)+"」に登録しました（新規 "+added+"件）\n\nお気に入りタブに表示されます");
  }
  function bulkRemoveGroup(groupNum){
    var targets=favs.filter(function(t){return (favGroups[t]==null?0:favGroups[t])===groupNum;});
    if(!targets.length){window.alert("「"+groupLabel(groupNum)+"」に登録された銘柄はありません");return;}
    if(!window.confirm("「"+groupLabel(groupNum)+"」の "+targets.length+"銘柄をお気に入りから外します。\nこの操作は元に戻せません。よろしいですか？"))return;
    var next=favs.filter(function(t){return targets.indexOf(t)<0;});
    var nextGroups=Object.assign({},favGroups);targets.forEach(function(t){delete nextGroups[t];});
    setFavs(next);setFavGroups(nextGroups);
    try{localStorage.setItem("fav_tickers",JSON.stringify(next));localStorage.setItem("fav_groups",JSON.stringify(nextGroups));}catch(e){}
    syncToServer(next,nextGroups,groupNames);
    window.alert("✅ "+targets.length+"銘柄を解除しました");
  }
  function groupCount(n){return favs.filter(function(t){return (favGroups[t]==null?0:favGroups[t])===n;}).length;}
  // 一括登録した銘柄を、その場で株価取得して一覧（stocks）に加える。
  // これをしないと、お気に入り一覧は「株価データを持つ銘柄」しか表示しないため
  // 登録したのに画面に出てこない状態になる
  async function loadStocksFor(list,onProgress){
    var universe=list.filter(function(s){return !stocks.some(function(x){return x.ticker===s.ticker;});})
      .map(function(s){
        var isJP=s.ticker.endsWith(".T"),code=s.ticker.replace(".T","");
        return{ticker:s.ticker,name:s.name||code,market:isJP?"JP":"US",tvSymbol:(isJP?"TSE:":"NASDAQ:")+code};
      });
    if(!universe.length)return[];
    await fillJPNames(universe); // 会社名がコードのままの銘柄に正式名称を補う
    var done=0,results=[];
    await Promise.all(universe.map(async function(stock){
      var pd=await fetchYahooSafe(stock.ticker);
      try{results.push(analyzeStock(stock,pd,vix));}catch(e){console.error("analyzeStock error",stock.ticker,e);}
      done++;if(onProgress)onProgress(done,universe.length);
    }));
    setStocks(function(prev){
      var seen={};prev.forEach(function(s){seen[s.ticker]=true;});
      return prev.concat(results.filter(function(s){return !seen[s.ticker];}));
    });
    return results;
  }

  function renameGroup(groupNum,name){
    var nextNames=Object.assign({},groupNames);nextNames[groupNum]=name;
    setGroupNames(nextNames);
    try{localStorage.setItem("group_names",JSON.stringify(nextNames));}catch(e){}
    syncToServer(favs,favGroups,nextNames);
  }

  // ── トレードシミュレーター：状態管理・登録・削除・価格判定 ───────────────────
  var ptS=useState(function(){return loadTrades("personal");});var personalTrades=ptS[0],setPersonalTrades=ptS[1];
  var tradeRefreshingS=useState(false);var tradeRefreshing=tradeRefreshingS[0],setTradeRefreshing=tradeRefreshingS[1];
  function addTradeHandler(kind,s,buyPrice,sellPrice,shares,stopPrice,buyDirection){
    var next=addTradeRecord(kind,s,buyPrice,sellPrice,shares,stopPrice,buyDirection);
    setPersonalTrades(next);syncToServer(favs,favGroups,groupNames,next);
  }
  function removeTradeHandler(kind,id){
    var next=removeTradeRecord(kind,id);
    setPersonalTrades(next);syncToServer(favs,favGroups,groupNames,next);
  }
  function editTradeHandler(kind,id,updates){
    var next=editTradeRecord(kind,id,updates);
    setPersonalTrades(next);syncToServer(favs,favGroups,groupNames,next);
  }
  function forceCompleteHandler(kind,id,curPrice){
    var next=forceCompleteTradeRecord(kind,id,curPrice);
    setPersonalTrades(next);syncToServer(favs,favGroups,groupNames,next);
  }
  // 保有中（waiting/active）のトレード銘柄の価格を手動で更新（🔄ボタン）。自動の定期更新は行わない
  // 日本株は立花証券のリアルタイム値を最優先。取れない場合のみYahoo（約20分遅れ）を使う
  function refreshTradePrices(){
    var tickers=[];
    personalTrades.forEach(function(t){
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
        var nextPersonal=applyPricesToTrades("personal",priceMap);
        setPersonalTrades(nextPersonal);
        syncToServer(favs,favGroups,groupNames,nextPersonal);
      }
    }).finally(function(){setTradeRefreshing(false);});
  }

  // ── ☀️日中型のバックグラウンド取得 ────────────────────────────────────
  // 一覧はすぐ表示し、その裏で日足を1銘柄ずつ取得して☀️バッジを順に埋める。
  // アプリ内でタブを移動しても処理は止まらない。ただしブラウザごと裏に回すと
  // iPadOSが処理を一時停止することがあるため、画面に戻った時に続きから再開する。
  var dnFillS=useState(null);var dnFill=dnFillS[0],setDnFill=dnFillS[1];
  var dnBusyRef=useRef(false); // 二重起動の防止
  var dnListRef=useRef([]);    // 取得対象の銘柄リスト（最後のスキャン結果）
  var startDayNightFill=useCallback(function(list){
    if(list&&list.length)dnListRef.current=list;
    if(dnBusyRef.current||!dnListRef.current.length)return;
    dnBusyRef.current=true;
    function refresh(){setStocks(function(prev){return prev.slice();});} // 取得できた分をバッジに反映
    fillDayNightFor(dnListRef.current,function(d,t){
      setDnFill(d<t?{d:d,t:t}:null);refresh();
    }).then(function(){setDnFill(null);refresh();})
      .catch(function(){setDnFill(null);})
      .finally(function(){dnBusyRef.current=false;});
  },[]);
  useEffect(function(){
    function onVisible(){if(document.visibilityState==="visible")startDayNightFill();}
    document.addEventListener("visibilitychange",onVisible);
    return function(){document.removeEventListener("visibilitychange",onVisible);};
  },[startDayNightFill]);

  var scan=useCallback(async function(manualSectors,skipAI){
    setLoading(true);
    try{
      // エラーで落ちても自動でやり直す（通信の一時的な不調が原因のことが多いため）
      await runScanWithRetry(async function(attempt){
        CACHE={}; // 再スキャン時は必ず最新データを取得（古いキャッシュ流用を防止。リトライ時も同様）
        var retryPrefix=attempt>0?"🔄 再試行中("+attempt+"/"+SCAN_MAX_RETRY+") ":"";
        setProgress({done:0,total:0,msg:retryPrefix+(skipAI?"前回データなし・通常ランキング取得中...":(manualSectors&&manualSectors.length?"指定業種の銘柄取得中...":"AI業種選定中..."))});
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
        loadTrades("personal").forEach(function(t){
          if(t.status==="done")return;
          if(!universe.some(function(u){return u.ticker===t.ticker;})){
            var isJP=t.ticker.endsWith(".T"),code=t.ticker.replace(".T","");
            universe.push({ticker:t.ticker,name:t.name||code,market:isJP?"JP":"US",tvSymbol:(isJP?"TSE:":"NASDAQ:")+code});
          }
        });
        await fillJPNames(universe); // 会社名がコードのままの銘柄に正式名称を補う
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
        startDayNightFill(results); // 表示後に☀️日中型を裏で取得
      },function(next,max,err,wait){
        setProgress({done:0,total:0,msg:"⚠️ エラー: "+err.message+" — "+Math.round(wait/1000)+"秒後に再試行します("+next+"/"+max+")"});
      });
    }catch(err){
      setProgress({done:0,total:0,msg:"❌ エラー: "+err.message+"（"+(SCAN_MAX_RETRY+1)+"回試行しました）"});
    }finally{
      setLoading(false);
    }
  },[startDayNightFill]);
  // ⭐お気に入り＋トレード登録中の銘柄だけを分析（AI業種選定・ランキング取得なしで高速）
  var scanFavsOnly=useCallback(async function(){
    setLoading(true);
    try{
      await runScanWithRetry(async function(attempt){
        CACHE={};
        var retryPrefix=attempt>0?"🔄 再試行中("+attempt+"/"+SCAN_MAX_RETRY+") ":"";
        setProgress({done:0,total:0,msg:retryPrefix+"⭐お気に入り銘柄を取得中..."});
        var favList=(function(){try{var v=localStorage.getItem("fav_tickers");return v?JSON.parse(v):[];}catch(e){return[];}})();
        var universe=[];
        function push(ticker,name){
          if(!ticker||universe.some(function(u){return u.ticker===ticker;}))return;
          var isJP=ticker.endsWith(".T"),code=ticker.replace(".T","");
          universe.push({ticker:ticker,name:name||code,market:isJP?"JP":"US",tvSymbol:(isJP?"TSE:":"NASDAQ:")+code});
        }
        favList.forEach(function(t){push(t);});
        loadTrades("personal").forEach(function(t){if(t.status!=="done")push(t.ticker,t.name);});
        // 登録が無いのは「エラー」ではないのでリトライせずそのまま終了する
        if(universe.length===0){setProgress({done:0,total:0,msg:"⚠️ お気に入り銘柄が登録されていません"});return;}
        await fillJPNames(universe); // 会社名がコードのままの銘柄に正式名称を補う
        setProgress({done:0,total:universe.length,msg:null});
        var results=[];
        await Promise.all(universe.map(async function(stock){
          var pd=await fetchYahooSafe(stock.ticker);
          try{results.push(analyzeStock(stock,pd,vix));}catch(e){console.error("analyzeStock error",stock.ticker,e);}
          setProgress(function(p){return{done:p.done+1,total:p.total,msg:null};});
        }));
        results.sort(function(x,y){return y.score-x.score;});
        setStocks(results);
        setTs(new Date().toLocaleTimeString("ja-JP"));
        startDayNightFill(results); // 表示後に☀️日中型を裏で取得
      },function(next,max,err,wait){
        setProgress({done:0,total:0,msg:"⚠️ エラー: "+err.message+" — "+Math.round(wait/1000)+"秒後に再試行します("+next+"/"+max+")"});
      });
    }catch(err){
      setProgress({done:0,total:0,msg:"❌ エラー: "+err.message+"（"+(SCAN_MAX_RETRY+1)+"回試行しました）"});
    }finally{setLoading(false);}
  },[vix,startDayNightFill]);
  function startFavsOnly(){setStartMode("favs");scanFavsOnly();}
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
    var universe=stocks.map(function(s){return{ticker:s.ticker,name:s.name,market:s.market,tvSymbol:s.tvSymbol};});
    try{
      await runScanWithRetry(async function(attempt){
        CACHE={};
        setProgress({done:0,total:universe.length,msg:attempt>0?"🔄 再試行中("+attempt+"/"+SCAN_MAX_RETRY+")...":null});
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
      },function(next,max,err,wait){
        setProgress({done:0,total:0,msg:"⚠️ エラー: "+err.message+" — "+Math.round(wait/1000)+"秒後に再試行します("+next+"/"+max+")"});
      });
    }catch(err){
      setProgress({done:0,total:0,msg:"❌ エラー: "+err.message+"（"+(SCAN_MAX_RETRY+1)+"回試行しました）"});
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
  var TABS=[["fav","⭐"],["trade","🎯"],["premarket","🌅"],["event","📅"],["index","🌍"],["market","📡"],["news","📰"],["sync","🔗"],["guide","📘"]];
  var TAB_LABELS={"fav":"メイン","trade":"トレード","premarket":"寄り予想","event":"決算・権利落ち","index":"リンク","market":"市場予測","news":"ニュース","sync":"デバイス同期","guide":"使い方"};

  var sectorPickerModal=sectorPickerOpen&&createPortal(
    <div onClick={function(e){if(e.target===e.currentTarget)setSectorPickerOpen(false);}} style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.6)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
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
    <div onClick={function(e){if(e.target===e.currentTarget)setRescanMenuOpen(false);}} style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.6)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"#071428",border:"1px solid #1e3050",borderRadius:10,padding:16,width:"100%",maxWidth:320,display:"flex",flexDirection:"column",gap:8,color:"#b8cce0"}}>
        <div style={{fontSize:13,fontWeight:800,color:"#e0f0ff",marginBottom:4}}>🔄 再スキャン方法を選択</div>
        <button onClick={function(){setRescanMenuOpen(false);startOmakase();}} style={{padding:"12px 10px",background:"#0ea5e9",border:"none",borderRadius:8,color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>🤖 おまかせ（AIがトレンド業種を選定）</button>
        <button onClick={function(){setRescanMenuOpen(false);setPickedSectors([]);setSectorPickerOpen(true);}} style={{padding:"12px 10px",background:"#050f20",border:"1px solid #1e3050",borderRadius:8,color:"#b8cce0",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>📋 業種コード一覧から選ぶ</button>
        <button onClick={function(){setRescanMenuOpen(false);reloadCurrentUniverse();}} style={{padding:"12px 10px",background:"#050f20",border:"1px solid #1e3050",borderRadius:8,color:"#b8cce0",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>🔁 今の銘柄でリロード</button>
        <button onClick={function(){setRescanMenuOpen(false);scanFavsOnly();}} style={{padding:"12px 10px",background:"#050f20",border:"1px solid #1e3050",borderRadius:8,color:"#fbbf24",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>⭐ お気に入りのみスキャン</button>
        <button onClick={function(){setRescanMenuOpen(false);setBulkOpen(true);}} style={{padding:"12px 10px",background:"#050f20",border:"1px solid #1e3050",borderRadius:8,color:"#7dd3fc",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>🏭 業種まとめ登録（上位50をお気に入りへ）</button>
        <button onClick={function(){setRescanMenuOpen(false);}} style={{padding:"8px 0",background:"transparent",border:"1px solid #2a4060",borderRadius:8,color:"#4a7090",fontSize:12,cursor:"pointer",fontFamily:"monospace"}}>キャンセル</button>
      </div>
    </div>,
    document.body
  );

  // 🏭 業種まとめ登録モーダル（業種を1つ選び、出来高上位50をお気に入りへ／保存先ごとに一括解除）
  var sectorBulkModal=bulkOpen&&createPortal(
    <div onClick={function(e){if(e.target===e.currentTarget&&!bulkMsg)setBulkOpen(false);}} style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.6)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"#071428",border:"1px solid #1e3050",borderRadius:10,padding:16,width:"100%",maxWidth:520,maxHeight:"85vh",display:"flex",flexDirection:"column",color:"#b8cce0"}}>
        <div style={{fontSize:13,fontWeight:800,color:"#e0f0ff",marginBottom:2}}>🏭 業種まとめ登録</div>
        <div style={{fontSize:11,color:"#4a7090",marginBottom:8}}>業種を1つ選ぶと、その業種の出来高上位50銘柄をまとめてお気に入りに登録します</div>
        <div style={{overflowY:"auto",marginBottom:10}}>
          {SECTOR_STYLE_GROUPS.map(function(g){
            var key=g[0],label=g[1];
            var list=JP_33_SECTORS.filter(function(name){return SECTOR_STYLE[name]===key;});
            return(
              <div key={key} style={{marginBottom:10}}>
                <div style={{fontSize:11,fontWeight:700,color:"#4a90c0",margin:"4px 0"}}>{label}</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px 10px"}}>
                  {list.map(function(name){
                    var active=bulkSector===name;
                    return(
                      <button key={name} onClick={function(){setBulkSector(active?null:name);}} style={{textAlign:"left",padding:"6px 8px",background:active?"#0ea5e930":"transparent",border:"1px solid "+(active?"#0ea5e9":"#1e3050"),borderRadius:6,color:active?"#7dd3fc":"#b8cce0",fontSize:12,cursor:"pointer",fontFamily:"monospace"}}>
                        {active?"✓ ":""}{SECTOR_CODES[name]} {name}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{fontSize:11,color:"#2a6090",marginBottom:4}}>保存先</div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
          {[0,1,2,3,4].map(function(n){
            var active=bulkGroup===n;
            return <button key={n} onClick={function(){setBulkGroup(n);}} style={{background:active?"#fbbf2420":"transparent",border:"1px solid "+(active?"#fbbf24":"#1e3050"),borderRadius:6,color:active?"#fbbf24":"#4a6080",padding:"4px 10px",fontSize:11,cursor:"pointer",fontFamily:"monospace",fontWeight:active?700:400}}>{n===0?"全体":groupNames[n]}（{groupCount(n)}）</button>;
          })}
        </div>
        {bulkMsg&&<div style={{fontSize:11,color:"#0ea5e9",marginBottom:8}}>{bulkMsg}</div>}
        <button onClick={bulkAddSector} disabled={!bulkSector||!!bulkMsg} style={{padding:"12px 10px",background:(bulkSector&&!bulkMsg)?"#0ea5e9":"#1e3050",border:"none",borderRadius:8,color:"#fff",fontSize:13,fontWeight:700,cursor:(bulkSector&&!bulkMsg)?"pointer":"default",fontFamily:"monospace",marginBottom:10}}>
          ⭐ 出来高上位50を「{groupLabel(bulkGroup)}」に一括登録
        </button>
        <div style={{borderTop:"1px solid #1e3050",paddingTop:10,marginBottom:10}}>
          <div style={{fontSize:11,color:"#2a6090",marginBottom:4}}>保存先ごとに一括解除（登録した銘柄をまとめて外す）</div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {[0,1,2,3,4].map(function(n){
              return <button key={n} onClick={function(){bulkRemoveGroup(n);}} style={{background:"#2a0a12",border:"1px solid #f43f5e60",borderRadius:6,color:"#f43f5e",padding:"4px 10px",fontSize:11,cursor:"pointer",fontFamily:"monospace"}}>🗑 {n===0?"全体":groupNames[n]}（{groupCount(n)}）</button>;
            })}
          </div>
        </div>
        <button onClick={function(){setBulkOpen(false);setBulkMsg("");}} style={{padding:"8px 0",background:"transparent",border:"1px solid #2a4060",borderRadius:8,color:"#4a7090",fontSize:12,cursor:"pointer",fontFamily:"monospace"}}>閉じる</button>
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
        <button onClick={startFavsOnly} style={{width:260,padding:"14px 12px",background:"#050f20",border:"1px solid #1e3050",borderRadius:8,color:"#fbbf24",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>
          ⭐ お気に入りのみスキャン（高速）
        </button>
        {sectorPickerModal}
      </div>
    );
  }

  return(
    <div style={{minHeight:"100vh",background:"#040c18",backgroundAttachment:"fixed",fontFamily:"monospace",color:"#b8cce0"}}>
      <div style={{background:"linear-gradient(180deg,#071428,#050f20)",borderBottom:"1px solid #0f2040",padding:"8px 12px",marginLeft:isMobile?0:50}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
          <div style={{display:"flex",alignItems:"center",gap:8,minWidth:0,flex:1,overflowX:"auto",WebkitOverflowScrolling:"touch"}}>
            <div style={{fontSize:14,fontWeight:800,color:"#e0f0ff",flexShrink:0,whiteSpace:"nowrap"}}>
              DaySimulator <span style={{fontSize:12,color:"#4a7090",fontWeight:400}}>/ {TAB_LABELS[activeTab]}</span>
            </div>
            <MarketRegimeBanner stocks={stocks}/>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
            <MarketHours/>
            <LayoutModeBtn/>
          </div>
        </div>
        {dnFill&&<div style={{fontSize:10,color:"#fbbf24",marginTop:2}}>☀️ 日中型を取得中... {dnFill.d}/{dnFill.t}（一覧はそのまま使えます）</div>}
        {sectorPickerModal}
        {rescanMenu}
        {favPickerModal}
        {sectorBulkModal}
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
                    {activeTab==="fav"&&<FavPanel onBulkSector={function(){setBulkOpen(true);}} loading={loading} progress={progress} ts={ts} onScan={function(){setRescanMenuOpen(true);}} stocks={stocks} setStocks={setStocks} favs={favs} toggleFav={toggleFav} favGroups={favGroups} groupNames={groupNames} renameGroup={renameGroup} vix={vix} usdJpy={usdJpy} selectedStock={selectedStock} setSelectedStock={setSelectedStock} onRescan={rescanOne} rescanLoading={rescanLoading} onAddTrade={addTradeHandler} personalTrades={personalTrades}/>}
          {activeTab==="trade"&&<TradePanel stocks={stocks} personalTrades={personalTrades} toggleFav={toggleFav} favs={favs} vix={vix} usdJpy={usdJpy} selectedStock={selectedStock} setSelectedStock={setSelectedStock} onRescan={rescanOne} rescanLoading={rescanLoading} onAddTrade={addTradeHandler} onRemoveTrade={removeTradeHandler} onEditTrade={editTradeHandler} onForceComplete={forceCompleteHandler} onRefreshTrades={refreshTradePrices} tradeRefreshing={tradeRefreshing}/>}
          {activeTab==="premarket"&&<PremarketPanel favs={favs}/>}
          {activeTab==="index"&&<IndexPanel/>}
          {activeTab==="market"&&<MarketPredictionPanel stocks={stocks} vix={vix} predictionResult={predictionResult} setPredictionResult={setPredictionResult} predictionLoading={predictionLoading} setPredictionLoading={setPredictionLoading} favs={favs} toggleFav={toggleFav}/>}
          {activeTab==="news"&&<NewsPanel/>}
          {activeTab==="event"&&<EventPanel stocks={stocks}/>}
          {activeTab==="sync"&&<SyncPanel userId={userId} setUserId={setUserId} syncApi={SYNC_API} favs={favs} favGroups={favGroups} groupNames={groupNames} personalTrades={personalTrades} syncToServer={syncToServer} setFavs={setFavs} setFavGroups={setFavGroups} setGroupNames={setGroupNames} setPersonalTrades={setPersonalTrades} scan={scan}/>}
          {activeTab==="guide"&&<GuidePanel/>}
        </div>
      </div>
    </div>
  );
}
