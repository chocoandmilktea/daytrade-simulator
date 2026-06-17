import { useState, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";

var BADGE = {
  BUY:   { bg:"#052e16", border:"#22d3a0", text:"#22d3a0", label:"買い"   },
  WATCH: { bg:"#1c1400", border:"#fbbf24", text:"#fbbf24", label:"様子見" },
  SKIP:  { bg:"#1f0010", border:"#f43f5e", text:"#f43f5e", label:"見送り" },
};
var MKT = {
  US: { bg:"#0a1e3a", border:"#3b82f6", text:"#93c5fd", label:"US" },
  JP: { bg:"#1a0a0a", border:"#f87171", text:"#fca5a5", label:"JP" },
};

function scoreColor(n){ return n>=68?"#22d3a0":n>=42?"#fbbf24":"#f43f5e"; }
function bStyle(bg,border,text){ return{background:bg,border:"1px solid "+border,color:text,fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4}; }

var CACHE={}, CACHE_TTL=30*60*1000;
var VERCEL_API="https://daytrade-simulator.vercel.app/api/stock";
var RANKING_API="https://daytrade-simulator.vercel.app/api/ranking";

async function fetchRanking(market){
  try{
    var res=await fetch(RANKING_API+"?market="+market,{signal:AbortSignal.timeout(15000)});
    if(!res.ok) throw new Error("ranking "+res.status);
    var json=await res.json();
    var stocks=(json.stocks||[]).map(function(s){return{ticker:s.ticker,name:s.name,market:s.market,tvSymbol:s.tvSymbol};});
    return stocks.length>0?stocks:null;
  }catch(e){return null;}
}

async function buildStockUniverse(){
  var results=await Promise.all([fetchRanking("us"),fetchRanking("jp")]);
  var us=results[0]||[];
  var jp=results[1]||[];
  if(us.length===0){var retry=await fetchRanking("us");us=retry||[];}
  if(jp.length===0){var retry2=await fetchRanking("jp");jp=retry2||[];}
  var seen={},out=[];
  us.slice(0,50).concat(jp.slice(0,50)).forEach(function(s){if(!seen[s.ticker]){seen[s.ticker]=true;out.push(s);}});
  return out;
}

async function fetchYahoo(ticker){
  var now=Date.now();
  if(CACHE[ticker]&&now-CACHE[ticker].ts<CACHE_TTL){var cached=CACHE[ticker].data;return{closes:cached.closes.slice(),highs:cached.highs.slice(),lows:cached.lows.slice(),volumes:cached.volumes?cached.volumes.slice():[],currentPrice:cached.currentPrice,previousClose:cached.previousClose,real:cached.real};}
  var res=await fetch(VERCEL_API+"?ticker="+encodeURIComponent(ticker)+"&range=2y",{signal:AbortSignal.timeout(15000)});
  if(!res.ok) throw new Error("HTTP "+res.status);
  var json=await res.json();
  var result=json&&json.chart&&json.chart.result&&json.chart.result[0];
  if(!result) throw new Error("empty");
  var q=result.indicators.quote[0],meta=result.meta;
  function fill(arr){var out=(arr||[]).slice();for(var j=0;j<out.length;j++)if(out[j]==null)out[j]=j>0?out[j-1]:0;return out;}
  var per=result.per||null,pbr=result.pbr||null,analystTarget=result.analystTarget||null;
  var data={closes:fill(q.close),highs:fill(q.high),lows:fill(q.low),volumes:fill(q.volume),currentPrice:meta.regularMarketPrice||fill(q.close).slice(-1)[0],previousClose:meta.chartPreviousClose||0,real:true,per:per,pbr:pbr,analystTarget:analystTarget};
  CACHE[ticker]={ts:now,data:data};
  return{closes:data.closes.slice(),highs:data.highs.slice(),lows:data.lows.slice(),volumes:data.volumes.slice(),currentPrice:data.currentPrice,previousClose:data.previousClose,real:data.real,per:data.per,pbr:data.pbr,analystTarget:data.analystTarget};
}

function genSim(ticker){
  var h=0;for(var i=0;i<ticker.length;i++)h=(Math.imul(31,h)+ticker.charCodeAt(i))|0;
  var s=Math.abs(h);function rng(){s=(s*1664525+1013904223)&0x7fffffff;return s/0x7fffffff;}
  var price=rng()*400+60,closes=[],highs=[],lows=[];
  for(var d=0;d<63;d++){var v=rng()*0.025;price=Math.max(5,price*(1+rng()*0.006-0.003+(rng()-0.5)*v));closes.push(price);highs.push(price*(1+rng()*0.008));lows.push(price*(1-rng()*0.008));}
  return{closes:closes,highs:highs,lows:lows,currentPrice:price,previousClose:closes[closes.length-2],real:false};
}

function calcSMA(arr,p){return arr.map(function(_,i){if(i<p-1)return null;var s=0;for(var j=i-p+1;j<=i;j++)s+=arr[j];return s/p;});}
function calcEMA(arr,p){var k=2/(p+1),out=[arr[0]];for(var i=1;i<arr.length;i++)out.push(arr[i]*k+out[i-1]*(1-k));return out;}
function calcMACD(arr){var e12=calcEMA(arr,12),e26=calcEMA(arr,26),ml=e12.map(function(v,i){return v-e26[i];}),sig=calcEMA(ml,9);return ml.map(function(v,i){return{hist:v-sig[i]};});}
function calcRSI(arr){var p=14,out=[];for(var x=0;x<p;x++)out.push(null);var ag=0,al=0;for(var i=1;i<=p;i++){var diff2=arr[i]-arr[i-1];if(diff2>=0)ag+=diff2;else al-=diff2;}ag/=p;al/=p;out.push(100-100/(1+ag/(al||1e-9)));for(var j=p+1;j<arr.length;j++){var diff=arr[j]-arr[j-1];ag=(ag*(p-1)+Math.max(diff,0))/p;al=(al*(p-1)+Math.max(-diff,0))/p;out.push(100-100/(1+ag/(al||1e-9)));}return out;}
function calcBoll(arr){var p=20,k=2;return arr.map(function(_,i){if(i<p-1)return null;var bl=arr.slice(i-p+1,i+1),m=bl.reduce(function(a,b){return a+b;})/p,sd=Math.sqrt(bl.reduce(function(a,b){return a+(b-m)*(b-m);},0)/p);return{upper:m+k*sd,lower:m-k*sd};});}
function calcStoch(closes,highs,lows){var p=14;return closes.map(function(_,i){if(i<p-1)return null;var hi=Math.max.apply(null,highs.slice(i-p+1,i+1)),lo=Math.min.apply(null,lows.slice(i-p+1,i+1));if(lo===hi)return 50;return((closes[i]-lo)/(hi-lo))*100;});}

function runBacktest(closes,sellDays){
  var days=sellDays||5;
  var results=[],wins=0,total=0;
  for(var i=26;i<closes.length-days;i++){
    var slice=closes.slice(0,i+1),macd=calcMACD(slice),mn=macd[i],mp=macd[i-1];
    if(mn&&mp&&mn.hist>0&&mp.hist<=0){var buyPrice=closes[i],sellPrice=closes[Math.min(i+days,closes.length-1)],ret=(sellPrice-buyPrice)/buyPrice*100;total++;if(ret>0)wins++;results.push({buyPrice:buyPrice.toFixed(2),sellPrice:sellPrice.toFixed(2),ret:ret.toFixed(2),win:ret>0});}
  }
  return{results:results.slice(-20),winRate:total>0?(wins/total*100).toFixed(1):"0",total:total};
}

function analyzeStock(stock,pd){
  var closes=pd.closes.slice(),highs=pd.highs.slice(),lows=pd.lows.slice();
  var volumes=pd.volumes?pd.volumes.slice():[];
  var n=closes.length-1;
  var s20=calcSMA(closes,20)[n],s50=calcSMA(closes,50)[n];
  var macdArr=calcMACD(closes),rsiVal=calcRSI(closes)[n];
  var bollVal=calcBoll(closes)[n],stochVal=calcStoch(closes,highs,lows)[n];
  var mNow=macdArr[n],mPrev=macdArr[n-1],price=pd.currentPrice||closes[n];
  var sc=0,signals=[];

  var change=pd.previousClose?((price-pd.previousClose)/pd.previousClose*100).toFixed(2):"0.00";
  var dispPrice=stock.market==="JP"?"¥"+Math.round(price).toLocaleString():"$"+price.toFixed(2);
  var yearData=closes.slice(-252);
  var high52=yearData.length>0?Math.max.apply(null,yearData):price;
  var low52=yearData.length>0?Math.min.apply(null,yearData):price;
  var fromHigh=high52>0?((price-high52)/high52*100):0;
  var fromLow=low52>0?((price-low52)/low52*100):0;
  var range52=high52-low52||1;
  var position52=((price-low52)/range52*100);

  if(s20&&s50){
    if(price>s20&&s20>s50){sc+=20;signals.push({label:"トレンド",val:"上昇トレンド",state:1});}
    else if(price<s20&&s20<s50){sc-=15;signals.push({label:"トレンド",val:"下降トレンド",state:-1});}
    else{sc+=5;signals.push({label:"トレンド",val:"横ばい",state:0});}
  }else if(s20){
    if(price>s20){sc+=10;signals.push({label:"トレンド",val:"MA20上",state:1});}
    else{sc-=8;signals.push({label:"トレンド",val:"MA20下",state:-1});}
  }

  if(mNow.hist>0&&mPrev&&mPrev.hist<=0){sc+=30;signals.push({label:"MACD",val:"ゴールデンクロス",state:1});}
  else if(mNow.hist>0){sc+=10;signals.push({label:"MACD",val:"強気ゾーン",state:1});}
  else if(mNow.hist<0&&mPrev&&mPrev.hist>=0){sc-=25;signals.push({label:"MACD",val:"デッドクロス",state:-1});}
  else{sc-=8;signals.push({label:"MACD",val:"弱気ゾーン",state:-1});}

  var rl="RSI("+rsiVal.toFixed(1)+")";
  if(rsiVal<30){sc+=25;signals.push({label:rl,val:"売られすぎ",state:1});}
  else if(rsiVal<40){sc+=18;signals.push({label:rl,val:"やや売られ",state:1});}
  else if(rsiVal<50){sc+=12;signals.push({label:rl,val:"やや弱め",state:0});}
  else if(rsiVal<60){sc+=8;signals.push({label:rl,val:"中立",state:0});}
  else if(rsiVal<70){sc+=5;signals.push({label:rl,val:"やや強め",state:0});}
  else{sc-=12;signals.push({label:rl,val:"買われすぎ",state:-1});}

  if(bollVal){
    var bbPos=(closes[n]-bollVal.lower)/(bollVal.upper-bollVal.lower||1);
    if(price<=bollVal.lower){sc+=20;signals.push({label:"BB",val:"下限→反発",state:1});}
    else if(bbPos<0.2){sc+=15;signals.push({label:"BB",val:"下限付近",state:1});}
    else if(price>=bollVal.upper){sc-=15;signals.push({label:"BB",val:"上限→過熱",state:-1});}
    else if(bbPos>0.8){sc+=3;signals.push({label:"BB",val:"上限付近",state:0});}
    else{sc+=8;signals.push({label:"BB",val:"バンド内",state:0});}
  }

  if(stochVal!==null){
    var sl="Stoch("+stochVal.toFixed(1)+")";
    if(stochVal<20){sc+=15;signals.push({label:sl,val:"売られすぎ",state:1});}
    else if(stochVal<35){sc+=10;signals.push({label:sl,val:"やや売られ",state:1});}
    else if(stochVal>80){sc-=10;signals.push({label:sl,val:"買われすぎ",state:-1});}
    else if(stochVal>65){sc+=3;signals.push({label:sl,val:"やや強め",state:0});}
    else{sc+=6;signals.push({label:sl,val:"中立",state:0});}
  }

  var overlapLabels=[];
  var hasMACD=signals.find(function(sig){return sig.label==="MACD"&&(sig.val==="ゴールデンクロス"||sig.val==="強気ゾーン");});
  var hasRSIOversold=signals.find(function(sig){return sig.label.startsWith("RSI")&&(sig.val==="売られすぎ"||sig.val==="やや売られ");});
  var hasBBLow=signals.find(function(sig){return sig.label==="BB"&&(sig.val==="下限→反発"||sig.val==="下限付近");});
  var hasStochOversold=signals.find(function(sig){return sig.label.startsWith("Stoch")&&(sig.val==="売られすぎ"||sig.val==="やや売られ");});
  var hasTrendUp=signals.find(function(sig){return sig.label==="トレンド"&&(sig.val==="上昇トレンド"||sig.val==="MA20上");});
  var hasGC=signals.find(function(sig){return sig.label==="MACD"&&sig.val==="ゴールデンクロス";});
  var hasDC=signals.find(function(sig){return sig.label==="MACD"&&sig.val==="デッドクロス";});
  var hasBearTrend=signals.find(function(sig){return sig.label==="トレンド"&&(sig.val==="下降トレンド"||sig.val==="MA20下");});
  var overlap=0;

  if(hasGC&&hasRSIOversold){overlap+=15;overlapLabels.push("GC+RSI");}
  if(hasGC&&hasBBLow){overlap+=12;overlapLabels.push("GC+BB");}
  if(hasRSIOversold&&hasBBLow&&!hasDC&&!hasBearTrend){overlap+=10;overlapLabels.push("RSI+BB");}
  if(hasRSIOversold&&hasStochOversold&&!hasDC&&!hasBearTrend){overlap+=8;overlapLabels.push("RSI+Stoch");}
  if(hasBBLow&&hasStochOversold&&!hasDC&&!hasBearTrend){overlap+=8;overlapLabels.push("BB+Stoch");}
  if(hasTrendUp&&hasGC){overlap+=10;overlapLabels.push("トレンド+GC");}
  if(hasGC&&hasRSIOversold&&hasBBLow){overlap+=10;overlapLabels.push("トリプル");}

  sc=sc+overlap;

  var obScore=0;
  if(volumes.length>0){
    var dayRange=highs[n]-lows[n]||1;
    var closePosition=(price-lows[n])/dayRange;
    if(closePosition>=0.8){obScore+=8;signals.push({label:"板代替",val:"買い優勢",state:1});}
    else if(closePosition>=0.6){obScore+=4;signals.push({label:"板代替",val:"やや買い優勢",state:1});}
    else if(closePosition<=0.2){obScore-=8;signals.push({label:"板代替",val:"売り優勢",state:-1});}
    else if(closePosition<=0.4){obScore-=4;signals.push({label:"板代替",val:"やや売り優勢",state:-1});}
    else{signals.push({label:"板代替",val:"中立",state:0});}
    var recentVols=volumes.slice(-21,-1);
    if(recentVols.length>0){
      var avgVol=recentVols.reduce(function(a,b){return a+b;},0)/recentVols.length;
      var surge=avgVol>0?volumes[n]/avgVol:1;
      if(surge>=2.0){
        obScore+=(closePosition>=0.6?10:closePosition<=0.4?-10:3);
        signals.push({label:"出来高",val:surge.toFixed(1)+"倍"+(closePosition>=0.6?"(買い)":closePosition<=0.4?"(売り)":"(中立)"),state:closePosition>=0.6?1:closePosition<=0.4?-1:0});
      }else if(surge>=1.5){obScore+=3;signals.push({label:"出来高",val:"やや増加",state:0});}
    }
  }
  sc=sc+obScore;

  var scoreCap=100;
  if(hasDC&&hasBearTrend){scoreCap=20;}
  else if(hasDC){scoreCap=30;}
  else if(hasBearTrend){scoreCap=35;}

  sc=Math.min(scoreCap,Math.max(0,sc));

  var recentCloses=closes.slice(-20);
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

  var winRate=Math.min(88,Math.max(28,sc*0.72));
  var expVal=(winRate/100*2.5-(1-winRate/100)*1.5).toFixed(2);
  var timing=sc>=68?"BUY":sc>=42?"WATCH":"SKIP";

  var aptScore=0;
  try{
    if(sc>=68) aptScore+=30;
    else if(sc>=42) aptScore+=15;
    var hasTrendUpApt=signals&&signals.find(function(sig){return sig&&sig.label==="トレンド"&&(sig.val==="上昇トレンド"||sig.val==="MA20上");});
    if(hasTrendUpApt) aptScore+=25;
    if(position52!=null&&position52<=25) aptScore+=25;
    else if(position52!=null&&position52<=50) aptScore+=15;
    if(tradeType==="mid") aptScore+=20;
    else if(tradeType==="stable") aptScore+=10;
    aptScore=Math.min(100,Math.max(0,aptScore));
  }catch(e){aptScore=0;}

  // ── 本日の想定値幅（ATRベース）─────────────────────────────────────────
  var atrLen=Math.min(14,closes.length-1);
  var atrSum=0;
  for(var ai=closes.length-atrLen;ai<closes.length;ai++){
    var h=highs[ai]||closes[ai],l=lows[ai]||closes[ai],pc=closes[ai-1];
    var tr=Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc));
    atrSum+=tr;
  }
  var atr=atrLen>0?Math.round(atrSum/atrLen):Math.round(price*0.02);
  var atrUpper=Math.round(price+atr);
  var atrLower=Math.round(price-atr);
  // ────────────────────────────────────────────────────────────────────────

  return{ticker:stock.ticker,tvSymbol:stock.tvSymbol,name:stock.name,market:stock.market,
    price:dispPrice,rawPrice:price,score:sc,winRate:winRate.toFixed(1),expVal:expVal,
    timing:timing,signals:signals,change:change,spark:closes.slice(-30),
    real:pd.real,closes:closes,per:pd.per||null,pbr:pd.pbr||null,
    high52:high52,low52:low52,fromHigh:fromHigh,fromLow:fromLow,position52:position52,
    overlapLabels:overlapLabels,
    tradeType:tradeType,tradeLabel:tradeLabel,tradeColor:tradeColor,
    aptScore:aptScore,
    atr:atr,atrUpper:atrUpper,atrLower:atrLower,
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

// ── 本日の想定値幅UIブロック（共通コンポーネント） ────────────────────────
function BuySellTargetBlock(p){
  var s=p.s;
  if(!s.atr) return null;
  var isJP=s.market==="JP";
  var fmtP=function(v){return isJP?"¥"+Math.round(v).toLocaleString():"$"+v.toFixed(2);};
  var fmtA=function(v){return isJP?"¥"+Math.round(v).toLocaleString():"$"+v.toFixed(2);};
  return(
    <div style={{background:"#040c18",border:"1px solid #1e4070",borderRadius:8,padding:"10px 12px"}}>
      <div style={{fontSize:11,fontWeight:700,color:"#4a90c0",marginBottom:6}}>📊 本日の想定値幅（ATR14日）</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
        <div style={{background:"#052e16",border:"1px solid #22d3a040",borderRadius:6,padding:"6px 10px"}}>
          <div style={{fontSize:10,color:"#22d3a0"}}>↑ 上限</div>
          <div style={{fontSize:15,fontWeight:800,color:"#22d3a0"}}>{fmtP(s.atrUpper)}</div>
        </div>
        <div style={{background:"#071428",border:"1px solid #4a90c040",borderRadius:6,padding:"6px 10px",textAlign:"center"}}>
          <div style={{fontSize:10,color:"#4a90c0"}}>ATR</div>
          <div style={{fontSize:15,fontWeight:800,color:"#4a90c0"}}>±{fmtA(s.atr)}</div>
        </div>
        <div style={{background:"#1f0010",border:"1px solid #f43f5e40",borderRadius:6,padding:"6px 10px",textAlign:"right"}}>
          <div style={{fontSize:10,color:"#f43f5e"}}>↓ 下限</div>
          <div style={{fontSize:15,fontWeight:800,color:"#f43f5e"}}>{fmtP(s.atrLower)}</div>
        </div>
      </div>
    </div>
  );
}

// ── StockCard ────────────────────────────────────────────────────────────────
function StockCard(p){
  var s=p.s,toggleFav=p.toggleFav,isFav=p.isFav,cross=p.cross;
  var bc=BADGE[s.timing],mc=MKT[s.market]||MKT["US"],isUp=parseFloat(s.change)>=0;
  function handleTvOpen(e){e.stopPropagation();if(navigator.clipboard){navigator.clipboard.writeText(s.tvSymbol).catch(function(){});}window.location.href="tradingview://";}

  var expandedS=useState(false);var expanded=expandedS[0],setExpanded=expandedS[1];
  var showHelpS=useState(false);var showHelp=showHelpS[0],setShowHelp=showHelpS[1];
  var showSimS=useState(false);var showSim=showSimS[0],setShowSim=showSimS[1];
  var simSharesS=useState("100");var simShares=simSharesS[0],setSimShares=simSharesS[1];
  var simBuyS=useState(s.rawPrice?s.rawPrice.toFixed(2):"");var simBuy=simBuyS[0],setSimBuy=simBuyS[1];
  var simTargetS=useState(20);var simTarget=simTargetS[0],setSimTarget=simTargetS[1];
  var simStopS=useState(-10);var simStop=simStopS[0],setSimStop=simStopS[1];
  var simTargetInputS=useState("20");var simTargetInput=simTargetInputS[0],setSimTargetInput=simTargetInputS[1];
  var simStopInputS=useState("-10");var simStopInput=simStopInputS[0],setSimStopInput=simStopInputS[1];
  var showAddS=useState(false);var showAdd=showAddS[0],setShowAdd=showAddS[1];
  var buyPriceS=useState(s.rawPrice?s.rawPrice.toFixed(2):"");var buyPrice=buyPriceS[0],setBuyPrice=buyPriceS[1];
  var sharesS=useState("");var shares=sharesS[0],setShares=sharesS[1];
  var addedS=useState(false);var added=addedS[0],setAdded=addedS[1];
  var showAiS=useState(false);var showAi=showAiS[0],setShowAi=showAiS[1];
  var aiTextS=useState("");var aiText=aiTextS[0],setAiText=aiTextS[1];
  var aiLoadingS=useState(false);var aiLoading=aiLoadingS[0],setAiLoading=aiLoadingS[1];

  var borderColor=s.score>=68?"#22d3a0":s.score>=42?"#fbbf24":"#f43f5e";
  var pos52=s.position52!=null?Math.min(98,Math.max(2,s.position52)):null;
  var pos52Color=pos52!=null?(pos52<=25?"#22d3a0":pos52<=75?"#fbbf24":"#f43f5e"):null;
  var stateColor=function(state){return state===1?"#22d3a0":state===-1?"#f43f5e":"#fbbf24";};
  var stateLabel=function(state){return state===1?"▲ 強気":state===-1?"▼ 弱気":"→ 中立";};
  var fromHighColor=s.fromHigh>=-10?"#f43f5e":s.fromHigh>=-30?"#fbbf24":"#22d3a0";
  var fromLowColor=s.fromLow<=20?"#22d3a0":s.fromLow<=50?"#fbbf24":"#f43f5e";

  function stopProp(e){e.stopPropagation();}

  var aiEntryS=useState(null);var aiEntry=aiEntryS[0],setAiEntry=aiEntryS[1];

  async function runAiAnalysis(e){
    stopProp(e);
    if(aiLoading) return;
    setShowAi(true);setAiLoading(true);setAiText("");setAiEntry(null);
    var isJP=s.market==="JP";
    var prompt="あなたは株式トレードのアナリストです。以下の銘柄データを分析して、日本語で簡潔に解説してください。\n\n"+
      "銘柄: "+s.ticker+" ("+s.name+")\n市場: "+s.market+"\n現在値: "+s.price+"\n前日比: "+s.change+"%\n"+
      "総合スコア: "+s.score+"/100\nトレードタイプ: "+s.tradeLabel+"\n"+
      "52週高値比: "+s.fromHigh.toFixed(1)+"%\n52週安値比: +"+s.fromLow.toFixed(1)+"%\n"+
      "52週ポジション: "+s.position52.toFixed(0)+"% (0%=安値圏 100%=高値圏)\n"+
      "ATR(14日): "+(isJP?"¥":"$")+s.atr+" / 想定値幅: "+(isJP?"¥":"$")+s.atrLower+"〜"+(isJP?"¥":"$")+s.atrUpper+"\n"+
      "シグナル:\n"+s.signals.map(function(sig){return"  "+sig.label+": "+sig.val;}).join("\n")+"\n\n"+
      "以下の3点を各2〜3文で答えてください:\n1. 現在の相場状況と注目ポイント\n2. このスコアになった主な理由\n3. 今後の注目ポイントと注意事項\n\n"+
      "最後の行に必ずこの形式のみでJSONを出力してください（説明不要）:\n{\"entry\":"+(isJP?"整数":"小数")+",\"target\":"+(isJP?"整数":"小数")+",\"stop\":"+(isJP?"整数":"小数")+"}";
    try{
      var res=await fetch("https://daytrade-simulator.vercel.app/api/ai",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({prompt:prompt}),signal:AbortSignal.timeout(30000)
      });
      var aiData=await res.json();
      if(aiData.error) throw new Error(typeof aiData.error==="string"?aiData.error:JSON.stringify(aiData.error));
      var aiText2=typeof aiData.text==="string"?aiData.text:JSON.stringify(aiData.text)||"";
      try{
        var jsonMatch=aiText2.match(/\{[^}]*"entry"[^}]*\}/);
        if(jsonMatch){var parsed=JSON.parse(jsonMatch[0]);setAiEntry(parsed);}
      }catch(je){}
      setAiText(aiText2
  .replace(/```json[\s\S]*?```/g,"")   // コードフェンスごと除去
  .replace(/\{[^}]*"entry"[^}]*\}/,"") // JSONオブジェクト除去
  .trim()||"分析できませんでした。");
    }catch(e){setAiText("エラーが発生しました: "+(e.message||JSON.stringify(e)||"不明なエラー"));}
    setAiLoading(false);
  }

  function submitAdd(){
    if(!buyPrice||!shares) return;
    var portfolio=(function(){try{var v=localStorage.getItem("portfolio_v1");return v?JSON.parse(v):[];}catch(e){return[];}}());
    var pos={id:Date.now(),ticker:s.ticker,name:s.name,market:s.market,buyPrice:parseFloat(buyPrice),shares:parseFloat(shares),stopLoss:null,target:null,addedAt:new Date().toLocaleDateString("ja-JP")};
    try{localStorage.setItem("portfolio_v1",JSON.stringify(portfolio.concat([pos])));}catch(e){}
    setShowAdd(false);setShares("");setAdded(true);
    setTimeout(function(){setAdded(false);},2000);
  }

  var inp={background:"#040c18",border:"1px solid #1e4070",borderRadius:5,color:"#b8cce0",padding:"6px 8px",fontSize:14,fontFamily:"monospace",width:"100%",boxSizing:"border-box"};

  var isMobile=window.innerWidth<768;
  var isSelected=!isMobile&&p.selectedStock&&p.selectedStock.ticker===s.ticker;
  var cardBorder=isSelected?"#60a5fa":borderColor;

  return(
    <div style={{background:isSelected?"#071e38":"#050e1c",border:"2px solid "+cardBorder,borderRadius:10,padding:"10px",display:"flex",flexDirection:"column",gap:7,cursor:"pointer"}}
      onClick={function(){
        if(!isMobile){if(p.setSelectedStock)p.setSelectedStock(s);}
        else{setExpanded(function(v){return !v;});}
      }}>
      {showHelp&&createPortal(<HelpModal onClose={function(){setShowHelp(false);}}/>,document.body)}
      <div style={{display:"flex",gap:6,alignItems:"center"}}>
        <ScoreRing score={s.score}/>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",gap:3,alignItems:"center",flexWrap:"wrap"}}>
            <span style={bStyle(mc.bg,mc.border,mc.text)}>{mc.label}</span>
            <span style={{fontSize:14,fontWeight:800,color:"#d8eeff"}}>{s.ticker.replace(".T","")}</span>
            {s.tradeLabel&&<span style={bStyle("#0a0a1a","1px solid "+s.tradeColor,s.tradeColor)}>{s.tradeLabel}</span>}
            {!s.real&&<span style={bStyle("#1a1200","#7c6010","#fbbf24")}>SIM</span>}
          </div>
          <div style={{fontSize:11,color:"#4a7090",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginTop:1}}>{s.name}</div>
        </div>
        <button onClick={function(e){stopProp(e);toggleFav(s.ticker);}} style={{background:"transparent",border:"none",fontSize:15,cursor:"pointer",padding:0,color:isFav(s.ticker)?"#fbbf24":"#2a4060",flexShrink:0}}>{isFav(s.ticker)?"★":"☆"}</button>
      </div>

      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
        <div>
          <span style={{fontSize:14,color:"#d8eeff",fontWeight:800}}>{s.price}</span>
          {s.market==="US"&&p.usdJpy&&(
            <div style={{fontSize:11,color:"#4a7090"}}>¥{Math.round(s.rawPrice*p.usdJpy).toLocaleString()}</div>
          )}
        </div>
      </div>

      <div style={{display:"flex",gap:8,alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          <span style={{fontSize:14,fontWeight:700,color:isUp?"#22d3a0":"#f43f5e"}}>{isUp?"▲":"▼"}{Math.abs(s.change)}%</span>
          {cross&&cross.type!=="NONE"&&<span style={bStyle(cross.bg,cross.border,cross.color)}>{cross.label}</span>}
        </div>
        <span style={bStyle(bc.bg,bc.border,bc.text)}>{bc.label}</span>
      </div>

      {s.overlapLabels&&s.overlapLabels.length>0&&(
        <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
          {s.overlapLabels.map(function(lb,i){return(<span key={i} style={{background:"#1a0a3a",border:"1px solid #a78bfa",color:"#a78bfa",fontSize:8,fontWeight:700,padding:"1px 5px",borderRadius:4}}>{lb}</span>);})}
        </div>
      )}
      {pos52!=null&&(
        <div style={{padding:"0 2px"}}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:7,color:"#2a5070",marginBottom:2}}>
            <span>52W安値</span>
            <span style={{color:pos52Color,fontWeight:700}}>{pos52<=25?"安値圏":pos52<=75?"中間":"高値圏"}</span>
            <span>52W高値</span>
          </div>
          <div style={{background:"#0a1828",borderRadius:3,height:4,position:"relative"}}>
            <div style={{background:"linear-gradient(90deg,#22d3a0,#fbbf24,#f43f5e)",height:4,borderRadius:3,width:"100%",opacity:0.25}}/>
            <div style={{position:"absolute",top:-2,left:"calc("+pos52+"% - 4px)",width:8,height:8,borderRadius:"50%",background:pos52Color,border:"1px solid #071428"}}/>
          </div>
        </div>
      )}
      {s.high52&&(
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:4}}>
          <div style={{background:"#071428",borderRadius:5,padding:"4px 6px"}}>
            <div style={{fontSize:8,color:"#2a6090"}}>高値比</div>
            <div style={{fontSize:13,fontWeight:700,color:fromHighColor}}>{s.fromHigh.toFixed(1)}%</div>
          </div>
          <div style={{background:"#071428",borderRadius:5,padding:"4px 6px"}}>
            <div style={{fontSize:8,color:"#2a6090"}}>安値比</div>
            <div style={{fontSize:13,fontWeight:700,color:fromLowColor}}>+{s.fromLow.toFixed(1)}%</div>
          </div>
          <div style={{background:"#071428",borderRadius:5,padding:"4px 6px"}}>
            <div style={{fontSize:8,color:"#2a6090"}}>VIX</div>
            <div style={{fontSize:13,fontWeight:700,color:p.vix&&parseFloat(p.vix)>=20?"#f43f5e":"#d8eeff"}}>{p.vix?parseFloat(p.vix).toFixed(2):"─"}</div>
          </div>
        </div>
      )}

      {isMobile&&<div style={{textAlign:"center",fontSize:11,color:"#2a4060"}}>{expanded?"▲ 閉じる":"▼ 詳細を見る"}</div>}

      {isMobile&&expanded&&(
        <div onClick={stopProp} style={{borderTop:"1px solid #0f2040",paddingTop:10,display:"flex",flexDirection:"column",gap:10}}>

          <div style={{display:"flex",gap:4,alignItems:"center",justifyContent:"flex-end"}}>
            <button onClick={function(e){stopProp(e);setShowHelp(true);}} style={{background:"transparent",border:"1px solid #1e4070",borderRadius:"50%",color:"#4a90c0",width:28,height:28,fontSize:14,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>?</button>
            <button onClick={runAiAnalysis} style={{background:"transparent",border:"1px solid #2a4060",borderRadius:6,color:"#4a7090",padding:"4px 9px",fontSize:14,cursor:"pointer"}}>🤖</button>
            <button onClick={function(e){stopProp(e);setShowAdd(function(v){return !v;});}} style={{background:showAdd?"#052e16":"transparent",border:"1px solid "+(showAdd?"#22d3a0":added?"#22d3a0":"#2a4060"),borderRadius:6,color:showAdd?"#22d3a0":added?"#22d3a0":"#4a7090",padding:"4px 9px",fontSize:14,cursor:"pointer"}}>{added?"✅":"💼"}</button>
            <button onClick={function(e){stopProp(e);setShowSim(function(v){return !v;});}} style={{background:showSim?"#1a0a3a":"transparent",border:"1px solid "+(showSim?"#a78bfa":"#2a4060"),borderRadius:6,color:showSim?"#a78bfa":"#4a7090",padding:"4px 9px",fontSize:14,cursor:"pointer"}}>💹</button>
          </div>

          {/* シグナル詳細 */}
          <div>
            <div style={{fontSize:12,fontWeight:700,color:"#4a90c0",marginBottom:6}}>📊 シグナル詳細</div>
            <div style={{display:"flex",flexDirection:"column",gap:4}}>
              {s.signals.map(function(sig,i){
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

          {/* ── 買い・売り目安価格 ── */}
          <BuySellTargetBlock s={s}/>

          {/* 損益シミュレーション */}
          {showSim&&(function(){
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
              <div style={{background:"#040c18",border:"1px solid #a78bfa30",borderRadius:10,padding:"12px"}}>
                <div style={{fontSize:12,fontWeight:700,color:"#a78bfa",marginBottom:8}}>💹 損益シミュレーション</div>
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
                      <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#4a7090",marginBottom:3}}>
                        <span style={{color:"#fbbf24"}}>{fmtP(bp*(1+simTarget/100))}</span>
                      </div>
                      <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4}}>
                        <span style={{fontSize:11,color:"#4a7090",flexShrink:0}}>目標</span>
                        <input type="number" value={simTargetInput} onChange={function(e){setSimTargetInput(e.target.value);}} onBlur={function(){var v=parseInt(simTargetInput);if(!isNaN(v)&&v>=1&&v<=200){setSimTarget(v);setSimTargetInput(String(v));}else{setSimTargetInput(String(simTarget));}}} onKeyDown={function(e){if(e.key==="Enter"){var v=parseInt(simTargetInput);if(!isNaN(v)&&v>=1&&v<=200){setSimTarget(v);setSimTargetInput(String(v));}else{setSimTargetInput(String(simTarget));}e.target.blur();}}} style={{width:56,background:"#040c18",border:"1px solid #fbbf24",borderRadius:4,color:"#fbbf24",padding:"2px 6px",fontSize:12,fontFamily:"monospace",textAlign:"center"}}/>
                        <span style={{fontSize:11,color:"#fbbf24"}}>%</span>
                        <input type="range" min={1} max={200} value={simTarget} onChange={function(e){var v=parseInt(e.target.value);setSimTarget(v);setSimTargetInput(String(v));}} style={{flex:1,accentColor:"#fbbf24"}}/>
                      </div>
                    </div>
                    <div style={{marginBottom:8}}>
                      <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#4a7090",marginBottom:3}}>
                        <span style={{color:"#f43f5e"}}>{fmtP(bp*(1+simStop/100))}</span>
                      </div>
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
            );
          })()}

          {showAdd&&(
            <div style={{background:"#040c18",border:"1px solid #22d3a030",borderRadius:8,padding:"12px"}}>
              <div style={{fontSize:12,fontWeight:700,color:"#22d3a0",marginBottom:8}}>💼 ポートフォリオに追加</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                <div><div style={{fontSize:11,color:"#2a6090",marginBottom:3}}>買値</div><input style={inp} type="number" value={buyPrice} onChange={function(e){setBuyPrice(e.target.value);}} placeholder="150.00"/></div>
                <div><div style={{fontSize:11,color:"#2a6090",marginBottom:3}}>株数</div><input style={inp} type="number" value={shares} onChange={function(e){setShares(e.target.value);}} placeholder="100"/></div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                <button onClick={function(){setShowAdd(false);}} style={{background:"transparent",border:"1px solid #2a3050",borderRadius:6,color:"#4a7090",padding:"7px",fontSize:13,cursor:"pointer",fontFamily:"monospace"}}>キャンセル</button>
                <button onClick={submitAdd} disabled={!buyPrice||!shares} style={{background:buyPrice&&shares?"linear-gradient(135deg,#22d3a0,#059669)":"#0a1828",border:"none",borderRadius:6,color:"#fff",padding:"7px",fontSize:13,fontWeight:700,cursor:buyPrice&&shares?"pointer":"not-allowed",fontFamily:"monospace"}}>追加</button>
              </div>
            </div>
          )}

          {showAi&&(
            <div style={{background:"#040c18",border:"1px solid #22d3a040",borderRadius:10,padding:"12px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <div style={{fontSize:12,fontWeight:700,color:"#22d3a0"}}>🤖 AI分析</div>
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
              {!aiLoading&&aiText&&(
                <button onClick={runAiAnalysis} style={{marginTop:8,background:"transparent",border:"1px solid #1e4070",borderRadius:6,color:"#4a7090",padding:"4px 10px",fontSize:12,cursor:"pointer",fontFamily:"monospace",width:"100%"}}>🔄 再分析</button>
              )}
            </div>
          )}

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
            <button onClick={handleTvOpen} style={{background:"linear-gradient(135deg,#0d2d4a,#0369a1)",border:"1px solid #0ea5e9",borderRadius:8,color:"#fff",padding:"10px",fontSize:12,fontWeight:700,fontFamily:"monospace",textAlign:"center",display:"block",cursor:"pointer",width:"100%"}}>📈 TV<div style={{fontSize:9,color:"#93c5fd",marginTop:2}}>シンボルをコピー</div></button>
            <a href={s.yahooUrl} target="_blank" rel="noreferrer" style={{background:"#071428",border:"1px solid #4f46e5",borderRadius:8,color:"#a5b4fc",padding:"10px",fontSize:12,fontWeight:700,fontFamily:"monospace",textDecoration:"none",textAlign:"center",display:"block"}}>🔗 Y!</a>
            <a href="ispeed://" onClick={function(){var code=s.ticker.replace(".T","");if(navigator.clipboard){navigator.clipboard.writeText(code).catch(function(){});}}} style={{background:"#1a0a0a",border:"1px solid #f87171",borderRadius:8,color:"#fca5a5",padding:"10px",fontSize:12,fontWeight:700,fontFamily:"monospace",textDecoration:"none",textAlign:"center",display:"block"}}>📱 iSPEED</a>
          </div>
        </div>
      )}
    </div>
  );
}

// ── StockDetailPanel ─────────────────────────────────────────────────────────
function StockDetailPanel(p){
  var s=p.s,toggleFav=p.toggleFav,isFav=p.isFav;
  if(!s){
    return(
      <div style={{textAlign:"center",padding:"60px 20px",color:"#2a6090"}}>
        <div style={{fontSize:32,marginBottom:12}}>👈</div>
        <div style={{fontSize:15,color:"#4a90c0"}}>銘柄を選択してください</div>
      </div>
    );
  }
  var isUp=parseFloat(s.change)>=0;
  function handleTvOpen(e){e.stopPropagation();if(navigator.clipboard){navigator.clipboard.writeText(s.tvSymbol).catch(function(){});}window.location.href="tradingview://";}
  var mc=MKT[s.market]||MKT["US"];
  var bc=BADGE[s.timing];
  var borderColor=s.score>=68?"#22d3a0":s.score>=42?"#fbbf24":"#f43f5e";
  var fromHighColor=s.fromHigh>=-10?"#f43f5e":s.fromHigh>=-30?"#fbbf24":"#22d3a0";
  var fromLowColor=s.fromLow<=20?"#22d3a0":s.fromLow<=50?"#fbbf24":"#f43f5e";
  var stateColor=function(state){return state===1?"#22d3a0":state===-1?"#f43f5e":"#fbbf24";};
  var stateLabel=function(state){return state===1?"▲ 強気":state===-1?"▼ 弱気":"→ 中立";};
  var pos52=s.position52!=null?Math.min(98,Math.max(2,s.position52)):null;
  var pos52Color=pos52!=null?(pos52<=25?"#22d3a0":pos52<=75?"#fbbf24":"#f43f5e"):null;

  var showSimS=useState(false);var showSim=showSimS[0],setShowSim=showSimS[1];
  var simSharesS=useState("100");var simShares=simSharesS[0],setSimShares=simSharesS[1];
  var simBuyS=useState(s.rawPrice?s.rawPrice.toFixed(2):"");var simBuy=simBuyS[0],setSimBuy=simBuyS[1];
  var simTargetS=useState(20);var simTarget=simTargetS[0],setSimTarget=simTargetS[1];
  var simStopS=useState(-10);var simStop=simStopS[0],setSimStop=simStopS[1];
  var simTargetInputS=useState("20");var simTargetInput=simTargetInputS[0],setSimTargetInput=simTargetInputS[1];
  var simStopInputS=useState("-10");var simStopInput=simStopInputS[0],setSimStopInput=simStopInputS[1];
  var showAddS=useState(false);var showAdd=showAddS[0],setShowAdd=showAddS[1];
  var buyPriceS=useState(s.rawPrice?s.rawPrice.toFixed(2):"");var buyPrice=buyPriceS[0],setBuyPrice=buyPriceS[1];
  var sharesS=useState("");var shares=sharesS[0],setShares=sharesS[1];
  var addedS=useState(false);var added=addedS[0],setAdded=addedS[1];
  var showAiS=useState(false);var showAi=showAiS[0],setShowAi=showAiS[1];
  var aiTextS=useState("");var aiText=aiTextS[0],setAiText=aiTextS[1];
  var aiLoadingS=useState(false);var aiLoading=aiLoadingS[0],setAiLoading=aiLoadingS[1];
  var showHelpS=useState(false);var showHelp=showHelpS[0],setShowHelp=showHelpS[1];

  var aiEntryS=useState(null);var aiEntry=aiEntryS[0],setAiEntry=aiEntryS[1];

  async function runAiAnalysis(){
    if(aiLoading) return;
    setShowAi(true);setAiLoading(true);setAiText("");setAiEntry(null);
    var isJP=s.market==="JP";
    var prompt="あなたは株式トレードのアナリストです。以下の銘柄データを分析して、日本語で簡潔に解説してください。\n\n"+
      "銘柄: "+s.ticker+" ("+s.name+")\n市場: "+s.market+"\n現在値: "+s.price+"\n前日比: "+s.change+"%\n"+
      "総合スコア: "+s.score+"/100\nトレードタイプ: "+s.tradeLabel+"\n"+
      "52週高値比: "+s.fromHigh.toFixed(1)+"%\n52週安値比: +"+s.fromLow.toFixed(1)+"%\n"+
      "52週ポジション: "+s.position52.toFixed(0)+"% (0%=安値圏 100%=高値圏)\n"+
      "ATR(14日): "+(isJP?"¥":"$")+s.atr+" / 想定値幅: "+(isJP?"¥":"$")+s.atrLower+"〜"+(isJP?"¥":"$")+s.atrUpper+"\n"+
      "シグナル:\n"+s.signals.map(function(sig){return"  "+sig.label+": "+sig.val;}).join("\n")+"\n\n"+
      "以下の3点を各2〜3文で答えてください:\n1. 現在の相場状況と注目ポイント\n2. このスコアになった主な理由\n3. 今後の注目ポイントと注意事項\n\n"+
      "最後の行に必ずこの形式のみでJSONを出力してください（説明不要）:\n{\"entry\":"+(isJP?"整数":"小数")+",\"target\":"+(isJP?"整数":"小数")+",\"stop\":"+(isJP?"整数":"小数")+"}";
    try{
      var res=await fetch("https://daytrade-simulator.vercel.app/api/ai",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt:prompt}),signal:AbortSignal.timeout(30000)});
      var aiData=await res.json();
      if(aiData.error) throw new Error(typeof aiData.error==="string"?aiData.error:JSON.stringify(aiData.error));
      var aiText2=typeof aiData.text==="string"?aiData.text:JSON.stringify(aiData.text)||"";
      try{
        var jsonMatch=aiText2.match(/\{[^}]*"entry"[^}]*\}/);
        if(jsonMatch){var parsed=JSON.parse(jsonMatch[0]);setAiEntry(parsed);}
      }catch(je){}
      setAiText(aiText2
  .replace(/```json[\s\S]*?```/g,"")   // コードフェンスごと除去
  .replace(/\{[^}]*"entry"[^}]*\}/,"") // JSONオブジェクト除去
  .trim()||"分析できませんでした。");
    }catch(e){setAiText("エラーが発生しました: "+(e.message||JSON.stringify(e)||"不明なエラー"));}
    setAiLoading(false);
  }
  function submitAdd(){
    if(!buyPrice||!shares) return;
    var portfolio=(function(){try{var v=localStorage.getItem("portfolio_v1");return v?JSON.parse(v):[];}catch(e){return[];}}());
    var pos={id:Date.now(),ticker:s.ticker,name:s.name,market:s.market,buyPrice:parseFloat(buyPrice),shares:parseFloat(shares),stopLoss:null,target:null,addedAt:new Date().toLocaleDateString("ja-JP")};
    try{localStorage.setItem("portfolio_v1",JSON.stringify(portfolio.concat([pos])));}catch(e){}
    setShowAdd(false);setShares("");setAdded(true);
    setTimeout(function(){setAdded(false);},2000);
  }
  var inp={background:"#040c18",border:"1px solid #1e4070",borderRadius:5,color:"#b8cce0",padding:"6px 8px",fontSize:14,fontFamily:"monospace",width:"100%",boxSizing:"border-box"};

  return(
    <div style={{background:"#050e1c",border:"1px solid "+borderColor,borderRadius:10,padding:"14px",display:"flex",flexDirection:"column",gap:10}}>
     {showHelp&&createPortal(<HelpModal onClose={function(){setShowHelp(false);}}/>,document.body)}
      <div style={{display:"flex",gap:6,alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          <ScoreRing score={s.score}/>
          <div>
            <div style={{display:"flex",gap:4,alignItems:"center",flexWrap:"wrap"}}>
              <span style={bStyle(mc.bg,mc.border,mc.text)}>{mc.label}</span>
              <span style={{fontSize:15,fontWeight:800,color:"#d8eeff"}}>{s.ticker.replace(".T","")}</span>
              {s.tradeLabel&&<span style={bStyle("#0a0a1a","1px solid "+s.tradeColor,s.tradeColor)}>{s.tradeLabel}</span>}
            </div>
            <div style={{fontSize:13,color:"#4a7090",marginTop:2}}>{s.name}</div>
          </div>
        </div>
        <div style={{display:"flex",gap:4,alignItems:"center"}}>
          <button onClick={function(){setShowHelp(true);}} style={{background:"transparent",border:"1px solid #1e4070",borderRadius:"50%",color:"#4a90c0",width:26,height:26,fontSize:14,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>?</button>
          <button onClick={function(){toggleFav(s.ticker);}} style={{background:"transparent",border:"none",fontSize:15,cursor:"pointer",padding:0,color:isFav(s.ticker)?"#fbbf24":"#2a4060"}}>{isFav(s.ticker)?"★":"☆"}</button>
        </div>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",background:"#071428",borderRadius:8,padding:"10px 14px"}}>
        <div>
          <span style={{fontSize:18,fontWeight:800,color:"#d8eeff"}}>{s.price}</span>
          {s.market==="US"&&p.usdJpy&&<div style={{fontSize:13,color:"#4a7090"}}>¥{Math.round(s.rawPrice*p.usdJpy).toLocaleString()}</div>}
        </div>
        <div style={{textAlign:"right"}}>
          <span style={{fontSize:15,fontWeight:700,color:isUp?"#22d3a0":"#f43f5e"}}>{isUp?"▲":"▼"}{Math.abs(s.change)}%</span>
          <div style={{marginTop:4}}><span style={bStyle(bc.bg,bc.border,bc.text)}>{bc.label}</span></div>
        </div>
      </div>
      {pos52!=null&&s.high52&&(
        <div>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:"#4a7090",marginBottom:4}}>
            <span>52W安値</span>
            <span style={{color:pos52Color,fontWeight:700}}>{pos52<=25?"安値圏":pos52<=75?"中間":"高値圏"}</span>
            <span>52W高値</span>
          </div>
          <div style={{background:"#0a1828",borderRadius:3,height:5,position:"relative",marginBottom:8}}>
            <div style={{background:"linear-gradient(90deg,#22d3a0,#fbbf24,#f43f5e)",height:5,borderRadius:3,width:"100%",opacity:0.25}}/>
            <div style={{position:"absolute",top:-2,left:"calc("+pos52+"% - 5px)",width:10,height:10,borderRadius:"50%",background:pos52Color,border:"1px solid #071428"}}/>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
            <div style={{background:"#071428",borderRadius:6,padding:"5px 8px"}}><div style={{fontSize:13,color:"#2a6090"}}>高値比</div><div style={{fontSize:15,fontWeight:700,color:fromHighColor}}>{s.fromHigh.toFixed(1)}%</div></div>
            <div style={{background:"#071428",borderRadius:6,padding:"5px 8px"}}><div style={{fontSize:13,color:"#2a6090"}}>安値比</div><div style={{fontSize:15,fontWeight:700,color:fromLowColor}}>+{s.fromLow.toFixed(1)}%</div></div>
            <div style={{background:"#071428",borderRadius:6,padding:"5px 8px"}}><div style={{fontSize:13,color:"#2a6090"}}>VIX</div><div style={{fontSize:15,fontWeight:700,color:p.vix&&parseFloat(p.vix)>=20?"#f43f5e":"#d8eeff"}}>{p.vix?parseFloat(p.vix).toFixed(2):"─"}</div></div>
          </div>
        </div>
      )}
      <div style={{display:"flex",gap:4,alignItems:"center",justifyContent:"flex-end"}}>
        <button onClick={runAiAnalysis} style={{background:"transparent",border:"1px solid #2a4060",borderRadius:6,color:"#4a7090",padding:"4px 9px",fontSize:14,cursor:"pointer"}}>🤖</button>
        <button onClick={function(){setShowAdd(function(v){return !v;});}} style={{background:showAdd?"#052e16":"transparent",border:"1px solid "+(showAdd?"#22d3a0":added?"#22d3a0":"#2a4060"),borderRadius:6,color:showAdd?"#22d3a0":added?"#22d3a0":"#4a7090",padding:"4px 9px",fontSize:14,cursor:"pointer"}}>{added?"✅":"💼"}</button>
        <button onClick={function(){setShowSim(function(v){return !v;});}} style={{background:showSim?"#1a0a3a":"transparent",border:"1px solid "+(showSim?"#a78bfa":"#2a4060"),borderRadius:6,color:showSim?"#a78bfa":"#4a7090",padding:"4px 9px",fontSize:14,cursor:"pointer"}}>💹</button>
      </div>
      {/* シグナル詳細 */}
      <div>
        <div style={{fontSize:14,fontWeight:700,color:"#4a90c0",marginBottom:6}}>📊 シグナル詳細</div>
        <div style={{display:"flex",flexDirection:"column",gap:4}}>
          {s.signals.map(function(sig,i){
            return(
              <div key={i} style={{background:"#071428",borderRadius:6,padding:"6px 10px",display:"flex",justifyContent:"space-between",alignItems:"center",border:"1px solid #0f2040"}}>
                <span style={{fontSize:14,color:"#4a7090"}}>{sig.label}</span>
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  <span style={{fontSize:14,fontWeight:700,color:stateColor(sig.state)}}>{sig.val}</span>
                  <span style={{fontSize:12,color:stateColor(sig.state)}}>{stateLabel(sig.state)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── 買い・売り目安価格 ── */}
      <BuySellTargetBlock s={s}/>

      {showSim&&(function(){
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
          <div style={{background:"#040c18",border:"1px solid #a78bfa30",borderRadius:10,padding:"12px"}}>
            <div style={{fontSize:14,fontWeight:700,color:"#a78bfa",marginBottom:8}}>💹 損益シミュレーション</div>
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
        );
      })()}
      {showAdd&&(
        <div style={{background:"#040c18",border:"1px solid #22d3a030",borderRadius:8,padding:"12px"}}>
          <div style={{fontSize:14,fontWeight:700,color:"#22d3a0",marginBottom:8}}>💼 ポートフォリオに追加</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
            <div><div style={{fontSize:13,color:"#2a6090",marginBottom:3}}>買値</div><input style={inp} type="number" value={buyPrice} onChange={function(e){setBuyPrice(e.target.value);}} placeholder="150.00"/></div>
            <div><div style={{fontSize:13,color:"#2a6090",marginBottom:3}}>株数</div><input style={inp} type="number" value={shares} onChange={function(e){setShares(e.target.value);}} placeholder="100"/></div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            <button onClick={function(){setShowAdd(false);}} style={{background:"transparent",border:"1px solid #2a3050",borderRadius:6,color:"#4a7090",padding:"7px",fontSize:15,cursor:"pointer",fontFamily:"monospace"}}>キャンセル</button>
            <button onClick={submitAdd} disabled={!buyPrice||!shares} style={{background:buyPrice&&shares?"linear-gradient(135deg,#22d3a0,#059669)":"#0a1828",border:"none",borderRadius:6,color:"#fff",padding:"7px",fontSize:15,fontWeight:700,cursor:buyPrice&&shares?"pointer":"not-allowed",fontFamily:"monospace"}}>追加</button>
          </div>
        </div>
      )}
      {showAi&&(
        <div style={{background:"#040c18",border:"1px solid #22d3a040",borderRadius:10,padding:"12px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <div style={{fontSize:14,fontWeight:700,color:"#22d3a0"}}>🤖 AI分析</div>
            <button onClick={function(){setShowAi(false);setAiText("");}} style={{background:"transparent",border:"none",color:"#4a7090",fontSize:15,cursor:"pointer"}}>✕</button>
          </div>
          {aiLoading?(<div style={{textAlign:"center",padding:"12px 0"}}><div style={{fontSize:18}}>⏳</div><div style={{fontSize:14,color:"#4a90c0",marginTop:4}}>AIが分析中...</div></div>):(<div style={{fontSize:15,color:"#b8cce0",lineHeight:1.7,whiteSpace:"pre-wrap"}}>{aiText}</div>)}
          {!aiLoading&&aiText&&(<button onClick={runAiAnalysis} style={{marginTop:8,background:"transparent",border:"1px solid #1e4070",borderRadius:6,color:"#4a7090",padding:"4px 10px",fontSize:14,cursor:"pointer",fontFamily:"monospace",width:"100%"}}>🔄 再分析</button>)}
        </div>
      )}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
        <button onClick={handleTvOpen} style={{background:"linear-gradient(135deg,#0d2d4a,#0369a1)",border:"1px solid #0ea5e9",borderRadius:8,color:"#fff",padding:"10px",fontSize:12,fontWeight:700,fontFamily:"monospace",textAlign:"center",display:"block",cursor:"pointer",width:"100%"}}>📈 TV<div style={{fontSize:10,color:"#93c5fd",marginTop:2}}>シンボルをコピー</div></button>
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

function CrossSection(sp){
  if(!sp.items||!sp.items.length) return null;
  var isMobile=window.innerWidth<768;
  function isFavFn(t){return sp.favs.indexOf(t)>=0;}
  var cards=(
    <div style={{display:"grid",gridTemplateColumns:isMobile?"repeat(1,1fr)":"repeat(2,1fr)",gap:8}}>
      {sp.items.map(function(item){
        return <StockCard key={item.s.ticker} s={item.s} toggleFav={sp.toggleFav} isFav={isFavFn} cross={item.cross} vix={sp.vix} usdJpy={sp.usdJpy} setSelectedStock={sp.setSelectedStock}/>;
      })}
    </div>
  );
  return(
    <div style={{marginBottom:16}}>
      <div style={{fontSize:13,fontWeight:700,color:sp.color,marginBottom:8,padding:"4px 0",borderBottom:"1px solid #0f2040"}}>{sp.title} ({sp.items.length})</div>
      {isMobile?cards:(
        <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
          <div style={{width:"60%",flexShrink:0}}>{cards}</div>
          <div style={{flex:1,position:"sticky",top:60,maxHeight:"calc(100vh - 70px)",overflowY:"auto",WebkitOverflowScrolling:"touch"}}>
            <StockDetailPanel s={sp.selectedStock&&sp.items.find(function(it){return it.s.ticker===sp.selectedStock.ticker;})?sp.selectedStock:null} toggleFav={sp.toggleFav} isFav={isFavFn} vix={sp.vix} usdJpy={sp.usdJpy}/>
          </div>
        </div>
      )}
    </div>
  );
}

function AllStocksPanel(p){
  var stocks=p.stocks,loading=p.loading,toggleFav=p.toggleFav,favs=p.favs,vix=p.vix,onScan=p.onScan,ts=p.ts,progress=p.progress;

  var viewModeS=useState("all");var viewMode=viewModeS[0],setViewMode=viewModeS[1];
  var filterMktS=useState("ALL");var filterMkt=filterMktS[0],setFilterMkt=filterMktS[1];
  var sortByS=useState("score");var sortBy=sortByS[0],setSortBy=sortByS[1];
  var filterTradeS=useState("ALL");var filterTrade=filterTradeS[0],setFilterTrade=filterTradeS[1];

  function isFavRef(t){return favs.indexOf(t)>=0;}

  var displayStocks=stocks.filter(function(s){
    if(filterMkt!=="ALL"&&s.market!==filterMkt) return false;
    if(filterTrade==="short"&&s.tradeType!=="short") return false;
    if(filterTrade==="mid"&&s.tradeType!=="mid") return false;
    if(filterTrade==="stable"&&s.tradeType!=="stable") return false;
    return true;
  }).slice().sort(function(a,b){
    if(sortBy==="score") return b.score-a.score;
    if(sortBy==="change") return Math.abs(parseFloat(b.change))-Math.abs(parseFloat(a.change));
    if(sortBy==="apt") return (b.aptScore||0)-(a.aptScore||0);
    return 0;
  });

  var filteredForCross=stocks.filter(function(s){
    if(filterMkt!=="ALL"&&s.market!==filterMkt) return false;
    if(filterTrade==="short"&&s.tradeType!=="short") return false;
    if(filterTrade==="mid"&&s.tradeType!=="mid") return false;
    if(filterTrade==="stable"&&s.tradeType!=="stable") return false;
    return true;
  });
  var gcNow=[],dcNow=[],gcNear=[],dcNear=[],gcWatch=[];
  filteredForCross.forEach(function(s){
    var c=classifyStockFn(s);if(!c||c.type==="NONE")return;
    if(c.type==="GC_NOW")gcNow.push({s:s,cross:c});
    else if(c.type==="DC_NOW")dcNow.push({s:s,cross:c});
    else if(c.type==="GC_NEAR")gcNear.push({s:s,cross:c});
    else if(c.type==="DC_NEAR")dcNear.push({s:s,cross:c});
    else if(c.type==="GC_WATCH")gcWatch.push({s:s,cross:c});
  });
  var hasAny=gcNow.length+dcNow.length+gcNear.length+dcNear.length+gcWatch.length>0;

  function fBtn(val,label,activeColor){
    var active=filterMkt===val;
    return(<button onClick={function(){setFilterMkt(val);}} style={{background:active?activeColor+"20":"transparent",border:"1px solid "+(active?activeColor:"#1e3050"),borderRadius:6,color:active?activeColor:"#4a6080",padding:"3px 8px",fontSize:11,cursor:"pointer",fontFamily:"monospace",fontWeight:active?700:400}}>{label}</button>);
  }
  function sBtn(val,label){
    var active=sortBy===val;
    return(<button onClick={function(){setSortBy(val);}} style={{background:active?"#0ea5e920":"transparent",border:"1px solid "+(active?"#0ea5e9":"#1e3050"),borderRadius:6,color:active?"#0ea5e9":"#4a6080",padding:"3px 8px",fontSize:11,cursor:"pointer",fontFamily:"monospace",fontWeight:active?700:400}}>{label}</button>);
  }
  function tBtn(val,label,color){
    var active=filterTrade===val;
    return(<button onClick={function(){setFilterTrade(val);}} style={{background:active?color+"20":"transparent",border:"1px solid "+(active?color:"#1e3050"),borderRadius:6,color:active?color:"#4a6080",padding:"3px 8px",fontSize:11,cursor:"pointer",fontFamily:"monospace",fontWeight:active?700:400}}>{label}</button>);
  }
  function mBtn(val,label){
    var active=viewMode===val;
    return(<button onClick={function(){setViewMode(val);}} style={{background:active?"#0ea5e920":"transparent",border:"1px solid "+(active?"#0ea5e9":"#1e3050"),borderRadius:6,color:active?"#0ea5e9":"#4a6080",padding:"3px 10px",fontSize:11,cursor:"pointer",fontFamily:"monospace",fontWeight:active?700:400}}>{label}</button>);
  }

  if(loading){
    return(
      <div style={{padding:"20px 0"}}>
        <div style={{textAlign:"center",padding:"40px 20px",color:"#4a7090"}}>
          <div style={{fontSize:28,marginBottom:12}}>📡</div>
          <div style={{fontSize:15,color:"#4a90c0",marginBottom:16}}>分析中...</div>
        </div>
        <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:8,padding:"12px 16px",margin:"0 4px"}}>
          <div style={{fontSize:12,color:"#4a7090",marginBottom:6}}>{progress.msg||("分析中... "+progress.done+" / "+progress.total+" 銘柄")}</div>
          <div style={{background:"#0a1828",borderRadius:4,height:4}}><div style={{background:"linear-gradient(90deg,#0ea5e9,#22d3a0)",height:4,borderRadius:4,width:(progress.total?(progress.done/progress.total)*100:5)+"%",transition:"width .3s"}}/></div>
        </div>
      </div>
    );
  }

  return(
    <div>
      <MarketBar/>
      <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"10px 14px",marginBottom:8,display:"flex",gap:12,flexWrap:"wrap",alignItems:"center"}}>
        <div style={{fontSize:12,color:"#4a7090"}}>
          <span style={{color:"#22d3a0",fontWeight:700}}>{stocks.filter(function(s){return s.real;}).length}</span>
          <span> / {stocks.length} 銘柄 リアルデータ</span>
        </div>
        {ts&&<span style={{fontSize:11,color:"#2a6090"}}>更新: {ts}</span>}
        <button onClick={onScan} style={{marginLeft:"auto",background:"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:6,color:"#fff",padding:"5px 14px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>再スキャン</button>
      </div>

      <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"8px 12px",marginBottom:8,display:"flex",gap:6,alignItems:"center"}}>
        <span style={{fontSize:11,color:"#2a6090",marginRight:2}}>モード:</span>
        {mBtn("all","📋 全銘柄")}
        {mBtn("cross","✨ クロス予測")}
      </div>

      <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"8px 12px",marginBottom:8,display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
        <span style={{fontSize:11,color:"#2a6090",marginRight:2}}>市場:</span>
        {fBtn("ALL","全て","#60a5fa")}
        {fBtn("US","US","#3b82f6")}
        {fBtn("JP","JP","#f87171")}
        <span style={{fontSize:11,color:"#2a6090",marginLeft:8,marginRight:2}}>タイプ:</span>
        {tBtn("ALL","全て","#60a5fa")}
        {tBtn("short","⚡スキャル","#f43f5e")}
        {tBtn("mid","📈デイトレ","#fbbf24")}
        {tBtn("stable","🌊スイング","#22d3a0")}
      </div>

      {viewMode==="all"&&(
        <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"8px 12px",marginBottom:14,display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
          <span style={{fontSize:11,color:"#2a6090",marginRight:2}}>並替:</span>
          {sBtn("score","スコア順")}
          {sBtn("change","騰落率順")}
          {sBtn("apt","適性順")}
          <span style={{fontSize:11,color:"#2a6090",marginLeft:"auto"}}>{displayStocks.length}銘柄</span>
        </div>
      )}

      {viewMode==="all"&&(function(){
        var isMobile=window.innerWidth<768;
        var cardGrid2=(
          <div style={{display:"grid",gridTemplateColumns:isMobile?"repeat(1,1fr)":"repeat(2,1fr)",gap:8}}>
            {displayStocks.map(function(s){
              var cross=s.signals&&s.signals.length>0?classifyStockFn(s):null;
              return <StockCard key={s.ticker} s={s} toggleFav={toggleFav} isFav={isFavRef} cross={cross} vix={vix} usdJpy={p.usdJpy} setSelectedStock={p.setSelectedStock}/>;
            })}
          </div>
        );
        return(
          <>
            {isMobile?cardGrid2:(
              <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
                <div style={{width:"60%",flexShrink:0}}>{cardGrid2}</div>
                <div style={{flex:1,position:"sticky",top:60,maxHeight:"calc(100vh - 70px)",overflowY:"auto",WebkitOverflowScrolling:"touch"}}>
                  <StockDetailPanel s={p.selectedStock} toggleFav={toggleFav} isFav={isFavRef} vix={vix} usdJpy={p.usdJpy}/>
                </div>
              </div>
            )}
            {displayStocks.length===0&&(
              <div style={{textAlign:"center",padding:"40px",color:"#4a7090",fontSize:14}}>該当する銘柄がありません</div>
            )}
          </>
        );
      })()}

      {viewMode==="cross"&&(
        <>
          {!hasAny&&<div style={{textAlign:"center",padding:"40px",color:"#4a7090",fontSize:14}}>現在クロス条件に該当する銘柄がありません</div>}
          <CrossSection title="⚡ GC接近中" items={gcNear} color="#fbbf24" toggleFav={toggleFav} favs={favs} vix={vix} usdJpy={p.usdJpy} selectedStock={p.selectedStock} setSelectedStock={p.setSelectedStock}/>
          <CrossSection title="🔥 GC発生中" items={gcNow} color="#22d3a0" toggleFav={toggleFav} favs={favs} vix={vix} usdJpy={p.usdJpy} selectedStock={p.selectedStock} setSelectedStock={p.setSelectedStock}/>
          <CrossSection title="👀 GC監視中" items={gcWatch} color="#60a5fa" toggleFav={toggleFav} favs={favs} vix={vix} usdJpy={p.usdJpy} selectedStock={p.selectedStock} setSelectedStock={p.setSelectedStock}/>
          <CrossSection title="⚠ DC接近中" items={dcNear} color="#fb923c" toggleFav={toggleFav} favs={favs} vix={vix} usdJpy={p.usdJpy} selectedStock={p.selectedStock} setSelectedStock={p.setSelectedStock}/>
          <CrossSection title="💀 DC発生中" items={dcNow} color="#f43f5e" toggleFav={toggleFav} favs={favs} vix={vix} usdJpy={p.usdJpy} selectedStock={p.selectedStock} setSelectedStock={p.setSelectedStock}/>
        </>
      )}
    </div>
  );
}

function FavPanel(p){
  var stocks=p.stocks,favs=p.favs,toggleFav=p.toggleFav,vix=p.vix;
  var favStocks=stocks.filter(function(s){return favs.indexOf(s.ticker)>=0;});
  var searchS=useState("");var searchTicker=searchS[0],setSearchTicker=searchS[1];
  var searchStatusS=useState(null);var searchStatus=searchStatusS[0],setSearchStatus=searchStatusS[1];
  var filterS=useState("ALL");var filterMkt=filterS[0],setFilterMkt=filterS[1];
  var sortS=useState("score");var sortBy=sortS[0],setSortBy=sortS[1];
  async function addByTicker(){var raw=searchTicker.trim().toUpperCase();if(!raw)return;var ticker=(raw.match(/^\d{4}$/)?raw+".T":raw);if(favs.indexOf(ticker)>=0){setSearchStatus("already");return;}setSearchStatus("loading");try{var res=await fetch(VERCEL_API+"?ticker="+encodeURIComponent(ticker)+"&range=2y",{signal:AbortSignal.timeout(15000)});if(!res.ok)throw new Error("not found");toggleFav(ticker);setSearchTicker("");setSearchStatus("ok");setTimeout(function(){setSearchStatus(null);},2000);}catch(e){setSearchStatus("error");setTimeout(function(){setSearchStatus(null);},2000);}}
  var statusMsg=searchStatus==="loading"?"取得中...":searchStatus==="ok"?"追加しました":searchStatus==="error"?"見つかりません":searchStatus==="already"?"登録済みです":null;
  var displayStocks=(filterMkt==="ALL"?favStocks:favStocks.filter(function(s){return s.market===filterMkt;})).slice().sort(function(a,b){
    if(sortBy==="score") return b.score-a.score;
    if(sortBy==="change") return Math.abs(parseFloat(b.change))-Math.abs(parseFloat(a.change));
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
  function isFavRef(t){return favs.indexOf(t)>=0;}
  var isMobile=window.innerWidth<768;
  var cardGrid=(
    <div style={{display:"grid",gridTemplateColumns:isMobile?"repeat(1,1fr)":"repeat(2,1fr)",gap:8}}>
      {displayStocks.map(function(s){
        var cross=s.signals&&s.signals.length>0?classifyStockFn(s):null;
        return <StockCard key={s.ticker} s={s} toggleFav={toggleFav} isFav={isFavRef} cross={cross} vix={vix} usdJpy={p.usdJpy} setSelectedStock={p.setSelectedStock}/>;
      })}
    </div>
  );
  return(
    <div>
      <div style={{background:"#050e1c",border:"1px solid #1e3050",borderRadius:10,padding:"12px 14px",marginBottom:14}}>
        <div style={{display:"flex",gap:8}}>
          <input style={{background:"#071428",border:"1px solid #1e3050",borderRadius:6,color:"#b8cce0",padding:"8px 10px",fontSize:14,fontFamily:"monospace",flex:1}} value={searchTicker} placeholder="AAPL / 7203" onChange={function(e){setSearchTicker(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter")addByTicker();}}/>
          <button onClick={addByTicker} style={{background:"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:8,color:"#fff",padding:"8px 16px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>追加</button>
        </div>
        {statusMsg&&<div style={{fontSize:12,color:searchStatus==="ok"?"#22d3a0":"#f43f5e",marginTop:6}}>{statusMsg}</div>}
      </div>
      {favStocks.length>0&&(
        <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"8px 12px",marginBottom:10,display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
          <span style={{fontSize:11,color:"#2a6090",marginRight:2}}>市場:</span>
          {fBtn("ALL","全て","#60a5fa")}
          {fBtn("US","US","#3b82f6")}
          {fBtn("JP","JP","#f87171")}
          <span style={{fontSize:11,color:"#2a6090",marginLeft:8,marginRight:2}}>並替:</span>
          {sBtn("score","スコア順")}
          {sBtn("change","騰落率順")}
        </div>
      )}
      {isMobile?cardGrid:(
        <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
          <div style={{width:"60%",flexShrink:0}}>{cardGrid}</div>
          <div style={{flex:1,position:"sticky",top:60,maxHeight:"calc(100vh - 70px)",overflowY:"auto",WebkitOverflowScrolling:"touch"}}>
            <StockDetailPanel s={p.selectedStock} toggleFav={toggleFav} isFav={isFavRef} vix={vix} usdJpy={p.usdJpy}/>
          </div>
        </div>
      )}
      {favs.length===0&&<div style={{textAlign:"center",padding:"30px 20px",color:"#4a7090",fontSize:13}}>ティッカーを入力して追加できます</div>}
    </div>
  );
}

function PortfolioPanel(p){
  var stocks=p.stocks;
  var initPort=(function(){try{var v=localStorage.getItem("portfolio_v1");return v?JSON.parse(v):[];}catch(e){return[];}})();
  var portS=useState(initPort);var portfolio=portS[0],setPortfolio=portS[1];
  var tabS=useState("list");var ptab=tabS[0],setPtab=tabS[1];
  var pricesS=useState({});var livePrices=pricesS[0],setLivePrices=pricesS[1];
  var lastUpdS=useState(null);var lastUpd=lastUpdS[0],setLastUpd=lastUpdS[1];
  var refreshingS=useState(false);var refreshing=refreshingS[0],setRefreshing=refreshingS[1];
  async function fetchLivePrices(port){
    if(!port||port.length===0) return;
    setRefreshing(true);
    var newPrices={};
    await Promise.all(port.map(async function(pos){
      try{
        var res=await fetch(VERCEL_API+"?ticker="+encodeURIComponent(pos.ticker)+"&range=5d",{signal:AbortSignal.timeout(8000)});
        var json=await res.json();
        var meta=json&&json.chart&&json.chart.result&&json.chart.result[0]&&json.chart.result[0].meta;
        if(meta) newPrices[pos.ticker]=meta.regularMarketPrice||0;
      }catch(e){}
    }));
    setLivePrices(newPrices);
    setLastUpd(new Date().toLocaleTimeString("ja-JP"));
    setRefreshing(false);
  }
  useEffect(function(){
    fetchLivePrices(portfolio);
    var timer=setInterval(function(){fetchLivePrices(portfolio);},5*60*1000);
    return function(){clearInterval(timer);};
  },[portfolio]);
  var formS=useState({ticker:"",name:"",buyPrice:"",shares:"",stopLoss:"",target:"",market:"US"});
  var form=formS[0],setForm=formS[1];
  var editS=useState(null);var editId=editS[0],setEditId=editS[1];
  var editFormS=useState(null);var editForm=editFormS[0],setEditForm=editFormS[1];
  function savePort(next){setPortfolio(next);try{localStorage.setItem("portfolio_v1",JSON.stringify(next));}catch(e){}}
  function addPosition(){if(!form.ticker||!form.buyPrice||!form.shares)return;var pos={id:Date.now(),ticker:form.ticker.toUpperCase(),name:form.name||form.ticker.toUpperCase(),market:form.market,buyPrice:parseFloat(form.buyPrice),shares:parseFloat(form.shares),stopLoss:form.stopLoss?parseFloat(form.stopLoss):null,target:form.target?parseFloat(form.target):null,addedAt:new Date().toLocaleDateString("ja-JP")};savePort(portfolio.concat([pos]));setForm({ticker:"",name:"",buyPrice:"",shares:"",stopLoss:"",target:"",market:"US"});setPtab("list");}
  function removePos(id){savePort(portfolio.filter(function(pos){return pos.id!==id;}));}
  function startEdit(pos){setEditId(pos.id);setEditForm({buyPrice:String(pos.buyPrice),shares:String(pos.shares),stopLoss:pos.stopLoss?String(pos.stopLoss):"",target:pos.target?String(pos.target):""});}
  function saveEdit(id){if(!editForm.buyPrice||!editForm.shares)return;savePort(portfolio.map(function(pos){if(pos.id!==id)return pos;return Object.assign({},pos,{buyPrice:parseFloat(editForm.buyPrice),shares:parseFloat(editForm.shares),stopLoss:editForm.stopLoss?parseFloat(editForm.stopLoss):null,target:editForm.target?parseFloat(editForm.target):null});}));setEditId(null);setEditForm(null);}
  function getCurrentPrice(ticker){if(livePrices[ticker]) return livePrices[ticker];var found=stocks.find(function(s){return s.ticker===ticker;});return found?found.rawPrice:null;}
  var totalPnL=portfolio.reduce(function(sum,pos){var cur=getCurrentPrice(pos.ticker);return sum+(cur?(cur-pos.buyPrice)*pos.shares:0);},0);
  var inp={background:"#071428",border:"1px solid #1e3050",borderRadius:6,color:"#b8cce0",padding:"8px 10px",fontSize:14,fontFamily:"monospace",width:"100%",boxSizing:"border-box"};
  var inpSm={background:"#040c18",border:"1px solid #1e4070",borderRadius:6,color:"#b8cce0",padding:"6px 8px",fontSize:13,fontFamily:"monospace",width:"100%",boxSizing:"border-box"};
  return(
    <div>
      <div style={{display:"flex",gap:6,marginBottom:10,alignItems:"center"}}>
        <TabBtn label="保有銘柄" active={ptab==="list"} onClick={function(){setPtab("list");}} color="#22d3a0"/>
        <TabBtn label="追加" active={ptab==="add"} onClick={function(){setPtab("add");}} color="#0ea5e9"/>
        <div style={{marginLeft:"auto",display:"flex",gap:8,alignItems:"center"}}>
          {lastUpd&&<span style={{fontSize:11,color:"#2a6090"}}>更新: {lastUpd}</span>}
          <button onClick={function(){fetchLivePrices(portfolio);}} disabled={refreshing} style={{background:"transparent",border:"1px solid #1e4070",borderRadius:6,color:refreshing?"#2a6090":"#4a90c0",padding:"3px 8px",fontSize:11,cursor:refreshing?"not-allowed":"pointer",fontFamily:"monospace"}}>{refreshing?"更新中...":"🔄"}</button>
        </div>
      </div>
      {ptab==="add"&&(<div style={{background:"#050e1c",border:"1px solid #1e3050",borderRadius:10,padding:16,marginBottom:16}}><div style={{fontSize:14,fontWeight:700,color:"#e0f0ff",marginBottom:12}}>ポジション追加</div><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>{[["ティッカー","ticker","AAPL","text"],["銘柄名","name","Apple","text"],["買値","buyPrice","150.00","number"],["株数","shares","100","number"],["損切り","stopLoss","140.00","number"],["目標価格","target","180.00","number"]].map(function(row){return(<div key={row[0]}><div style={{fontSize:11,color:"#2a6090",marginBottom:3}}>{row[0]}</div><input style={inp} type={row[3]} value={form[row[1]]} placeholder={row[2]} onChange={function(e){var up={};up[row[1]]=e.target.value;setForm(Object.assign({},form,up));}}/></div>);})}</div><div style={{display:"flex",gap:6,marginBottom:12}}>{["US","JP"].map(function(m){return(<button key={m} onClick={function(){setForm(Object.assign({},form,{market:m}));}} style={{background:form.market===m?"#0ea5e9":"#071428",border:"1px solid "+(form.market===m?"#0ea5e9":"#1e3050"),borderRadius:6,color:form.market===m?"#fff":"#4a7090",padding:"5px 16px",fontSize:13,cursor:"pointer",fontFamily:"monospace"}}>{m}</button>);})}</div><button onClick={addPosition} style={{width:"100%",background:"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:8,color:"#fff",padding:"10px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>追加する</button></div>)}
      {ptab==="list"&&(portfolio.length===0?(<div style={{textAlign:"center",padding:"60px 20px",color:"#2a6090"}}><div style={{fontSize:36,marginBottom:12}}>📊</div><div style={{fontSize:15,color:"#4a90c0"}}>保有銘柄がありません</div></div>):(<div><div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"12px 16px",marginBottom:12,display:"flex",gap:20}}><div><div style={{fontSize:11,color:"#2a6090"}}>保有銘柄</div><div style={{fontSize:16,fontWeight:800,color:"#e0f0ff"}}>{portfolio.length}銘柄</div></div><div><div style={{fontSize:11,color:"#2a6090"}}>損益合計</div><div style={{fontSize:16,fontWeight:800,color:totalPnL>=0?"#22d3a0":"#f43f5e"}}>{totalPnL>=0?"+":""}{totalPnL.toFixed(2)}</div></div></div><div style={{display:"flex",flexDirection:"column",gap:8}}>{portfolio.map(function(pos){var cur=getCurrentPrice(pos.ticker),pnl=cur?(cur-pos.buyPrice)*pos.shares:null,pct=cur?(cur-pos.buyPrice)/pos.buyPrice*100:null,hitStop=cur&&pos.stopLoss&&cur<=pos.stopLoss,hitTarget=cur&&pos.target&&cur>=pos.target,isEditing=editId===pos.id;return(<div key={pos.id} style={{background:"#050e1c",border:"1px solid "+(hitStop?"#f43f5e":hitTarget?"#22d3a0":"#1e3050"),borderRadius:10,padding:"14px 16px"}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}><div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}><span style={{fontSize:15,fontWeight:800,color:"#d8eeff"}}>{pos.ticker.replace(".T","")}</span><span style={{fontSize:13,color:"#4a7090"}}>{pos.name}</span>{hitStop&&<span style={bStyle("#1f0010","#f43f5e","#f43f5e")}>損切りライン</span>}{hitTarget&&<span style={bStyle("#052e16","#22d3a0","#22d3a0")}>目標達成</span>}</div><div style={{display:"flex",gap:6}}><button onClick={function(){isEditing?setEditId(null):startEdit(pos);}} style={{background:"transparent",border:"1px solid "+(isEditing?"#fbbf24":"#2a3050"),borderRadius:6,color:isEditing?"#fbbf24":"#4a7090",padding:"3px 8px",fontSize:12,cursor:"pointer",fontFamily:"monospace"}}>{isEditing?"閉じる":"編集"}</button><button onClick={function(){removePos(pos.id);}} style={{background:"transparent",border:"1px solid #2a3050",borderRadius:6,color:"#4a7090",padding:"3px 8px",fontSize:12,cursor:"pointer",fontFamily:"monospace"}}>削除</button></div></div>{isEditing&&editForm&&(<div style={{background:"#040c18",border:"1px solid #1e4070",borderRadius:8,padding:"12px",marginBottom:10}}><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8}}>{[["買値","buyPrice"],["株数","shares"],["損切り","stopLoss"],["目標","target"]].map(function(row){return(<div key={row[0]}><div style={{fontSize:11,color:"#2a6090",marginBottom:2}}>{row[0]}</div><input style={inpSm} type="number" value={editForm[row[1]]} onChange={function(e){var up={};up[row[1]]=e.target.value;setEditForm(Object.assign({},editForm,up));}}/></div>);})}</div><button onClick={function(){saveEdit(pos.id);}} style={{width:"100%",background:"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:6,color:"#fff",padding:"8px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>保存する</button></div>)}<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(100px,1fr))",gap:6}}>{[["買値",pos.market==="JP"?"¥"+pos.buyPrice.toLocaleString():"$"+pos.buyPrice,"#b8cce0"],["株数",pos.shares+"株","#b8cce0"],["現在値",cur?(pos.market==="JP"?"¥"+Math.round(cur).toLocaleString():"$"+cur.toFixed(2)):"─","#b8cce0"],["損益",pnl!==null?(pnl>=0?"+":"")+pnl.toFixed(2):"─",pnl!==null?(pnl>=0?"#22d3a0":"#f43f5e"):"#4a7090"],["損益率",pct!==null?(pct>=0?"+":"")+pct.toFixed(2)+"%":"─",pct!==null?(pct>=0?"#22d3a0":"#f43f5e"):"#4a7090"]].map(function(row){return(<div key={row[0]} style={{background:"#071428",borderRadius:6,padding:"5px 8px"}}><div style={{fontSize:11,color:"#2a6090"}}>{row[0]}</div><div style={{fontSize:13,fontWeight:700,color:row[2]}}>{row[1]}</div></div>);})}</div></div>);})}</div></div>))}
    </div>
  );
}

function SimPanel(p){
  var stocks=p.stocks;
  var tickerS=useState("");var ticker=tickerS[0],setTicker=tickerS[1];
  var buyPriceS=useState("");var buyPrice=buyPriceS[0],setBuyPrice=buyPriceS[1];
  var sharesS=useState("100");var shares=sharesS[0],setShares=sharesS[1];
  var targetPctS=useState(20);var targetPct=targetPctS[0],setTargetPct=targetPctS[1];
  var stopPctS=useState(-10);var stopPct=stopPctS[0],setStopPct=stopPctS[1];
  var inp={background:"#071428",border:"1px solid #1e3050",borderRadius:6,color:"#b8cce0",padding:"8px 10px",fontSize:14,fontFamily:"monospace",width:"100%",boxSizing:"border-box"};
  var bp=parseFloat(buyPrice)||0;
  var sh=parseFloat(shares)||0;
  var cost=bp*sh;
  var scenarios=[
    {label:"損切りライン",pct:stopPct,color:"#f43f5e"},
    {label:"-5%",pct:-5,color:"#fb923c"},
    {label:"現在値",pct:0,color:"#b8cce0"},
    {label:"+5%",pct:5,color:"#22d3a0"},
    {label:"+10%",pct:10,color:"#22d3a0"},
    {label:"+20%",pct:20,color:"#22d3a0"},
    {label:"目標価格",pct:targetPct,color:"#fbbf24"},
  ];
  var found=stocks.find(function(s){return s.ticker===ticker;});
  var currentPrice=found?found.rawPrice:null;
  var currentPct=currentPrice&&bp>0?((currentPrice-bp)/bp*100):null;
  var isJP=ticker.endsWith(".T");
  function fmtPrice(v){return isJP?"¥"+Math.round(v).toLocaleString():"$"+v.toFixed(2);}
  function fmtPnL(v){return(v>=0?"+":"")+(isJP?"¥"+Math.round(v).toLocaleString():"$"+Math.abs(v).toFixed(2));}
  return(
    <div>
      <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"12px 16px",marginBottom:14}}>
        <div style={{fontSize:14,fontWeight:700,color:"#e0f0ff",marginBottom:4}}>💹 損益シミュレーション</div>
        <div style={{fontSize:12,color:"#4a7090"}}>買値・株数を入力して損益を確認できます</div>
      </div>
      <div style={{background:"#050e1c",border:"1px solid #1e3050",borderRadius:10,padding:"14px",marginBottom:14}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
          <div>
            <div style={{fontSize:11,color:"#2a6090",marginBottom:4}}>銘柄（任意）</div>
            <select value={ticker} onChange={function(e){
              setTicker(e.target.value);
              var s=stocks.find(function(s){return s.ticker===e.target.value;});
              if(s) setBuyPrice(s.rawPrice.toFixed(2));
            }} style={{background:"#071428",border:"1px solid #1e3050",borderRadius:6,color:"#b8cce0",padding:"8px 6px",fontSize:13,fontFamily:"monospace",width:"100%"}}>
              <option value="">手動入力</option>
              {stocks.slice(0,50).map(function(s){return(<option key={s.ticker} value={s.ticker}>{s.ticker.replace(".T","")} {s.name.slice(0,12)}</option>);})}
            </select>
          </div>
          <div>
            <div style={{fontSize:11,color:"#2a6090",marginBottom:4}}>株数</div>
            <input style={inp} type="number" value={shares} onChange={function(e){setShares(e.target.value);}} placeholder="100"/>
          </div>
        </div>
        <div style={{marginBottom:10}}>
          <div style={{fontSize:11,color:"#2a6090",marginBottom:4}}>買値</div>
          <input style={inp} type="number" value={buyPrice} onChange={function(e){setBuyPrice(e.target.value);}} placeholder="150.00"/>
        </div>
        {bp>0&&sh>0&&(
          <div style={{background:"#071428",borderRadius:6,padding:"8px 12px",fontSize:13,color:"#4a7090"}}>
            投資総額: <span style={{color:"#d8eeff",fontWeight:700}}>{fmtPrice(cost)}</span>
            {currentPct!==null&&<span style={{marginLeft:12}}>現在: <span style={{color:currentPct>=0?"#22d3a0":"#f43f5e",fontWeight:700}}>{currentPct>=0?"+":""}{currentPct.toFixed(1)}%</span></span>}
          </div>
        )}
      </div>
      {bp>0&&sh>0&&(
        <div style={{background:"#050e1c",border:"1px solid #1e3050",borderRadius:10,padding:"14px",marginBottom:14}}>
          <div style={{marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#4a7090",marginBottom:6}}>
              <span>目標価格</span>
              <span style={{color:"#fbbf24",fontWeight:700}}>+{targetPct}% → {fmtPrice(bp*(1+targetPct/100))}</span>
            </div>
            <input type="range" min={1} max={100} value={targetPct} onChange={function(e){setTargetPct(parseInt(e.target.value));}} style={{width:"100%",accentColor:"#fbbf24"}}/>
          </div>
          <div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#4a7090",marginBottom:6}}>
              <span>損切りライン</span>
              <span style={{color:"#f43f5e",fontWeight:700}}>{stopPct}% → {fmtPrice(bp*(1+stopPct/100))}</span>
            </div>
            <input type="range" min={-50} max={-1} value={stopPct} onChange={function(e){setStopPct(parseInt(e.target.value));}} style={{width:"100%",accentColor:"#f43f5e"}}/>
          </div>
        </div>
      )}
      {bp>0&&sh>0&&(
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          {scenarios.sort(function(a,b){return a.pct-b.pct;}).map(function(sc,i){
            var sellPrice=bp*(1+sc.pct/100);
            var pnl=(sellPrice-bp)*sh;
            var isProfit=pnl>=0;
            return(
              <div key={i} style={{background:"#050e1c",border:"1px solid "+(isProfit?"#22d3a040":"#f43f5e40"),borderRadius:8,padding:"10px 14px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{fontSize:13,color:sc.color,fontWeight:700}}>{sc.label}</div>
                  <div style={{fontSize:12,color:"#4a7090"}}>{fmtPrice(sellPrice)} ({sc.pct>=0?"+":""}{sc.pct}%)</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:15,fontWeight:800,color:isProfit?"#22d3a0":"#f43f5e"}}>{fmtPnL(pnl)}</div>
                  <div style={{fontSize:11,color:"#4a7090"}}>{sh}株</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {(!bp||!sh)&&(
        <div style={{textAlign:"center",padding:"40px 20px",color:"#2a6090"}}>
          <div style={{fontSize:32,marginBottom:12}}>💹</div>
          <div style={{fontSize:14}}>買値と株数を入力してください</div>
        </div>
      )}
    </div>
  );
}

function BacktestPanel(p){
  var stocks=p.stocks,favs=p.favs||[];
  var selS=useState("");var sel=selS[0],setSel=selS[1];
  var resS=useState(null);var result=resS[0],setResult=resS[1];
  var sellDaysS=useState(5);var sellDays=sellDaysS[0],setSellDays=sellDaysS[1];
  var favStocks=stocks.filter(function(s){return favs.indexOf(s.ticker)>=0;});
  var otherStocks=stocks.filter(function(s){return favs.indexOf(s.ticker)<0;});
  function run(){var found=stocks.find(function(s){return s.ticker===sel;});if(!found||!found.closes)return;setResult(runBacktest(found.closes,sellDays));}
  var SELL_DAYS=[1,3,5,10,20];
  return(
    <div>
      <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"12px 16px",marginBottom:14}}>
        <div style={{fontSize:14,fontWeight:700,color:"#e0f0ff",marginBottom:4}}>バックテスト</div>
        <div style={{fontSize:12,color:"#4a7090"}}>MACDゴールデンクロス → {sellDays}日後売却の過去勝率を検証します。</div>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:14}}>
        <select value={sel} onChange={function(e){setSel(e.target.value);setResult(null);}} style={{background:"#071428",border:"1px solid #1e3050",borderRadius:6,color:"#b8cce0",padding:"10px 12px",fontSize:14,fontFamily:"monospace",width:"100%"}}>
          <option value="">銘柄を選択</option>
          {favStocks.length>0&&<optgroup label="お気に入り">{favStocks.map(function(s){return(<option key={s.ticker} value={s.ticker}>{s.ticker.replace(".T","")} {s.name}</option>);})}</optgroup>}
          {otherStocks.length>0&&<optgroup label="その他">{otherStocks.map(function(s){return(<option key={s.ticker} value={s.ticker}>{s.ticker.replace(".T","")} {s.name}</option>);})}</optgroup>}
        </select>
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          <span style={{fontSize:12,color:"#4a7090",flexShrink:0}}>売却日数:</span>
          {SELL_DAYS.map(function(d){
            var active=sellDays===d;
            return(
              <button key={d} onClick={function(){setSellDays(d);setResult(null);}}
                style={{background:active?"#0ea5e918":"transparent",border:"1px solid "+(active?"#0ea5e9":"#1e3050"),borderRadius:6,color:active?"#0ea5e9":"#4a6080",padding:"4px 10px",fontSize:12,cursor:"pointer",fontFamily:"monospace",fontWeight:active?700:400}}>
                {d}日
              </button>
            );
          })}
        </div>
        <button onClick={run} disabled={!sel} style={{background:sel?"linear-gradient(135deg,#0ea5e9,#0369a1)":"#0a1828",border:"none",borderRadius:8,color:"#fff",padding:"12px",fontSize:14,fontWeight:700,cursor:sel?"pointer":"not-allowed",fontFamily:"monospace",width:"100%"}}>実行</button>
      </div>
      {result&&(
        <div>
          <div style={{fontSize:12,color:"#4a7090",marginBottom:10}}>MACDゴールデンクロス → {sellDays}日後売却の過去勝率</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr auto",gap:8,marginBottom:14}}>
            <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:8,padding:"10px 12px"}}>
              <div style={{fontSize:11,color:"#2a6090"}}>検証回数</div>
              <div style={{fontSize:18,fontWeight:800,color:"#e0f0ff"}}>{result.total}回</div>
            </div>
            <div style={{background:parseFloat(result.winRate)>=50?"#052e16":"#1f0010",border:"1px solid "+(parseFloat(result.winRate)>=50?"#22d3a0":"#f43f5e"),borderRadius:8,padding:"10px 12px"}}>
              <div style={{fontSize:11,color:"#2a6090"}}>勝率</div>
              <div style={{fontSize:18,fontWeight:800,color:parseFloat(result.winRate)>=50?"#22d3a0":"#f43f5e"}}>{result.winRate}%</div>
            </div>
            <button onClick={function(){setResult(null);setSel("");}} style={{background:"transparent",border:"1px solid #2a3050",borderRadius:8,color:"#4a7090",padding:"8px 12px",fontSize:13,cursor:"pointer",fontFamily:"monospace"}}>戻る</button>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {result.results.map(function(r,i){
              return(
                <div key={i} style={{background:"#050e1c",border:"1px solid "+(r.win?"#22d3a040":"#f43f5e40"),borderRadius:8,padding:"8px 12px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{display:"flex",gap:12}}>
                    <span style={{fontSize:13,color:"#4a7090"}}>買 <span style={{color:"#b8cce0"}}>{r.buyPrice}</span></span>
                    <span style={{fontSize:13,color:"#4a7090"}}>売 <span style={{color:"#b8cce0"}}>{r.sellPrice}</span></span>
                  </div>
                  <span style={{fontSize:14,fontWeight:700,color:r.win?"#22d3a0":"#f43f5e"}}>{r.win?"+":""}{r.ret}%</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

var TREND_LINKS=[{category:"日本株ランキング",links:[{label:"値上がり率",url:"https://finance.yahoo.co.jp/stocks/ranking/up?market=all"},{label:"値下がり率",url:"https://finance.yahoo.co.jp/stocks/ranking/down?market=all"},{label:"出来高",url:"https://finance.yahoo.co.jp/stocks/ranking/volume?market=all"}]},{category:"米国株ランキング",links:[{label:"値上がり率",url:"https://finance.yahoo.co.jp/stocks/us/ranking/up?market=all"},{label:"値下がり率",url:"https://finance.yahoo.co.jp/stocks/us/ranking/down?market=all"},{label:"出来高",url:"https://finance.yahoo.co.jp/stocks/us/ranking/volume?market=all"}]},{category:"市況・指数",links:[{label:"日経平均",url:"https://finance.yahoo.co.jp/quote/998407.O"},{label:"NYダウ",url:"https://finance.yahoo.co.jp/quote/%5EDJI"},{label:"ドル円",url:"https://finance.yahoo.co.jp/quote/USDJPY=X"}]}];

function MarketPredictionPanel(p){
  var stocks=p.stocks,vix=p.vix,predictionResult=p.predictionResult,setPredictionResult=p.setPredictionResult,predictionLoading=p.predictionLoading,setPredictionLoading=p.setPredictionLoading;
  var lastUpdS=useState(null);var lastUpd=lastUpdS[0],setLastUpd=lastUpdS[1];

  async function runPrediction(){
    if(predictionLoading||stocks.length===0) return;
    setPredictionLoading(true);
    setPredictionResult("");
    var top5=stocks.slice().sort(function(a,b){return b.score-a.score;}).slice(0,5);
    var gcNowList=stocks.filter(function(s){var c=classifyStockFn(s);return c&&c.type==="GC_NOW";}).slice(0,5);
    var gcNearList=stocks.filter(function(s){var c=classifyStockFn(s);return c&&c.type==="GC_NEAR";}).slice(0,5);
    var dcNowList=stocks.filter(function(s){var c=classifyStockFn(s);return c&&c.type==="DC_NOW";}).slice(0,5);
    var usStocks=stocks.filter(function(s){return s.market==="US";});
    var jpStocks=stocks.filter(function(s){return s.market==="JP";});
    var usUp=usStocks.filter(function(s){return parseFloat(s.change)>=0;}).length;
    var jpUp=jpStocks.filter(function(s){return parseFloat(s.change)>=0;}).length;
    var usUpPct=usStocks.length>0?Math.round(usUp/usStocks.length*100):0;
    var jpUpPct=jpStocks.length>0?Math.round(jpUp/jpStocks.length*100):0;
    var vixNum=vix?parseFloat(vix):null;
    var vixLevel=vixNum==null?"不明":vixNum>=30?"高（警戒）":vixNum>=20?"中（注意）":"低（落ち着き）";
    var userMsg=
      "【現在の市場データ】\n"+
      "VIX: "+(vixNum?vixNum.toFixed(2):"不明")+" （警戒レベル: "+vixLevel+"）\n"+
      "US市場: 上昇銘柄 "+usUpPct+"% ("+usUp+"/"+usStocks.length+"銘柄)\n"+
      "JP市場: 上昇銘柄 "+jpUpPct+"% ("+jpUp+"/"+jpStocks.length+"銘柄)\n\n"+
      "【スコア上位5銘柄】\n"+
      top5.map(function(s){return s.ticker+" スコア:"+s.score+" "+s.tradeLabel+" 騰落:"+s.change+"%";}).join("\n")+"\n\n"+
      "【GC発生中】\n"+(gcNowList.length>0?gcNowList.map(function(s){return s.ticker+"("+s.market+")";}).join(", "):"なし")+"\n"+
      "【GC接近中】\n"+(gcNearList.length>0?gcNearList.map(function(s){return s.ticker+"("+s.market+")";}).join(", "):"なし")+"\n"+
      "【DC発生中】\n"+(dcNowList.length>0?dcNowList.map(function(s){return s.ticker+"("+s.market+")";}).join(", "):"なし")+"\n\n"+
      "以下の6セクション形式で出力してください。各セクションは必ず以下のアイコンで始めてください：📊 今日の相場環境、📈 注目市場・セクター、🔥 注目銘柄、⚠️ リスク要因、🔭 来週の見通し、💡 個人投資家へのアドバイス。\n\n"+
      "📊 今日の相場環境\nVIXの水準・市場の方向感・注意点を含めて3〜4行で説明。\n\n"+
      "📈 注目市場・セクター\nなぜ今注目なのか理由と根拠を含めて3〜4行で説明。\n\n"+
      "🔥 注目銘柄（2〜3銘柄）\n各銘柄について「なぜ注目か」「どんな値動きが期待できるか」「リスクは何か」を含めて説明。\n\n"+
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

  var SECTIONS=[
    {key:"env",   icon:"📊", label:"相場環境"},
    {key:"mkt",   icon:"📈", label:"注目市場"},
    {key:"stock", icon:"🔥", label:"注目銘柄"},
    {key:"risk",  icon:"⚠️", label:"リスク"},
    {key:"next",  icon:"🔭", label:"来週"},
    {key:"advice",icon:"💡", label:"アドバイス"},
  ];
  var activeSectionS=useState("env");var activeSection=activeSectionS[0],setActiveSection=activeSectionS[1];

  function buildSectionMap(text){
    var sectionMap={};
    if(!text) return sectionMap;
    var sectionKeys=["env","mkt","stock","risk","next","advice"];
    var sectionMarkers=["📊","📈","🔥","⚠️","🔭","💡"];
    sectionMarkers.forEach(function(marker,i){
      var startIdx=text.indexOf(marker);
      if(startIdx===-1) return;
      var nextIdx=text.length;
      for(var j=i+1;j<sectionMarkers.length;j++){
        var ni=text.indexOf(sectionMarkers[j],startIdx+1);
        if(ni!==-1){nextIdx=ni;break;}
      }
      sectionMap[sectionKeys[i]]=text.slice(startIdx,nextIdx).trim();
    });
    if(Object.keys(sectionMap).length===0) sectionMap["env"]=text;
    return sectionMap;
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

      {predictionLoading&&(
        <div style={{background:"#040c18",border:"1px solid #0ea5e940",borderRadius:10,padding:"32px",textAlign:"center"}}>
          <div style={{fontSize:28,marginBottom:12}}>⏳</div>
          <div style={{fontSize:14,color:"#4a90c0",marginBottom:6}}>AIがニュースを収集・分析中です...</div>
          <div style={{fontSize:11,color:"#2a6090"}}>Web検索を含むため30〜60秒かかることがあります</div>
        </div>
      )}

      {!predictionLoading&&predictionResult&&(function(){
        var sectionMap=buildSectionMap(predictionResult);
        var sectionText=sectionMap[activeSection]!==undefined?sectionMap[activeSection]:"このセクションのデータが取得できませんでした。再分析してください。";
        return(
          <div>
            <div style={{display:"flex",gap:6,overflowX:"auto",WebkitOverflowScrolling:"touch",marginBottom:12,paddingBottom:4}}>
              {SECTIONS.map(function(sec){
                var active=activeSection===sec.key;
                return(
                  <button key={sec.key} onClick={function(){setActiveSection(sec.key);}}
                    style={{background:active?"#0ea5e920":"transparent",border:"1px solid "+(active?"#0ea5e9":"#1e3050"),borderRadius:6,color:active?"#0ea5e9":"#4a6080",padding:"4px 10px",fontSize:11,cursor:"pointer",fontFamily:"monospace",whiteSpace:"nowrap",flexShrink:0}}>
                    {sec.icon} {sec.label}
                  </button>
                );
              })}
            </div>
            <div style={{fontSize:13,color:"#b8cce0",lineHeight:1.8,whiteSpace:"pre-wrap"}}>
              {sectionText}
            </div>
            <button onClick={runPrediction} style={{marginTop:20,width:"100%",background:"transparent",border:"1px solid #1e4070",borderRadius:8,color:"#4a7090",padding:"10px",fontSize:12,cursor:"pointer",fontFamily:"monospace",marginBottom:40}}>🔄 再分析</button>
          </div>
        );
      })()}

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

function NewsPanel(){var NEWS=[{label:"株式ニュース",url:"https://finance.yahoo.co.jp/news",desc:"国内外の最新株式ニュース"},{label:"日本株ニュース",url:"https://finance.yahoo.co.jp/news/stocks",desc:"日本株関連ニュース"},{label:"米国株ニュース",url:"https://finance.yahoo.co.jp/news/world",desc:"米国株最新情報"},{label:"マーケット概況",url:"https://finance.yahoo.co.jp/stocks",desc:"日本株式市場の概況"}];return(<div style={{background:"#050e1c",border:"1px solid #0f2040",borderRadius:10,overflow:"hidden"}}><div style={{background:"#071428",borderBottom:"1px solid #0f2040",padding:"12px 16px"}}><div style={{fontSize:15,fontWeight:700,color:"#e0f0ff"}}>ニュース</div></div><div style={{padding:"8px"}}>{NEWS.map(function(item,i){return(<a key={i} href={item.url} target="_blank" rel="noreferrer" style={{display:"flex",flexDirection:"column",padding:"12px 14px",margin:"4px 0",background:"#071428",border:"1px solid #1e3050",borderRadius:8,textDecoration:"none",gap:4}}><span style={{fontSize:15,fontWeight:700,color:"#93c5fd"}}>{item.label}</span><span style={{fontSize:12,color:"#4a7090"}}>{item.desc}</span></a>);})}</div></div>);}
function TrendPanel(){var cs=useState(0);var openCat=cs[0],setOpenCat=cs[1];return(<div style={{background:"#050e1c",border:"1px solid #0f2040",borderRadius:10,overflow:"hidden"}}><div style={{background:"#071428",borderBottom:"1px solid #0f2040",padding:"10px 14px"}}><div style={{fontSize:14,fontWeight:700,color:"#e0f0ff"}}>トレンド・ランキング</div></div>{TREND_LINKS.map(function(cat,ci){var isOpen=openCat===ci;return(<div key={ci}><div onClick={function(){setOpenCat(isOpen?-1:ci);}} style={{padding:"10px 14px",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid #0a1828",background:isOpen?"#071a2e":"transparent"}}><span style={{fontSize:14,fontWeight:700,color:"#b8cce0"}}>{cat.category}</span><span style={{fontSize:12,color:"#2a6090"}}>{isOpen?"▲":"▼"}</span></div>{isOpen&&<div style={{background:"#040c18",borderBottom:"1px solid #0a1828"}}>{cat.links.map(function(link,li){return(<a key={li} href={link.url} target="_blank" rel="noreferrer" style={{display:"flex",alignItems:"center",padding:"9px 20px",borderBottom:"1px solid #0a1828",textDecoration:"none",gap:8}}><span style={{fontSize:12,color:"#22d3a0"}}>→</span><span style={{fontSize:14,color:"#93c5fd"}}>{link.label}</span></a>);})}</div>}</div>);})}</div>);}

function IndexPanel(){
  var INDEX_FUNDS=[
    {label:"eMAXIS Slim 全世界株式（オール・カントリー）",url:"https://www.rakuten-sec.co.jp/web/fund/detail/?ID=JP90C000H1T1",desc:"楽天証券 投資信託詳細ページ"},
    {label:"楽天証券 ホーム",url:"https://member.rakuten-sec.co.jp/app/home.do",desc:"保有資産・取引状況の確認"},
  ];
  return(
    <div style={{background:"#050e1c",border:"1px solid #0f2040",borderRadius:10,overflow:"hidden"}}>
      <div style={{background:"#071428",borderBottom:"1px solid #0f2040",padding:"12px 16px"}}>
        <div style={{fontSize:15,fontWeight:700,color:"#e0f0ff"}}>インデックスファンド</div>
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
  var userId=p.userId,syncApi=p.syncApi,setFavs=p.setFavs,scan=p.scan;
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
      try{localStorage.setItem("portfolio_v1",JSON.stringify(data.portfolio||[]));}catch(e){}
      try{localStorage.setItem("daytrade_uid",id);}catch(e){}
      setSyncStatus("ok");
      setTimeout(function(){setSyncStatus(null);scan();},1500);
    }catch(e){setSyncStatus("error");setTimeout(function(){setSyncStatus(null);},2500);}
  }
  var favCount=(function(){try{return JSON.parse(localStorage.getItem("fav_tickers")||"[]").length;}catch(e){return 0;}})();
  var portCount=(function(){try{return JSON.parse(localStorage.getItem("portfolio_v1")||"[]").length;}catch(e){return 0;}})();
  return(
    <div>
      <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"14px 16px",marginBottom:14}}>
        <div style={{fontSize:14,fontWeight:700,color:"#e0f0ff",marginBottom:10}}>🔗 デバイス間同期</div>
        <div style={{display:"flex",gap:12,marginBottom:14}}>
          <div style={{background:"#050e1c",borderRadius:8,padding:"10px 16px"}}><div style={{fontSize:11,color:"#2a6090"}}>お気に入り</div><div style={{fontSize:18,fontWeight:800,color:"#fbbf24"}}>{favCount}銘柄</div></div>
          <div style={{background:"#050e1c",borderRadius:8,padding:"10px 16px"}}><div style={{fontSize:11,color:"#2a6090"}}>ポートフォリオ</div><div style={{fontSize:18,fontWeight:800,color:"#22d3a0"}}>{portCount}銘柄</div></div>
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
        <div style={{fontSize:12,color:"#4a7090",marginBottom:10}}>他のデバイスのIDを入力するとお気に入り・ポートフォリオが引き継がれます</div>
        <input style={{background:"#040c18",border:"1px solid #1e4070",borderRadius:6,color:"#b8cce0",padding:"10px 12px",fontSize:14,fontFamily:"monospace",width:"100%",boxSizing:"border-box",marginBottom:10}} value={input} placeholder="別デバイスのIDを貼り付け" onChange={function(e){setInput(e.target.value);}}/>
        <button onClick={syncById} disabled={!input.trim()||syncStatus==="loading"} style={{width:"100%",background:input.trim()?"linear-gradient(135deg,#22d3a0,#059669)":"#0a1828",border:"none",borderRadius:8,color:"#fff",padding:"10px",fontSize:14,fontWeight:700,cursor:input.trim()?"pointer":"not-allowed",fontFamily:"monospace"}}>
          {syncStatus==="loading"?"同期中...":syncStatus==="ok"?"✅ 同期完了！":syncStatus==="error"?"❌ IDが見つかりません":"このIDで同期する"}
        </button>
      </div>
      <div style={{background:"#050e1c",border:"1px solid #0f2040",borderRadius:10,padding:"14px 16px"}}>
        <div style={{fontSize:13,fontWeight:700,color:"#4a90c0",marginBottom:10}}>使い方</div>
        {[["1","iPadで「IDをコピー」をタップ"],["2","iPhoneのDaySimulatorを開く"],["3","🔗タブ → IDを貼り付けて「同期」"],["4","お気に入り・ポートフォリオが反映される"]].map(function(row){
          return(<div key={row[0]} style={{display:"flex",gap:10,marginBottom:8,alignItems:"flex-start"}}>
            <span style={{background:"#0ea5e9",color:"#fff",borderRadius:"50%",width:18,height:18,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,flexShrink:0}}>{row[0]}</span>
            <span style={{fontSize:13,color:"#b8cce0"}}>{row[1]}</span>
          </div>);
        })}
        <div style={{fontSize:11,color:"#2a6060",marginTop:8}}>※ お気に入り登録・変更時に自動でサーバーに保存されます</div>
      </div>
    </div>
  );
}

function HelpModal(p){
  var onClose=p.onClose;
  var SECTIONS=[
    {title:"📊 データ取得",items:["米国株：Yahoo Finance・15分遅延","日本株：Yahoo Finance・15分遅延","日本株ランキング：J-Quants（前営業日の出来高上位50）","米国株ランキング：Yahoo Finance 出来高上位50","市況指数（日経・ダウ等）：Yahoo Finance・15分遅延"]},
    {title:"✨ クロス予測",items:["MACDヒストグラムとスコアで自動分類","GC発生：MACDがゴールデンクロス直後","GC接近：強気ゾーン＋スコア60以上","GC監視：強気ゾーン＋スコア50以上","DC発生・DC接近：逆のパターン"]},
    {title:"📈 スコア計算",items:["トレンド（MA20・MA50）：最大20点","MACD：最大30点（GC発生で30点）","RSI：最大25点（売られすぎで25点）","ボリンジャーバンド：最大20点","ストキャスティクス：最大15点"]},
    {title:"📉 スパークライン",items:["直近30本分（約1.5ヶ月）を表示","黄色ライン：MA5","青紫ライン：MA25","緑/赤ライン（半透明）：価格"]},
    {title:"🔗 デバイス同期",items:["お気に入り登録時にサーバーへ自動保存","起動時にサーバーからデータを自動取得","Pushoverでデバイスに同期IDを通知","同期タブでIDを入力して別デバイスと同期"]},
    {title:"💼 ポートフォリオ",items:["損切りライン到達で枠が赤く変化","目標価格到達で枠が緑に変化","5分ごとに自動で価格更新"]},
    {title:"📖 指標の見方",items:["PER（株価収益率）：株価が1株利益の何倍か → 業種平均より低ければ割安で買い候補","PBR（株価純資産倍率）：株価が純資産の何倍か → 1倍割れは理論上割安で買い候補","RSI（相対力指数）：0〜100で買われすぎ・売られすぎを表示 → 30以下で売られすぎ・反発狙いの買い候補","BB（ボリンジャーバンド）：移動平均線を中心に上下2本のバンドを表示 → 下限バンドに触れると売られすぎのサインで反発狙いの買い候補、上限バンドに触れると買われすぎで警戒","Stoch（ストキャスティクス）：0〜100で直近の高値・安値に対する現在値の位置を表示 → 20以下で売られすぎ・反発狙いの買い候補、80以上で買われすぎで警戒","MACD：トレンド転換を示す指標 → ゴールデンクロス発生時が買いシグナル","VIX（恐怖指数）：市場の不安度を示す指数 → 30〜40超の急騰後に低下し始めたら相場回復の買い候補"]},
    {title:"⚡ トレードタイプの見方",items:["⚡ スキャル（スキャルピング）：数秒〜数分で決済。細かい値動きで何度も売買する短期手法","📈 デイトレ（デイトレード）：当日中に決済。翌日に持ち越さないのが基本ルール","🌊 スイング（スイングトレード）：数日〜2週間保有。トレンドに乗って利益を狙う中期手法","判定基準：年間値幅・直近の日次変動率・当日騰落率をもとに自動分類"]},
  ];
  return(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:500,background:"#000000cc",display:"flex",alignItems:"center",justifyContent:"center",padding:16}}
      onTouchEnd={function(e){if(e.target===e.currentTarget){e.preventDefault();onClose();}}}>
      <div style={{background:"#071428",border:"1px solid #1e4070",borderRadius:14,padding:20,width:"100%",maxWidth:520,maxHeight:"92vh",overflowY:"scroll",WebkitOverflowScrolling:"touch"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{fontSize:16,fontWeight:800,color:"#e0f0ff"}}>DaySimulator 使い方</div>
          <button onClick={onClose} style={{background:"transparent",border:"1px solid #2a4060",borderRadius:8,color:"#4a7090",padding:"4px 12px",fontSize:14,cursor:"pointer",fontFamily:"monospace"}}>✕</button>
        </div>
        {SECTIONS.map(function(sec,i){
          return(
            <div key={i} style={{marginBottom:14}}>
              <div style={{fontSize:14,fontWeight:700,color:"#4a90c0",marginBottom:6,borderBottom:"1px solid #0f2040",paddingBottom:4}}>{sec.title}</div>
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
        <div style={{background:"#050e1c",borderRadius:8,padding:"10px 14px",marginTop:8}}>
          <div style={{fontSize:12,color:"#4a7090"}}>銘柄カードをタップ → 詳細シグナル表示</div>
          <div style={{fontSize:12,color:"#4a7090",marginTop:4}}>💼ボタン → ポートフォリオに追加</div>
          <div style={{fontSize:12,color:"#4a7090",marginTop:4}}>★ボタン → お気に入り登録</div>
        </div>
      </div>
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
  var usOpen=isWeekday&&(timeMin>=usStartMin||timeMin<usEndMin);
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
  var selStockS=useState(null);var selectedStock=selStockS[0],setSelectedStock=selStockS[1];
  var k=useState("all");var activeTab=k[0],setActiveTab=k[1];
  var userId=(function(){try{var id=localStorage.getItem("daytrade_uid");if(!id){id="u_"+Math.random().toString(36).slice(2,10);localStorage.setItem("daytrade_uid",id);}return id;}catch(e){return"u_default";}})();
  var SYNC_API="https://daytrade-simulator.vercel.app/api/sync";
  var favInit=(function(){try{var v=localStorage.getItem("fav_tickers");return v?JSON.parse(v):[];}catch(e){return[];}})();
  var fvS=useState(favInit);var favs=fvS[0],setFavs=fvS[1];
  var NOTIFY_API="https://daytrade-simulator.vercel.app/api/notify";
  function toggleFav(ticker){setFavs(function(prev){
    var isAdding=prev.indexOf(ticker)<0;
    var next=isAdding?prev.concat([ticker]):prev.filter(function(t){return t!==ticker;});
    try{localStorage.setItem("fav_tickers",JSON.stringify(next));}catch(e){}
    var port=(function(){try{return JSON.parse(localStorage.getItem("portfolio_v1")||"[]");}catch(e){return[];}})();
    fetch(SYNC_API+"?userId="+userId,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({favs:next,portfolio:port})}).catch(function(){});
    if(isAdding){
      fetch(NOTIFY_API,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:" ",message:userId})}).catch(function(){});
    }
    return next;
  });}
  function isFav(ticker){return favs.indexOf(ticker)>=0;}
  var scan=useCallback(async function(){
    setLoading(true);
    setProgress({done:0,total:0,msg:"出来高ランキング取得中..."});
    try{
      var universe=(await buildStockUniverse()).slice();
      var usCount=universe.filter(function(s){return s.market==="US";}).length;
      var jpCount=universe.filter(function(s){return s.market==="JP";}).length;
      setProgress({done:0,total:0,msg:"US:"+usCount+"銘柄 JP:"+jpCount+"銘柄 取得完了 分析開始..."});
      var favList=(function(){try{var v=localStorage.getItem("fav_tickers");return v?JSON.parse(v):[];}catch(e){return[];}})();
      var uTickers=universe.map(function(s){return s.ticker;});
      favList.forEach(function(ticker){if(uTickers.indexOf(ticker)<0){var isJP=ticker.endsWith(".T"),code=ticker.replace(".T","");universe.push({ticker:ticker,name:code,market:isJP?"JP":"US",tvSymbol:(isJP?"TSE:":"NASDAQ:")+code});}});
      setProgress({done:0,total:universe.length,msg:null});
      var results=[],BATCH=6;
      for(var i=0;i<universe.length;i+=BATCH){
        var batch=universe.slice(i,i+BATCH);
        await Promise.all(batch.map(async function(stock){
          var pd;
          try{pd=await fetchYahoo(stock.ticker);}catch(err){pd=genSim(stock.ticker);}
          try{results.push(analyzeStock(stock,pd));}catch(e){console.error("analyzeStock error",stock.ticker,e);}
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
        if(data.portfolio&&data.portfolio.length>0){try{localStorage.setItem("portfolio_v1",JSON.stringify(data.portfolio));}catch(e){}}
      })
      .catch(function(){})
      .finally(function(){scan();});
  },[]);
  var helpS=useState(false);var showHelp=helpS[0],setShowHelp=helpS[1];
  var TABS=[["all","📋"],["fav","⭐"],["portfolio","💼"],["backtest","📈"],["index","🌍"],["market","📡"],["news","📰"],["trend","🔥"],["sync","🔗"]];
  var TAB_LABELS={"all":"全銘柄","fav":"お気に入り","portfolio":"ポートフォリオ","backtest":"バックテスト","index":"インデックス","market":"市場予測","news":"ニュース","trend":"トレンド","sync":"デバイス同期"};
  var TAB_SHORT={"all":"全銘柄","fav":"お気に入り","portfolio":"PF","backtest":"BT","index":"指数","market":"市場予測","news":"ニュース","trend":"トレンド","sync":"同期"};
  var isMobile=window.innerWidth<768;
  return(
    <div style={{minHeight:"100vh",background:"#040c18",fontFamily:"monospace",color:"#b8cce0"}}>
      <div style={{background:"linear-gradient(180deg,#071428,#050f20)",borderBottom:"1px solid #0f2040",padding:"8px 12px",position:"sticky",top:0,zIndex:20,marginLeft:isMobile?0:50}}>
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
        {showHelp&&createPortal(<HelpModal onClose={function(){setShowHelp(false);}}/>,document.body)}
      </div>
      {activeTab==="market"&&(
        <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:100,background:"#040c18",overflowY:"auto",WebkitOverflowScrolling:"touch",padding:"10px 10px 80px",transform:"translateZ(0)"}}
          onTouchStart={function(e){e.stopPropagation();}}
          onTouchMove={function(e){e.stopPropagation();}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,padding:"8px 0",borderBottom:"1px solid #0f2040"}}>
            <div style={{fontSize:14,fontWeight:800,color:"#e0f0ff"}}>📡 市場予測</div>
            <button onClick={function(){setActiveTab("all");}} style={{background:"transparent",border:"1px solid #2a4060",borderRadius:8,color:"#4a7090",padding:"4px 12px",fontSize:12,cursor:"pointer",fontFamily:"monospace"}}>✕ 閉じる</button>
          </div>
          <MarketPredictionPanel stocks={stocks} vix={vix} predictionResult={predictionResult} setPredictionResult={setPredictionResult} predictionLoading={predictionLoading} setPredictionLoading={setPredictionLoading}/>
        </div>
      )}
      <div>
        {!isMobile&&(
          <div style={{width:50,background:"#050f20",borderRight:"1px solid #0f2040",display:"flex",flexDirection:"column",alignItems:"center",paddingTop:10,gap:4,flexShrink:0,position:"fixed",top:0,left:0,height:"100vh",overflowY:"auto",zIndex:15}}>
            {TABS.map(function(tab){var active=activeTab===tab[0];return(<button key={tab[0]} onClick={function(){setActiveTab(tab[0]);}} title={TAB_LABELS[tab[0]]} style={{width:40,height:40,background:active?"#0ea5e9":"transparent",border:"1px solid "+(active?"#0ea5e9":"transparent"),borderRadius:8,color:active?"#fff":"#4a6080",fontSize:17,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>{tab[1]}</button>);})}
          </div>
        )}
        <div style={{marginLeft:isMobile?0:50,padding:"10px 10px 120px"}}>
          {activeTab==="all"&&<AllStocksPanel stocks={stocks} loading={loading} toggleFav={toggleFav} favs={favs} vix={vix} usdJpy={usdJpy} onScan={scan} ts={ts} progress={progress} selectedStock={selectedStock} setSelectedStock={setSelectedStock}/>}
          {activeTab==="fav"&&<FavPanel stocks={stocks} favs={favs} toggleFav={toggleFav} vix={vix} usdJpy={usdJpy} selectedStock={selectedStock} setSelectedStock={setSelectedStock}/>}
          {activeTab==="portfolio"&&<PortfolioPanel stocks={stocks}/>}
          {activeTab==="backtest"&&<BacktestPanel stocks={stocks} favs={favs}/>}
          {activeTab==="index"&&<IndexPanel/>}
          {activeTab==="news"&&<NewsPanel/>}
          {activeTab==="trend"&&<TrendPanel/>}
          {activeTab==="sync"&&<SyncPanel userId={userId} syncApi={SYNC_API} setFavs={setFavs} scan={scan}/>}
        </div>
      </div>
    </div>
  );
}
