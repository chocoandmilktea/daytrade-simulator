import { useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

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
function bStyle(bg,border,text){ return{background:bg,border:"1px solid "+border,color:text,fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4}; }

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
var SECTOR_API="https://daytrade-simulator.vercel.app/api/sector";
var CORRELATION_API="https://daytrade-simulator.vercel.app/api/correlation";
var INTRADAY_API="https://daytrade-simulator.vercel.app/api/intraday";
var DAILY_API="https://daytrade-simulator.vercel.app/api/daily";

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

// レスポンス形式: { m1:{closes,times}, date }（チャートモーダル用の1分足）
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

// ── 日足（カードのミニチャート用）────────────────────────────────────────
// 直近3ヶ月の日足終値。値の変化が緩やかなので30分キャッシュ、分足用の直列
// キューとは別枠で（軽いデータなので待たせる必要が薄いため）直接取得する。
var DAILY_CACHE={}, DAILY_TTL=30*60*1000, DAILY_INFLIGHT={};
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
      var result={closes:json.closes,dates:json.dates||[]};
      DAILY_CACHE[ticker]={ts:now,data:result};
      return result;
    }catch(e){return null;}
  })();
  DAILY_INFLIGHT[ticker]=p;
  p.finally(function(){delete DAILY_INFLIGHT[ticker];});
  return p;
}

// 出来高ランキング取得（sector API失敗時の最終フォールバック用に残置）
async function fetchRanking(market){
  try{
    var res=await fetch(RANKING_API+"?market="+market,{signal:AbortSignal.timeout(15000)});
    if(!res.ok) throw new Error("ranking "+res.status);
    var json=await res.json();
    // ハイブリッド方式：volume・changeも受け取る
    var stocks=(json.stocks||[]).map(function(s){return{ticker:s.ticker,name:s.name,market:s.market,tvSymbol:s.tvSymbol,volume:s.volume||0,change:s.change||0};});
    return stocks.length>0?stocks:null;
  }catch(e){return null;}
}

// AI業種選定→J-Quants絞り込みランキング取得（メインの取得経路）
// manualSectors指定時はAIのweb_search選定をスキップし、指定業種のランキングのみ取得（トークン節約）
async function fetchSectorRanking(manualSectors){
  try{
    var url=SECTOR_API;
    if(manualSectors&&manualSectors.length){url+="?sectors="+encodeURIComponent(manualSectors.join(","));}
    var res=await fetch(url,{signal:AbortSignal.timeout(25000)});
    if(!res.ok) throw new Error("sector "+res.status);
    var json=await res.json();
    var stocks=(json.stocks||[]).map(function(s){return{ticker:s.ticker,name:s.name,market:s.market,tvSymbol:s.tvSymbol,volume:s.volume||0,change:s.change||0};});
    return{stocks:stocks.length>0?stocks:null,sectors:json.sectors||[]};
  }catch(e){return{stocks:null,sectors:[]};}
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

// 15分足データ取得（メイン分析用・60日分）
async function fetchYahoo(ticker){
  var now=Date.now();
  if(CACHE[ticker]&&now-CACHE[ticker].ts<CACHE_TTL){var cached=CACHE[ticker].data;return{closes:cached.closes.slice(),highs:cached.highs.slice(),lows:cached.lows.slice(),volumes:cached.volumes?cached.volumes.slice():[],currentPrice:cached.currentPrice,previousClose:cached.previousClose,real:cached.real,per:cached.per,pbr:cached.pbr,analystTarget:cached.analystTarget,earningsDate:cached.earningsDate,exRightsDate:cached.exRightsDate,topixChange:cached.topixChange};}
  var res=await fetch(VERCEL_API+"?ticker="+encodeURIComponent(ticker)+"&range=60d",{signal:AbortSignal.timeout(25000),cache:"no-store"});
  if(!res.ok) throw new Error("HTTP "+res.status);
  var json=await res.json();
  var result=json&&json.chart&&json.chart.result&&json.chart.result[0];
  if(!result) throw new Error("empty");
  var q=result.indicators.quote[0],meta=result.meta;
  function fill(arr){var out=(arr||[]).slice();for(var j=0;j<out.length;j++)if(out[j]==null)out[j]=j>0?out[j-1]:0;return out;}
  var per=result.per||null,pbr=result.pbr||null,analystTarget=result.analystTarget||null,earningsDate=result.earningsDate||null,exRightsDate=result.exRightsDate||null,topixChange=result.topixChange!=null?result.topixChange:null;
  var filledClose=fill(q.close);
  var data={closes:filledClose,highs:fill(q.high),lows:fill(q.low),volumes:fill(q.volume),currentPrice:meta.regularMarketPrice||filledClose[filledClose.length-1],previousClose:meta.chartPreviousClose||0,real:true,per:per,pbr:pbr,analystTarget:analystTarget,earningsDate:earningsDate,exRightsDate:exRightsDate,topixChange:topixChange};
  CACHE[ticker]={ts:now,data:data};
  return{closes:data.closes.slice(),highs:data.highs.slice(),lows:data.lows.slice(),volumes:data.volumes.slice(),currentPrice:data.currentPrice,previousClose:data.previousClose,real:data.real,per:data.per,pbr:data.pbr,analystTarget:data.analystTarget,earningsDate:data.earningsDate,exRightsDate:data.exRightsDate,topixChange:data.topixChange};
}


// 取得失敗（タイムアウト等）の場合、1回だけ自動で再試行。それでもダメならシミュレーションデータで代替
async function fetchYahooSafe(ticker){
  try{return await fetchYahoo(ticker);}
  catch(err){
    try{return await fetchYahoo(ticker);}
    catch(err2){return genSim(ticker);}
  }
}

function genSim(ticker){
  var h=0;for(var i=0;i<ticker.length;i++)h=(Math.imul(31,h)+ticker.charCodeAt(i))|0;
  var s=Math.abs(h);function rng(){s=(s*1664525+1013904223)&0x7fffffff;return s/0x7fffffff;}
  var price=rng()*400+60,closes=[],highs=[],lows=[];
  for(var d=0;d<63;d++){var v=rng()*0.025;price=Math.max(5,price*(1+rng()*0.006-0.003+(rng()-0.5)*v));closes.push(price);highs.push(price*(1+rng()*0.008));lows.push(price*(1-rng()*0.008));}
  return{closes:closes,highs:highs,lows:lows,currentPrice:price,previousClose:closes[closes.length-2],real:false};
}

// ── トレードシミュレーター（仮想売買の記録・検証）───────────────────────────
// 「アプリ予想」＝アプリのシグナル判断に従った場合の検証、「個人予想」＝アプリの判断と異なる自分の判断の検証
function fmtMoney(v,isJP){return isJP?"¥"+Math.round(v).toLocaleString():"$"+v.toFixed(2);}
function fmtPnl(v,isJP){var sign=v>=0?"+":"";return isJP?sign+"¥"+Math.round(v).toLocaleString():sign+"$"+v.toFixed(2);}

function tradeStorageKey(kind){return kind==="app"?"trade_app_v1":"trade_personal_v1";}
function loadTrades(kind){try{var v=localStorage.getItem(tradeStorageKey(kind));return v?JSON.parse(v):[];}catch(e){return[];}}
function saveTrades(kind,list){try{localStorage.setItem(tradeStorageKey(kind),JSON.stringify(list));}catch(e){}}

// 買い判定の方向を決める：登録時の価格より安ければ「下値待ち（指値買い）」、高ければ「上抜け待ち（逆指値買い）」
function getBuyDirection(t){
  if(t.buyDirection)return t.buyDirection;
  if(t.lastPrice!=null)return t.buyPrice<=t.lastPrice?"down":"up";
  return "down";
}

function addTradeRecord(kind,s,buyPrice,sellPrice,shares,stopPrice){
  var list=loadTrades(kind);
  var curPrice=s.rawPrice!=null?s.rawPrice:null;
  list.push({
    id:"t"+Date.now()+Math.random().toString(36).slice(2,6),
    ticker:s.ticker,name:s.name,market:s.market,
    buyPrice:buyPrice,sellPrice:sellPrice,
    stopPrice:(stopPrice!=null&&stopPrice>0)?stopPrice:null, // 損切り価格（任意）
    shares:shares>0?shares:1,
    buyDirection:curPrice!=null?(buyPrice<=curPrice?"down":"up"):"down",
    status:"waiting", // waiting(待機中) → active(進行中) → done(完了)
    startPrice:null,startAt:null,endPrice:null,endAt:null,
    pnl:null,pnlPercent:null,exitReason:null, // take_profit(利確) / stop_loss(損切り) / forced(強制完了)
    signalAtAdd:s.timing||null, // 登録時点のアプリ判定（BUY/WATCH/SKIP）＝後から検証するための記録
    lastPrice:curPrice,
    addedAt:new Date().toISOString()
  });
  saveTrades(kind,list);
  return list;
}
function removeTradeRecord(kind,id){var list=loadTrades(kind).filter(function(t){return t.id!==id;});saveTrades(kind,list);return list;}

// 売買価格・株数・損切り価格の編集（進行中・完了済みの場合は開始/終了価格や損益も再計算）
function editTradeRecord(kind,id,updates){
  var list=loadTrades(kind).map(function(t){
    if(t.id!==id)return t;
    var next=Object.assign({},t,updates);
    if(t.status==="waiting"&&updates.buyPrice!=null&&t.lastPrice!=null){
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
    var cur=priceMap[t.ticker];
    if(cur==null)return t;
    if(t.status==="waiting"){
      var dir=getBuyDirection(t);
      var reached=dir==="down"?cur<=t.buyPrice:cur>=t.buyPrice;
      if(reached){
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
  return "あなたは株式トレードのアナリストです。以下の銘柄データを分析して、日本語で簡潔に解説してください。\n\n"+
    "銘柄: "+s.ticker+" ("+s.name+")\n市場: "+s.market+"\n現在値: "+s.price+"\n前日比: "+s.change+"%\n"+
    "総合スコア: "+s.score+"/100\nトレードタイプ: "+s.tradeLabel+"\n"+
    "52週高値比: "+s.fromHigh.toFixed(1)+"%\n52週安値比: "+(s.fromLow>=0?"+":"")+s.fromLow.toFixed(1)+"%\n"+
    "52週ポジション: "+s.position52.toFixed(0)+"% (0%=安値圏 100%=高値圏)\n"+
    "ATR(14日): "+(isJP?"¥":"$")+s.atr+" / 想定値幅: "+(isJP?"¥":"$")+s.atrLower+"〜"+(isJP?"¥":"$")+s.atrUpper+"\n"+
    relPart+
    histPart+
    "シグナル:\n"+s.signals.map(function(sig){return"  "+sig.label+": "+sig.val;}).join("\n")+"\n\n"+
    "以下のトレード判断を数値で答えてください:\n1. 📌 今日中に買うべきか / 見送るべきか（理由を2文で）\n2. 💰 entry: 具体的な買いレンジ（買いを検討すべき価格帯）\n3. 🎯 target: 利確ライン（ATR比での根拠も添えて）\n4. 🛑 stop: 損切りライン（サポートやBB下限など根拠も添えて）\n5. 🔮 今後の見通し: 必ずWeb検索でこの銘柄の最新ニュース・決算・材料を調べた上で、今後数日〜1週間程度で上昇/下落/中立のどれに向かいやすいかを予想し、確信度と根拠を1〜2文で述べてください\n\n"+
    "最後の行に必ずこの形式のみでJSONを出力してください（説明不要）:\n{\"entry\":"+(isJP?"整数":"小数")+",\"target\":"+(isJP?"整数":"小数")+",\"stop\":"+(isJP?"整数":"小数")+",\"forecast\":{\"direction\":\"上昇 or 下落 or 中立\",\"confidence\":整数0〜100,\"timeframe\":\"文字列\",\"reason\":\"文字列\"}}";
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
async function callAiAnalysis(s,setAiText,setAiEntry,setAiLoading){
  try{
    var res=await fetch(AI_API_URL,{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        prompt:buildAiPrompt(s),
        system:"必ず自分でWeb検索ツールを使って、この銘柄の最新ニュース・材料を確認してから回答してください。ユーザーに質問や確認を求めず、自律的に分析を完了してください。",
        useWebSearch:true
      }),signal:AbortSignal.timeout(45000)});
    var aiData=await res.json();
    if(aiData.error) throw new Error(typeof aiData.error==="string"?aiData.error:JSON.stringify(aiData.error));
    var aiText2=typeof aiData.text==="string"?aiData.text:JSON.stringify(aiData.text)||"";
    // 末尾の{...}ブロックを探してJSON.parseする（ネスト・配列値にも対応）
    var cleanText=aiText2.replace(/```json[\s\S]*?```/g,"");
    var braceIdx=cleanText.lastIndexOf("{");
    var parsed=null;
    if(braceIdx!==-1){
      try{parsed=JSON.parse(cleanText.slice(braceIdx));}catch(je){}
    }
    if(parsed&&typeof parsed.entry!=="undefined"){
      setAiEntry(parsed);
      cleanText=cleanText.slice(0,braceIdx);
    }
    setAiText(cleanText.trim()||"分析できませんでした。");
  }catch(e){setAiText("エラーが発生しました: "+(e.message||JSON.stringify(e)||"不明なエラー"));}
  setAiLoading(false);
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
// 上位足の方向判定。factor本ごとに間引いた擬似終値列でEMA5/13クロスを見る（1:上昇 -1:下降 0:横ばい/データ不足）
function resampleDir(closes,factor){var arr=[];for(var i=closes.length-1;i>=0&&arr.length<40;i-=factor){arr.unshift(closes[i]);}if(arr.length<14)return 0;var e5=calcEMA(arr,5),e13=calcEMA(arr,13),m=arr.length-1;return e5[m]>e13[m]?1:(e5[m]<e13[m]?-1:0);}

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
    var won=nxt.p>cur.p;
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

// 1銘柄分のscoreHistから、シグナルごとの勝敗数をstatsに積算する
// daysAfter: 何営業日後の価格と比較するか(scoreHistの記録間隔=1エントリ想定)
function accumulateSignalStats(hist,daysAfter,stats){
  for(var i=0;i<hist.length-daysAfter;i++){
    var cur=hist[i],nxt=hist[i+daysAfter];
    if(cur.p==null||nxt.p==null||!cur.sig) continue;
    var won=nxt.p>cur.p;
    cur.sig.forEach(function(key){
      if(!stats[key])stats[key]={w:0,t:0};
      stats[key].t++;
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
    return{signal:k,winRate:s.t>0?Math.round(s.w/s.t*100):null,total:s.t};
  }).sort(function(a,b){return(b.winRate||0)-(a.winRate||0);});
}
// お気に入り登録銘柄全体で集計（お気に入りタブ用）
function calcFavSignalAccuracy(){
  var favList=(function(){try{return JSON.parse(localStorage.getItem("fav_tickers")||"[]");}catch(e){return[];}})();
  return calcSignalAccuracy(favList);
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
  // JP: J-Quants 1分足・30営業日（1日≒390本 東証9:00-15:30）
  //     20日相当=390×20=7800本だが取得は30日≒11700本
  //     実用上はバー数上限に合わせて縮小定義
  // US: Yahoo Finance 15分足（1日≒26本）・60日分≒1560本
  var isJP=stock.market==="JP";
  // JP:1分足/20日(1日≒390本) / US:5分足/30日(1日≒78本)
  var DAY_BARS   =isJP?390 :78;    // 1日あたりのバー数
  var RSI_P      =isJP?5460:1092;  // JP:14日相当 / US:14日相当
  var BB_P       =isJP?7800:1560;  // JP:20日 / US:20日
  var STOCH_P    =isJP?5460:1092;  // JP:14日相当 / US:14日相当
  var RECENT_BARS=isJP?7800:1560;  // JP:20日 / US:20日
  var BB_LOOKBACK_S=isJP?1950:390; // short: 約5日相当
  var BB_LOOKBACK_M=isJP?3900:780; // mid:   約10日相当
  var BB_LOOKBACK_L=isJP?7800:1560;// stable: 約20日相当
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

  // ── VWAP・ピボット計算 ─────────────────────────────────────────────────────
  var vwap=volumes.length>0?calcVWAP(closes,highs,lows,volumes):null;
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

  var dispPrice=stock.market==="JP"?"¥"+Math.round(price).toLocaleString():"$"+price.toFixed(2);
  // 52週相当: 60日分データの全体を使用
  var yearData=closes.slice(-YEAR_BARS);
  var high52=yearData.length>0?Math.max.apply(null,yearData):price;
  var low52=yearData.length>0?Math.min.apply(null,yearData):price;
  var fromHigh=high52>0?((price-high52)/high52*100):0;
  var fromLow=low52>0?((price-low52)/low52*100):0;
  var range52=high52-low52||1;
  var position52=((price-low52)/range52*100);

  // ── トレードタイプ先行判定（BB収束本数に使用）──────────────────────────
  var yearData0=closes.slice(-YEAR_BARS);
  var high52_0=yearData0.length>0?Math.max.apply(null,yearData0):price;
  var low52_0=yearData0.length>0?Math.min.apply(null,yearData0):price;
  var yearRange0=high52_0>0?(high52_0-low52_0)/low52_0*100:0;
  var recentC0=closes.slice(-RECENT_BARS);
  var avgDC0=0;
  if(recentC0.length>1){var tc0=0;for(var di=1;di<recentC0.length;di++)tc0+=Math.abs((recentC0[di]-recentC0[di-1])/recentC0[di-1]*100);avgDC0=tc0/(recentC0.length-1);}
  var absChg0=Math.abs(pd.previousClose?((price-pd.previousClose)/pd.previousClose*100):0);
  var tradeType0=yearRange0>=60||avgDC0>=2||absChg0>=5?"short":yearRange0>=25||avgDC0>=1||absChg0>=2?"mid":"stable";
  var bbLookback=tradeType0==="short"?BB_LOOKBACK_S:tradeType0==="mid"?BB_LOOKBACK_M:BB_LOOKBACK_L;

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

  var recentCloses=closes.slice(-RECENT_BARS); // 20日相当
  var avgDailyChange=0;
  if(recentCloses.length>1){
    var totalChange=0;
    for(var dc=1;dc<recentCloses.length;dc++){
      totalChange+=Math.abs((recentCloses[dc]-recentCloses[dc-1])/recentCloses[dc-1]*100);
    }
    avgDailyChange=totalChange/(recentCloses.length-1);
  }
  var yearRange=high52>0?(high52-low52)/low52*100:0;
  var absChange=Math.abs(parseFloat(change));
  var tradeType,tradeLabel,tradeColor;
  if(yearRange>=60||avgDailyChange>=2||absChange>=5){
    tradeType="short";tradeLabel="⚡スキャル";tradeColor="#f43f5e";
  }else if(yearRange>=25||avgDailyChange>=1||absChange>=2){
    tradeType="mid";tradeLabel="📈デイトレ";tradeColor="#fbbf24";
  }else{
    tradeType="stable";tradeLabel="🌊スイング";tradeColor="#22d3a0";
  }

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
  // ────────────────────────────────────────────────────────────────────────

  // ── スコア履歴をlocalStorageに蓄積（自動・最大40日分）────────────────────
  var scoreHist=(function(){
    try{
      var key="sh_"+stock.ticker;
      var hist=JSON.parse(localStorage.getItem(key)||"[]");
      var today=new Date().toISOString().slice(0,10);
      var sigKeys=signals.map(function(x){return baseSigLabel(x.label)+"#"+x.state;});
      if(hist.length&&hist[hist.length-1].d===today){
        hist[hist.length-1]={d:today,s:sc,atr:atr,p:price,sig:sigKeys};
      }else{
        hist.push({d:today,s:sc,atr:atr,p:price,sig:sigKeys});
        if(hist.length>40)hist.shift();
      }
      localStorage.setItem(key,JSON.stringify(hist));
      return hist;
    }catch(e){return[];}
  })();
  // ────────────────────────────────────────────────────────────────────────

  return{ticker:stock.ticker,tvSymbol:stock.tvSymbol,name:stock.name,market:stock.market,
    volume:stock.volume||0,volSurge:(typeof surge!=="undefined"?surge:1),
    price:dispPrice,rawPrice:pd.real?price:null,score:sc,winRate:winRate.toFixed(1),expVal:expVal,
    timing:timing,signals:signals,breakdown:breakdown,change:change,spark:closes.slice(-30),
    real:pd.real,closes:closes,highs:highs,lows:lows,volumes:volumes,per:pd.per||null,pbr:pd.pbr||null,
    analystTarget:pd.analystTarget||null,earningsDate:resolveEventDate(stock.ticker,"earningsDate",pd.earningsDate||null),exRightsDate:resolveEventDate(stock.ticker,"exRightsDate",pd.exRightsDate||null),weekHigh:weekHigh,weekLow:weekLow,
    topixChange:topixChange,relStrength:relStrength,
    high52:high52,low52:low52,fromHigh:fromHigh,fromLow:fromLow,position52:position52,
    overlapLabels:overlapLabels,
    tradeType:tradeType,tradeLabel:tradeLabel,tradeColor:tradeColor,
    aptScore:aptScore,
    atr:atr,atrUpper:atrUpper,atrLower:atrLower,support:support,
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
// 土日等でデータが直近の取引日のものになっている場合は、日付ラベルを添えて分かるようにする。
var WEEKDAY_JA=["日","月","火","水","木","金","土"];
function formatChartDateLabel(isoDate){
  if(!isoDate) return "";
  var d=new Date(isoDate+"T00:00:00");
  var today=new Date();
  var isToday=d.getFullYear()===today.getFullYear()&&d.getMonth()===today.getMonth()&&d.getDate()===today.getDate();
  if(isToday) return "";
  return (d.getMonth()+1)+"/"+d.getDate()+"("+WEEKDAY_JA[d.getDay()]+")時点";
}
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
  var closes=data.closes,dates=data.dates||[];
  var W=100;
  var mn=Math.min.apply(null,closes),mx=Math.max.apply(null,closes);
  var rng=mx-mn||1;
  function toY(v){return H-((v-mn)/rng)*(H-4)-2;}
  function toX(i){return(i/(closes.length-1))*(W-1);}
  var pts=closes.map(function(v,i){return toX(i)+","+toY(v);}).join(" ");
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
function IntradayChart1m(p){
  var data=p.data,H=140;
  var wrapStyle={height:H+16,display:"flex",alignItems:"center",justifyContent:"center"};
  if(data===undefined){
    return <div style={wrapStyle}><span style={{fontSize:9,color:"#2a4060"}}>読込中…</span></div>;
  }
  if(data===null||!data.m1||!data.m1.closes||data.m1.closes.length<2){
    return <div style={wrapStyle}><span style={{fontSize:9,color:"#2a4060"}}>データなし</span></div>;
  }
  var fullCloses=data.m1.closes,fullTimes=data.m1.times||[];
  var dateLabel=formatChartDateLabel(data.date);
  // MAは全期間のデータで計算してから、表示だけ直近2時間（1分足120本）に絞る。
  // 表示範囲の先頭でも正しいMA値になるよう、計算は絞り込み前の配列に対して行う。
  var fullMa25=trailingSMA(fullCloses,25),fullMa75=trailingSMA(fullCloses,75);
  var cropStart=Math.max(0,fullCloses.length-120);
  var closes=fullCloses.slice(cropStart),times=fullTimes.slice(cropStart);
  var ma25=fullMa25.slice(cropStart),ma75=fullMa75.slice(cropStart);
  var W=100;
  // 縦軸はMAも同じ1分足由来の値なので価格と一緒に含めてよい（週足MAと違い値幅が近いため）
  var allVals=closes.concat(ma25.filter(function(v){return v!=null;})).concat(ma75.filter(function(v){return v!=null;}));
  var mn=Math.min.apply(null,allVals),mx=Math.max.apply(null,allVals);
  var rng=mx-mn||1;
  var pad=rng*0.1;
  mn-=pad;mx+=pad;rng=mx-mn||1;
  function toY(v){return H-((v-mn)/rng)*(H-4)-2;}
  function toX(i){return(i/(closes.length-1))*(W-1);}
  function toPts(arr){
    return arr.map(function(v,i){return v==null?null:toX(i)+","+toY(v);}).filter(function(v){return v!=null;}).join(" ");
  }
  var pts=toPts(closes),pts25=toPts(ma25),pts75=toPts(ma75);
  var lastMa25=ma25[ma25.length-1],lastMa75=ma75[ma75.length-1];
  var priceLevels=[mx, mn+rng*2/3, mn+rng/3, mn];
  var timeLabels=pickTimeLabels(times,5);
  if(dateLabel){
    var shortDate=formatShortDate(data.date);
    timeLabels=timeLabels.map(function(t){return {label:shortDate+" "+t.label,index:t.index};});
  }
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"#6a90b0",marginBottom:2}}>
        <span>1分足（直近2時間）</span>
        <span>{dateLabel}</span>
      </div>
      <div style={{display:"flex",gap:6}}>
        <div style={{flex:1,minWidth:0}}>
          <svg width="100%" height={H} viewBox={"0 0 "+W+" "+H} preserveAspectRatio="none" style={{display:"block"}}>
            {priceLevels.map(function(v,i){
              var y=toY(v);
              return <line key={i} x1={0} y1={y} x2={W} y2={y} stroke="#26344a" strokeWidth={0.5} strokeDasharray="2,2"/>;
            })}
            {pts75&&<polyline points={pts75} fill="none" stroke="#f472b6" strokeWidth={0.6}/>}
            {pts25&&<polyline points={pts25} fill="none" stroke="#a3e635" strokeWidth={0.6}/>}
            <polyline points={pts} fill="none" stroke="#e8eef5" strokeWidth={0.25} strokeLinejoin="round" strokeLinecap="round"/>
          </svg>
        </div>
        <div style={{width:52,flexShrink:0,display:"flex",flexDirection:"column",justifyContent:"space-between",fontSize:11,color:"#a8c0d8",textAlign:"right",height:H,paddingTop:2,paddingBottom:2,boxSizing:"border-box"}}>
          {priceLevels.map(function(v,i){return <span key={i}>{fmtPriceLabel(v,rng)}</span>;})}
        </div>
      </div>
      <div style={{display:"flex",gap:10,fontSize:10,marginTop:3,flexWrap:"wrap"}}>
        <span style={{color:"#a3e635"}}>― 25期MA{lastMa25!=null&&" "+fmtPriceLabel(lastMa25)}</span>
        <span style={{color:"#f472b6"}}>― 75期MA{lastMa75!=null&&" "+fmtPriceLabel(lastMa75)}</span>
      </div>
      {timeLabels.length>0&&<TimeLabelRow timeLabels={timeLabels} toX={toX} W={W} rightGutter={58}/>}
    </div>
  );
}

// ── シグナル詳細（カードの展開パネルとチャートモーダルで共通利用）────────
function SignalDetailList(p){
  var bd=(p.breakdown||[]).filter(function(b){return b.delta!==0;});
  var negatives=bd.filter(function(b){return b.delta<0;}).sort(function(a,b){return a.delta-b.delta;});
  var bdOpenS=useState(false);var bdOpen=bdOpenS[0],setBdOpen=bdOpenS[1];
  return(
    <div>
      {bd.length>0&&(
        <div style={{marginBottom:14}}>
          <div onClick={function(){setBdOpen(!bdOpen);}} style={{display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer",marginBottom:bdOpen?6:0}}>
            <div style={{fontSize:12,fontWeight:700,color:"#4a90c0"}}>🧮 スコア内訳（60点まで何が足りないか）</div>
            <span style={{color:"#4a7090",fontSize:12}}>{bdOpen?"▲":"▼"}</span>
          </div>
          {!bdOpen&&negatives.length>0&&(
            <div style={{fontSize:11,color:"#f87171",marginTop:4}}>
              ⬇️ 特に足を引っ張っている要因: {negatives.slice(0,2).map(function(b){return b.label+"("+b.delta+")";}).join("、")}
            </div>
          )}
          {bdOpen&&(
            <div>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                {bd.map(function(b,i){
                  var c=b.delta>0?"#22d3a0":"#f43f5e";
                  return(
                    <div key={i} style={{background:"#071428",borderRadius:6,padding:"5px 10px",display:"flex",justifyContent:"space-between",alignItems:"center",border:"1px solid #0f2040"}}>
                      <span style={{fontSize:11,color:"#4a7090"}}>{b.label}</span>
                      <span style={{fontSize:12,fontWeight:700,color:c}}>{b.delta>0?"+":""}{b.delta}</span>
                    </div>
                  );
                })}
              </div>
              {negatives.length>0&&(
                <div style={{fontSize:11,color:"#f87171",marginTop:6}}>
                  ⬇️ 特に足を引っ張っている要因: {negatives.slice(0,2).map(function(b){return b.label+"("+b.delta+")";}).join("、")}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <div style={{fontSize:12,fontWeight:700,color:"#4a90c0",marginBottom:6}}>📊 シグナル詳細</div>
      <div style={{display:"flex",flexDirection:"column",gap:4}}>
        {(p.signals||[]).filter(function(sig){return sig.label==="BB"||sig.label==="BB収束"||sig.label==="OBV"||sig.label==="出来高"||sig.label.startsWith("RSI");}).map(function(sig,i){
          return(
            <div key={i} style={{background:"#071428",borderRadius:6,padding:"6px 10px",display:"flex",justifyContent:"space-between",alignItems:"center",border:"1px solid #0f2040"}}>
              <span style={{fontSize:12,color:"#4a7090"}}>{sig.label}</span>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                <span style={{fontSize:12,fontWeight:700,color:stateColor(sig.state)}}>{sig.val}</span>
                <span style={{fontSize:8,color:stateColor(sig.state)}}>{stateLabel(sig.state)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ScoreRing(p){
  var sc=p.score,R=14,C=2*Math.PI*R,col=scoreColor(sc);
  return(
    <svg width={34} height={34} style={{flexShrink:0}}>
      <circle cx={17} cy={17} r={R} fill="none" stroke="#1e3050" strokeWidth={3}/>
      <circle cx={17} cy={17} r={R} fill="none" stroke={col} strokeWidth={3} strokeDasharray={C} strokeDashoffset={C-(sc/100)*C} strokeLinecap="round" transform="rotate(-90 17 17)"/>
      <text x={17} y={21} textAnchor="middle" fill={col} style={{fontSize:8,fontWeight:800,fontFamily:"monospace"}}>{sc}</text>
    </svg>
  );
}

function TabBtn(p){return(<button onClick={p.onClick} style={{background:p.active?p.color+"18":"transparent",border:"1px solid "+(p.active?p.color:"#1e3050"),borderRadius:6,color:p.active?p.color:"#4a6080",padding:"4px 10px",fontSize:12,cursor:"pointer",fontFamily:"monospace",fontWeight:p.active?700:400}}>{p.label}</button>);}

// ── StockCard ────────────────────────────────────────────────────────────────
// ── AI解説文中の銘柄コードをタップ可能にするヘルパー ──────────────────────
function renderReasonText(text,allStocks,onSelect){
  var known={};
  (allStocks||[]).forEach(function(x){known[x.ticker.replace(".T","")]=x;});
  return text.split(/(\d{4})/g).map(function(part,i){
    var stock=known[part];
    if(stock){
      return <span key={i} onClick={function(e){e.stopPropagation();onSelect(stock);}} style={{color:"#60a5fa",textDecoration:"underline",cursor:"pointer",fontWeight:700}}>{part}</span>;
    }
    return part;
  });
}

// ── 銘柄プレビューモーダル（AI解説文中の銘柄コードタップ時に表示）────────
function TickerPreviewModal(p){
  var s=p.stock,bc=BADGE[s.timing];
  return(
    <div onClick={function(e){if(e.target===e.currentTarget)p.onClose();}} style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.75)",zIndex:2100,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{background:"#040c18",border:"1px solid #60a5fa50",borderRadius:16,padding:16,width:"100%",maxWidth:340}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div style={{fontSize:13,fontWeight:700,color:"#60a5fa"}}>📌 {s.ticker.replace(".T","")}</div>
          <div style={{display:"flex",gap:4,alignItems:"center"}}>
            <a href="ispeed://" onClick={function(){var code=s.ticker.replace(".T","");if(navigator.clipboard){navigator.clipboard.writeText(code).catch(function(){});}}} title="銘柄コードをコピーしてiSPEEDを開く" style={{background:"transparent",border:"1px solid #f87171",borderRadius:6,color:"#fca5a5",padding:"3px 7px",fontSize:14,textDecoration:"none",lineHeight:1,display:"flex",alignItems:"center"}}>📱</a>
            <button onClick={p.onClose} style={{background:"transparent",border:"none",color:"#4a7090",fontSize:18,cursor:"pointer",lineHeight:1}}>✕</button>
          </div>
        </div>
        <div style={{fontSize:12,color:"#4a7090",marginBottom:8}}>{s.name}</div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",background:"#071428",borderRadius:8,padding:"8px 12px",marginBottom:8}}>
          <span style={{fontSize:16,fontWeight:800,color:"#d8eeff"}}>{s.price}</span>
          {s.real!==false&&<span style={{fontSize:13,fontWeight:700,color:parseFloat(s.change)>=0?"#22d3a0":"#f43f5e"}}>{parseFloat(s.change)>=0?"▲":"▼"}{Math.abs(s.change)}%</span>}
        </div>
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          <span style={{fontSize:12,color:"#4a7090"}}>スコア <span style={{color:scoreColor(s.score),fontWeight:700}}>{s.score}</span></span>
          {bc&&<span style={bStyle(bc.bg,bc.border,bc.text)}>{bc.label}</span>}
        </div>
      </div>
    </div>
  );
}

// ── トレード登録モーダル（買い/売り価格を入力し、アプリ予想 or 個人予想へ追加）─────
function TradeAddModal(p){
  var s=p.s;
  var buyS=useState(s.rawPrice!=null?String(s.rawPrice):"");var buyVal=buyS[0],setBuyVal=buyS[1];
  var sellS=useState("");var sellVal=sellS[0],setSellVal=sellS[1];
  var stopS=useState("");var stopVal=stopS[0],setStopVal=stopS[1];
  var sharesS=useState("100");var sharesVal=sharesS[0],setSharesVal=sharesS[1];
  var isJP=s.market==="JP";
  var inp={background:"#040c18",border:"1px solid #1e4070",borderRadius:5,color:"#b8cce0",padding:"8px",fontSize:14,fontFamily:"monospace",width:"100%",boxSizing:"border-box"};
  function valid(){
    var b=parseFloat(buyVal),se=parseFloat(sellVal),sh=parseInt(sharesVal);
    if(isNaN(b)||b<=0||isNaN(se)||se<=0||isNaN(sh)||sh<=0)return false;
    if(stopVal!==""){var sp=parseFloat(stopVal);if(isNaN(sp)||sp<=0||sp>=se)return false;}
    return true;
  }
  function add(kind){
    if(!valid())return;
    p.onAddTrade(kind,s,parseFloat(buyVal),parseFloat(sellVal),parseInt(sharesVal),stopVal!==""?parseFloat(stopVal):null);
    p.onClose();
  }
  return(
    <div onClick={function(e){if(e.target===e.currentTarget)p.onClose();}} style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.75)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{background:"#040c18",border:"1px solid #0ea5e950",borderRadius:16,padding:"16px",width:"100%",maxWidth:420}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
          <div style={{fontSize:13,fontWeight:700,color:"#0ea5e9"}}>🎯 トレード登録 - {s.ticker.replace(".T","")}</div>
          <button onClick={p.onClose} style={{background:"transparent",border:"none",color:"#4a7090",fontSize:18,cursor:"pointer",lineHeight:1}}>✕</button>
        </div>
        <div style={{fontSize:11,color:"#4a7090",marginBottom:12}}>価格が指定値に到達すると自動で開始・終了します（判定はトレードタブの更新ボタンで反映）</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:8}}>
          <div><div style={{fontSize:11,color:"#22d3a0",marginBottom:3}}>買い価格</div><input style={inp} type="number" value={buyVal} onChange={function(e){setBuyVal(e.target.value);}}/></div>
          <div><div style={{fontSize:11,color:"#f43f5e",marginBottom:3}}>売り価格（利確）</div><input style={inp} type="number" value={sellVal} onChange={function(e){setSellVal(e.target.value);}}/></div>
          <div><div style={{fontSize:11,color:"#4a7090",marginBottom:3}}>株数</div><input style={inp} type="number" value={sharesVal} onChange={function(e){setSharesVal(e.target.value);}}/></div>
        </div>
        <div style={{marginBottom:14}}>
          <div style={{fontSize:11,color:"#fbbf24",marginBottom:3}}>損切り価格（任意・売り価格より低い値）</div>
          <input style={inp} type="number" value={stopVal} onChange={function(e){setStopVal(e.target.value);}} placeholder="未設定でもOK"/>
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
    <div onClick={function(e){if(e.target===e.currentTarget)onClose();}} style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.6)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
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
  var bc=BADGE[s.timing],mc=MKT[s.market]||MKT["US"],isUp=parseFloat(s.change)>=0;
  var expandedS=useState(false);var expanded=expandedS[0],setExpanded=expandedS[1];
  var showSimS=useState(false);var showSim=showSimS[0],setShowSim=showSimS[1];
  var showTradeS=useState(false);var showTrade=showTradeS[0],setShowTrade=showTradeS[1];
  var showCorrS=useState(false);var showCorr=showCorrS[0],setShowCorr=showCorrS[1];
  var simSharesS=useState("100");var simShares=simSharesS[0],setSimShares=simSharesS[1];
  var simBuyS=useState(s.rawPrice?s.rawPrice.toFixed(2):"");var simBuy=simBuyS[0],setSimBuy=simBuyS[1];
  var simTargetS=useState(3);var simTarget=simTargetS[0],setSimTarget=simTargetS[1];
  var simStopS=useState(-5);var simStop=simStopS[0],setSimStop=simStopS[1];
  var simTargetInputS=useState("3");var simTargetInput=simTargetInputS[0],setSimTargetInput=simTargetInputS[1];
  var simStopInputS=useState("-5");var simStopInput=simStopInputS[0],setSimStopInput=simStopInputS[1];
  var showAiS=useState(false);var showAi=showAiS[0],setShowAi=showAiS[1];
  var aiTextS=useState("");var aiText=aiTextS[0],setAiText=aiTextS[1];
  var aiLoadingS=useState(false);var aiLoading=aiLoadingS[0],setAiLoading=aiLoadingS[1];
  var aiBoxRef=useRef(null);
  useEffect(function(){
    if(showAi&&aiBoxRef.current) aiBoxRef.current.scrollIntoView({behavior:"smooth",block:"start"});
  },[showAi]);

  // ── チャート（カードが選択/展開された時だけ取得＝体感速度・API負荷を改善）───
  // daily: カードのミニチャート用（日足）。false=未取得, undefined=読込中, null=データなし
  // intraday: モバイル展開パネルのチャート用（1分足）。同上
  var dailyS=useState(false);var daily=dailyS[0],setDaily=dailyS[1];
  var intradayS=useState(false);var intraday=intradayS[0],setIntraday=intradayS[1];

  var borderColor=s.score>=58?"#22d3a0":s.score>=38?"#fbbf24":"#f43f5e";
  var pos52=s.position52!=null?Math.min(98,Math.max(2,s.position52)):null;
  var pos52Color=pos52!=null?(pos52<=25?"#22d3a0":pos52<=75?"#fbbf24":"#f43f5e"):null;
  var fromHighColor=s.fromHigh>=-10?"#f43f5e":s.fromHigh>=-30?"#fbbf24":"#22d3a0";
  var fromLowColor=s.fromLow<=20?"#22d3a0":s.fromLow<=50?"#fbbf24":"#f43f5e";

  function stopProp(e){e.stopPropagation();}

  var aiEntryS=useState(null);var aiEntry=aiEntryS[0],setAiEntry=aiEntryS[1];

  async function runAiAnalysis(e){
    stopProp(e);
    if(aiLoading) return;
    setShowAi(true);setAiLoading(true);setAiText("");setAiEntry(null);
    await callAiAnalysis(s,setAiText,setAiEntry,setAiLoading);
  }

  // ── 逆相関銘柄予想（下落中の銘柄を見ている時だけ算出）───────────────────
  var corrListS=useState([]);var corrList=corrListS[0],setCorrList=corrListS[1];
  var corrLoadingS=useState(false);var corrLoading=corrLoadingS[0],setCorrLoading=corrLoadingS[1];
  var corrErrorS=useState("");var corrError=corrErrorS[0],setCorrError=corrErrorS[1];
  var corrFetchedS=useState(false);var corrFetched=corrFetchedS[0],setCorrFetched=corrFetchedS[1];
  var corrReasonS=useState("");var corrReason=corrReasonS[0],setCorrReason=corrReasonS[1];
  var corrReasonLoadingS=useState(false);var corrReasonLoading=corrReasonLoadingS[0],setCorrReasonLoading=corrReasonLoadingS[1];
  var previewStockS=useState(null);var previewStock=previewStockS[0],setPreviewStock=previewStockS[1];
  useEffect(function(){
    setCorrList([]);setCorrReason("");setCorrError("");setCorrFetched(false);
  },[s&&s.ticker]);

  function runCorrFetch(e){
    if(e) stopProp(e);
    if(corrLoading||!s) return;
    var candidates=(p.allStocks||[]).map(function(x){return x.ticker;}).filter(function(t){return t!==s.ticker;}).slice(0,60);
    setCorrError("");setCorrList([]);
    if(!candidates.length){setCorrFetched(true);return;}
    setCorrLoading(true);
    fetch(CORRELATION_API+"?ticker="+encodeURIComponent(s.ticker)+"&candidates="+encodeURIComponent(candidates.join(",")),{signal:AbortSignal.timeout(20000)})
      .then(function(r){return r.json();})
      .then(function(json){
        if(json.error){setCorrError(json.error);return;}
        setCorrList(json.results||[]);
      })
      .catch(function(){setCorrError("通信エラー");})
      .finally(function(){setCorrLoading(false);setCorrFetched(true);});
  }

  async function runCorrReason(e){
    stopProp(e);
    if(corrReasonLoading||!corrList.length) return;
    setCorrReasonLoading(true);setCorrReason("");
    var names=corrList.map(function(c){return c.ticker.replace(".T","");}).join("、");
    var prompt="銘柄"+s.ticker.replace(".T","")+"("+s.name+")が下落した場合に、過去の値動きデータ上「逆相関」が確認された次の銘柄が上昇しやすい理由を、競合関係・代替需要・資金シフトなどの観点から1銘柄につき1〜2文で日本語で簡潔に説明してください。断定を避け「〜の可能性があります」等の表現にしてください。\n対象銘柄: "+names;
    try{
      var res=await fetch(AI_API_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt:prompt,system:"あなたは個人投資家向けの株式アナリストです。与えられた銘柄同士の逆相関関係について、簡潔で分かりやすい日本語の解説のみを出力してください。"}),signal:AbortSignal.timeout(20000)});
      var json=await res.json();
      setCorrReason(json.text||"");
    }catch(err){setCorrReason("取得に失敗しました");}
    finally{setCorrReasonLoading(false);}
  }

  var promptCopiedS=useState(false);var promptCopied=promptCopiedS[0],setPromptCopied=promptCopiedS[1];
  function copyTradePrompt(e){
    stopProp(e);
    if(!navigator.clipboard) return;
    navigator.clipboard.writeText(buildVolumeRankingPrompt([s],1,false)).then(function(){
      setPromptCopied(true);
      setTimeout(function(){setPromptCopied(false);},2000);
    }).catch(function(){});
  }

  var isMobile=window.innerWidth<768;
  var isSelected=!isMobile&&p.selectedStock&&p.selectedStock.ticker===s.ticker;

  // 選択（デスクトップ）または展開（モバイル）＝「この銘柄を見ている」時だけ日足を取得
  useEffect(function(){
    if(!isSelected&&!(isMobile&&expanded)) return;
    if(daily===false||daily===null){
      setDaily(undefined);
      fetchDaily(s.ticker).then(function(r){setDaily(r);});
    }
    if(onRescan) onRescan(s.ticker); // 価格・判定バッジもチャートと同様に毎回最新化
  },[isSelected,expanded]);

  // モバイル展開パネルのチャート（1分足）はモバイルで展開された時だけ取得
  // （デスクトップ版の同等表示はStockDetailPanel側で独自に取得するため不要）
  useEffect(function(){
    if(!(isMobile&&expanded)) return;
    if(intraday===false||intraday===null){
      setIntraday(undefined);
      fetchIntraday(s.ticker).then(function(r){setIntraday(r);});
    }
  },[expanded]);

  var cardBorder=isSelected?"#60a5fa":borderColor;

  return(
    <div style={{background:isSelected?"#071e38":"#050e1c",border:"none",borderRadius:10,padding:"10px",display:"flex",flexDirection:"column",gap:7,cursor:"pointer",minWidth:0}}
      onClick={function(){
        if(!isMobile){if(p.setSelectedStock)p.setSelectedStock(s);}
        else{setExpanded(function(v){return !v;});}
      }}>
      <div style={{display:"flex",gap:6,alignItems:"center",justifyContent:"space-between"}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",gap:4,alignItems:"center"}}>
            <div style={{fontSize:17,fontWeight:800,color:borderColor,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.ticker.replace(".T","")}</div>
            <button onClick={function(e){stopProp(e);toggleFav(s.ticker);}} style={{background:"transparent",border:"none",fontSize:15,cursor:"pointer",padding:0,color:isFav(s.ticker)?"#fbbf24":"#2a4060",flexShrink:0}}>{isFav(s.ticker)?"★":"☆"}</button>
          </div>
          <div style={{fontSize:11,color:"#4a7090",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.name}</div>
          {(function(){var ei=earningsInfo(s.earningsDate);return ei&&<span style={bStyle(ei.urgent?"#3a0a0a":"#1c1400","1px solid "+(ei.urgent?"#f43f5e":"#fbbf24"),ei.urgent?"#f87171":"#fbbf24")} title={"決算発表: "+ei.date}>📈決算{ei.label}</span>;})()}
          {(function(){var xi=exRightsInfo(s.exRightsDate);return xi&&<span style={bStyle("#0a1a3a","1px solid #3b82f6","#60a5fa")} title={"権利落ち予想: "+xi.date}>💰権利落ち(予想){xi.label}</span>;})()}
          {(function(){var ri=relStrengthInfo(s.relStrength);return ri&&<span style={bStyle(ri.strong?"#052e16":"#1f0010","1px solid "+(ri.strong?"#22d3a0":"#f43f5e"),ri.strong?"#22d3a0":"#f43f5e")} title={"対TOPIX相対(前日比差): "+ri.label}>{ri.strong?"🔥対TOPIX":"🧊対TOPIX"}{ri.label}</span>;})()}
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
            <div style={{fontSize:14,color:"#d8eeff",fontWeight:800}}>{s.price}</div>
            {s.real!==false&&<div style={{fontSize:11,color:isUp?"#22d3a0":"#f43f5e"}}>{isUp?"▲":"▼"}{Math.abs(s.change)}%</div>}
          </div>
        </div>
      </div>

      <div style={{background:"#03080f",borderRadius:6,padding:"2px 4px"}}>
        <DailyMiniChart data={daily}/>
      </div>

      {isMobile&&<div style={{textAlign:"center",fontSize:11,color:"#2a4060"}}>{expanded?"▲ 閉じる":"▼ 詳細を見る"}</div>}

      {isMobile&&expanded&&(
        <div onClick={stopProp} style={{borderTop:"1px solid #0f2040",paddingTop:10,display:"flex",flexDirection:"column",gap:10}}>

          <div style={{display:"flex",gap:4,alignItems:"center",justifyContent:"flex-end"}}>
            <button onClick={copyTradePrompt} title="判定プロンプトをコピー" style={{background:promptCopied?"#052e16":"transparent",border:"1px solid "+(promptCopied?"#22d3a0":"#2a4060"),borderRadius:6,color:promptCopied?"#22d3a0":"#4a7090",padding:"4px 9px",fontSize:14,cursor:"pointer"}}>{promptCopied?"✓":"📋"}</button>
            <button onClick={function(e){stopProp(e);if(onRescan&&!rescanLoading)onRescan(s.ticker);}} disabled={rescanLoading} style={{background:"transparent",border:"1px solid "+(rescanLoading?"#fbbf24":"#2a4060"),borderRadius:6,color:rescanLoading?"#fbbf24":"#4a7090",padding:"4px 9px",fontSize:14,cursor:rescanLoading?"not-allowed":"pointer"}}>{rescanLoading?"⏳":"🔄"}</button>
            <button onClick={runAiAnalysis} disabled={aiLoading} style={{background:"transparent",border:"1px solid "+(aiLoading?"#22d3a0":"#2a4060"),borderRadius:6,color:aiLoading?"#22d3a0":"#4a7090",padding:"4px 9px",fontSize:14,cursor:aiLoading?"not-allowed":"pointer"}}>{aiLoading?"⏳":"🤖"}</button>
            <button onClick={function(e){stopProp(e);setShowSim(function(v){return !v;});}} style={{background:showSim?"#1a0a3a":"transparent",border:"1px solid "+(showSim?"#a78bfa":"#2a4060"),borderRadius:6,color:showSim?"#a78bfa":"#4a7090",padding:"4px 9px",fontSize:14,cursor:"pointer"}}>💹</button>
            <button onClick={function(e){stopProp(e);setShowTrade(function(v){return !v;});}} style={{background:showTrade?"#0a1a3a":"transparent",border:"1px solid "+(showTrade?"#0ea5e9":"#2a4060"),borderRadius:6,color:showTrade?"#0ea5e9":"#4a7090",padding:"4px 9px",fontSize:14,cursor:"pointer"}}>🎯</button>
            <button onClick={function(e){stopProp(e);if(isUp)return;setShowCorr(true);if(!corrFetched&&!corrLoading)runCorrFetch();}} disabled={isUp} title={isUp?"上昇中の銘柄では使用できません":"逆相関で上昇しやすい銘柄を調べる"} style={{background:"transparent",border:"1px solid "+(isUp?"#1a2c40":"#2a4060"),borderRadius:6,color:isUp?"#2a4a60":"#4a7090",padding:"4px 9px",fontSize:14,cursor:isUp?"not-allowed":"pointer"}}>🔀</button>
          </div>

          {/* チャート（1分足＋週足MA） */}
          <div style={{background:"#03080f",borderRadius:6,padding:"4px 6px"}}>
            <IntradayChart1m data={intraday}/>
          </div>

          {/* シグナル詳細 */}
          <SignalDetailList signals={s.signals} breakdown={s.breakdown}/>

          {showAi&&(
            <div ref={aiBoxRef} style={{background:"#040c18",border:"1px solid #22d3a040",borderRadius:10,padding:"12px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  <div style={{fontSize:12,fontWeight:700,color:"#22d3a0"}}>🤖 AI分析</div>
                  {s.scoreHist&&(<span style={{fontSize:9,padding:"1px 5px",borderRadius:4,
                    background:s.scoreHist.length>=7?"#052e16":s.scoreHist.length>=3?"#1c1400":"#1f0010",
                    color:s.scoreHist.length>=7?"#22d3a0":s.scoreHist.length>=3?"#fbbf24":"#f43f5e",
                    border:"1px solid "+(s.scoreHist.length>=7?"#22d3a0":s.scoreHist.length>=3?"#fbbf24":"#f43f5e")}}>
                    {s.scoreHist.length>=7?"精度◎":s.scoreHist.length>=3?"精度△("+s.scoreHist.length+"日)":"精度⚠️("+s.scoreHist.length+"日)"}
                  </span>)}
                </div>
                <button onClick={function(){setShowAi(false);setAiText("");}} style={{background:"transparent",border:"none",color:"#4a7090",fontSize:13,cursor:"pointer"}}>✕</button>
              </div>
              {aiLoading?(
                <div style={{textAlign:"center",padding:"12px 0"}}>
                  <div style={{fontSize:18}}>⏳</div>
                  <div style={{fontSize:12,color:"#4a90c0",marginTop:4}}>AIが分析中...</div>
                </div>
              ):(
                <div style={{fontSize:13,color:"#b8cce0",lineHeight:1.7,whiteSpace:"pre-wrap"}}>{aiText}</div>
              )}
              {!aiLoading&&aiEntry&&(
                <div style={{background:"#071428",border:"1px solid #4a90c040",borderRadius:8,padding:"8px 10px",marginTop:8}}>
                  <div style={{fontSize:11,fontWeight:700,color:"#4a90c0",marginBottom:6}}>🎯 AIエントリー提案</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
                    <div style={{background:"#052e16",border:"1px solid #22d3a040",borderRadius:6,padding:"5px 8px"}}>
                      <div style={{fontSize:10,color:"#22d3a0"}}>📥 エントリー</div>
                      <div style={{fontSize:14,fontWeight:800,color:"#22d3a0"}}>{s.market==="JP"?"¥"+Math.round(aiEntry.entry).toLocaleString():"$"+parseFloat(aiEntry.entry).toFixed(2)}</div>
                    </div>
                    <div style={{background:"#071e10",border:"1px solid #22d3a040",borderRadius:6,padding:"5px 8px"}}>
                      <div style={{fontSize:10,color:"#22d3a0"}}>🎯 利確</div>
                      <div style={{fontSize:14,fontWeight:800,color:"#22d3a0"}}>{s.market==="JP"?"¥"+Math.round(aiEntry.target).toLocaleString():"$"+parseFloat(aiEntry.target).toFixed(2)}</div>
                    </div>
                    <div style={{background:"#1f0010",border:"1px solid #f43f5e40",borderRadius:6,padding:"5px 8px"}}>
                      <div style={{fontSize:10,color:"#f43f5e"}}>🛑 損切り</div>
                      <div style={{fontSize:14,fontWeight:800,color:"#f43f5e"}}>{s.market==="JP"?"¥"+Math.round(aiEntry.stop).toLocaleString():"$"+parseFloat(aiEntry.stop).toFixed(2)}</div>
                    </div>
                  </div>
                </div>
              )}
              {!aiLoading&&aiEntry&&ForecastBox(aiEntry.forecast)}
              {!aiLoading&&aiText&&(
                <button onClick={runAiAnalysis} style={{marginTop:8,background:"transparent",border:"1px solid #1e4070",borderRadius:6,color:"#4a7090",padding:"4px 10px",fontSize:12,cursor:"pointer",fontFamily:"monospace",width:"100%"}}>🔄 再分析</button>
              )}
            </div>
          )}

          {s.support&&(
            <div style={{background:"#071428",border:"1px solid #2a4060",borderRadius:8,padding:"8px 10px"}}>
              <div style={{fontSize:11,fontWeight:700,color:"#fbbf24",marginBottom:6}}>📉 下値サポート目安</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
                {[["🟡 S1 20日",s.support.s1,"#fbbf24"],["🔴 S2 60日",s.support.s2,"#f43f5e"],["⚡ ATR×1.5",s.support.atrFloor,"#a78bfa"]].map(function(row){
                  return(
                    <div key={row[0]} style={{background:"#040c18",border:"1px solid #1e3050",borderRadius:6,padding:"5px 8px"}}>
                      <div style={{fontSize:9,color:row[2],marginBottom:2}}>{row[0]}</div>
                      <div style={{fontSize:13,fontWeight:800,color:row[2]}}>{s.market==="JP"?"¥"+row[1].toLocaleString():"$"+row[1]}</div>
                    </div>
                  );
                })}
              </div>
              <div style={{fontSize:10,color:"#2a5070",marginTop:5}}>S1割れ→S2、S2割れ→ATR下限が次の下値目安</div>
            </div>
          )}

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
            <a href={s.yahooUrl} target="_blank" rel="noreferrer" style={{background:"#071428",border:"1px solid #4f46e5",borderRadius:8,color:"#a5b4fc",padding:"10px",fontSize:12,fontWeight:700,fontFamily:"monospace",textDecoration:"none",textAlign:"center",display:"block"}}>🔗 Y!</a>
            <a href="ispeed://" onClick={function(){var code=s.ticker.replace(".T","");if(navigator.clipboard){navigator.clipboard.writeText(code).catch(function(){});}}} style={{background:"#1a0a0a",border:"1px solid #f87171",borderRadius:8,color:"#fca5a5",padding:"10px",fontSize:12,fontWeight:700,fontFamily:"monospace",textDecoration:"none",textAlign:"center",display:"block"}}>📱 iSPEED</a>
          </div>

          {showSim&&createPortal((function(){
            var bp=parseFloat(simBuy)||0;
            var sh=parseFloat(simShares)||0;
            var isJP=s.market==="JP";
            function fmtP(v){return isJP?"¥"+Math.round(v).toLocaleString():"$"+v.toFixed(2);}
            function fmtPnL(v){
              if(isJP) return(v>=0?"+":"")+"¥"+Math.round(Math.abs(v)).toLocaleString();
              var jpy=p.usdJpy?Math.round(Math.abs(v)*p.usdJpy):null;
              return(v>=0?"+":"")+"$"+Math.abs(v).toFixed(2)+(jpy?"  (¥"+jpy.toLocaleString()+")":"");
            }
            var inpSim={background:"#040c18",border:"1px solid #1e4070",borderRadius:5,color:"#b8cce0",padding:"6px 8px",fontSize:14,fontFamily:"monospace",width:"100%",boxSizing:"border-box"};
            var scenarios=[
              {label:"損切りライン",pct:simStop,color:"#f43f5e"},
              {label:"-5%",pct:-5,color:"#fb923c"},
              {label:"+5%",pct:5,color:"#22d3a0"},
              {label:"+10%",pct:10,color:"#22d3a0"},
              {label:"+20%",pct:20,color:"#22d3a0"},
              {label:"目標価格",pct:simTarget,color:"#fbbf24"},
            ];
            return(
              <div onClick={function(e){if(e.target===e.currentTarget)setShowSim(false);}} style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.75)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center"}}>
                <div style={{background:"#040c18",border:"1px solid #a78bfa50",borderRadius:16,padding:"16px",width:"100%",maxWidth:520,maxHeight:"85vh",overflowY:"auto",WebkitOverflowScrolling:"touch"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                    <div style={{fontSize:13,fontWeight:700,color:"#a78bfa"}}>💹 損益シミュレーション</div>
                    <button onClick={function(e){e.stopPropagation();setShowSim(false);}} style={{background:"transparent",border:"none",color:"#4a7090",fontSize:18,cursor:"pointer",lineHeight:1}}>✕</button>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                    <div><div style={{fontSize:11,color:"#2a6090",marginBottom:3}}>買値</div><input style={inpSim} type="number" value={simBuy} onChange={function(e){setSimBuy(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter"){e.preventDefault();var v=parseFloat(simBuy);if(!isNaN(v)&&v>0){setSimBuy(String(v));}else{setSimBuy("");}e.target.blur();}}}/></div>
                    <div><div style={{fontSize:11,color:"#2a6090",marginBottom:3}}>株数</div><input style={inpSim} type="number" value={simShares} onChange={function(e){setSimShares(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter"){e.preventDefault();var v=parseInt(simShares);if(!isNaN(v)&&v>0){setSimShares(String(v));}else{setSimShares("");}e.target.blur();}}}/></div>
                  </div>
                  {bp>0&&sh>0&&(
                    <div>
                      <div style={{background:"#071428",borderRadius:6,padding:"6px 10px",fontSize:12,color:"#4a7090",marginBottom:8}}>
                        投資総額: <span style={{color:"#d8eeff",fontWeight:700}}>{fmtP(bp*sh)}</span>
                        {(!isJP&&p.usdJpy)&&<span style={{color:"#4a7090",fontSize:11}}>  (¥{Math.round(bp*sh*p.usdJpy).toLocaleString()})</span>}
                      </div>
                      <div style={{marginBottom:6}}>
                        <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4}}>
                          <span style={{fontSize:11,color:"#4a7090",flexShrink:0}}>目標</span>
                          <input type="number" value={simTargetInput} onChange={function(e){setSimTargetInput(e.target.value);}} onBlur={function(){var v=parseInt(simTargetInput);if(!isNaN(v)&&v>=1&&v<=200){setSimTarget(v);setSimTargetInput(String(v));}else{setSimTargetInput(String(simTarget));}}} onKeyDown={function(e){if(e.key==="Enter"){var v=parseInt(simTargetInput);if(!isNaN(v)&&v>=1&&v<=200){setSimTarget(v);setSimTargetInput(String(v));}else{setSimTargetInput(String(simTarget));}e.target.blur();}}} style={{width:56,background:"#040c18",border:"1px solid #fbbf24",borderRadius:4,color:"#fbbf24",padding:"2px 6px",fontSize:12,fontFamily:"monospace",textAlign:"center"}}/>
                          <span style={{fontSize:11,color:"#fbbf24"}}>%</span>
                          <input type="range" min={1} max={200} value={simTarget} onChange={function(e){var v=parseInt(e.target.value);setSimTarget(v);setSimTargetInput(String(v));}} style={{flex:1,accentColor:"#fbbf24"}}/>
                        </div>
                      </div>
                      <div style={{marginBottom:8}}>
                        <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4}}>
                          <span style={{fontSize:11,color:"#4a7090",flexShrink:0}}>損切り</span>
                          <input type="number" value={simStopInput} onChange={function(e){setSimStopInput(e.target.value);}} onBlur={function(){var v=parseInt(simStopInput);if(!isNaN(v)&&v>=-50&&v<=-1){setSimStop(v);setSimStopInput(String(v));}else{setSimStopInput(String(simStop));}}} onKeyDown={function(e){if(e.key==="Enter"){var v=parseInt(simStopInput);if(!isNaN(v)&&v>=-50&&v<=-1){setSimStop(v);setSimStopInput(String(v));}else{setSimStopInput(String(simStop));}e.target.blur();}}} style={{width:56,background:"#040c18",border:"1px solid #f43f5e",borderRadius:4,color:"#f43f5e",padding:"2px 6px",fontSize:12,fontFamily:"monospace",textAlign:"center"}}/>
                          <span style={{fontSize:11,color:"#f43f5e"}}>%</span>
                          <input type="range" min={-50} max={-1} value={simStop} onChange={function(e){var v=parseInt(e.target.value);setSimStop(v);setSimStopInput(String(v));}} style={{flex:1,accentColor:"#f43f5e"}}/>
                        </div>
                      </div>
                      <div style={{display:"flex",flexDirection:"column",gap:4}}>
                        {scenarios.sort(function(a,b){return a.pct-b.pct;}).map(function(sc,i){
                          var pnl=(bp*(1+sc.pct/100)-bp)*sh;
                          return(
                            <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",background:"#071428",borderRadius:6,padding:"5px 8px"}}>
                              <div><span style={{fontSize:12,color:sc.color,fontWeight:700}}>{sc.label}</span><span style={{fontSize:11,color:"#4a7090",marginLeft:4}}>{sc.pct>=0?"+":""}{sc.pct}%</span></div>
                              <span style={{fontSize:13,fontWeight:800,color:pnl>=0?"#22d3a0":"#f43f5e"}}>{fmtPnL(pnl)}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })(),document.body)}

          {showTrade&&createPortal(<TradeAddModal s={s} onAddTrade={p.onAddTrade} onClose={function(){setShowTrade(false);}}/>,document.body)}

          {showCorr&&createPortal(
            <div onClick={function(e){if(e.target===e.currentTarget)setShowCorr(false);}} style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.75)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center"}}>
              <div style={{background:"#040c18",border:"1px solid #a78bfa50",borderRadius:16,padding:"16px",width:"100%",maxWidth:480,maxHeight:"85vh",overflowY:"auto",WebkitOverflowScrolling:"touch"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                  <div style={{fontSize:13,fontWeight:700,color:"#a78bfa"}}>🔀 逆相関で上昇しやすい銘柄</div>
                  <button onClick={function(){setShowCorr(false);}} style={{background:"transparent",border:"none",color:"#4a7090",fontSize:18,cursor:"pointer",lineHeight:1}}>✕</button>
                </div>
                {!corrFetched&&!corrLoading?(
                  <button onClick={runCorrFetch} style={{background:"transparent",border:"1px solid #a78bfa",borderRadius:6,color:"#a78bfa",padding:"8px 10px",fontSize:13,cursor:"pointer",width:"100%"}}>🔀 逆相関銘柄を調べる</button>
                ):corrLoading?(
                  <div style={{fontSize:12,color:"#4a7090"}}>算出中...</div>
                ):corrError?(
                  <div>
                    <div style={{fontSize:12,color:"#f43f5e",marginBottom:6}}>取得できませんでした（{corrError}）</div>
                    <button onClick={runCorrFetch} style={{background:"transparent",border:"1px solid #a78bfa",borderRadius:6,color:"#a78bfa",padding:"4px 9px",fontSize:12,cursor:"pointer"}}>🔄 再試行</button>
                  </div>
                ):corrList.length===0?(
                  <div style={{fontSize:12,color:"#4a7090"}}>強い逆相関の銘柄は見つかりませんでした</div>
                ):(
                  <div>
                    <div style={{display:"flex",flexDirection:"column",gap:4}}>
                      {corrList.map(function(c){
                        var code=c.ticker.replace(".T","");
                        var matched=(p.allStocks||[]).find(function(x){return x.ticker.replace(".T","")===code;});
                        return(
                          <div key={c.ticker} onClick={function(e){if(matched){e.stopPropagation();setPreviewStock(matched);}}} style={{display:"flex",justifyContent:"space-between",alignItems:"center",background:"#071428",borderRadius:6,padding:"6px 10px",cursor:matched?"pointer":"default"}}>
                            <span style={{fontSize:13,color:matched?"#60a5fa":"#d8eeff",textDecoration:matched?"underline":"none",fontWeight:matched?700:400}}>{code}</span>
                            <span style={{fontSize:12,color:"#a78bfa"}}>逆相関 {c.correlation.toFixed(2)}</span>
                          </div>
                        );
                      })}
                    </div>
                    <button onClick={runCorrReason} disabled={corrReasonLoading} style={{marginTop:8,background:"transparent",border:"1px solid #a78bfa",borderRadius:6,color:"#a78bfa",padding:"5px 10px",fontSize:12,cursor:corrReasonLoading?"not-allowed":"pointer"}}>{corrReasonLoading?"⏳ 生成中...":"🤖 AIに理由を聞く"}</button>
                    {corrReason&&<div style={{fontSize:12,color:"#b8cce0",lineHeight:1.6,marginTop:8,whiteSpace:"pre-wrap"}}>{renderReasonText(corrReason,p.allStocks,setPreviewStock)}</div>}
                    <div style={{fontSize:10,color:"#2a5070",marginTop:8}}>過去60営業日程度の値動きに基づく統計的傾向であり、将来を保証するものではありません</div>
                  </div>
                )}
              </div>
            </div>,document.body)}

          {previewStock&&createPortal(<TickerPreviewModal stock={previewStock} onClose={function(){setPreviewStock(null);}}/>,document.body)}

        </div>
      )}
    </div>
  );
}

// ── StockDetailPanel ─────────────────────────────────────────────────────────
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
  var mc=MKT[s.market]||MKT["US"];
  var bc=BADGE[s.timing];
  var borderColor=s.score>=58?"#22d3a0":s.score>=38?"#fbbf24":"#f43f5e";
  var fromHighColor=s.fromHigh>=-10?"#f43f5e":s.fromHigh>=-30?"#fbbf24":"#22d3a0";
  var fromLowColor=s.fromLow<=20?"#22d3a0":s.fromLow<=50?"#fbbf24":"#f43f5e";
  var pos52=s.position52!=null?Math.min(98,Math.max(2,s.position52)):null;
  var pos52Color=pos52!=null?(pos52<=25?"#22d3a0":pos52<=75?"#fbbf24":"#f43f5e"):null;

  // チャート（1分足＋25期・75期の短期MA）：この銘柄が選択された時に取得
  // intraday: undefined=読込中, null=データなし, オブジェクト=取得済み
  var intradayS=useState(undefined);var intraday=intradayS[0],setIntraday=intradayS[1];
  useEffect(function(){
    setIntraday(undefined);
    fetchIntraday(s.ticker).then(function(r){setIntraday(r);});
    if(onRescan) onRescan(s.ticker); // カードの価格・判定バッジもチャートと同様に毎回最新化
  },[s.ticker]);

  var showSimS=useState(false);var showSim=showSimS[0],setShowSim=showSimS[1];
  var showTradeS=useState(false);var showTrade=showTradeS[0],setShowTrade=showTradeS[1];
  var showCorrS=useState(false);var showCorr=showCorrS[0],setShowCorr=showCorrS[1];
  var simSharesS=useState("100");var simShares=simSharesS[0],setSimShares=simSharesS[1];
  var simBuyS=useState(s.rawPrice?s.rawPrice.toFixed(2):"");var simBuy=simBuyS[0],setSimBuy=simBuyS[1];
  useEffect(function(){var isJP=s.market==="JP";setSimBuy(s.rawPrice?(isJP?String(Math.round(s.rawPrice)):s.rawPrice.toFixed(2)):"");},[s.ticker]);
  var simTargetS=useState(3);var simTarget=simTargetS[0],setSimTarget=simTargetS[1];
  var simStopS=useState(-5);var simStop=simStopS[0],setSimStop=simStopS[1];
  var simTargetInputS=useState("3");var simTargetInput=simTargetInputS[0],setSimTargetInput=simTargetInputS[1];
  var simStopInputS=useState("-5");var simStopInput=simStopInputS[0],setSimStopInput=simStopInputS[1];
  var showAiS=useState(false);var showAi=showAiS[0],setShowAi=showAiS[1];
  var aiTextS=useState("");var aiText=aiTextS[0],setAiText=aiTextS[1];
  var aiLoadingS=useState(false);var aiLoading=aiLoadingS[0],setAiLoading=aiLoadingS[1];

  var aiEntryS=useState(null);var aiEntry=aiEntryS[0],setAiEntry=aiEntryS[1];

  async function runAiAnalysis(){
    if(aiLoading) return;
    setShowAi(true);setAiLoading(true);setAiText("");setAiEntry(null);
    await callAiAnalysis(s,setAiText,setAiEntry,setAiLoading);
  }

  // ── 逆相関銘柄予想（下落中の銘柄を見ている時だけ算出）───────────────────
  var corrListS=useState([]);var corrList=corrListS[0],setCorrList=corrListS[1];
  var corrLoadingS=useState(false);var corrLoading=corrLoadingS[0],setCorrLoading=corrLoadingS[1];
  var corrErrorS=useState("");var corrError=corrErrorS[0],setCorrError=corrErrorS[1];
  var corrFetchedS=useState(false);var corrFetched=corrFetchedS[0],setCorrFetched=corrFetchedS[1];
  var corrReasonS=useState("");var corrReason=corrReasonS[0],setCorrReason=corrReasonS[1];
  var corrReasonLoadingS=useState(false);var corrReasonLoading=corrReasonLoadingS[0],setCorrReasonLoading=corrReasonLoadingS[1];
  var previewStockS=useState(null);var previewStock=previewStockS[0],setPreviewStock=previewStockS[1];
  useEffect(function(){
    setCorrList([]);setCorrReason("");setCorrError("");setCorrFetched(false);
  },[s&&s.ticker]);

  function runCorrFetch(){
    if(corrLoading||!s) return;
    var candidates=(p.allStocks||[]).map(function(x){return x.ticker;}).filter(function(t){return t!==s.ticker;}).slice(0,60);
    setCorrError("");setCorrList([]);
    if(!candidates.length){setCorrFetched(true);return;}
    setCorrLoading(true);
    fetch(CORRELATION_API+"?ticker="+encodeURIComponent(s.ticker)+"&candidates="+encodeURIComponent(candidates.join(",")),{signal:AbortSignal.timeout(20000)})
      .then(function(r){return r.json();})
      .then(function(json){
        if(json.error){setCorrError(json.error);return;}
        setCorrList(json.results||[]);
      })
      .catch(function(){setCorrError("通信エラー");})
      .finally(function(){setCorrLoading(false);setCorrFetched(true);});
  }

  async function runCorrReason(){
    if(corrReasonLoading||!corrList.length) return;
    setCorrReasonLoading(true);setCorrReason("");
    var names=corrList.map(function(c){return c.ticker.replace(".T","");}).join("、");
    var prompt="銘柄"+s.ticker.replace(".T","")+"("+s.name+")が下落した場合に、過去の値動きデータ上「逆相関」が確認された次の銘柄が上昇しやすい理由を、競合関係・代替需要・資金シフトなどの観点から1銘柄につき1〜2文で日本語で簡潔に説明してください。断定を避け「〜の可能性があります」等の表現にしてください。\n対象銘柄: "+names;
    try{
      var res=await fetch(AI_API_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt:prompt,system:"あなたは個人投資家向けの株式アナリストです。与えられた銘柄同士の逆相関関係について、簡潔で分かりやすい日本語の解説のみを出力してください。"}),signal:AbortSignal.timeout(20000)});
      var json=await res.json();
      setCorrReason(json.text||"");
    }catch(e){setCorrReason("取得に失敗しました");}
    finally{setCorrReasonLoading(false);}
  }

  var promptCopiedS=useState(false);var promptCopied=promptCopiedS[0],setPromptCopied=promptCopiedS[1];
  function copyTradePrompt(){
    if(!navigator.clipboard) return;
    navigator.clipboard.writeText(buildVolumeRankingPrompt([s],1,false)).then(function(){
      setPromptCopied(true);
      setTimeout(function(){setPromptCopied(false);},2000);
    }).catch(function(){});
  }

  return(
    <div style={{background:"#050e1c",border:"none",borderRadius:10,padding:"14px",display:"flex",flexDirection:"column",gap:10}}>
      <div style={{display:"flex",gap:6,alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex",gap:6,alignItems:"center",minWidth:0,flex:1}}>
          <ScoreRing score={s.score}/>
          <div style={{minWidth:0}}>
            <div style={{display:"flex",gap:4,alignItems:"center",flexWrap:"wrap"}}>
              <span style={bStyle(mc.bg,mc.border,mc.text)}>{mc.label}</span>
              <span style={{fontSize:15,fontWeight:800,color:"#d8eeff"}}>{s.ticker.replace(".T","")}</span>
              {s.tradeLabel&&<span style={bStyle("#0a0a1a","1px solid "+s.tradeColor,s.tradeColor)}>{s.tradeLabel}</span>}
              {(function(){var ei=earningsInfo(s.earningsDate);return ei&&<span style={bStyle(ei.urgent?"#3a0a0a":"#1c1400","1px solid "+(ei.urgent?"#f43f5e":"#fbbf24"),ei.urgent?"#f87171":"#fbbf24")} title={"決算発表: "+ei.date}>📈決算{ei.label}</span>;})()}
              {(function(){var xi=exRightsInfo(s.exRightsDate);return xi&&<span style={bStyle("#0a1a3a","1px solid #3b82f6","#60a5fa")} title={"権利落ち予想: "+xi.date}>💰権利落ち(予想){xi.label}</span>;})()}
          {(function(){var ri=relStrengthInfo(s.relStrength);return ri&&<span style={bStyle(ri.strong?"#052e16":"#1f0010","1px solid "+(ri.strong?"#22d3a0":"#f43f5e"),ri.strong?"#22d3a0":"#f43f5e")} title={"対TOPIX相対(前日比差): "+ri.label}>{ri.strong?"🔥対TOPIX":"🧊対TOPIX"}{ri.label}</span>;})()}
            </div>
            <div style={{fontSize:13,color:"#4a7090",marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.name}</div>
          </div>
        </div>
        <div style={{display:"flex",gap:4,alignItems:"center"}}>
          <button onClick={function(){toggleFav(s.ticker);}} style={{background:"transparent",border:"none",fontSize:15,cursor:"pointer",padding:0,color:isFav(s.ticker)?"#fbbf24":"#2a4060"}}>{isFav(s.ticker)?"★":"☆"}</button>
        </div>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",background:"#071428",borderRadius:8,padding:"10px 14px"}}>
        <div>
          <span style={{fontSize:18,fontWeight:800,color:"#d8eeff"}}>{s.price}</span>
          {s.market==="US"&&p.usdJpy&&<div style={{fontSize:13,color:"#4a7090"}}>¥{Math.round(s.rawPrice*p.usdJpy).toLocaleString()}</div>}
        </div>
        <div style={{textAlign:"right"}}>
          {s.real!==false&&<span style={{fontSize:15,fontWeight:700,color:isUp?"#22d3a0":"#f43f5e"}}>{isUp?"▲":"▼"}{Math.abs(s.change)}%</span>}
          <div style={{marginTop:4}}><span style={bStyle(bc.bg,bc.border,bc.text)}>{bc.label}</span></div>
        </div>
      </div>

      <div style={{display:"flex",gap:4,alignItems:"center",justifyContent:"flex-end"}}>
        <button onClick={copyTradePrompt} title="判定プロンプトをコピー" style={{background:promptCopied?"#052e16":"transparent",border:"1px solid "+(promptCopied?"#22d3a0":"#2a4060"),borderRadius:6,color:promptCopied?"#22d3a0":"#4a7090",padding:"4px 9px",fontSize:14,cursor:"pointer"}}>{promptCopied?"✓":"📋"}</button>
        <button onClick={function(){if(onRescan&&!rescanLoading)onRescan(s.ticker);}} disabled={rescanLoading} style={{background:"transparent",border:"1px solid "+(rescanLoading?"#fbbf24":"#2a4060"),borderRadius:6,color:rescanLoading?"#fbbf24":"#4a7090",padding:"4px 9px",fontSize:14,cursor:rescanLoading?"not-allowed":"pointer"}}>{rescanLoading?"⏳":"🔄"}</button>
        <button onClick={runAiAnalysis} disabled={aiLoading} style={{background:"transparent",border:"1px solid "+(aiLoading?"#22d3a0":"#2a4060"),borderRadius:6,color:aiLoading?"#22d3a0":"#4a7090",padding:"4px 9px",fontSize:14,cursor:aiLoading?"not-allowed":"pointer"}}>{aiLoading?"⏳":"🤖"}</button>
        <button onClick={function(){setShowSim(function(v){return !v;});}} style={{background:showSim?"#1a0a3a":"transparent",border:"1px solid "+(showSim?"#a78bfa":"#2a4060"),borderRadius:6,color:showSim?"#a78bfa":"#4a7090",padding:"4px 9px",fontSize:14,cursor:"pointer"}}>💹</button>
        <button onClick={function(){setShowTrade(function(v){return !v;});}} style={{background:showTrade?"#0a1a3a":"transparent",border:"1px solid "+(showTrade?"#0ea5e9":"#2a4060"),borderRadius:6,color:showTrade?"#0ea5e9":"#4a7090",padding:"4px 9px",fontSize:14,cursor:"pointer"}}>🎯</button>
        <button onClick={function(){if(isUp)return;setShowCorr(true);if(!corrFetched&&!corrLoading)runCorrFetch();}} disabled={isUp} title={isUp?"上昇中の銘柄では使用できません":"逆相関で上昇しやすい銘柄を調べる"} style={{background:"transparent",border:"1px solid "+(isUp?"#1a2c40":"#2a4060"),borderRadius:6,color:isUp?"#2a4a60":"#4a7090",padding:"4px 9px",fontSize:14,cursor:isUp?"not-allowed":"pointer"}}>🔀</button>
      </div>

      {/* チャート（1分足＋週足MA） */}
      <div style={{background:"#03080f",borderRadius:6,padding:"4px 6px"}}>
        <IntradayChart1m data={intraday}/>
      </div>

      {/* シグナル詳細 */}
      <SignalDetailList signals={s.signals} breakdown={s.breakdown}/>

      {showAi&&createPortal(
        <div onClick={function(e){if(e.target===e.currentTarget){setShowAi(false);setAiText("");setAiEntry(null);}}} style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.75)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div style={{background:"#040c18",border:"1px solid #22d3a050",borderRadius:16,padding:"16px",width:"100%",maxWidth:520,maxHeight:"85vh",overflowY:"auto",WebkitOverflowScrolling:"touch"}}>
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
              <button onClick={function(){setShowAi(false);setAiText("");setAiEntry(null);}} style={{background:"transparent",border:"none",color:"#4a7090",fontSize:18,cursor:"pointer",lineHeight:1}}>✕</button>
            </div>
            {aiLoading?(<div style={{textAlign:"center",padding:"12px 0"}}><div style={{fontSize:18}}>⏳</div><div style={{fontSize:14,color:"#4a90c0",marginTop:4}}>AIが分析中...</div></div>):(<div style={{fontSize:15,color:"#b8cce0",lineHeight:1.7,whiteSpace:"pre-wrap"}}>{aiText}</div>)}
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
            {!aiLoading&&aiEntry&&ForecastBox(aiEntry.forecast)}
            {!aiLoading&&aiText&&(<button onClick={runAiAnalysis} style={{marginTop:8,background:"transparent",border:"1px solid #1e4070",borderRadius:6,color:"#4a7090",padding:"4px 10px",fontSize:14,cursor:"pointer",fontFamily:"monospace",width:"100%"}}>🔄 再分析</button>)}
          </div>
        </div>
      ,document.body)}
      {s.support&&(
        <div style={{background:"#071428",border:"1px solid #2a4060",borderRadius:8,padding:"8px 10px"}}>
          <div style={{fontSize:12,fontWeight:700,color:"#fbbf24",marginBottom:6}}>📉 下値サポート目安</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
            {[["🟡 S1 20日",s.support.s1,"#fbbf24"],["🔴 S2 60日",s.support.s2,"#f43f5e"],["⚡ ATR×1.5",s.support.atrFloor,"#a78bfa"]].map(function(row){
              return(
                <div key={row[0]} style={{background:"#040c18",border:"1px solid #1e3050",borderRadius:6,padding:"5px 8px"}}>
                  <div style={{fontSize:10,color:row[2],marginBottom:2}}>{row[0]}</div>
                  <div style={{fontSize:14,fontWeight:800,color:row[2]}}>{s.market==="JP"?"¥"+row[1].toLocaleString():"$"+row[1]}</div>
                </div>
              );
            })}
          </div>
          <div style={{fontSize:11,color:"#2a5070",marginTop:5}}>S1割れ→S2、S2割れ→ATR下限が次の下値目安</div>
        </div>
      )}
      {showSim&&createPortal((function(){
        var bp=parseFloat(simBuy)||0;var sh=parseFloat(simShares)||0;
        var isJP=s.market==="JP";
        function fmtP(v){return isJP?"¥"+Math.round(v).toLocaleString():"$"+v.toFixed(2);}
        function fmtPnL(v){
          if(isJP) return(v>=0?"+":"")+"¥"+Math.round(Math.abs(v)).toLocaleString();
          var jpy=p.usdJpy?Math.round(Math.abs(v)*p.usdJpy):null;
          return(v>=0?"+":"")+"$"+Math.abs(v).toFixed(2)+(jpy?"  (¥"+jpy.toLocaleString()+")":"");
        }
        var inpSim={background:"#040c18",border:"1px solid #1e4070",borderRadius:5,color:"#b8cce0",padding:"6px 8px",fontSize:14,fontFamily:"monospace",width:"100%",boxSizing:"border-box"};
        var scenarios=[{label:"損切りライン",pct:simStop,color:"#f43f5e"},{label:"-5%",pct:-5,color:"#fb923c"},{label:"+5%",pct:5,color:"#22d3a0"},{label:"+10%",pct:10,color:"#22d3a0"},{label:"+20%",pct:20,color:"#22d3a0"},{label:"目標価格",pct:simTarget,color:"#fbbf24"}];
        return(
          <div onClick={function(e){if(e.target===e.currentTarget)setShowSim(false);}} style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.75)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <div style={{background:"#040c18",border:"1px solid #a78bfa50",borderRadius:16,padding:"16px",width:"100%",maxWidth:520,maxHeight:"85vh",overflowY:"auto",WebkitOverflowScrolling:"touch"}}>
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
                      <input type="number" value={simTargetInput} onChange={function(e){setSimTargetInput(e.target.value);}} onBlur={function(){var v=parseInt(simTargetInput);if(!isNaN(v)&&v>=1&&v<=200){setSimTarget(v);setSimTargetInput(String(v));}else{setSimTargetInput(String(simTarget));}}} onKeyDown={function(e){if(e.key==="Enter"){var v=parseInt(simTargetInput);if(!isNaN(v)&&v>=1&&v<=200){setSimTarget(v);setSimTargetInput(String(v));}else{setSimTargetInput(String(simTarget));}e.target.blur();}}} style={{width:56,background:"#040c18",border:"1px solid #fbbf24",borderRadius:4,color:"#fbbf24",padding:"2px 6px",fontSize:12,fontFamily:"monospace",textAlign:"center"}}/>
                      <span style={{fontSize:13,color:"#fbbf24"}}>%</span>
                      <input type="range" min={1} max={200} value={simTarget} onChange={function(e){var v=parseInt(e.target.value);setSimTarget(v);setSimTargetInput(String(v));}} style={{flex:1,accentColor:"#fbbf24"}}/>
                    </div>
                  </div>
                  <div style={{marginBottom:8}}>
                    <div style={{fontSize:13,color:"#f43f5e",marginBottom:3}}>{fmtP(bp*(1+simStop/100))}</div>
                    <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4}}>
                      <span style={{fontSize:13,color:"#4a7090",flexShrink:0}}>損切り</span>
                      <input type="number" value={simStopInput} onChange={function(e){setSimStopInput(e.target.value);}} onBlur={function(){var v=parseInt(simStopInput);if(!isNaN(v)&&v>=-50&&v<=-1){setSimStop(v);setSimStopInput(String(v));}else{setSimStopInput(String(simStop));}}} onKeyDown={function(e){if(e.key==="Enter"){var v=parseInt(simStopInput);if(!isNaN(v)&&v>=-50&&v<=-1){setSimStop(v);setSimStopInput(String(v));}else{setSimStopInput(String(simStop));}e.target.blur();}}} style={{width:56,background:"#040c18",border:"1px solid #f43f5e",borderRadius:4,color:"#f43f5e",padding:"2px 6px",fontSize:12,fontFamily:"monospace",textAlign:"center"}}/>
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

      {showTrade&&createPortal(<TradeAddModal s={s} onAddTrade={p.onAddTrade} onClose={function(){setShowTrade(false);}}/>,document.body)}

      {showCorr&&createPortal(
        <div onClick={function(e){if(e.target===e.currentTarget)setShowCorr(false);}} style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.75)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div style={{background:"#040c18",border:"1px solid #a78bfa50",borderRadius:16,padding:"16px",width:"100%",maxWidth:480,maxHeight:"85vh",overflowY:"auto",WebkitOverflowScrolling:"touch"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <div style={{fontSize:13,fontWeight:700,color:"#a78bfa"}}>🔀 逆相関で上昇しやすい銘柄</div>
              <button onClick={function(){setShowCorr(false);}} style={{background:"transparent",border:"none",color:"#4a7090",fontSize:18,cursor:"pointer",lineHeight:1}}>✕</button>
            </div>
            {!corrFetched&&!corrLoading?(
              <button onClick={runCorrFetch} style={{background:"transparent",border:"1px solid #a78bfa",borderRadius:6,color:"#a78bfa",padding:"8px 10px",fontSize:13,cursor:"pointer",width:"100%"}}>🔀 逆相関銘柄を調べる</button>
            ):corrLoading?(
              <div style={{fontSize:12,color:"#4a7090"}}>算出中...</div>
            ):corrError?(
              <div>
                <div style={{fontSize:12,color:"#f43f5e",marginBottom:6}}>取得できませんでした（{corrError}）</div>
                <button onClick={runCorrFetch} style={{background:"transparent",border:"1px solid #a78bfa",borderRadius:6,color:"#a78bfa",padding:"4px 9px",fontSize:12,cursor:"pointer"}}>🔄 再試行</button>
              </div>
            ):corrList.length===0?(
              <div style={{fontSize:12,color:"#4a7090"}}>強い逆相関の銘柄は見つかりませんでした</div>
            ):(
              <div>
                <div style={{display:"flex",flexDirection:"column",gap:4}}>
                  {corrList.map(function(c){
                    var code=c.ticker.replace(".T","");
                    var matched=(p.allStocks||[]).find(function(x){return x.ticker.replace(".T","")===code;});
                    return(
                      <div key={c.ticker} onClick={function(e){if(matched){e.stopPropagation();setPreviewStock(matched);}}} style={{display:"flex",justifyContent:"space-between",alignItems:"center",background:"#071428",borderRadius:6,padding:"6px 10px",cursor:matched?"pointer":"default"}}>
                        <span style={{fontSize:13,color:matched?"#60a5fa":"#d8eeff",textDecoration:matched?"underline":"none",fontWeight:matched?700:400}}>{code}</span>
                        <span style={{fontSize:12,color:"#a78bfa"}}>逆相関 {c.correlation.toFixed(2)}</span>
                      </div>
                    );
                  })}
                </div>
                <button onClick={runCorrReason} disabled={corrReasonLoading} style={{marginTop:8,background:"transparent",border:"1px solid #a78bfa",borderRadius:6,color:"#a78bfa",padding:"5px 10px",fontSize:12,cursor:corrReasonLoading?"not-allowed":"pointer"}}>{corrReasonLoading?"⏳ 生成中...":"🤖 AIに理由を聞く"}</button>
                {corrReason&&<div style={{fontSize:12,color:"#b8cce0",lineHeight:1.6,marginTop:8,whiteSpace:"pre-wrap"}}>{renderReasonText(corrReason,p.allStocks,setPreviewStock)}</div>}
                <div style={{fontSize:10,color:"#2a5070",marginTop:8}}>過去60営業日程度の値動きに基づく統計的傾向であり、将来を保証するものではありません</div>
              </div>
            )}
          </div>
        </div>,document.body)}

      {previewStock&&createPortal(<TickerPreviewModal stock={previewStock} onClose={function(){setPreviewStock(null);}}/>,document.body)}

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
        <a href={s.yahooUrl} target="_blank" rel="noreferrer" style={{background:"#071428",border:"1px solid #4f46e5",borderRadius:8,color:"#a5b4fc",padding:"10px",fontSize:14,fontWeight:700,fontFamily:"monospace",textDecoration:"none",textAlign:"center",display:"block"}}>🔗 Y!</a>
        <a href="ispeed://" onClick={function(){var code=s.ticker.replace(".T","");if(navigator.clipboard){navigator.clipboard.writeText(code).catch(function(){});}}} style={{background:"#1a0a0a",border:"1px solid #f87171",borderRadius:8,color:"#fca5a5",padding:"10px",fontSize:14,fontWeight:700,fontFamily:"monospace",textDecoration:"none",textAlign:"center",display:"block"}}>📱 iSPEED</a>
      </div>
    </div>
  );
}

// ── MarketBar ─────────────────────────────────────────────────────────────────
function MarketBar(){
  var dataS=useState({}); var data=dataS[0],setData=dataS[1];
  var loadingS=useState(true); var loading=loadingS[0],setLoading=loadingS[1];
  var isWide=window.innerWidth>=768;
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
  return(
    <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"12px",marginBottom:12,display:"grid",gridTemplateColumns:isWide?"repeat(5,1fr)":"1fr 1fr",gap:8}}>
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
          <div key={idx.key} style={{background:vixAlert?"#1f0010":"#050e1c",borderRadius:8,padding:"10px 12px",border:vixAlert?"1px solid #f43f5e50":"1px solid transparent",gridColumn:(!isWide&&isVix)?"1 / -1":undefined}}>
            <div style={{fontSize:13,color:vixAlert?"#f43f5e":"#4a7090",fontWeight:700,marginBottom:4}}>{idx.label}{vixAlert?" ⚠ 警戒":""}</div>
            <div style={{fontSize:20,fontWeight:800,color:vixAlert?"#f43f5e":"#d8eeff"}}>{d.prefix}{price}</div>
            <div style={{fontSize:15,fontWeight:700,color:isUp?"#22d3a0":"#f43f5e",marginTop:2}}>{isUp?"▲":"▼"}{Math.abs(d.change)}%</div>
          </div>
        );
      })}
    </div>
  );
}

function AllStocksPanel(p){
  var stocks=p.stocks,loading=p.loading,toggleFav=p.toggleFav,favs=p.favs,vix=p.vix,onScan=p.onScan,ts=p.ts,progress=p.progress;

  function isFavRef(t){return favs.indexOf(t)>=0;}

  var displayStocks=stocks.slice().sort(function(a,b){return b.score-a.score;});


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

  var isMobile=window.innerWidth<768;
  var isWide=window.innerWidth>=1400; // 画面が広い時はカードを3列にして横幅を狭くする
  var cols=isMobile?1:(isWide?3:2);
  var stickyTop=isMobile?0:50;
  var cardGrid=(
    <div style={{display:"grid",gridTemplateColumns:"repeat("+cols+",1fr)",gap:8}}>
      {displayStocks.map(function(s){
        return <StockCard key={s.ticker} s={s} toggleFav={toggleFav} isFav={isFavRef} vix={vix} usdJpy={p.usdJpy} setSelectedStock={p.setSelectedStock} selectedStock={p.selectedStock} onRescan={p.onRescan} rescanLoading={p.rescanLoading&&p.rescanLoading[s.ticker]} allStocks={stocks} onAddTrade={p.onAddTrade}/>;
      })}
    </div>
  );
  return(
    <div style={{display:"flex",flexDirection:"column",height:"calc(100vh - "+(isMobile?0:50)+"px)"}}>
      <div style={{position:"sticky",top:stickyTop,zIndex:10,background:"#040c18",paddingBottom:4}}>
        {isMobile?(
          <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"6px 10px",marginBottom:4,display:"flex",alignItems:"center",gap:6}}>
            <span style={{fontSize:10,color:"#4a7090"}}>
              <span style={{color:"#22d3a0",fontWeight:700}}>{stocks.filter(function(s){return s.real;}).length}</span>
              <span>/{stocks.length}</span>
            </span>
            {ts&&<span style={{fontSize:10,color:"#2a6090",whiteSpace:"nowrap"}}>{ts}</span>}
            <button onClick={onScan} style={{marginLeft:"auto",background:"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:6,color:"#fff",padding:"4px 10px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"monospace",whiteSpace:"nowrap"}}>再スキャン</button>
          </div>
        ):(
          <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"6px 10px",marginBottom:4,display:"flex",gap:4,alignItems:"center",flexWrap:"nowrap",overflowX:"auto",WebkitOverflowScrolling:"touch"}}>
            <span style={{fontSize:10,color:"#4a7090",flexShrink:0}}>
              <span style={{color:"#22d3a0",fontWeight:700}}>{stocks.filter(function(s){return s.real;}).length}</span>
              <span>/{stocks.length}</span>
            </span>
            {ts&&<span style={{fontSize:10,color:"#2a6090",flexShrink:0,whiteSpace:"nowrap"}}>{ts}</span>}
            <button onClick={onScan} style={{marginLeft:"auto",flexShrink:0,background:"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:6,color:"#fff",padding:"4px 10px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"monospace",whiteSpace:"nowrap"}}>再スキャン</button>
          </div>
        )}
      </div>
      <div style={{overflowY:"auto",flex:1,WebkitOverflowScrolling:"touch",paddingTop:8}}>
        <MarketBar/>
        {isMobile?cardGrid:(
          <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
            <div style={{width:"60%",flexShrink:0}}>{cardGrid}</div>
            <div style={{flex:1,position:"sticky",top:0,maxHeight:"100%",overflowY:"auto",WebkitOverflowScrolling:"touch"}}>
              <StockDetailPanel s={p.selectedStock} toggleFav={toggleFav} isFav={isFavRef} vix={vix} usdJpy={p.usdJpy} onRescan={p.onRescan} rescanLoading={p.rescanLoading&&p.selectedStock&&p.rescanLoading[p.selectedStock.ticker]} allStocks={stocks} onAddTrade={p.onAddTrade}/>
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
  var favGroups=p.favGroups,groupNames=p.groupNames,renameGroup=p.renameGroup;
  var favStocks=stocks.filter(function(s){return favs.indexOf(s.ticker)>=0;});
  var searchS=useState("");var searchTicker=searchS[0],setSearchTicker=searchS[1];
  var searchStatusS=useState(null);var searchStatus=searchStatusS[0],setSearchStatus=searchStatusS[1];
  var filterS=useState("ALL");var filterMkt=filterS[0],setFilterMkt=filterS[1];
  var sortS=useState("score");var sortBy=sortS[0],setSortBy=sortS[1];
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
  var displayStocks=(filterMkt==="ALL"?groupedStocks:groupedStocks.filter(function(s){return s.market===filterMkt;})).slice().sort(function(a,b){
    if(sortBy==="score") return b.score-a.score;
    if(sortBy==="change") return parseFloat(b.change)-parseFloat(a.change);
    return 0;
  });
  function fBtn(val,label,activeColor){
    var active=filterMkt===val;
    return(<button onClick={function(){setFilterMkt(val);}} style={{background:active?activeColor+"20":"transparent",border:"1px solid "+(active?activeColor:"#1e3050"),borderRadius:6,color:active?activeColor:"#4a6080",padding:"3px 8px",fontSize:11,cursor:"pointer",fontFamily:"monospace",fontWeight:active?700:400}}>{label}</button>);
  }
  function sBtn(val,label){
    var active=sortBy===val;
    return(<button onClick={function(){setSortBy(val);}} style={{background:active?"#0ea5e920":"transparent",border:"1px solid "+(active?"#0ea5e9":"#1e3050"),borderRadius:6,color:active?"#0ea5e9":"#4a6080",padding:"3px 8px",fontSize:11,cursor:"pointer",fontFamily:"monospace",fontWeight:active?700:400}}>{label}</button>);
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
  var isMobile=window.innerWidth<768;
  var isWide=window.innerWidth>=1400; // 全銘柄タブと同じ基準で3列にする
  var favCols=isMobile?1:(isWide?3:2);
  var cardGrid=(
    <div style={{display:"grid",gridTemplateColumns:"repeat("+favCols+",1fr)",gap:8}}>
      {displayStocks.map(function(s){
        var cross=s.signals&&s.signals.length>0?classifyStockFn(s):null;
        return <StockCard key={s.ticker} s={s} toggleFav={toggleFav} isFav={isFavRef} cross={cross} vix={vix} usdJpy={p.usdJpy} setSelectedStock={p.setSelectedStock} selectedStock={p.selectedStock} onRescan={p.onRescan} rescanLoading={p.rescanLoading&&p.rescanLoading[s.ticker]} allStocks={stocks} onAddTrade={p.onAddTrade}/>;
      })}
    </div>
  );
  var stickyTop=isMobile?0:50;
  return(
    <div style={{display:"flex",flexDirection:"column",height:"calc(100vh - "+(isMobile?0:50)+"px)"}}>
      <div style={{position:isMobile?"static":"sticky",top:stickyTop,zIndex:10,background:"#040c18",paddingBottom:4,paddingLeft:10,paddingRight:10,paddingTop:4}}>
        <div style={{background:"#050e1c",border:"1px solid #1e3050",borderRadius:10,padding:"12px 14px",marginBottom:8}}>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            <input style={{background:"#071428",border:"1px solid #1e3050",borderRadius:6,color:"#b8cce0",padding:"8px 10px",fontSize:14,fontFamily:"monospace",flex:"1 1 130px",minWidth:0}} value={searchTicker} placeholder="AAPL / 7203" onChange={function(e){setSearchTicker(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter")addByTicker();}}/>
            <select value={addGroup} onChange={function(e){setAddGroup(Number(e.target.value));}} style={{background:"#071428",border:"1px solid #1e3050",borderRadius:6,color:"#fbbf24",padding:"0 6px",fontSize:13,fontFamily:"monospace",flex:"1 1 110px",minWidth:0}}>
              <option value={0}>全体（未分類）</option>
              {[1,2,3,4,5].map(function(n){return <option key={n} value={n}>{groupNames[n]}</option>;})}
            </select>
            <button onClick={addByTicker} style={{background:"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:8,color:"#fff",padding:"8px 16px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"monospace",flex:"0 0 auto"}}>追加</button>
          </div>
          {statusMsg&&<div style={{fontSize:12,color:searchStatus==="ok"?"#22d3a0":"#f43f5e",marginTop:6}}>{statusMsg}</div>}
        </div>
        <button onClick={function(){setFiltersOpen(function(v){return !v;});}} style={{width:"100%",background:"#071428",border:"1px solid #0f2040",borderRadius:10,color:"#4a90c0",padding:"6px 12px",fontSize:11,cursor:"pointer",fontFamily:"monospace",marginBottom:4,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span>🔍 絞り込み（グループ・市場・並替）</span>
          <span>{filtersOpen?"▲":"▼"}</span>
        </button>
        {filtersOpen&&(
        <div>
        <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"8px 12px",marginBottom:4,display:"flex",gap:4,flexWrap:"wrap",alignItems:"center"}}>
          <span style={{fontSize:11,color:"#2a6090",marginRight:2}}>グループ:</span>
          {gBtn(0,"全体")}
          {[1,2,3,4,5].map(function(n){return <span key={n} style={{display:"flex",alignItems:"center",gap:2}}>{gBtn(n,groupNames[n])}{groupFilter===n&&<span onClick={function(){editGroupName(n);}} style={{cursor:"pointer",fontSize:11,color:"#4a6080"}}>✎</span>}</span>;})}
          <button onClick={function(){setShowAcc(true);}} style={{marginLeft:"auto",background:"transparent",border:"1px solid #1e3050",borderRadius:6,color:"#0ea5e9",padding:"3px 8px",fontSize:11,cursor:"pointer",fontFamily:"monospace"}}>📊的中率</button>
        </div>
        {showAcc&&createPortal(<SignalAccuracyModal onClose={function(){setShowAcc(false);}}/>,document.body)}
        {favStocks.length>0&&(
          isMobile?(
            <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"8px 12px",marginBottom:4,display:"grid",gridTemplateColumns:"1fr 1fr",gap:4}}>
              <div style={{display:"flex",gap:4,alignItems:"center",flexWrap:"wrap"}}>
                <span style={{fontSize:11,color:"#2a6090",flexShrink:0}}>市場:</span>
                {fBtn("ALL","全て","#60a5fa")}
                {fBtn("US","US","#3b82f6")}
                {fBtn("JP","JP","#f87171")}
              </div>
              <div style={{display:"flex",gap:4,alignItems:"center",flexWrap:"wrap",justifyContent:"flex-end"}}>
                <span style={{fontSize:11,color:"#2a6090",flexShrink:0}}>並替:</span>
                {sBtn("score","スコア")}
                {sBtn("change","上昇率")}
              </div>
            </div>
          ):(
            <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"8px 12px",marginBottom:4,display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
              <span style={{fontSize:11,color:"#2a6090",marginRight:2}}>市場:</span>
              {fBtn("ALL","全て","#60a5fa")}
              {fBtn("US","US","#3b82f6")}
              {fBtn("JP","JP","#f87171")}
              <span style={{fontSize:11,color:"#2a6090",marginLeft:8,marginRight:2}}>並替:</span>
              {sBtn("score","スコア順")}
              {sBtn("change","上昇率順")}
            </div>
          )
        )}
        </div>
        )}
      </div>
      <div style={{overflowY:"auto",flex:1,WebkitOverflowScrolling:"touch",paddingTop:8,paddingLeft:10,paddingRight:10,paddingBottom:120}}>
        {isMobile?cardGrid:(
          <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
            <div style={{width:"60%",flexShrink:0}}>{cardGrid}</div>
            <div style={{flex:1,position:"sticky",top:0,maxHeight:"calc(100vh - 200px)",overflowY:"auto",WebkitOverflowScrolling:"touch"}}>
              <StockDetailPanel s={p.selectedStock} toggleFav={toggleFav} isFav={isFavRef} vix={vix} usdJpy={p.usdJpy} onRescan={p.onRescan} rescanLoading={p.rescanLoading&&p.selectedStock&&p.rescanLoading[p.selectedStock.ticker]} allStocks={stocks} onAddTrade={p.onAddTrade}/>
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
  var subS=useState("app");var sub=subS[0],setSub=subS[1];
  var selIdS=useState(null);var selId=selIdS[0],setSelId=selIdS[1];
  var showAccS=useState(false);var showAcc=showAccS[0],setShowAcc=showAccS[1];
  var isMobile=window.innerWidth<768;
  function isFavRef(t){return favs.indexOf(t)>=0;}
  var list=sub==="app"?p.appTrades:p.personalTrades;
  var waitingList=list.filter(function(t){return t.status==="waiting";});
  var activeList=list.filter(function(t){return t.status==="active";});
  var doneList=list.filter(function(t){return t.status==="done";});
  var totalPnl=doneList.reduce(function(a,t){return a+(t.pnl||0);},0);
  // 勝率：完了トレードのうち損益がプラスだった割合
  var winRate=doneList.length?Math.round(doneList.filter(function(t){return(t.pnl||0)>0;}).length/doneList.length*100):null;
  // 的中率の集計対象：アプリ予想で登録した銘柄のみ（お気に入りタブの集計とは分離）。個人予想では的中率自体を出さない
  var appTradeTickers=sub==="app"?Array.from(new Set(p.appTrades.map(function(t){return t.ticker;}))):[];
  var showAccuracy=sub==="app";
  var selTrade=selId?list.find(function(t){return t.id===selId;}):null;
  var selStock=selTrade?stocks.find(function(x){return x.ticker===selTrade.ticker;}):null;

  function Section(title,items,color){
    if(!items.length)return null;
    return(
      <div>
        <div style={{fontSize:11,fontWeight:700,color:color,margin:"2px 0 6px"}}>● {title}（{items.length}）</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:6}}>
          {items.slice().reverse().map(function(t){
            return <TradeMiniTile key={t.id} t={t} onClick={function(){setSelId(t.id);}}/>;
          })}
        </div>
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

      <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
        <div style={{width:(isMobile||!showAccuracy)?"100%":"60%",flexShrink:0,display:"flex",flexDirection:"column",gap:10,minWidth:0}}>
          <div style={{background:"#050e1c",borderRadius:10,padding:"12px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",gap:10}}>
            <div>
              <div style={{fontSize:11,color:"#4a7090"}}>合計損益（完了 {doneList.length}件）</div>
              <div style={{fontSize:20,fontWeight:800,color:totalPnl>=0?"#22d3a0":"#f43f5e"}}>{doneList.length?fmtPnl(totalPnl,true):"—"}</div>
            </div>
            <div style={{display:"flex",gap:10,alignItems:"center"}}>
              <div style={{textAlign:"center"}}>
                <div style={{fontSize:11,color:"#4a7090"}}>勝率</div>
                <div style={{fontSize:17,fontWeight:800,color:"#fbbf24"}}>{winRate!=null?winRate+"%":"—"}</div>
              </div>
              {isMobile&&showAccuracy&&(
                <button onClick={function(){setShowAcc(true);}} style={{background:"transparent",border:"1px solid #1e3050",borderRadius:6,color:"#0ea5e9",padding:"6px 8px",fontSize:11,cursor:"pointer",fontFamily:"monospace",whiteSpace:"nowrap"}}>📊的中率</button>
              )}
            </div>
            <button onClick={p.onRefreshTrades} disabled={p.tradeRefreshing} style={{background:p.tradeRefreshing?"#0f2040":"#0a1a3a",border:"1px solid #0ea5e9",borderRadius:8,color:"#0ea5e9",padding:"8px 12px",fontSize:12,fontWeight:700,cursor:p.tradeRefreshing?"not-allowed":"pointer",whiteSpace:"nowrap"}}>{p.tradeRefreshing?"更新中…":"🔄 価格更新"}</button>
          </div>

          {list.length===0&&<div style={{textAlign:"center",padding:"30px 20px",color:"#4a7090",fontSize:13}}>まだトレードが登録されていません。銘柄カードの🎯ボタンから登録してください</div>}

          {Section("進行中",activeList,"#0ea5e9")}
          {Section("待機中",waitingList,"#4a7090")}
          {Section("完了",doneList,"#22d3a0")}
        </div>

        {!isMobile&&showAccuracy&&(
          <div style={{flex:1,position:"sticky",top:0,background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:16,maxHeight:"calc(100vh - 200px)",overflowY:"auto",WebkitOverflowScrolling:"touch"}}>
            <div style={{fontSize:16,fontWeight:800,color:"#e0f0ff",marginBottom:10}}>📊 シグナル的中率（アプリ予想銘柄）</div>
            <SignalAccuracyContent tickers={appTradeTickers}/>
          </div>
        )}
      </div>

      {showAcc&&createPortal(<SignalAccuracyModal tickers={appTradeTickers} onClose={function(){setShowAcc(false);}}/>,document.body)}

      {selTrade&&createPortal(
        <TradeDetailModal t={selTrade} s={selStock} kind={sub} stocks={stocks} toggleFav={toggleFav} isFav={isFavRef}
          vix={vix} usdJpy={p.usdJpy} setSelectedStock={p.setSelectedStock} selectedStock={p.selectedStock}
          onRescan={p.onRescan} rescanLoading={p.rescanLoading} onAddTrade={p.onAddTrade}
          onRemoveTrade={function(kind,id){p.onRemoveTrade(kind,id);setSelId(null);}}
          onEditTrade={p.onEditTrade} onForceComplete={p.onForceComplete} onClose={function(){setSelId(null);}}/>,
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
      <div style={{fontSize:10,fontWeight:800,color:"#d8eeff",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:"100%"}}>{t.ticker.replace(".T","")}</div>
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
  var STATUS_LABEL={waiting:"待機中",active:"進行中",done:"完了"};
  var STATUS_COLOR={waiting:"#4a7090",active:"#0ea5e9",done:"#22d3a0"};
  var EXIT_LABEL={take_profit:"利確で完了",stop_loss:"損切りで完了",forced:"強制完了"};
  var unrealized=(t.status==="active"&&t.lastPrice!=null&&t.startPrice!=null)?((t.lastPrice-t.startPrice)*(t.shares||1)):null;
  var editInp={background:"#040c18",border:"1px solid #1e4070",borderRadius:5,color:"#b8cce0",padding:"6px",fontSize:13,fontFamily:"monospace",width:"100%",boxSizing:"border-box"};

  function startEdit(){setBuyVal(String(t.buyPrice));setSellVal(String(t.sellPrice));setStopVal(t.stopPrice!=null?String(t.stopPrice):"");setSharesVal(String(t.shares||1));setEditing(true);}
  function saveEdit(){
    var b=parseFloat(buyVal),se=parseFloat(sellVal),sh=parseInt(sharesVal);
    if(isNaN(b)||b<=0||isNaN(se)||se<=0||isNaN(sh)||sh<=0)return;
    var sp=stopVal!==""?parseFloat(stopVal):null;
    if(sp!=null&&(isNaN(sp)||sp<=0))return;
    p.onEditTrade(kind,t.id,{buyPrice:b,sellPrice:se,shares:sh,stopPrice:sp});
    setEditing(false);
  }
  function forceComplete(){
    var curPrice=p.s&&p.s.rawPrice!=null?p.s.rawPrice:t.lastPrice;
    if(curPrice==null){alert("現在価格が取得できていません。先に「🔄価格更新」を実行してください。");return;}
    if(!window.confirm("現在価格（"+fmtMoney(curPrice,isJP)+"）で強制的に完了させますか？"))return;
    p.onForceComplete(kind,t.id,curPrice);
  }

  return(
    <div onClick={function(e){if(e.target===e.currentTarget)p.onClose();}} style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.75)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center"}}>
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
            <div><div style={{fontSize:10,color:"#fbbf24",marginBottom:2}}>損切り（任意）</div><input type="number" value={stopVal} onChange={function(e){setStopVal(e.target.value);}} style={editInp} placeholder="未設定でもOK"/></div>
          </div>
        ):(
          <div style={{display:"flex",gap:12,fontSize:11,color:"#4a7090",flexWrap:"wrap"}}>
            <span>買い {fmtMoney(t.buyPrice,isJP)}</span>
            <span>売り {fmtMoney(t.sellPrice,isJP)}</span>
            {t.stopPrice!=null&&<span style={{color:"#fbbf24"}}>損切り {fmtMoney(t.stopPrice,isJP)}</span>}
            <span>{t.shares||1}株</span>
          </div>
        )}

        {t.status==="done"&&<div style={{fontSize:16,fontWeight:800,color:t.pnl>=0?"#22d3a0":"#f43f5e"}}>{fmtPnl(t.pnl,isJP)} <span style={{fontSize:11,fontWeight:400}}>({t.pnlPercent>=0?"+":""}{t.pnlPercent.toFixed(1)}%)</span></div>}
        {t.status==="active"&&unrealized!=null&&<div style={{fontSize:13,color:unrealized>=0?"#22d3a0":"#f43f5e"}}>含み損益 {fmtPnl(unrealized,isJP)}</div>}

        {!editing&&t.status!=="done"&&<button onClick={forceComplete} style={{background:"#2a0a12",border:"1px solid #f43f5e60",borderRadius:8,color:"#f43f5e",padding:"8px",fontSize:12,fontWeight:700,cursor:"pointer"}}>⏹ 現在価格で強制完了</button>}

        {isJP&&<a href="ispeed://" onClick={function(){var code=t.ticker.replace(".T","");if(navigator.clipboard){navigator.clipboard.writeText(code).catch(function(){});}}} style={{background:"#1a0a0a",border:"1px solid #f87171",borderRadius:8,color:"#fca5a5",padding:"10px",fontSize:12,fontWeight:700,fontFamily:"monospace",textDecoration:"none",textAlign:"center",display:"block"}}>📱 iSPEED</a>}

        {p.s?(
          <StockCard s={p.s} toggleFav={p.toggleFav} isFav={p.isFav} vix={p.vix} usdJpy={p.usdJpy} setSelectedStock={p.setSelectedStock} selectedStock={p.selectedStock} onRescan={p.onRescan} rescanLoading={p.rescanLoading&&p.rescanLoading[t.ticker]} allStocks={p.stocks} onAddTrade={p.onAddTrade}/>
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

  // ── スコア×AI判定 ダブルチェック（スコア上位5件・手動実行・stateはApp側で保持しタブ切替でも保持）───
  var dblTop5=stocks.slice().sort(function(a,b){return b.score-a.score;}).slice(0,5);
  var dblLoading=p.dblLoading,setDblLoading=p.setDblLoading;
  var dblVerdicts=p.dblVerdicts,setDblVerdicts=p.setDblVerdicts;
  var dblUpd=p.dblUpd,setDblUpd=p.setDblUpd;
  var dblErr=p.dblErr,setDblErr=p.setDblErr;

  async function runDoubleCheck(){
    if(dblLoading||dblTop5.length===0) return;
    setDblLoading(true);setDblErr("");setDblVerdicts({});
    try{
      var res=await fetch(AI_API_URL,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          prompt:buildVolumeRankingPrompt(dblTop5,dblTop5.length,false),
          system:"必ず自分でWeb検索ツールを使って各銘柄の最新ニュースを確認してから判定してください。ユーザーに質問や確認を求めず、自律的に判定を完了してください。",
          useWebSearch:true
        }),signal:AbortSignal.timeout(45000)});
      var data=await res.json();
      if(data.error) throw new Error(typeof data.error==="string"?data.error:JSON.stringify(data.error));
      var text=typeof data.text==="string"?data.text:"";
      var lines=text.split("\n");
      var map={};
      dblTop5.forEach(function(s){
        var key=s.ticker.replace(".T","");
        var line=lines.find(function(l){return l.indexOf(key)!==-1;});
        if(!line) return;
        var vm=line.match(/(買い|売り|見送り)/);
        if(!vm) return;
        var reason=line.slice(line.indexOf(vm[1])+vm[1].length).replace(/^[\s—\-ー：:）)]+/,"").trim();
        map[key]={verdict:vm[1],reason:reason};
      });
      setDblVerdicts(map);
      if(Object.keys(map).length===0) setDblErr("AIの回答から判定を抽出できませんでした。");
      else setDblUpd(new Date().toLocaleTimeString("ja-JP"));
    }catch(e){
      setDblErr("エラーが発生しました: "+(e.message||JSON.stringify(e)||"不明なエラー"));
    }
    setDblLoading(false);
  }
  // ────────────────────────────────────────────────────────────────────────

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

  // ── 出来高ランキングTOP N → claude.ai用プロンプト ──────────────────────
  var volTopNS=useState(10);var volTopN=volTopNS[0],setVolTopN=volTopNS[1];
  var volPromptS=useState("");var volPrompt=volPromptS[0],setVolPrompt=volPromptS[1];
  var volCopiedS=useState(false);var volCopied=volCopiedS[0],setVolCopied=volCopiedS[1];
  function genVolumePrompt(){
    setVolPrompt(buildVolumeRankingPrompt(stocks,volTopN));
    setVolCopied(false);
  }
  function copyVolumePrompt(){
    if(!volPrompt) return;
    navigator.clipboard.writeText(volPrompt).then(function(){
      setVolCopied(true);
      setTimeout(function(){setVolCopied(false);},2000);
    });
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
            style={{background:predictionLoading?"#0a1828":"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:8,color:"#fff",padding:"10px 16px",fontSize:13,fontWeight:700,cursor:predictionLoading||stocks.length===0?"not-allowed":"pointer",fontFamily:"monospace",flexShrink:0}}>
            {predictionLoading?"分析中...":"📡 市場予測を分析する"}
          </button>
        </div>
        {lastUpd&&<div style={{fontSize:11,color:"#2a6090"}}>最終更新: {lastUpd}</div>}
        {stocks.length===0&&<div style={{fontSize:11,color:"#f43f5e",marginTop:4}}>※ 先にスキャンを実行してください</div>}
      </div>

      <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"14px 16px",marginBottom:12}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
          <div>
            <div style={{fontSize:15,fontWeight:700,color:"#e0f0ff"}}>🎯 スコア×AI判定 ダブルチェック</div>
            <div style={{fontSize:11,color:"#4a7090",marginTop:2}}>スコア上位5件をAIが個別に買い/売り/見送り判定</div>
          </div>
          <button onClick={runDoubleCheck} disabled={dblLoading||dblTop5.length===0}
            style={{background:dblLoading?"#0a1828":"linear-gradient(135deg,#22d3a0,#059669)",border:"none",borderRadius:8,color:"#fff",padding:"10px 16px",fontSize:13,fontWeight:700,cursor:dblLoading||dblTop5.length===0?"not-allowed":"pointer",fontFamily:"monospace",flexShrink:0}}>
            {dblLoading?"判定中...":"🎯 AI判定を実行"}
          </button>
        </div>
        {dblUpd&&<div style={{fontSize:11,color:"#2a6090"}}>最終更新: {dblUpd}</div>}
        {dblErr&&<div style={{fontSize:11,color:"#f43f5e",marginTop:4}}>{dblErr}</div>}
        {dblTop5.length===0&&<div style={{fontSize:11,color:"#f43f5e",marginTop:4}}>※ 先にスキャンを実行してください</div>}
        {Object.keys(dblVerdicts).length>0&&(
          <div style={{marginTop:10,display:"flex",flexDirection:"column",gap:6}}>
            {dblTop5.map(function(s){
              var key=s.ticker.replace(".T","");
              var v=dblVerdicts[key];
              var pass=s.score>=60&&v&&v.verdict==="買い";
              var vColor=v?(v.verdict==="買い"?"#22d3a0":v.verdict==="売り"?"#f43f5e":"#fbbf24"):"#4a7090";
              return(
                <div key={s.ticker} style={{background:pass?"#052e16":"#040c18",border:"1px solid "+(pass?"#22d3a0":"#1e3050"),borderRadius:8,padding:"8px 10px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div style={{display:"flex",gap:6,alignItems:"center"}}>
                      {toggleFav&&<button onClick={function(){toggleFav(s.ticker);}} style={{background:"transparent",border:"none",fontSize:15,cursor:"pointer",padding:0,color:isFavRef(s.ticker)?"#fbbf24":"#2a4060"}}>{isFavRef(s.ticker)?"★":"☆"}</button>}
                      <span style={{fontSize:12,fontWeight:700,color:"#e0f0ff"}}>{key} {s.name}</span>
                    </div>
                    <span style={{fontSize:11,color:scoreColor(s.score)}}>スコア{s.score}</span>
                  </div>
                  <div style={{fontSize:11,color:vColor,marginTop:3}}>
                    {v?("AI判定: "+v.verdict+(v.reason?"　"+v.reason:"")):"判定なし（AI回答から抽出できず）"}
                  </div>
                  {pass&&<div style={{fontSize:11,fontWeight:700,color:"#22d3a0",marginTop:3}}>✅ ダブル合格（スコア60以上 かつ AI買い判定）</div>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div style={{background:"#050e1c",border:"1px solid #0f2040",borderRadius:10,padding:"14px 16px",marginBottom:12}}>
        <div style={{fontSize:14,fontWeight:700,color:"#e0f0ff",marginBottom:8}}>📋 出来高急増率×ボラ ランキング(日本株限定) → claude.ai用プロンプト</div>
        <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:10}}>
          <span style={{fontSize:12,color:"#4a7090"}}>上位</span>
          <input type="number" min="1" max="50" value={volTopN}
            onChange={function(e){setVolTopN(parseInt(e.target.value)||10);}}
            style={{width:56,background:"#040c18",border:"1px solid #1e3050",borderRadius:6,color:"#e0f0ff",padding:"5px 8px",fontSize:13,fontFamily:"monospace"}}/>
          <span style={{fontSize:12,color:"#4a7090"}}>件</span>
          <button onClick={genVolumePrompt} disabled={stocks.length===0}
            style={{background:"#0ea5e9",border:"none",borderRadius:6,color:"#fff",padding:"6px 12px",fontSize:12,fontWeight:700,cursor:stocks.length===0?"not-allowed":"pointer",fontFamily:"monospace"}}>生成</button>
        </div>
        {volPrompt&&(
          <div>
            <textarea readOnly value={volPrompt}
              style={{width:"100%",height:180,background:"#040c18",border:"1px solid #1e3050",borderRadius:6,color:"#b8cce0",padding:8,fontSize:11,fontFamily:"monospace",resize:"vertical",boxSizing:"border-box"}}/>
            <button onClick={copyVolumePrompt}
              style={{marginTop:8,width:"100%",background:volCopied?"#22d3a0":"transparent",border:"1px solid "+(volCopied?"#22d3a0":"#1e4070"),borderRadius:8,color:volCopied?"#04150c":"#4a7090",padding:"8px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>
              {volCopied?"✓ コピーしました":"📋 コピー"}
            </button>
          </div>
        )}
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
            style={{background:loading?"#0a1828":"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:8,color:"#fff",padding:"7px 16px",fontSize:13,fontWeight:700,cursor:loading?"not-allowed":"pointer",fontFamily:"monospace"}}>
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
              <span style={{fontSize:15,fontWeight:700,color:"#93c5fd"}}>{item.label}</span>
              <span style={{fontSize:12,color:"#4a7090"}}>{item.desc}</span>
            </a>
          );
        })}
      </div>
    </div>
  );
}

function SyncPanel(p){
  var userId=p.userId,syncApi=p.syncApi,setFavs=p.setFavs,setFavGroups=p.setFavGroups,setGroupNames=p.setGroupNames,scan=p.scan;
  var copyStatusS=useState(null);var copyStatus=copyStatusS[0],setCopyStatus=copyStatusS[1];
  var inputS=useState("");var input=inputS[0],setInput=inputS[1];
  var syncStatusS=useState(null);var syncStatus=syncStatusS[0],setSyncStatus=syncStatusS[1];
  function copyId(){
    if(navigator.clipboard){navigator.clipboard.writeText(userId).then(function(){setCopyStatus("ok");setTimeout(function(){setCopyStatus(null);},2000);});}
    else{prompt("ユーザーID",userId);}
  }
  async function syncById(){
    var id=input.trim();if(!id)return;
    setSyncStatus("loading");
    try{
      var res=await fetch(syncApi+"?userId="+id);
      var data=await res.json();
      if(!data.favs)throw new Error("invalid");
      setFavs(data.favs.slice());
      try{localStorage.setItem("fav_tickers",JSON.stringify(data.favs));}catch(e){}
      if(data.groups){setFavGroups(data.groups);try{localStorage.setItem("fav_groups",JSON.stringify(data.groups));}catch(e){}}
      if(data.groupNames){setGroupNames(function(prev){return Object.assign({},prev,data.groupNames);});try{localStorage.setItem("group_names",JSON.stringify(data.groupNames));}catch(e){}}
      if(data.appTrades){saveTrades("app",data.appTrades);p.setAppTrades(data.appTrades);}
      if(data.personalTrades){saveTrades("personal",data.personalTrades);p.setPersonalTrades(data.personalTrades);}
      try{localStorage.setItem("daytrade_uid",id);}catch(e){}
      setSyncStatus("ok");
      setTimeout(function(){setSyncStatus(null);scan();},1500);
    }catch(e){setSyncStatus("error");setTimeout(function(){setSyncStatus(null);},2500);}
  }
  var favCount=(function(){try{return JSON.parse(localStorage.getItem("fav_tickers")||"[]").length;}catch(e){return 0;}})();
  var tradeCount=(function(){try{return loadTrades("app").length+loadTrades("personal").length;}catch(e){return 0;}})();
  return(
    <div>
      <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"14px 16px",marginBottom:14}}>
        <div style={{fontSize:14,fontWeight:700,color:"#e0f0ff",marginBottom:10}}>🔗 デバイス間同期</div>
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
        <input style={{background:"#040c18",border:"1px solid #1e4070",borderRadius:6,color:"#b8cce0",padding:"10px 12px",fontSize:14,fontFamily:"monospace",width:"100%",boxSizing:"border-box",marginBottom:10}} value={input} placeholder="別デバイスのIDを貼り付け" onChange={function(e){setInput(e.target.value);}}/>
        <button onClick={syncById} disabled={!input.trim()||syncStatus==="loading"} style={{width:"100%",background:input.trim()?"linear-gradient(135deg,#22d3a0,#059669)":"#0a1828",border:"none",borderRadius:8,color:"#fff",padding:"10px",fontSize:14,fontWeight:700,cursor:input.trim()?"pointer":"not-allowed",fontFamily:"monospace"}}>
          {syncStatus==="loading"?"同期中...":syncStatus==="ok"?"✅ 同期完了！":syncStatus==="error"?"❌ IDが見つかりません":"このIDで同期する"}
        </button>
      </div>
      <div style={{background:"#050e1c",border:"1px solid #0f2040",borderRadius:10,padding:"14px 16px"}}>
        <div style={{fontSize:13,fontWeight:700,color:"#4a90c0",marginBottom:10}}>使い方</div>
        {[["1","iPadで「IDをコピー」をタップ"],["2","iPhoneのDaySimulatorを開く"],["3","🔗タブ → IDを貼り付けて「同期」"],["4","お気に入り・トレードが反映される"]].map(function(row){
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

// シグナル的中率の中身（お気に入りタブ／トレードタブ両方から使う）
// tickers省略時はお気に入り銘柄で集計。指定時はそのtickerだけで集計（トレードタブ用・お気に入りとは分離）
function SignalAccuracyContent(p){
  var tickers=p&&p.tickers;
  var data=tickers?calcSignalAccuracy(tickers):calcFavSignalAccuracy();
  var emptyLabel=tickers?"アプリ予想の登録銘柄":"お気に入り銘柄";
  return(
    <div>
      <div style={{fontSize:11,color:"#4a7090",marginBottom:10}}>{(tickers?"アプリ予想で登録した銘柄":"お気に入り登録銘柄")+"の過去データを集計。各シグナルが出た翌営業日に株価が上がった割合です"}</div>
      {data.length===0?(
        <div style={{fontSize:13,color:"#4a7090",textAlign:"center",padding:"20px 0"}}>まだデータがありません。{emptyLabel}を毎日スキャンすると溜まっていきます。</div>
      ):(
        <div>
          <div style={{display:"flex",fontSize:11,color:"#2a6090",padding:"4px 8px",borderBottom:"1px solid #0f2040"}}>
            <div style={{flex:1}}>シグナル</div>
            <div style={{width:60,textAlign:"right"}}>的中率</div>
            <div style={{width:50,textAlign:"right"}}>件数</div>
          </div>
          {data.map(function(row,i){
            var reliable=row.total>=5;
            var color=row.winRate==null?"#4a7090":row.winRate>=60?"#22d3a0":row.winRate>=50?"#fbbf24":"#f43f5e";
            return(
              <div key={i} style={{display:"flex",alignItems:"center",fontSize:13,padding:"6px 8px",borderBottom:"1px solid #0a1830",opacity:reliable?1:0.5}}>
                <div style={{flex:1,color:"#b8cce0",fontFamily:"monospace"}}>{formatSigKeyLabel(row.signal)}</div>
                <div style={{width:60,textAlign:"right",color:color,fontWeight:700}}>{row.winRate!=null?row.winRate+"%":"-"}</div>
                <div style={{width:50,textAlign:"right",color:"#4a7090"}}>{row.total}</div>
              </div>
            );
          })}
          <div style={{fontSize:11,color:"#2a6090",marginTop:10}}>※件数5未満は参考値（薄く表示）。件数が増えるほど信頼度が上がります</div>
        </div>
      )}
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
        <SignalAccuracyContent tickers={p.tickers}/>
      </div>
    </div>
  );
}

function GuidePanel(){
  var openS=useState("all");var openKey=openS[0],setOpenKey=openS[1];
  var CATS=[
    {key:"all",icon:"📋",label:"全銘柄",sections:[
      {title:null,items:["銘柄カードをタップ → 詳細シグナル表示"]},
      {title:"📊 データ取得の方法",items:["米国株：Yahoo Finance・15分足（直近60日）","日本株：J-Quants・1分足（直近10営業日）","日本株ランキング：J-Quants（前営業日の出来高上位50）","米国株ランキング：Yahoo Finance 出来高上位50","市況指数（日経・ダウ等）：Yahoo Finance・15分遅延"]},
      {title:"📖 指標の見方（RSI・BB・BB収束・OBV・出来高）",items:[
        "【確認用】RSI（相対力指数）：30以下で売られすぎ・反発狙いの補助確認。70以上で買われすぎ・過熱感の補助確認。BBのシグナルと合わせて判断する",
        "【メイン判断】BB（ボリンジャーバンド）：バンドの収縮＝エネルギー蓄積→ブレイクアウト狙いの買い準備。バンドの拡大＝トレンド発生中。下限タッチで反発買い候補、上限タッチで過熱感・利確検討",
        "【収束確認】BB収束：バンドが狭まっている状態＝エネルギー蓄積中。収束率が高いほどブレイクアウトの可能性が高まる",
        "【方向確認】OBV（板代替）：終値の位置で買い・売り優勢を判定。高値引けに近いほど買い圧力が強い。BB判断と方向が一致しているか確認する",
        "【勢い確認】出来高：平均比2倍以上の急増＋高値引けなら買いシグナル強化。出来高増＋安値引けなら売り圧力増大で警戒"
      ]},
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
      {title:"📉 下値サポート目安の見方",items:["S1（20日安値）：直近20日間の最安値。短期の下値サポートライン。ここを割ると次のS2が目安","S2（60日安値）：直近60日間の最安値。中期の強いサポートライン。S1を割り込んだ場合の次の目安","ATR×1.5下限：14日間の平均値幅（ATR）×1.5を現在値から引いた価格。統計的な下値の限界目安","活用法：S1割れで警戒、S2割れで損切り検討、ATR下限は最悪ケースの想定として使用"]},
      {title:"🔘 銘柄詳細のアイコン行",items:[
        "📋：AI判定用のプロンプトをクリップボードにコピー（claude.aiなどに貼り付けて使う用）",
        "🔄：この銘柄だけを最新データで再スキャン",
        "🤖：AIによる分析・上昇予測をポップアップ表示",
        "💹：損益シミュレーターをポップアップ表示（買値・株数から利確/損切りラインの損益を試算）",
        "🔀：逆相関で上昇しやすい銘柄をポップアップ表示（下落中の銘柄でのみ使用可）",
        "逆相関の数値（例：-0.51）：2銘柄の値動きの関係の強さを-1〜+1で表す相関係数。+1に近いほど同じ方向に動きやすく、-1に近いほど逆方向に動きやすい（0は無関係）。過去60営業日程度のデータに基づく統計的傾向であり、将来を保証するものではない"
      ]},
    ]},
    {key:"fav",icon:"⭐",label:"お気に入り",sections:[
      {title:null,items:[
        "★/☆ボタンでお気に入りの登録・解除",
        "グループ1〜5に分類可能（グループ名は選択中に表示される✎アイコンで編集）",
        "「全体」フィルターで登録済みお気に入りを全件表示",
        "検索欄にティッカーコード（例：AAPL、7203）を入力すると新規銘柄を追加登録できる（登録グループも指定可）",
        "市場（US/JP）で絞り込み、スコア順・上昇率順で並び替え可能",
        "「📊的中率」ボタンでお気に入り銘柄のシグナル的中率を確認"
      ]},
    ]},
    {key:"trade",icon:"🎯",label:"トレード",sections:[
      {title:null,items:[
        "銘柄カードの🎯ボタンからトレード登録（買い価格・売り価格＝利確ライン・株数を入力。損切り価格は任意）",
        "「🎯アプリ予想」：アプリの買いシグナル判断を忠実に守った場合の検証用タブ",
        "「👤個人予想」：アプリの判断とは別に、自分自身の判断を検証するためのタブ",
        "価格が指定値に到達すると自動で「待機中→進行中→完了」に遷移（判定は🔄価格更新ボタンで反映）",
        "完了したトレードの合計損益・勝率を集計表示",
        "「📊的中率」でアプリ予想に登録した銘柄のシグナル的中率を確認（個人予想では非表示）",
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
  var isMobile=window.innerWidth<768;
  return(
    <div style={{display:"flex",gap:isMobile?4:8,alignItems:isMobile?"flex-start":"center",flexDirection:isMobile?"column":"row"}}>
      <div style={{display:"flex",flexDirection:"column",gap:2}}>
        <span style={{fontSize:isMobile?11:13,fontWeight:jpOpen?700:400,color:jpOpen?"#22d3a0":"#4a7090"}}>🇯🇵 9:00〜11:30</span>
        <span style={{fontSize:isMobile?11:13,fontWeight:jpOpen?700:400,color:jpOpen?"#22d3a0":"#4a7090"}}>🇯🇵 12:30〜15:30</span>
      </div>
      {!isMobile&&<span style={{fontSize:13,color:"#1e3050"}}>|</span>}
      <div style={{display:"flex",flexDirection:"column",gap:2}}>
        <span style={{fontSize:isMobile?11:13,fontWeight:usOpen?700:400,color:usOpen?"#22d3a0":"#4a7090"}}>🇺🇸 22:30〜翌5:00 <span style={{fontSize:isMobile?9:11,color:usOpen?"#22d3a0":"#2a6090"}}>[夏]</span></span>
        <span style={{fontSize:isMobile?11:13,fontWeight:usOpen?700:400,color:usOpen?"#22d3a0":"#4a7090"}}>🇺🇸 23:30〜翌6:00 <span style={{fontSize:isMobile?9:11,color:usOpen?"#22d3a0":"#2a6090"}}>[冬]</span></span>
      </div>
    </div>
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
  var dblLoadS=useState(false);var dblLoading=dblLoadS[0],setDblLoading=dblLoadS[1];
  var dblVerdS=useState({});var dblVerdicts=dblVerdS[0],setDblVerdicts=dblVerdS[1];
  var dblUpdS2=useState(null);var dblUpd=dblUpdS2[0],setDblUpd=dblUpdS2[1];
  var dblErrS2=useState("");var dblErr=dblErrS2[0],setDblErr=dblErrS2[1];
  var selStockS=useState(null);var selectedStock=selStockS[0],setSelectedStock=selStockS[1];
  var k=useState("all");var activeTab=k[0],setActiveTab=k[1];

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

  var userIdS=useState(function(){try{var id=localStorage.getItem("daytrade_uid");if(!id){id="u_"+Math.random().toString(36).slice(2,10);localStorage.setItem("daytrade_uid",id);}return id;}catch(e){return"u_default";}});var userId=userIdS[0];
  var SYNC_API="https://daytrade-simulator.vercel.app/api/sync";
  function getAllScoreHist(){var result={};try{Object.keys(localStorage).forEach(function(k){if(k.startsWith("sh_"))result[k.slice(3)]=JSON.parse(localStorage.getItem(k)||"[]");});}catch(e){}return result;}
  var fvS=useState(function(){try{var v=localStorage.getItem("fav_tickers");return v?JSON.parse(v):[];}catch(e){return[];}});var favs=fvS[0],setFavs=fvS[1];
  var DEFAULT_GROUP_NAMES={1:"グループ1",2:"グループ2",3:"グループ3",4:"グループ4",5:"グループ5"};
  var fgS=useState(function(){try{var v=localStorage.getItem("fav_groups");return v?JSON.parse(v):{};}catch(e){return{};}});var favGroups=fgS[0],setFavGroups=fgS[1];
  var gnS=useState(function(){try{var v=localStorage.getItem("group_names");return v?Object.assign({},DEFAULT_GROUP_NAMES,JSON.parse(v)):Object.assign({},DEFAULT_GROUP_NAMES);}catch(e){return Object.assign({},DEFAULT_GROUP_NAMES);}});var groupNames=gnS[0],setGroupNames=gnS[1];
  var NOTIFY_API="https://daytrade-simulator.vercel.app/api/notify";
  function syncToServer(nextFavs,nextGroups,nextGroupNames,nextAppTrades,nextPersonalTrades){
    fetch(SYNC_API+"?userId="+userId,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
      favs:nextFavs,
      scoreHist:getAllScoreHist(),
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
  function addTradeHandler(kind,s,buyPrice,sellPrice,shares,stopPrice){
    var next=addTradeRecord(kind,s,buyPrice,sellPrice,shares,stopPrice);
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
  function refreshTradePrices(){
    var tickers=[];
    appTrades.concat(personalTrades).forEach(function(t){
      if(t.status!=="done"&&tickers.indexOf(t.ticker)<0)tickers.push(t.ticker);
    });
    if(!tickers.length)return;
    setTradeRefreshing(true);
    tickers.forEach(function(ticker){delete CACHE[ticker];}); // キャッシュを無視して必ず最新価格を取得
    Promise.all(tickers.map(function(ticker){
      return fetchYahoo(ticker).then(function(pd){return{ticker:ticker,price:pd.currentPrice};}).catch(function(){return{ticker:ticker,price:null};});
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
      var uResult=await buildStockUniverse(manualSectors,skipAI);
      var universe=uResult.stocks.slice();
      var jpCount=universe.length;
      var sectorLabel=uResult.sectors&&uResult.sectors.length?uResult.sectors.map(function(s){return s.name;}).join("/"):"通常ランキング";
      setProgress({done:0,total:0,msg:"JP:"+jpCount+"銘柄（"+sectorLabel+"）取得完了 分析開始..."});
      await new Promise(function(r){setTimeout(r,800);}); // ↑のメッセージが一瞬で上書きされて表示されないのを防ぐため少し待つ
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
      var results=[],BATCH=3;
      for(var i=0;i<universe.length;i+=BATCH){
        var batch=universe.slice(i,i+BATCH);
        await Promise.all(batch.map(async function(stock){
          var pd=await fetchYahooSafe(stock.ticker);
          try{results.push(analyzeStock(stock,pd,vix));}catch(e){console.error("analyzeStock error",stock.ticker,e);}
          setProgress(function(p){return{done:p.done+1,total:p.total,msg:null};});
        }));
        if(i+BATCH<universe.length)await new Promise(function(r){setTimeout(r,300);});
      }
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
      var results=[],BATCH=3;
      for(var i=0;i<universe.length;i+=BATCH){
        var batch=universe.slice(i,i+BATCH);
        await Promise.all(batch.map(async function(stock){
          var pd=await fetchYahooSafe(stock.ticker);
          try{results.push(analyzeStock(stock,pd,vix));}catch(e){console.error("analyzeStock error",stock.ticker,e);}
          setProgress(function(p){return{done:p.done+1,total:p.total,msg:null};});
        }));
        if(i+BATCH<universe.length)await new Promise(function(r){setTimeout(r,300);});
      }
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
    fetch(SYNC_API+"?userId="+userId)
      .then(function(r){return r.json();})
      .then(function(data){
        if(data.favs&&data.favs.length>0){setFavs(data.favs.slice());try{localStorage.setItem("fav_tickers",JSON.stringify(data.favs));}catch(e){}}
        if(data.groups){setFavGroups(data.groups);try{localStorage.setItem("fav_groups",JSON.stringify(data.groups));}catch(e){}}
        if(data.groupNames){setGroupNames(function(prev){return Object.assign({},prev,data.groupNames);});try{localStorage.setItem("group_names",JSON.stringify(data.groupNames));}catch(e){}}
        if(data.appTrades){saveTrades("app",data.appTrades);setAppTrades(data.appTrades);}
        if(data.personalTrades){saveTrades("personal",data.personalTrades);setPersonalTrades(data.personalTrades);}
        if(data.scoreHist){try{Object.keys(data.scoreHist).forEach(function(ticker){localStorage.setItem("sh_"+ticker,JSON.stringify(data.scoreHist[ticker]));});}catch(e){}}
      })
      .catch(function(){});
  },[]);
  var TABS=[["all","📋"],["fav","⭐"],["trade","🎯"],["event","📅"],["index","🌍"],["market","📡"],["news","📰"],["sync","🔗"],["guide","📘"]];
  var TAB_LABELS={"all":"全銘柄","fav":"お気に入り","trade":"トレード","event":"決算・権利落ち","index":"リンク","market":"市場予測","news":"ニュース","sync":"デバイス同期","guide":"使い方"};
  var TAB_SHORT={"all":"全銘柄","fav":"お気に入り","trade":"トレード","event":"決算/権利","index":"リンク","market":"市場予測","news":"ニュース","sync":"同期","guide":"使い方"};
  var isMobile=window.innerWidth<768;

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
        {isMobile&&(
          <div style={{display:"flex",gap:4,marginTop:8,overflowX:"auto",WebkitOverflowScrolling:"touch",paddingBottom:2}}>
            {TABS.map(function(tab){
              var active=activeTab===tab[0];
              return(
                <button key={tab[0]} onClick={function(){setActiveTab(tab[0]);}}
                  style={{background:active?"#0ea5e9":"#050f20",border:"1px solid "+(active?"#0ea5e9":"#1e3050"),borderRadius:8,color:active?"#fff":"#4a6080",padding:"4px 8px",fontSize:10,cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:1,flexShrink:0,minWidth:44}}>
                  <span style={{fontSize:16}}>{tab[1]}</span>
                  <span style={{fontSize:9,whiteSpace:"nowrap"}}>{TAB_SHORT[tab[0]]}</span>
                </button>
              );
            })}
          </div>
        )}
        {sectorPickerModal}
        {rescanMenu}
        {favPickerModal}
      </div>
      <div>
        {!isMobile&&(
          <div style={{width:50,background:"#050f20",borderRight:"1px solid #0f2040",display:"flex",flexDirection:"column",alignItems:"center",paddingTop:10,gap:4,flexShrink:0,position:"fixed",top:0,left:0,height:"100vh",overflowY:"auto",zIndex:15}}>
            {TABS.map(function(tab){var active=activeTab===tab[0];return(<button key={tab[0]} onClick={function(){setActiveTab(tab[0]);}} title={TAB_LABELS[tab[0]]} style={{width:40,height:40,background:active?"#0ea5e9":"transparent",border:"1px solid "+(active?"#0ea5e9":"transparent"),borderRadius:8,color:active?"#fff":"#4a6080",fontSize:17,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>{tab[1]}</button>);})}
          </div>
        )}
        <div style={{marginLeft:isMobile?0:50,padding:"10px 10px 120px"}}>
          {activeTab==="all"&&<AllStocksPanel stocks={stocks} loading={loading} toggleFav={toggleFav} favs={favs} vix={vix} usdJpy={usdJpy} onScan={function(){setRescanMenuOpen(true);}} ts={ts} progress={progress} selectedStock={selectedStock} setSelectedStock={setSelectedStock} onRescan={rescanOne} rescanLoading={rescanLoading} onAddTrade={addTradeHandler}/>}
          {activeTab==="fav"&&<FavPanel stocks={stocks} setStocks={setStocks} favs={favs} toggleFav={toggleFav} favGroups={favGroups} groupNames={groupNames} renameGroup={renameGroup} vix={vix} usdJpy={usdJpy} selectedStock={selectedStock} setSelectedStock={setSelectedStock} onRescan={rescanOne} rescanLoading={rescanLoading} onAddTrade={addTradeHandler}/>}
          {activeTab==="trade"&&<TradePanel stocks={stocks} appTrades={appTrades} personalTrades={personalTrades} toggleFav={toggleFav} favs={favs} vix={vix} usdJpy={usdJpy} selectedStock={selectedStock} setSelectedStock={setSelectedStock} onRescan={rescanOne} rescanLoading={rescanLoading} onAddTrade={addTradeHandler} onRemoveTrade={removeTradeHandler} onEditTrade={editTradeHandler} onForceComplete={forceCompleteHandler} onRefreshTrades={refreshTradePrices} tradeRefreshing={tradeRefreshing}/>}
          {activeTab==="index"&&<IndexPanel/>}
          {activeTab==="market"&&<MarketPredictionPanel stocks={stocks} vix={vix} predictionResult={predictionResult} setPredictionResult={setPredictionResult} predictionLoading={predictionLoading} setPredictionLoading={setPredictionLoading} dblLoading={dblLoading} setDblLoading={setDblLoading} dblVerdicts={dblVerdicts} setDblVerdicts={setDblVerdicts} dblUpd={dblUpd} setDblUpd={setDblUpd} dblErr={dblErr} setDblErr={setDblErr} favs={favs} toggleFav={toggleFav}/>}
          {activeTab==="news"&&<NewsPanel/>}
          {activeTab==="event"&&<EventPanel stocks={stocks}/>}
          {activeTab==="sync"&&<SyncPanel userId={userId} syncApi={SYNC_API} setFavs={setFavs} setFavGroups={setFavGroups} setGroupNames={setGroupNames} setAppTrades={setAppTrades} setPersonalTrades={setPersonalTrades} scan={scan}/>}
          {activeTab==="guide"&&<GuidePanel/>}
        </div>
      </div>
    </div>
  );
}
