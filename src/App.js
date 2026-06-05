import { useState, useCallback, useEffect } from "react";

function useColumns(){
  var w=useState(window.innerWidth); var width=w[0],setWidth=w[1];
  useEffect(function(){
    function onResize(){setWidth(window.innerWidth);}
    window.addEventListener("resize",onResize);
    return function(){window.removeEventListener("resize",onResize);};
  },[]);
  return width<768?2:3;
}


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
  var seen={},out=[];
  us.slice(0,50).concat(jp.slice(0,50)).forEach(function(s){if(!seen[s.ticker]){seen[s.ticker]=true;out.push(s);}});
  return out;
}

async function fetchYahoo(ticker){
  var now=Date.now();
  if(CACHE[ticker]&&now-CACHE[ticker].ts<CACHE_TTL){var cached=CACHE[ticker].data;return{closes:cached.closes.slice(),highs:cached.highs.slice(),lows:cached.lows.slice(),currentPrice:cached.currentPrice,previousClose:cached.previousClose,real:cached.real};}
  var res=await fetch(VERCEL_API+"?ticker="+encodeURIComponent(ticker)+"&range=2y",{signal:AbortSignal.timeout(15000)});
  if(!res.ok) throw new Error("HTTP "+res.status);
  var json=await res.json();
  var result=json&&json.chart&&json.chart.result&&json.chart.result[0];
  if(!result) throw new Error("empty");
  var q=result.indicators.quote[0],meta=result.meta;
  function fill(arr){var out=(arr||[]).slice();for(var j=0;j<out.length;j++)if(out[j]==null)out[j]=j>0?out[j-1]:0;return out;}
  var data={closes:fill(q.close),highs:fill(q.high),lows:fill(q.low),currentPrice:meta.regularMarketPrice||fill(q.close).slice(-1)[0],previousClose:meta.chartPreviousClose||0,real:true};
  CACHE[ticker]={ts:now,data:data};
  return{closes:data.closes.slice(),highs:data.highs.slice(),lows:data.lows.slice(),currentPrice:data.currentPrice,previousClose:data.previousClose,real:data.real};
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

function runBacktest(closes){
  var results=[],wins=0,total=0;
  for(var i=26;i<closes.length-5;i++){
    var slice=closes.slice(0,i+1),macd=calcMACD(slice),mn=macd[i],mp=macd[i-1];
    if(mn&&mp&&mn.hist>0&&mp.hist<=0){var buyPrice=closes[i],sellPrice=closes[Math.min(i+5,closes.length-1)],ret=(sellPrice-buyPrice)/buyPrice*100;total++;if(ret>0)wins++;results.push({buyPrice:buyPrice.toFixed(2),sellPrice:sellPrice.toFixed(2),ret:ret.toFixed(2),win:ret>0});}
  }
  return{results:results.slice(-20),winRate:total>0?(wins/total*100).toFixed(1):"0",total:total};
}

function analyzeStock(stock,pd){
  var closes=pd.closes.slice(),highs=pd.highs.slice(),lows=pd.lows.slice();
  var n=closes.length-1;
  var s20=calcSMA(closes,20)[n],s50=calcSMA(closes,50)[n];
  var macdArr=calcMACD(closes),rsiVal=calcRSI(closes)[n];
  var bollVal=calcBoll(closes)[n],stochVal=calcStoch(closes,highs,lows)[n];
  var mNow=macdArr[n],mPrev=macdArr[n-1],price=pd.currentPrice||closes[n];
  var sc=0,signals=[];

  // トレンド判定（最大30点）
  if(s20&&s50){
    if(price>s20&&s20>s50){
      sc+=20;
      signals.push({label:"トレンド",val:"上昇トレンド",state:1});
    }else if(price<s20&&s20<s50){
      signals.push({label:"トレンド",val:"下降トレンド",state:-1});
    }else{sc+=5;signals.push({label:"トレンド",val:"横ばい",state:0});}
  }else if(s20){
    if(price>s20){sc+=10;signals.push({label:"トレンド",val:"MA20上",state:1});}
    else{signals.push({label:"トレンド",val:"MA20下",state:-1});}
  }

  // MACD（最大30点）
  if(mNow.hist>0&&mPrev&&mPrev.hist<=0){
    sc+=30;signals.push({label:"MACD",val:"ゴールデンクロス",state:1});
  }else if(mNow.hist>0){
    sc+=10;
    signals.push({label:"MACD",val:"強気ゾーン",state:1});
  }else if(mNow.hist<0&&mPrev&&mPrev.hist>=0){
    signals.push({label:"MACD",val:"デッドクロス",state:-1});
  }else{
    signals.push({label:"MACD",val:"弱気ゾーン",state:-1});
  }

  // RSI（最大25点）
  var rl="RSI("+rsiVal.toFixed(1)+")";
  if(rsiVal<30){sc+=25;signals.push({label:rl,val:"売られすぎ",state:1});}
  else if(rsiVal<40){sc+=18;signals.push({label:rl,val:"やや売られ",state:1});}
  else if(rsiVal<50){sc+=12;signals.push({label:rl,val:"やや弱め",state:0});}
  else if(rsiVal<60){sc+=8;signals.push({label:rl,val:"中立",state:0});}
  else if(rsiVal<70){sc+=5;signals.push({label:rl,val:"やや強め",state:0});}
  else{signals.push({label:rl,val:"買われすぎ",state:-1});}

  // ボリンジャーバンド（最大20点）
  if(bollVal){
    var bbPos=(closes[n]-bollVal.lower)/(bollVal.upper-bollVal.lower||1);
    if(price<=bollVal.lower){sc+=20;signals.push({label:"BB",val:"下限→反発",state:1});}
    else if(bbPos<0.2){sc+=15;signals.push({label:"BB",val:"下限付近",state:1});}
    else if(price>=bollVal.upper){signals.push({label:"BB",val:"上限→過熱",state:-1});}
    else if(bbPos>0.8){sc+=3;signals.push({label:"BB",val:"上限付近",state:0});}
    else{sc+=8;signals.push({label:"BB",val:"バンド内",state:0});}
  }

  // ストキャスティクス（最大15点）
  if(stochVal!==null){
    var sl="Stoch("+stochVal.toFixed(1)+")";
    if(stochVal<20){sc+=15;signals.push({label:sl,val:"売られすぎ",state:1});}
    else if(stochVal<35){sc+=10;signals.push({label:sl,val:"やや売られ",state:1});}
    else if(stochVal>80){signals.push({label:sl,val:"買われすぎ",state:-1});}
    else if(stochVal>65){sc+=3;signals.push({label:sl,val:"やや強め",state:0});}
    else{sc+=6;signals.push({label:sl,val:"中立",state:0});}
  }
  var winRate=Math.min(88,Math.max(28,sc*0.72));
  var expVal=(winRate/100*2.5-(1-winRate/100)*1.5).toFixed(2);
  var timing=sc>=68?"BUY":sc>=42?"WATCH":"SKIP";
  var change=pd.previousClose?((price-pd.previousClose)/pd.previousClose*100).toFixed(2):"0.00";
  var dispPrice=stock.market==="JP"?"¥"+Math.round(price).toLocaleString():"$"+price.toFixed(2);
  return{ticker:stock.ticker,tvSymbol:stock.tvSymbol,name:stock.name,market:stock.market,
    price:dispPrice,rawPrice:price,score:sc,winRate:winRate.toFixed(1),expVal:expVal,
    timing:timing,signals:signals,change:change,spark:closes.slice(-30),
    real:pd.real,closes:closes,yahooUrl:"https://finance.yahoo.co.jp/quote/"+stock.ticker};
}

function classifyStockFn(s){
  var sigs=s.signals,macdSig=null;
  for(var i=0;i<sigs.length;i++){if(sigs[i].label==="MACD"){macdSig=sigs[i];break;}}
  if(!macdSig) return null;
  if(macdSig.val==="ゴールデンクロス") return{type:"GC_NOW",label:"GC発生",color:"#22d3a0",bg:"#052e16",border:"#22d3a0"};
  if(macdSig.val==="デッドクロス")     return{type:"DC_NOW",label:"DC発生",color:"#f43f5e",bg:"#1f0010",border:"#f43f5e"};
  // GC接近: 強気ゾーン + スコア60以上
  if(macdSig.val==="強気ゾーン"&&s.score>=60) return{type:"GC_NEAR",label:"GC接近",color:"#fbbf24",bg:"#1c1400",border:"#fbbf24"};
  // DC接近: 弱気ゾーン + スコア35以下
  if(macdSig.val==="弱気ゾーン"&&s.score<=35) return{type:"DC_NEAR",label:"DC接近",color:"#fb923c",bg:"#1a0800",border:"#fb923c"};
  // GC監視: 強気ゾーン + スコア50以上（50未満は表示しない）
  if(macdSig.val==="強気ゾーン"&&s.score>=50) return{type:"GC_WATCH",label:"GC監視",color:"#60a5fa",bg:"#0a1e3a",border:"#3b82f6"};
  return{type:"NONE",label:"中立",color:"#4a7090",bg:"#071428",border:"#1e3050"};
}

// ── SparklineWithMA ───────────────────────────────────────────────────────────
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

function TabBtn(p){return(<button onClick={p.onClick} style={{background:p.active?p.color+"18":"transparent",border:"1px solid "+(p.active?p.color:"#1e3050"),borderRadius:6,color:p.active?p.color:"#4a6080",padding:"4px 10px",fontSize:10,cursor:"pointer",fontFamily:"monospace",fontWeight:p.active?700:400}}>{p.label}</button>);}


// ── SignalModal ───────────────────────────────────────────────────────────────
function SignalModal(p){
  var s=p.s,onClose=p.onClose,toggleFav=p.toggleFav,isFav=p.isFav;
  if(!s) return null;
  var mc=MKT[s.market]||MKT["US"];
  var isUp=parseFloat(s.change)>=0;
  var tvUrl="https://www.tradingview.com/chart/?symbol="+encodeURIComponent(s.tvSymbol)+"&interval=D";
  var stateColor=function(state){return state===1?"#22d3a0":state===-1?"#f43f5e":"#fbbf24";};
  var stateLabel=function(state){return state===1?"▲ 強気":state===-1?"▼ 弱気":"→ 中立";};

  // ポートフォリオ追加
  var addFormS=useState(false);var showAdd=addFormS[0],setShowAdd=addFormS[1];
  var buyPriceS=useState(s.rawPrice?s.rawPrice.toFixed(2):"");var buyPrice=buyPriceS[0],setBuyPrice=buyPriceS[1];
  var sharesS=useState("");var shares=sharesS[0],setShares=sharesS[1];
  var addedS=useState(false);var added=addedS[0],setAdded=addedS[1];
  function submitAdd(){
    if(!buyPrice||!shares) return;
    var portfolio=(function(){try{var v=localStorage.getItem("portfolio_v1");return v?JSON.parse(v):[];}catch(e){return[];}})();
    var pos={id:Date.now(),ticker:s.ticker,name:s.name,market:s.market,buyPrice:parseFloat(buyPrice),shares:parseFloat(shares),stopLoss:null,target:null,addedAt:new Date().toLocaleDateString("ja-JP")};
    try{localStorage.setItem("portfolio_v1",JSON.stringify(portfolio.concat([pos])));}catch(e){}
    setShowAdd(false);setShares("");setAdded(true);
    setTimeout(function(){setAdded(false);},2000);
  }
  var inp={background:"#040c18",border:"1px solid #1e4070",borderRadius:5,color:"#b8cce0",padding:"6px 8px",fontSize:12,fontFamily:"monospace",width:"100%",boxSizing:"border-box"};

  return(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:300,background:"#000000cc",display:"flex",alignItems:"center",justifyContent:"center",padding:16,cursor:"pointer",WebkitTapHighlightColor:"transparent"}} onClick={onClose}>
      <div style={{background:"#071428",border:"1px solid #1e4070",borderRadius:14,padding:20,width:"100%",maxWidth:480,maxHeight:"85vh",overflowY:"auto"}} onClick={function(e){e.stopPropagation();}}>

        {/* ヘッダー */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
          <div>
            <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:4}}>
              <span style={bStyle(mc.bg,mc.border,mc.text)}>{mc.label}</span>
              <span style={{fontSize:18,fontWeight:800,color:"#e0f0ff"}}>{s.ticker.replace(".T","")}</span>
            </div>
            <div style={{fontSize:11,color:"#4a7090"}}>{s.name}</div>
          </div>
          <div style={{display:"flex",gap:6,alignItems:"center"}}>
            {/* ★お気に入り */}
            <button onClick={function(){toggleFav(s.ticker);}} style={{background:"transparent",border:"1px solid #2a4060",borderRadius:8,color:isFav(s.ticker)?"#fbbf24":"#4a7090",padding:"4px 10px",fontSize:16,cursor:"pointer"}}>
              {isFav(s.ticker)?"★":"☆"}
            </button>
            {/* 💼ポートフォリオ */}
            <button onClick={function(){setShowAdd(!showAdd);}} style={{background:showAdd?"#052e16":"transparent",border:"1px solid "+(showAdd?"#22d3a0":"#2a4060"),borderRadius:8,color:showAdd?"#22d3a0":added?"#22d3a0":"#4a7090",padding:"4px 10px",fontSize:14,cursor:"pointer"}}>
              {added?"✅":"💼"}
            </button>
            {/* ✕閉じる */}
            <button onClick={onClose} style={{background:"transparent",border:"1px solid #2a4060",borderRadius:8,color:"#4a7090",padding:"4px 12px",fontSize:12,cursor:"pointer",fontFamily:"monospace"}}>✕</button>
          </div>
        </div>

        {/* ポートフォリオ追加フォーム */}
        {showAdd&&(
          <div style={{background:"#040c18",border:"1px solid #22d3a030",borderRadius:8,padding:"12px",marginBottom:14}}>
            <div style={{fontSize:10,fontWeight:700,color:"#22d3a0",marginBottom:8}}>💼 ポートフォリオに追加</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
              <div><div style={{fontSize:9,color:"#2a6090",marginBottom:3}}>買値</div><input style={inp} type="number" value={buyPrice} onChange={function(e){setBuyPrice(e.target.value);}} placeholder="150.00"/></div>
              <div><div style={{fontSize:9,color:"#2a6090",marginBottom:3}}>株数</div><input style={inp} type="number" value={shares} onChange={function(e){setShares(e.target.value);}} placeholder="100"/></div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              <button onClick={function(){setShowAdd(false);}} style={{background:"transparent",border:"1px solid #2a3050",borderRadius:6,color:"#4a7090",padding:"8px",fontSize:11,cursor:"pointer",fontFamily:"monospace"}}>キャンセル</button>
              <button onClick={submitAdd} disabled={!buyPrice||!shares} style={{background:buyPrice&&shares?"linear-gradient(135deg,#22d3a0,#059669)":"#0a1828",border:"none",borderRadius:6,color:"#fff",padding:"8px",fontSize:11,fontWeight:700,cursor:buyPrice&&shares?"pointer":"not-allowed",fontFamily:"monospace"}}>追加</button>
            </div>
          </div>
        )}

        {/* 価格・前日比 */}
        <div style={{background:"#050e1c",borderRadius:10,padding:"12px 16px",marginBottom:14,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontSize:22,fontWeight:800,color:"#e0f0ff"}}>{s.price}</span>
          <span style={{fontSize:15,fontWeight:700,color:isUp?"#22d3a0":"#f43f5e"}}>{isUp?"▲":"▼"}{Math.abs(s.change)}%</span>
        </div>

        {/* スパークライン */}
        <div style={{background:"#030b14",borderRadius:8,padding:"8px",marginBottom:14}}>
          <SparklineWithMA data={s.spark} up={isUp}/>
          <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:4}}>
            <span style={{fontSize:8,color:"#fbbf24",fontWeight:700}}>─ MA5</span>
            <span style={{fontSize:8,color:"#818cf8",fontWeight:700}}>─ MA25</span>
            <span style={{fontSize:8,color:isUp?"#22d3a060":"#f43f5e60"}}>─ 価格</span>
          </div>
        </div>

        {/* スコア */}
        <div style={{display:"flex",gap:10,marginBottom:14,alignItems:"center"}}>
          <ScoreRing score={s.score}/>
          <div>
            <div style={{fontSize:11,color:"#4a7090"}}>総合スコア</div>
            <div style={{fontSize:13,fontWeight:700,color:scoreColor(s.score)}}>{s.score>=68?"買いシグナル強":s.score>=50?"中程度":"弱いシグナル"}</div>
          </div>
        </div>

        {/* シグナル詳細 */}
        <div style={{fontSize:11,fontWeight:700,color:"#4a90c0",marginBottom:8}}>📊 シグナル詳細</div>
        <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:16}}>
          {s.signals.map(function(sig,i){
            return(
              <div key={i} style={{background:"#050e1c",borderRadius:8,padding:"10px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",border:"1px solid #0f2040"}}>
                <span style={{fontSize:11,color:"#4a7090"}}>{sig.label}</span>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <span style={{fontSize:11,fontWeight:700,color:stateColor(sig.state)}}>{sig.val}</span>
                  <span style={{fontSize:9,color:stateColor(sig.state)}}>{stateLabel(sig.state)}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* ボタン */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          <a href={tvUrl} target="_blank" rel="noreferrer" style={{background:"linear-gradient(135deg,#0d2d4a,#0369a1)",border:"1px solid #0ea5e9",borderRadius:8,color:"#fff",padding:"12px",fontSize:12,fontWeight:700,fontFamily:"monospace",textDecoration:"none",textAlign:"center",display:"block"}}>📈 TradingView</a>
          <a href={s.yahooUrl} target="_blank" rel="noreferrer" style={{background:"#071428",border:"1px solid #4f46e5",borderRadius:8,color:"#a5b4fc",padding:"12px",fontSize:12,fontWeight:700,fontFamily:"monospace",textDecoration:"none",textAlign:"center",display:"block"}}>🔗 Yahoo!</a>
        </div>
      </div>
    </div>
  );
}

// ── StockCard ─────────────────────────────────────────────────────────────────
function StockCard(p){
  var s=p.s,toggleFav=p.toggleFav,isFav=p.isFav,cross=p.cross;
  var bc=BADGE[s.timing],mc=MKT[s.market]||MKT["US"],isUp=parseFloat(s.change)>=0;
  var tvUrl="https://www.tradingview.com/chart/?symbol="+encodeURIComponent(s.tvSymbol)+"&interval=D";
  var showModalS=useState(false); var showModal=showModalS[0],setShowModal=showModalS[1];
  var addFormS=useState(false); var showAdd=addFormS[0],setShowAdd=addFormS[1];
  var buyPriceS=useState(s.rawPrice?s.rawPrice.toFixed(2):""); var buyPrice=buyPriceS[0],setBuyPrice=buyPriceS[1];
  var sharesS=useState(""); var shares=sharesS[0],setShares=sharesS[1];
  function submitAdd(){
    if(!buyPrice||!shares) return;
    var portfolio=(function(){try{var v=localStorage.getItem("portfolio_v1");return v?JSON.parse(v):[];}catch(e){return[];}})();
    var pos={id:Date.now(),ticker:s.ticker,name:s.name,market:s.market,buyPrice:parseFloat(buyPrice),shares:parseFloat(shares),stopLoss:null,target:null,addedAt:new Date().toLocaleDateString("ja-JP")};
    try{localStorage.setItem("portfolio_v1",JSON.stringify(portfolio.concat([pos])));}catch(e){}
    setShowAdd(false); setShares("");
  }
  var inp={background:"#040c18",border:"1px solid #1e4070",borderRadius:5,color:"#b8cce0",padding:"5px 7px",fontSize:11,fontFamily:"monospace",width:"100%",boxSizing:"border-box"};
  return(
    <div style={{background:"#050e1c",border:"1px solid #0f2040",borderRadius:10,padding:"10px 10px",display:"flex",flexDirection:"column",gap:7,cursor:"pointer"}} onClick={function(e){
  if(showAdd) return;
  var t=e.target;
  if(t.tagName==="BUTTON"||t.tagName==="A"||t.tagName==="INPUT") return;
  if(t.closest("button")||t.closest("a")||t.closest("input")) return;
  setShowModal(true);
}}>
      {showModal&&<SignalModal s={s} onClose={function(){setShowModal(false);}} toggleFav={toggleFav} isFav={isFav}/>}
      <div style={{display:"flex",gap:6,alignItems:"center"}}>
        <ScoreRing score={s.score}/>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",gap:3,alignItems:"center"}}>
            <span style={bStyle(mc.bg,mc.border,mc.text)}>{mc.label}</span>
            <span style={{fontSize:12,fontWeight:800,color:"#d8eeff"}}>{s.ticker.replace(".T","")}</span>
            {!s.real&&<span style={bStyle("#1a1200","#7c6010","#fbbf24")}>SIM</span>}
          </div>
          <div style={{fontSize:9,color:"#4a7090",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginTop:1}}>{s.name}</div>
        </div>
        <button onClick={function(){toggleFav(s.ticker);}} style={{background:"transparent",border:"none",fontSize:13,cursor:"pointer",padding:0,color:isFav(s.ticker)?"#fbbf24":"#2a4060",flexShrink:0}}>{isFav(s.ticker)?"★":"☆"}</button>
      </div>
      <div style={{background:"#030b14",borderRadius:6,padding:"4px 4px 2px"}}>
        <SparklineWithMA data={s.spark} up={isUp}/>
        <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:2}}>
          <span style={{fontSize:7,color:"#fbbf24",fontWeight:700}}>─ MA5</span>
          <span style={{fontSize:7,color:"#818cf8",fontWeight:700}}>─ MA25</span>
          <span style={{fontSize:7,color:isUp?"#22d3a060":"#f43f5e60"}}>─ 価格</span>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:6,alignItems:"center"}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4,alignItems:"center"}}>
          {/* 左上: 価格 */}
          <span style={{fontSize:13,color:"#d8eeff",fontWeight:800}}>{s.price}</span>
          {/* 右上: クロスバッジ */}
          <div style={{textAlign:"right"}}>
            {cross&&cross.type!=="NONE"
              ? <span style={bStyle(cross.bg,cross.border,cross.color)}>{cross.label}</span>
              : <span style={{fontSize:9,color:"#1a3050"}}>─</span>}
          </div>
          {/* 左下: 前日比 */}
          <div style={{display:"flex",gap:4,alignItems:"center"}}>
            <span style={{fontSize:12,fontWeight:700,color:isUp?"#22d3a0":"#f43f5e"}}>{isUp?"▲":"▼"}{Math.abs(s.change)}%</span>
          </div>
          {/* 右下: 買い/様子見バッジ */}
          <div style={{textAlign:"right"}}>
            <span style={bStyle(bc.bg,bc.border,bc.text)}>{bc.label}</span>
          </div>
        </div>
        <div style={{display:"flex",flexDirection:"row",gap:4,alignItems:"stretch"}}>
          <button onClick={function(){setShowAdd(!showAdd);}} style={{background:showAdd?"#052e16":"#071428",border:"1px solid "+(showAdd?"#22d3a0":"#1e5030"),borderRadius:6,color:showAdd?"#22d3a0":"#3a8060",padding:"5px 8px",fontSize:10,fontWeight:700,fontFamily:"monospace",cursor:"pointer",textAlign:"center",whiteSpace:"nowrap",display:"flex",alignItems:"center",justifyContent:"center"}}>💼</button>
          <div style={{display:"flex",flexDirection:"column",gap:4}}>
            <a href={tvUrl} target="_blank" rel="noreferrer" style={{background:"#071428",border:"1px solid #1e6090",borderRadius:6,color:"#4a90c0",padding:"5px 8px",fontSize:9,fontWeight:700,fontFamily:"monospace",textDecoration:"none",textAlign:"center",display:"block",whiteSpace:"nowrap"}}>📈 TV</a>
            <a href={s.yahooUrl} target="_blank" rel="noreferrer" style={{background:"#071428",border:"1px solid #4f46e5",borderRadius:6,color:"#a5b4fc",padding:"5px 8px",fontSize:9,fontWeight:700,fontFamily:"monospace",textDecoration:"none",textAlign:"center",display:"block",whiteSpace:"nowrap"}}>🔗 Y!</a>
          </div>
        </div>
      </div>
      {showAdd&&(
        <div style={{background:"#040c18",border:"1px solid #22d3a030",borderRadius:8,padding:"10px 10px",display:"flex",flexDirection:"column",gap:7}}>
          <div style={{fontSize:10,fontWeight:700,color:"#22d3a0"}}>💼 ポートフォリオに追加</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
            <div><div style={{fontSize:9,color:"#2a6090",marginBottom:3}}>買値</div><input style={inp} type="number" value={buyPrice} onChange={function(e){setBuyPrice(e.target.value);}} placeholder="150.00"/></div>
            <div><div style={{fontSize:9,color:"#2a6090",marginBottom:3}}>株数</div><input style={inp} type="number" value={shares} onChange={function(e){setShares(e.target.value);}} placeholder="100"/></div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
            <button onClick={function(){setShowAdd(false);}} style={{background:"transparent",border:"1px solid #2a3050",borderRadius:6,color:"#4a7090",padding:"7px",fontSize:10,cursor:"pointer",fontFamily:"monospace"}}>キャンセル</button>
            <button onClick={submitAdd} disabled={!buyPrice||!shares} style={{background:buyPrice&&shares?"linear-gradient(135deg,#22d3a0,#059669)":"#0a1828",border:"none",borderRadius:6,color:"#fff",padding:"7px",fontSize:10,fontWeight:700,cursor:buyPrice&&shares?"pointer":"not-allowed",fontFamily:"monospace"}}>追加</button>
          </div>
        </div>
      )}
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
    <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"10px 14px",marginBottom:12,display:"flex",gap:8,alignItems:"center"}}>
      <span style={{fontSize:10,color:"#2a6090"}}>市況取得中...</span>
    </div>
  );

  return(
    <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"12px",marginBottom:12,display:"grid",gridTemplateColumns:isWide?"repeat(5,1fr)":"1fr 1fr",gap:8}}>
      {INDICES.map(function(idx){
        var d=data[idx.key];
        if(!d||d.error) return(
          <div key={idx.key} style={{background:"#050e1c",borderRadius:8,padding:"10px 12px"}}>
            <div style={{fontSize:11,color:"#2a6090"}}>{idx.label}</div>
            <div style={{fontSize:13,color:"#4a7090"}}>─</div>
          </div>
        );
        var isUp=parseFloat(d.change)>=0;
        var price=d.round?Math.round(d.price).toLocaleString():parseFloat(d.price).toFixed(2);
        var isVix=idx.key==="vix";
        var vixAlert=isVix&&d.price>=20;
        return(
          <div key={idx.key} style={{background:vixAlert?"#1f0010":"#050e1c",borderRadius:8,padding:"10px 12px",border:vixAlert?"1px solid #f43f5e50":"1px solid transparent"}}>
            <div style={{fontSize:11,color:vixAlert?"#f43f5e":"#4a7090",fontWeight:700,marginBottom:4}}>{idx.label}{vixAlert?" ⚠ 警戒":""}</div>
            <div style={{fontSize:20,fontWeight:800,color:vixAlert?"#f43f5e":"#d8eeff"}}>{d.prefix}{price}</div>
            <div style={{fontSize:13,fontWeight:700,color:isUp?"#22d3a0":"#f43f5e",marginTop:2}}>{isUp?"▲":"▼"}{Math.abs(d.change)}%</div>
          </div>
        );
      })}
    </div>
  );
}

// ── CrossPanel（メインタブ） ───────────────────────────────────────────────────
function CrossPanel(p){
  var stocks=p.stocks,loading=p.loading,onScan=p.onScan,toggleFav=p.toggleFav,favs=p.favs,ts=p.ts,progress=p.progress;
  var gcNow=[],dcNow=[],gcNear=[],dcNear=[],gcWatch=[];
  stocks.forEach(function(s){
    var c=classifyStockFn(s);if(!c||c.type==="NONE")return;
    if(c.type==="GC_NOW")gcNow.push({s:s,cross:c});
    else if(c.type==="DC_NOW")dcNow.push({s:s,cross:c});
    else if(c.type==="GC_NEAR")gcNear.push({s:s,cross:c});
    else if(c.type==="DC_NEAR")dcNear.push({s:s,cross:c});
    else if(c.type==="GC_WATCH")gcWatch.push({s:s,cross:c});
  });

  function Section(sp){
    if(!sp.items||!sp.items.length) return null;
    return(
      <div style={{marginBottom:16}}>
        <div style={{fontSize:11,fontWeight:700,color:sp.color,marginBottom:8,padding:"4px 0",borderBottom:"1px solid #0f2040"}}>{sp.title} ({sp.items.length})</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:8}}>
          {sp.items.map(function(item){return <StockCard key={item.s.ticker} s={item.s} toggleFav={toggleFav} isFav={function(t){return favs.indexOf(t)>=0;}} cross={item.cross}/>;  })}
        </div>
      </div>
    );
  }

  // スキャン中
  if(loading){
    return(
      <div style={{padding:"20px 0"}}>
        <div style={{textAlign:"center",padding:"40px 20px",color:"#4a7090"}}>
          <div style={{fontSize:28,marginBottom:12}}>📡</div>
          <div style={{fontSize:13,color:"#4a90c0",marginBottom:16}}>分析中...</div>
        </div>
        <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:8,padding:"12px 16px",margin:"0 4px"}}>
          <div style={{fontSize:10,color:"#4a7090",marginBottom:6}}>{progress.msg||("分析中... "+progress.done+" / "+progress.total+" 銘柄")}</div>
          <div style={{background:"#0a1828",borderRadius:4,height:4}}><div style={{background:"linear-gradient(90deg,#0ea5e9,#22d3a0)",height:4,borderRadius:4,width:(progress.total?(progress.done/progress.total)*100:5)+"%",transition:"width .3s"}}/></div>
        </div>
      </div>
    );
  }

  // データなし（初回前）
  if(stocks.length===0){
    return(
      <div style={{textAlign:"center",padding:"80px 20px",color:"#2a6090"}}>
        <div style={{fontSize:40,marginBottom:16}}>✨</div>
        <div style={{fontSize:14,color:"#4a90c0",marginBottom:8}}>データを読み込んでいます...</div>
      </div>
    );
  }

  var hasAny=gcNow.length+dcNow.length+gcNear.length+dcNear.length+gcWatch.length>0;
  var realCount=stocks.filter(function(s){return s.real;}).length;

  return(
    <div>
      <MarketBar/>
      {/* ステータスバー */}
      <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"10px 14px",marginBottom:14,display:"flex",gap:12,flexWrap:"wrap",alignItems:"center"}}>
        <div style={{fontSize:10,color:"#4a7090"}}>
          <span style={{color:"#22d3a0",fontWeight:700}}>{realCount}</span>
          <span style={{color:"#4a7090"}}> / {stocks.length} 銘柄 リアルデータ</span>
        </div>
        {ts&&<span style={{fontSize:9,color:"#2a6090"}}>更新: {ts}</span>}
        <button onClick={onScan} style={{marginLeft:"auto",background:"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:6,color:"#fff",padding:"5px 14px",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>再スキャン</button>
      </div>

      {!hasAny&&(
        <div style={{textAlign:"center",padding:"40px",color:"#4a7090",fontSize:12}}>
          現在クロス条件に該当する銘柄がありません
        </div>
      )}
      <Section title="⚡ GC接近中" items={gcNear} color="#fbbf24"/>
      <Section title="🔥 GC発生中" items={gcNow} color="#22d3a0"/>
      <Section title="👀 GC監視中" items={gcWatch} color="#60a5fa"/>
      <Section title="⚠ DC接近中" items={dcNear} color="#fb923c"/>
      <Section title="💀 DC発生中" items={dcNow} color="#f43f5e"/>
    </div>
  );
}

// ── FavPanel ──────────────────────────────────────────────────────────────────
function FavPanel(p){
  var stocks=p.stocks,favs=p.favs,toggleFav=p.toggleFav;
  var favStocks=stocks.filter(function(s){return favs.indexOf(s.ticker)>=0;});
  var searchS=useState("");var searchTicker=searchS[0],setSearchTicker=searchS[1];
  var searchStatusS=useState(null);var searchStatus=searchStatusS[0],setSearchStatus=searchStatusS[1];
  async function addByTicker(){var raw=searchTicker.trim().toUpperCase();if(!raw)return;var ticker=(raw.match(/^\d{4}$/)?raw+".T":raw);if(favs.indexOf(ticker)>=0){setSearchStatus("already");return;}setSearchStatus("loading");try{var res=await fetch(VERCEL_API+"?ticker="+encodeURIComponent(ticker)+"&range=2y",{signal:AbortSignal.timeout(15000)});if(!res.ok)throw new Error("not found");toggleFav(ticker);setSearchTicker("");setSearchStatus("ok");setTimeout(function(){setSearchStatus(null);},2000);}catch(e){setSearchStatus("error");setTimeout(function(){setSearchStatus(null);},2000);}}
  var statusMsg=searchStatus==="loading"?"取得中...":searchStatus==="ok"?"追加しました":searchStatus==="error"?"見つかりません":searchStatus==="already"?"登録済みです":null;
  return(
    <div>
      <div style={{background:"#050e1c",border:"1px solid #1e3050",borderRadius:10,padding:"12px 14px",marginBottom:14}}>
        <div style={{display:"flex",gap:8}}>
          <input style={{background:"#071428",border:"1px solid #1e3050",borderRadius:6,color:"#b8cce0",padding:"8px 10px",fontSize:12,fontFamily:"monospace",flex:1}} value={searchTicker} placeholder="AAPL / 7203" onChange={function(e){setSearchTicker(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter")addByTicker();}}/>
          <button onClick={addByTicker} style={{background:"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:8,color:"#fff",padding:"8px 16px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>追加</button>
        </div>
        {statusMsg&&<div style={{fontSize:10,color:searchStatus==="ok"?"#22d3a0":"#f43f5e",marginTop:6}}>{statusMsg}</div>}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:8}}>
        {favStocks.map(function(s){var cross=s.signals&&s.signals.length>0?classifyStockFn(s):null;return <StockCard key={s.ticker} s={s} toggleFav={toggleFav} isFav={function(t){return favs.indexOf(t)>=0;}} cross={cross}/>;  })}
      </div>
      {favs.length===0&&<div style={{textAlign:"center",padding:"30px 20px",color:"#4a7090",fontSize:11}}>ティッカーを入力して追加できます</div>}
    </div>
  );
}

// ── PortfolioPanel ────────────────────────────────────────────────────────────
function PortfolioPanel(p){
  var stocks=p.stocks;
  var initPort=(function(){try{var v=localStorage.getItem("portfolio_v1");return v?JSON.parse(v):[];}catch(e){return[];}})();
  var portS=useState(initPort);var portfolio=portS[0],setPortfolio=portS[1];
  var tabS=useState("list");var ptab=tabS[0],setPtab=tabS[1];
  var pricesS=useState({});var livePrices=pricesS[0],setLivePrices=pricesS[1];
  var lastUpdS=useState(null);var lastUpd=lastUpdS[0],setLastUpd=lastUpdS[1];
  var refreshingS=useState(false);var refreshing=refreshingS[0],setRefreshing=refreshingS[1];

  // 保有銘柄の価格を取得
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

  // 初回 + 5分ごとに自動更新
  useEffect(function(){
    fetchLivePrices(portfolio);
    var timer=setInterval(function(){fetchLivePrices(portfolio);},5*60*1000);
    return function(){clearInterval(timer);};
  },[portfolio.length]);
  var formS=useState({ticker:"",name:"",buyPrice:"",shares:"",stopLoss:"",target:"",market:"US"});
  var form=formS[0],setForm=formS[1];
  var editS=useState(null);var editId=editS[0],setEditId=editS[1];
  var editFormS=useState(null);var editForm=editFormS[0],setEditForm=editFormS[1];
  function savePort(next){setPortfolio(next);try{localStorage.setItem("portfolio_v1",JSON.stringify(next));}catch(e){}}
  function addPosition(){if(!form.ticker||!form.buyPrice||!form.shares)return;var pos={id:Date.now(),ticker:form.ticker.toUpperCase(),name:form.name||form.ticker.toUpperCase(),market:form.market,buyPrice:parseFloat(form.buyPrice),shares:parseFloat(form.shares),stopLoss:form.stopLoss?parseFloat(form.stopLoss):null,target:form.target?parseFloat(form.target):null,addedAt:new Date().toLocaleDateString("ja-JP")};savePort(portfolio.concat([pos]));setForm({ticker:"",name:"",buyPrice:"",shares:"",stopLoss:"",target:"",market:"US"});setPtab("list");}
  function removePos(id){savePort(portfolio.filter(function(p){return p.id!==id;}));}
  function startEdit(pos){setEditId(pos.id);setEditForm({buyPrice:String(pos.buyPrice),shares:String(pos.shares),stopLoss:pos.stopLoss?String(pos.stopLoss):"",target:pos.target?String(pos.target):""});}
  function saveEdit(id){if(!editForm.buyPrice||!editForm.shares)return;savePort(portfolio.map(function(pos){if(pos.id!==id)return pos;return Object.assign({},pos,{buyPrice:parseFloat(editForm.buyPrice),shares:parseFloat(editForm.shares),stopLoss:editForm.stopLoss?parseFloat(editForm.stopLoss):null,target:editForm.target?parseFloat(editForm.target):null});}));setEditId(null);setEditForm(null);}
  function getCurrentPrice(ticker){if(livePrices[ticker]) return livePrices[ticker];var found=stocks.find(function(s){return s.ticker===ticker;});return found?found.rawPrice:null;}
  var totalPnL=portfolio.reduce(function(sum,pos){var cur=getCurrentPrice(pos.ticker);return sum+(cur?(cur-pos.buyPrice)*pos.shares:0);},0);
  var inp={background:"#071428",border:"1px solid #1e3050",borderRadius:6,color:"#b8cce0",padding:"8px 10px",fontSize:12,fontFamily:"monospace",width:"100%",boxSizing:"border-box"};
  var inpSm={background:"#040c18",border:"1px solid #1e4070",borderRadius:6,color:"#b8cce0",padding:"6px 8px",fontSize:11,fontFamily:"monospace",width:"100%",boxSizing:"border-box"};
  return(
    <div>
      <div style={{display:"flex",gap:6,marginBottom:10,alignItems:"center"}}>
        <TabBtn label="保有銘柄" active={ptab==="list"} onClick={function(){setPtab("list");}} color="#22d3a0"/>
        <TabBtn label="追加" active={ptab==="add"} onClick={function(){setPtab("add");}} color="#0ea5e9"/>
        <div style={{marginLeft:"auto",display:"flex",gap:8,alignItems:"center"}}>
          {lastUpd&&<span style={{fontSize:9,color:"#2a6090"}}>更新: {lastUpd}</span>}
          <button onClick={function(){fetchLivePrices(portfolio);}} disabled={refreshing} style={{background:"transparent",border:"1px solid #1e4070",borderRadius:6,color:refreshing?"#2a6090":"#4a90c0",padding:"3px 8px",fontSize:9,cursor:refreshing?"not-allowed":"pointer",fontFamily:"monospace"}}>{refreshing?"更新中...":"🔄"}</button>
        </div>
      </div>
      {ptab==="add"&&(<div style={{background:"#050e1c",border:"1px solid #1e3050",borderRadius:10,padding:16,marginBottom:16}}><div style={{fontSize:12,fontWeight:700,color:"#e0f0ff",marginBottom:12}}>ポジション追加</div><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>{[["ティッカー","ticker","AAPL","text"],["銘柄名","name","Apple","text"],["買値","buyPrice","150.00","number"],["株数","shares","100","number"],["損切り","stopLoss","140.00","number"],["目標価格","target","180.00","number"]].map(function(row){return(<div key={row[0]}><div style={{fontSize:9,color:"#2a6090",marginBottom:3}}>{row[0]}</div><input style={inp} type={row[3]} value={form[row[1]]} placeholder={row[2]} onChange={function(e){var up={};up[row[1]]=e.target.value;setForm(Object.assign({},form,up));}}/></div>);})}</div><div style={{display:"flex",gap:6,marginBottom:12}}>{["US","JP"].map(function(m){return(<button key={m} onClick={function(){setForm(Object.assign({},form,{market:m}));}} style={{background:form.market===m?"#0ea5e9":"#071428",border:"1px solid "+(form.market===m?"#0ea5e9":"#1e3050"),borderRadius:6,color:form.market===m?"#fff":"#4a7090",padding:"5px 16px",fontSize:11,cursor:"pointer",fontFamily:"monospace"}}>{m}</button>);})}</div><button onClick={addPosition} style={{width:"100%",background:"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:8,color:"#fff",padding:"10px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>追加する</button></div>)}
      {ptab==="list"&&(portfolio.length===0?(<div style={{textAlign:"center",padding:"60px 20px",color:"#2a6090"}}><div style={{fontSize:36,marginBottom:12}}>📊</div><div style={{fontSize:13,color:"#4a90c0"}}>保有銘柄がありません</div></div>):(<div><div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"12px 16px",marginBottom:12,display:"flex",gap:20}}><div><div style={{fontSize:9,color:"#2a6090"}}>保有銘柄</div><div style={{fontSize:16,fontWeight:800,color:"#e0f0ff"}}>{portfolio.length}銘柄</div></div><div><div style={{fontSize:9,color:"#2a6090"}}>損益合計</div><div style={{fontSize:16,fontWeight:800,color:totalPnL>=0?"#22d3a0":"#f43f5e"}}>{totalPnL>=0?"+":""}{totalPnL.toFixed(2)}</div></div></div><div style={{display:"flex",flexDirection:"column",gap:8}}>{portfolio.map(function(pos){var cur=getCurrentPrice(pos.ticker),pnl=cur?(cur-pos.buyPrice)*pos.shares:null,pct=cur?(cur-pos.buyPrice)/pos.buyPrice*100:null,hitStop=cur&&pos.stopLoss&&cur<=pos.stopLoss,hitTarget=cur&&pos.target&&cur>=pos.target,isEditing=editId===pos.id;return(<div key={pos.id} style={{background:"#050e1c",border:"1px solid "+(hitStop?"#f43f5e":hitTarget?"#22d3a0":"#1e3050"),borderRadius:10,padding:"14px 16px"}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}><div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}><span style={{fontSize:15,fontWeight:800,color:"#d8eeff"}}>{pos.ticker.replace(".T","")}</span><span style={{fontSize:11,color:"#4a7090"}}>{pos.name}</span>{hitStop&&<span style={bStyle("#1f0010","#f43f5e","#f43f5e")}>損切りライン</span>}{hitTarget&&<span style={bStyle("#052e16","#22d3a0","#22d3a0")}>目標達成</span>}</div><div style={{display:"flex",gap:6}}><button onClick={function(){isEditing?setEditId(null):startEdit(pos);}} style={{background:"transparent",border:"1px solid "+(isEditing?"#fbbf24":"#2a3050"),borderRadius:6,color:isEditing?"#fbbf24":"#4a7090",padding:"3px 8px",fontSize:10,cursor:"pointer",fontFamily:"monospace"}}>{isEditing?"閉じる":"編集"}</button><button onClick={function(){removePos(pos.id);}} style={{background:"transparent",border:"1px solid #2a3050",borderRadius:6,color:"#4a7090",padding:"3px 8px",fontSize:10,cursor:"pointer",fontFamily:"monospace"}}>削除</button></div></div>{isEditing&&editForm&&(<div style={{background:"#040c18",border:"1px solid #1e4070",borderRadius:8,padding:"12px",marginBottom:10}}><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8}}>{[["買値","buyPrice"],["株数","shares"],["損切り","stopLoss"],["目標","target"]].map(function(row){return(<div key={row[0]}><div style={{fontSize:9,color:"#2a6090",marginBottom:2}}>{row[0]}</div><input style={inpSm} type="number" value={editForm[row[1]]} onChange={function(e){var up={};up[row[1]]=e.target.value;setEditForm(Object.assign({},editForm,up));}}/></div>);})}</div><button onClick={function(){saveEdit(pos.id);}} style={{width:"100%",background:"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:6,color:"#fff",padding:"8px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>保存する</button></div>)}<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(100px,1fr))",gap:6}}>{[["買値",pos.market==="JP"?"¥"+pos.buyPrice.toLocaleString():"$"+pos.buyPrice,"#b8cce0"],["株数",pos.shares+"株","#b8cce0"],["現在値",cur?(pos.market==="JP"?"¥"+Math.round(cur).toLocaleString():"$"+cur.toFixed(2)):"─","#b8cce0"],["損益",pnl!==null?(pnl>=0?"+":"")+pnl.toFixed(2):"─",pnl!==null?(pnl>=0?"#22d3a0":"#f43f5e"):"#4a7090"],["損益率",pct!==null?(pct>=0?"+":"")+pct.toFixed(2)+"%":"─",pct!==null?(pct>=0?"#22d3a0":"#f43f5e"):"#4a7090"]].map(function(row){return(<div key={row[0]} style={{background:"#071428",borderRadius:6,padding:"5px 8px"}}><div style={{fontSize:9,color:"#2a6090"}}>{row[0]}</div><div style={{fontSize:11,fontWeight:700,color:row[2]}}>{row[1]}</div></div>);})}</div></div>);})}</div></div>))}
    </div>
  );
}

function BacktestPanel(p){
  var stocks=p.stocks,favs=p.favs||[];
  var selS=useState("");var sel=selS[0],setSel=selS[1];
  var resS=useState(null);var result=resS[0],setResult=resS[1];
  var favStocks=stocks.filter(function(s){return favs.indexOf(s.ticker)>=0;});
  var otherStocks=stocks.filter(function(s){return favs.indexOf(s.ticker)<0;});
  function run(){var found=stocks.find(function(s){return s.ticker===sel;});if(!found||!found.closes)return;setResult(runBacktest(found.closes));}
  return(
    <div>
      <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"12px 16px",marginBottom:14}}><div style={{fontSize:12,fontWeight:700,color:"#e0f0ff",marginBottom:4}}>バックテスト</div><div style={{fontSize:10,color:"#4a7090"}}>MACDゴールデンクロス → 5日後売却の過去勝率を検証します。</div></div>
      <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:14}}><select value={sel} onChange={function(e){setSel(e.target.value);setResult(null);}} style={{background:"#071428",border:"1px solid #1e3050",borderRadius:6,color:"#b8cce0",padding:"10px 12px",fontSize:12,fontFamily:"monospace",width:"100%"}}><option value="">銘柄を選択</option>{favStocks.length>0&&<optgroup label="お気に入り">{favStocks.map(function(s){return(<option key={s.ticker} value={s.ticker}>{s.ticker.replace(".T","")} {s.name}</option>);})}</optgroup>}{otherStocks.length>0&&<optgroup label="その他">{otherStocks.map(function(s){return(<option key={s.ticker} value={s.ticker}>{s.ticker.replace(".T","")} {s.name}</option>);})}</optgroup>}</select><button onClick={run} disabled={!sel} style={{background:sel?"linear-gradient(135deg,#0ea5e9,#0369a1)":"#0a1828",border:"none",borderRadius:8,color:"#fff",padding:"12px",fontSize:12,fontWeight:700,cursor:sel?"pointer":"not-allowed",fontFamily:"monospace",width:"100%"}}>実行</button></div>
      {result&&(<div><div style={{display:"grid",gridTemplateColumns:"1fr 1fr auto",gap:8,marginBottom:14}}><div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:8,padding:"10px 12px"}}><div style={{fontSize:9,color:"#2a6090"}}>検証回数</div><div style={{fontSize:18,fontWeight:800,color:"#e0f0ff"}}>{result.total}回</div></div><div style={{background:parseFloat(result.winRate)>=50?"#052e16":"#1f0010",border:"1px solid "+(parseFloat(result.winRate)>=50?"#22d3a0":"#f43f5e"),borderRadius:8,padding:"10px 12px"}}><div style={{fontSize:9,color:"#2a6090"}}>勝率</div><div style={{fontSize:18,fontWeight:800,color:parseFloat(result.winRate)>=50?"#22d3a0":"#f43f5e"}}>{result.winRate}%</div></div><button onClick={function(){setResult(null);setSel("");}} style={{background:"transparent",border:"1px solid #2a3050",borderRadius:8,color:"#4a7090",padding:"8px 12px",fontSize:11,cursor:"pointer",fontFamily:"monospace"}}>戻る</button></div><div style={{display:"flex",flexDirection:"column",gap:6}}>{result.results.map(function(r,i){return(<div key={i} style={{background:"#050e1c",border:"1px solid "+(r.win?"#22d3a040":"#f43f5e40"),borderRadius:8,padding:"8px 12px",display:"flex",justifyContent:"space-between",alignItems:"center"}}><div style={{display:"flex",gap:12}}><span style={{fontSize:11,color:"#4a7090"}}>買 <span style={{color:"#b8cce0"}}>{r.buyPrice}</span></span><span style={{fontSize:11,color:"#4a7090"}}>売 <span style={{color:"#b8cce0"}}>{r.sellPrice}</span></span></div><span style={{fontSize:12,fontWeight:700,color:r.win?"#22d3a0":"#f43f5e"}}>{r.win?"+":""}{r.ret}%</span></div>);})}</div></div>)}
    </div>
  );
}

function IpoPanel(){
  var dataS=useState(null);var ipoData=dataS[0],setIpoData=dataS[1];
  var errS=useState(null);var err=errS[0],setErr=errS[1];
  var loadS=useState(true);var load=loadS[0],setLoad=loadS[1];

  useEffect(function(){
    fetch("https://daytrade-simulator.vercel.app/api/ipo")
      .then(function(r){return r.json();})
      .then(function(json){
        setIpoData(json.ipos||[]);
        setLoad(false);
      })
      .catch(function(e){
        setErr(e.message);
        setLoad(false);
      });
  },[]);

  var today=new Date();
  function daysUntil(d){return Math.ceil((new Date(d)-today)/(1000*60*60*24));}

  if(load) return(<div style={{textAlign:"center",padding:"60px",color:"#4a7090"}}><div style={{fontSize:24,marginBottom:12}}>🚀</div><div style={{fontSize:12}}>IPOデータ取得中...</div></div>);
  if(err) return(<div style={{textAlign:"center",padding:"60px",color:"#f43f5e"}}><div style={{fontSize:12}}>取得エラー: {err}</div></div>);
  if(!ipoData||ipoData.length===0) return(<div style={{textAlign:"center",padding:"60px",color:"#4a7090"}}><div style={{fontSize:24,marginBottom:12}}>🚀</div><div style={{fontSize:12}}>直近のIPOデータがありません</div></div>);

  return(
    <div>
      <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"10px 14px",marginBottom:12}}>
        <div style={{fontSize:11,fontWeight:700,color:"#e0f0ff"}}>🚀 IPO・新規上場 <span style={{fontSize:9,color:"#4a7090",fontWeight:400}}>直近6ヶ月〜3ヶ月先</span></div>
      </div>
      {ipoData.map(function(ipo){
        var days=daysUntil(ipo.listingDate);
        var dLabel=days<0?"上場済み":days===0?"本日上場！":"あと"+days+"日";
        var dColor=days<0?"#4a7090":days===0?"#22d3a0":days<=7?"#f43f5e":days<=30?"#fbbf24":"#4a90c0";
        var yahooUrl="https://finance.yahoo.co.jp/ipo/"+ipo.code;
        return(
          <div key={ipo.code} style={{background:"#050e1c",border:"1px solid "+(days===0?"#22d3a0":"#0f2040"),borderRadius:10,padding:"14px 16px",marginBottom:8}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12}}>
              <div style={{flex:1}}>
                <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap",marginBottom:6}}>
                  <span style={{fontSize:14,fontWeight:800,color:"#d8eeff"}}>{ipo.name}</span>
                  <span style={{fontSize:10,color:"#4a7090"}}>{ipo.code}</span>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8}}>
                  {[["上場日",ipo.listingDate],["市場",ipo.market],["セクター",ipo.sector]].map(function(row){
                    return(<div key={row[0]} style={{background:"#071428",borderRadius:6,padding:"5px 8px"}}>
                      <div style={{fontSize:9,color:"#2a6090"}}>{row[0]}</div>
                      <div style={{fontSize:11,fontWeight:700,color:"#b8cce0"}}>{row[1]}</div>
                    </div>);
                  })}
                </div>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <span style={{fontSize:12,fontWeight:700,color:dColor}}>{dLabel}</span>
                  <a href={yahooUrl} target="_blank" rel="noreferrer" style={{background:"#071428",border:"1px solid #3b82f6",borderRadius:6,color:"#93c5fd",padding:"4px 10px",fontSize:10,fontWeight:700,fontFamily:"monospace",textDecoration:"none"}}>Yahoo!</a>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function NewsPanel(){var NEWS=[{label:"株式ニュース",url:"https://finance.yahoo.co.jp/news",desc:"国内外の最新株式ニュース"},{label:"日本株ニュース",url:"https://finance.yahoo.co.jp/news/stocks",desc:"日本株関連ニュース"},{label:"米国株ニュース",url:"https://finance.yahoo.co.jp/news/world",desc:"米国株最新情報"},{label:"マーケット概況",url:"https://finance.yahoo.co.jp/stocks",desc:"日本株式市場の概況"}];return(<div style={{background:"#050e1c",border:"1px solid #0f2040",borderRadius:10,overflow:"hidden"}}><div style={{background:"#071428",borderBottom:"1px solid #0f2040",padding:"12px 16px"}}><div style={{fontSize:13,fontWeight:700,color:"#e0f0ff"}}>ニュース</div></div><div style={{padding:"8px"}}>{NEWS.map(function(item,i){return(<a key={i} href={item.url} target="_blank" rel="noreferrer" style={{display:"flex",flexDirection:"column",padding:"12px 14px",margin:"4px 0",background:"#071428",border:"1px solid #1e3050",borderRadius:8,textDecoration:"none",gap:4}}><span style={{fontSize:13,fontWeight:700,color:"#93c5fd"}}>{item.label}</span><span style={{fontSize:10,color:"#4a7090"}}>{item.desc}</span></a>);})}</div></div>);}
function TrendPanel(){var cs=useState(0);var openCat=cs[0],setOpenCat=cs[1];return(<div style={{background:"#050e1c",border:"1px solid #0f2040",borderRadius:10,overflow:"hidden"}}><div style={{background:"#071428",borderBottom:"1px solid #0f2040",padding:"10px 14px"}}><div style={{fontSize:12,fontWeight:700,color:"#e0f0ff"}}>トレンド・ランキング</div></div>{TREND_LINKS.map(function(cat,ci){var isOpen=openCat===ci;return(<div key={ci}><div onClick={function(){setOpenCat(isOpen?-1:ci);}} style={{padding:"10px 14px",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid #0a1828",background:isOpen?"#071a2e":"transparent"}}><span style={{fontSize:12,fontWeight:700,color:"#b8cce0"}}>{cat.category}</span><span style={{fontSize:10,color:"#2a6090"}}>{isOpen?"▲":"▼"}</span></div>{isOpen&&<div style={{background:"#040c18",borderBottom:"1px solid #0a1828"}}>{cat.links.map(function(link,li){return(<a key={li} href={link.url} target="_blank" rel="noreferrer" style={{display:"flex",alignItems:"center",padding:"9px 20px",borderBottom:"1px solid #0a1828",textDecoration:"none",gap:8}}><span style={{fontSize:10,color:"#22d3a0"}}>→</span><span style={{fontSize:12,color:"#93c5fd"}}>{link.label}</span></a>);})}</div>}</div>);})}</div>);}


// ── SyncPanel ─────────────────────────────────────────────────────────────────
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
      {/* 現在のデータ */}
      <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"14px 16px",marginBottom:14}}>
        <div style={{fontSize:12,fontWeight:700,color:"#e0f0ff",marginBottom:10}}>🔗 デバイス間同期</div>
        <div style={{display:"flex",gap:12,marginBottom:14}}>
          <div style={{background:"#050e1c",borderRadius:8,padding:"10px 16px"}}><div style={{fontSize:9,color:"#2a6090"}}>お気に入り</div><div style={{fontSize:18,fontWeight:800,color:"#fbbf24"}}>{favCount}銘柄</div></div>
          <div style={{background:"#050e1c",borderRadius:8,padding:"10px 16px"}}><div style={{fontSize:9,color:"#2a6090"}}>ポートフォリオ</div><div style={{fontSize:18,fontWeight:800,color:"#22d3a0"}}>{portCount}銘柄</div></div>
        </div>
        <div style={{fontSize:10,color:"#4a7090",marginBottom:8}}>あなたのデバイスID</div>
        <div style={{background:"#040c18",border:"1px solid #1e4070",borderRadius:8,padding:"10px 12px",fontFamily:"monospace",fontSize:13,color:"#b8cce0",wordBreak:"break-all",marginBottom:10}}>{userId}</div>
        <button onClick={copyId} style={{width:"100%",background:"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:8,color:"#fff",padding:"10px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"monospace",marginBottom:8}}>
          {copyStatus==="ok"?"✅ コピーしました！":"📋 IDをコピー"}
        </button>
        <a href="pushover://" style={{display:"block",width:"100%",background:"linear-gradient(135deg,#1a1a2e,#16213e)",border:"1px solid #4a4a8a",borderRadius:8,color:"#a0a0ff",padding:"10px",fontSize:12,fontWeight:700,fontFamily:"monospace",textDecoration:"none",textAlign:"center",boxSizing:"border-box"}}>
          📱 Pushoverを開く
        </a>
      </div>

      {/* 別デバイスから同期 */}
      <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"14px 16px",marginBottom:14}}>
        <div style={{fontSize:12,fontWeight:700,color:"#e0f0ff",marginBottom:4}}>別デバイスのIDで同期</div>
        <div style={{fontSize:10,color:"#4a7090",marginBottom:10}}>他のデバイスのIDを入力するとお気に入り・ポートフォリオが引き継がれます</div>
        <input
          style={{background:"#040c18",border:"1px solid #1e4070",borderRadius:6,color:"#b8cce0",padding:"10px 12px",fontSize:12,fontFamily:"monospace",width:"100%",boxSizing:"border-box",marginBottom:10}}
          value={input} placeholder="別デバイスのIDを貼り付け"
          onChange={function(e){setInput(e.target.value);}}
        />
        <button onClick={syncById} disabled={!input.trim()||syncStatus==="loading"}
          style={{width:"100%",background:input.trim()?"linear-gradient(135deg,#22d3a0,#059669)":"#0a1828",border:"none",borderRadius:8,color:"#fff",padding:"10px",fontSize:12,fontWeight:700,cursor:input.trim()?"pointer":"not-allowed",fontFamily:"monospace"}}>
          {syncStatus==="loading"?"同期中...":syncStatus==="ok"?"✅ 同期完了！":syncStatus==="error"?"❌ IDが見つかりません":"このIDで同期する"}
        </button>
      </div>

      {/* 使い方 */}
      <div style={{background:"#050e1c",border:"1px solid #0f2040",borderRadius:10,padding:"14px 16px"}}>
        <div style={{fontSize:11,fontWeight:700,color:"#4a90c0",marginBottom:10}}>使い方</div>
        {[["1","iPadで「IDをコピー」をタップ"],["2","iPhoneのDaySimulatorを開く"],["3","🔗タブ → IDを貼り付けて「同期」"],["4","お気に入り・ポートフォリオが反映される"]].map(function(row){
          return(<div key={row[0]} style={{display:"flex",gap:10,marginBottom:8,alignItems:"flex-start"}}>
            <span style={{background:"#0ea5e9",color:"#fff",borderRadius:"50%",width:18,height:18,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:700,flexShrink:0}}>{row[0]}</span>
            <span style={{fontSize:11,color:"#b8cce0"}}>{row[1]}</span>
          </div>);
        })}
        <div style={{fontSize:9,color:"#2a6060",marginTop:8}}>※ お気に入り登録・変更時に自動でサーバーに保存されます</div>
      </div>
    </div>
  );
}

export default function App(){
  var a=useState([]);var stocks=a[0],setStocks=a[1];
  var b=useState(false);var loading=b[0],setLoading=b[1];
  var c=useState({done:0,total:0,msg:null});var progress=c[0],setProgress=c[1];
  var g=useState(null);var ts=g[0],setTs=g[1];
  var k=useState("cross");var activeTab=k[0],setActiveTab=k[1];
  // ユーザーID（初回自動生成）
  var userId=(function(){try{var id=localStorage.getItem("daytrade_uid");if(!id){id="u_"+Math.random().toString(36).slice(2,10);localStorage.setItem("daytrade_uid",id);}return id;}catch(e){return"u_default";}})();
  var SYNC_API="https://daytrade-simulator.vercel.app/api/sync";

  var favInit=(function(){try{var v=localStorage.getItem("fav_tickers");return v?JSON.parse(v):[];}catch(e){return[];}})();
  var fvS=useState(favInit);var favs=fvS[0],setFavs=fvS[1];

  var NOTIFY_API="https://daytrade-simulator.vercel.app/api/notify";

  function toggleFav(ticker){setFavs(function(prev){
    var isAdding=prev.indexOf(ticker)<0;
    var next=isAdding?prev.concat([ticker]):prev.filter(function(t){return t!==ticker;});
    try{localStorage.setItem("fav_tickers",JSON.stringify(next));}catch(e){}
    // サーバー同期
    var port=(function(){try{return JSON.parse(localStorage.getItem("portfolio_v1")||"[]");}catch(e){return[];}})();
    fetch(SYNC_API+"?userId="+userId,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({favs:next,portfolio:port})}).catch(function(){});
    // Pushover通知（デバイスIDを送信）
    if(isAdding){
      fetch(NOTIFY_API,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:"DaySimulator 同期ID",message:userId})}).catch(function(){});
    }
    return next;
  });}
  function isFav(ticker){return favs.indexOf(ticker)>=0;}

  var scan=useCallback(async function(){
    setLoading(true);
    setProgress({done:0,total:0,msg:"出来高ランキング取得中..."});
    var universe=(await buildStockUniverse()).slice();
    var favList=(function(){try{var v=localStorage.getItem("fav_tickers");return v?JSON.parse(v):[];}catch(e){return[];}})();
    var uTickers=universe.map(function(s){return s.ticker;});
    favList.forEach(function(ticker){if(uTickers.indexOf(ticker)<0){var isJP=ticker.endsWith(".T"),code=ticker.replace(".T","");universe.push({ticker:ticker,name:code,market:isJP?"JP":"US",tvSymbol:(isJP?"TSE:":"NASDAQ:")+code});}});
    setProgress({done:0,total:universe.length,msg:null});
    var results=[],BATCH=6;
    for(var i=0;i<universe.length;i+=BATCH){
      var batch=universe.slice(i,i+BATCH);
      await Promise.all(batch.map(async function(stock){
        var pd;try{pd=await fetchYahoo(stock.ticker);}catch(err){pd=genSim(stock.ticker);}
        results.push(analyzeStock(stock,pd));
        setProgress(function(p){return{done:p.done+1,total:p.total,msg:null};});
      }));
      if(i+BATCH<universe.length)await new Promise(function(r){setTimeout(r,300);});
    }
    results.sort(function(x,y){return y.score-x.score;});
    setStocks(results);
    setTs(new Date().toLocaleTimeString("ja-JP"));
    setLoading(false);
  },[]);

  // 起動時: サーバーからデータ取得 → スキャン
  useEffect(function(){
    fetch(SYNC_API+"?userId="+userId)
      .then(function(r){return r.json();})
      .then(function(data){
        if(data.favs&&data.favs.length>0){
          setFavs(data.favs.slice());
          try{localStorage.setItem("fav_tickers",JSON.stringify(data.favs));}catch(e){}
        }
        if(data.portfolio&&data.portfolio.length>0){
          try{localStorage.setItem("portfolio_v1",JSON.stringify(data.portfolio));}catch(e){}
        }
      })
      .catch(function(){})
      .finally(function(){scan();});
  },[]);

  var TABS=[["cross","✨"],["fav","⭐"],["portfolio","💼"],["backtest","📈"],["news","📰"],["trend","🔥"],["sync","🔗"]];
  var TAB_LABELS={"cross":"クロス予測","fav":"お気に入り","portfolio":"ポートフォリオ","backtest":"バックテスト","news":"ニュース","trend":"トレンド","sync":"デバイス同期"};

  return(
    <div style={{minHeight:"100vh",background:"#040c18",fontFamily:"monospace",color:"#b8cce0",display:"flex"}}>
      <div style={{width:50,background:"#050f20",borderRight:"1px solid #0f2040",display:"flex",flexDirection:"column",alignItems:"center",paddingTop:10,gap:4,flexShrink:0,position:"sticky",top:0,height:"100vh",overflowY:"auto"}}>
        {TABS.map(function(tab){var active=activeTab===tab[0];return(<button key={tab[0]} onClick={function(){setActiveTab(tab[0]);}} title={TAB_LABELS[tab[0]]} style={{width:40,height:40,background:active?"#0ea5e9":"transparent",border:"1px solid "+(active?"#0ea5e9":"transparent"),borderRadius:8,color:active?"#fff":"#4a6080",fontSize:17,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>{tab[1]}</button>);})}
      </div>
      <div style={{flex:1,display:"flex",flexDirection:"column",minWidth:0}}>
        <div style={{background:"linear-gradient(180deg,#071428,#050f20)",borderBottom:"1px solid #0f2040",padding:"8px 12px",position:"sticky",top:0,zIndex:10}}>
          <div style={{fontSize:14,fontWeight:800,color:"#e0f0ff"}}>
            DaySimulator <span style={{fontSize:10,color:"#4a7090",fontWeight:400}}>/ {TAB_LABELS[activeTab]}</span>
          </div>
        </div>
        <div style={{flex:1,padding:"10px 10px 60px",overflowY:"auto"}}>
          {activeTab==="cross"&&<CrossPanel stocks={stocks} loading={loading} onScan={scan} toggleFav={toggleFav} favs={favs} ts={ts} progress={progress}/>}
          {activeTab==="fav"&&<FavPanel stocks={stocks} favs={favs} toggleFav={toggleFav}/>}
          {activeTab==="portfolio"&&<PortfolioPanel stocks={stocks}/>}
          {activeTab==="backtest"&&<BacktestPanel stocks={stocks} favs={favs}/>}
          {activeTab==="news"&&<NewsPanel/>}
          {activeTab==="trend"&&<TrendPanel/>}
          {activeTab==="sync"&&<SyncPanel userId={userId} syncApi={SYNC_API} setFavs={setFavs} scan={scan}/>}
        </div>
      </div>
    </div>
  );
}
