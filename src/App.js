import { useState, useCallback, useEffect } from "react";

var STOCK_UNIVERSE = [
  { ticker:"AAPL",  tvSymbol:"NASDAQ:AAPL",  name:"Apple",          market:"US" },
  { ticker:"MSFT",  tvSymbol:"NASDAQ:MSFT",  name:"Microsoft",      market:"US" },
  { ticker:"NVDA",  tvSymbol:"NASDAQ:NVDA",  name:"NVIDIA",         market:"US" },
  { ticker:"AMZN",  tvSymbol:"NASDAQ:AMZN",  name:"Amazon",         market:"US" },
  { ticker:"GOOGL", tvSymbol:"NASDAQ:GOOGL", name:"Alphabet A",     market:"US" },
  { ticker:"META",  tvSymbol:"NASDAQ:META",  name:"Meta",           market:"US" },
  { ticker:"TSLA",  tvSymbol:"NASDAQ:TSLA",  name:"Tesla",          market:"US" },
  { ticker:"BRK-B", tvSymbol:"NYSE:BRK.B",   name:"Berkshire B",    market:"US" },
  { ticker:"JPM",   tvSymbol:"NYSE:JPM",     name:"JPMorgan",       market:"US" },
  { ticker:"V",     tvSymbol:"NYSE:V",       name:"Visa",           market:"US" },
  { ticker:"UNH",   tvSymbol:"NYSE:UNH",     name:"UnitedHealth",   market:"US" },
  { ticker:"XOM",   tvSymbol:"NYSE:XOM",     name:"ExxonMobil",     market:"US" },
  { ticker:"MA",    tvSymbol:"NYSE:MA",      name:"Mastercard",     market:"US" },
  { ticker:"LLY",   tvSymbol:"NYSE:LLY",     name:"Eli Lilly",      market:"US" },
  { ticker:"AVGO",  tvSymbol:"NASDAQ:AVGO",  name:"Broadcom",       market:"US" },
  { ticker:"PG",    tvSymbol:"NYSE:PG",      name:"P&G",            market:"US" },
  { ticker:"JNJ",   tvSymbol:"NYSE:JNJ",     name:"J&J",            market:"US" },
  { ticker:"HD",    tvSymbol:"NYSE:HD",      name:"Home Depot",     market:"US" },
  { ticker:"COST",  tvSymbol:"NASDAQ:COST",  name:"Costco",         market:"US" },
  { ticker:"ABBV",  tvSymbol:"NYSE:ABBV",    name:"AbbVie",         market:"US" },
  { ticker:"NFLX",  tvSymbol:"NASDAQ:NFLX",  name:"Netflix",        market:"US" },
  { ticker:"AMD",   tvSymbol:"NASDAQ:AMD",   name:"AMD",            market:"US" },
  { ticker:"CRM",   tvSymbol:"NYSE:CRM",     name:"Salesforce",     market:"US" },
  { ticker:"ADBE",  tvSymbol:"NASDAQ:ADBE",  name:"Adobe",          market:"US" },
  { ticker:"WMT",   tvSymbol:"NYSE:WMT",     name:"Walmart",        market:"US" },
  { ticker:"BAC",   tvSymbol:"NYSE:BAC",     name:"Bank of America",market:"US" },
  { ticker:"KO",    tvSymbol:"NYSE:KO",      name:"Coca-Cola",      market:"US" },
  { ticker:"PEP",   tvSymbol:"NASDAQ:PEP",   name:"PepsiCo",        market:"US" },
  { ticker:"TMO",   tvSymbol:"NYSE:TMO",     name:"Thermo Fisher",  market:"US" },
  { ticker:"ACN",   tvSymbol:"NYSE:ACN",     name:"Accenture",      market:"US" },
  { ticker:"INTC",  tvSymbol:"NASDAQ:INTC",  name:"Intel",          market:"US" },
  { ticker:"DIS",   tvSymbol:"NYSE:DIS",     name:"Disney",         market:"US" },
  { ticker:"PYPL",  tvSymbol:"NASDAQ:PYPL",  name:"PayPal",         market:"US" },
  { ticker:"UBER",  tvSymbol:"NYSE:UBER",    name:"Uber",           market:"US" },
  { ticker:"ABNB",  tvSymbol:"NASDAQ:ABNB",  name:"Airbnb",         market:"US" },
  { ticker:"7203.T",tvSymbol:"TSE:7203", name:"トヨタ自動車",       market:"JP" },
  { ticker:"6758.T",tvSymbol:"TSE:6758", name:"ソニーグループ",     market:"JP" },
  { ticker:"8306.T",tvSymbol:"TSE:8306", name:"三菱UFJ",            market:"JP" },
  { ticker:"9984.T",tvSymbol:"TSE:9984", name:"ソフトバンクG",      market:"JP" },
  { ticker:"6861.T",tvSymbol:"TSE:6861", name:"キーエンス",         market:"JP" },
  { ticker:"7974.T",tvSymbol:"TSE:7974", name:"任天堂",             market:"JP" },
  { ticker:"8035.T",tvSymbol:"TSE:8035", name:"東京エレクトロン",   market:"JP" },
  { ticker:"9432.T",tvSymbol:"TSE:9432", name:"NTT",                market:"JP" },
  { ticker:"4063.T",tvSymbol:"TSE:4063", name:"信越化学",           market:"JP" },
  { ticker:"6367.T",tvSymbol:"TSE:6367", name:"ダイキン工業",       market:"JP" },
  { ticker:"PLTR",  tvSymbol:"NASDAQ:PLTR",  name:"Palantir",       market:"US" },
  { ticker:"F",     tvSymbol:"NYSE:F",       name:"Ford",           market:"US" },
  { ticker:"SOFI",  tvSymbol:"NASDAQ:SOFI",  name:"SoFi",           market:"US" },
  { ticker:"NIO",   tvSymbol:"NYSE:NIO",     name:"NIO",            market:"US" },
  { ticker:"RIVN",  tvSymbol:"NASDAQ:RIVN",  name:"Rivian",         market:"US" },
];

var BADGE = {
  BUY:   { bg:"#052e16", border:"#22d3a0", text:"#22d3a0", label:"買い"   },
  WATCH: { bg:"#1c1400", border:"#fbbf24", text:"#fbbf24", label:"様子見" },
  SKIP:  { bg:"#1f0010", border:"#f43f5e", text:"#f43f5e", label:"見送り" },
};
var MKT = {
  US: { bg:"#0a1e3a", border:"#3b82f6", text:"#93c5fd", label:"🇺🇸" },
  JP: { bg:"#1a0a0a", border:"#f87171", text:"#fca5a5", label:"🇯🇵" },
};
var TV_INTERVALS = [
  { label:"5分足",   value:"5"  },
  { label:"15分足",  value:"15" },
  { label:"1時間足", value:"60" },
  { label:"日足",    value:"D"  },
];

function scoreColor(n) { return n>=68?"#22d3a0":n>=42?"#fbbf24":"#f43f5e"; }
function bStyle(bg,border,text){ return{background:bg,border:"1px solid "+border,color:text,fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:4}; }

// ── Cache ─────────────────────────────────────────────────────────────────────
var CACHE = {};
var CACHE_TTL = 15*60*1000;

var VERCEL_API  = "https://daytrade-simulator.vercel.app/api/stock";
var RANKING_API = "https://daytrade-simulator.vercel.app/api/ranking";

async function fetchRanking(market) {
  try {
    var res = await fetch(RANKING_API+"?market="+market, { signal:AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error("ranking "+res.status);
    var json = await res.json();
    var stocks = (json.stocks||[]).map(function(s){ return{ticker:s.ticker,name:s.name,market:s.market,tvSymbol:s.tvSymbol}; });
    return stocks.length > 0 ? stocks : null;
  } catch(e) { return null; }
}

async function buildStockUniverse() {
  var results = await Promise.all([fetchRanking("us"), fetchRanking("jp")]);
  var us = results[0] || STOCK_UNIVERSE.filter(function(s){ return s.market==="US"; });
  var jp = results[1] || STOCK_UNIVERSE.filter(function(s){ return s.market==="JP"; });
  var seen={}, out=[];
  us.slice(0,50).concat(jp.slice(0,50)).forEach(function(s){
    if(!seen[s.ticker]){ seen[s.ticker]=true; out.push(s); }
  });
  return out;
}

async function fetchYahoo(ticker) {
  var now = Date.now();
  if (CACHE[ticker] && now-CACHE[ticker].ts < CACHE_TTL) {
    var cached = CACHE[ticker].data;
    return { closes:cached.closes.slice(), highs:cached.highs.slice(), lows:cached.lows.slice(), currentPrice:cached.currentPrice, previousClose:cached.previousClose, real:cached.real };
  }
  var res = await fetch(VERCEL_API+"?ticker="+encodeURIComponent(ticker), { signal:AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error("HTTP "+res.status);
  var json = await res.json();
  var result = json&&json.chart&&json.chart.result&&json.chart.result[0];
  if (!result) throw new Error("empty");
  var q=result.indicators.quote[0], meta=result.meta;
  function fill(arr){ var out=(arr||[]).slice(); for(var j=0;j<out.length;j++) if(out[j]==null) out[j]=j>0?out[j-1]:0; return out; }
  var data = { closes:fill(q.close), highs:fill(q.high), lows:fill(q.low), currentPrice:meta.regularMarketPrice||fill(q.close).slice(-1)[0], previousClose:meta.chartPreviousClose||0, real:true };
  CACHE[ticker] = { ts:now, data:data };
  return { closes:data.closes.slice(), highs:data.highs.slice(), lows:data.lows.slice(), currentPrice:data.currentPrice, previousClose:data.previousClose, real:data.real };
}

function genSim(ticker) {
  var h=0; for(var i=0;i<ticker.length;i++) h=(Math.imul(31,h)+ticker.charCodeAt(i))|0;
  var s=Math.abs(h); function rng(){ s=(s*1664525+1013904223)&0x7fffffff; return s/0x7fffffff; }
  var price=rng()*400+60, closes=[], highs=[], lows=[];
  for(var d=0;d<63;d++){ var v=rng()*0.025; price=Math.max(5,price*(1+rng()*0.006-0.003+(rng()-0.5)*v)); closes.push(price); highs.push(price*(1+rng()*0.008)); lows.push(price*(1-rng()*0.008)); }
  return { closes:closes,highs:highs,lows:lows,currentPrice:price,previousClose:closes[closes.length-2],real:false };
}

// ── Indicators ────────────────────────────────────────────────────────────────
function calcSMA(arr,p){ return arr.map(function(_,i){ if(i<p-1) return null; var s=0; for(var j=i-p+1;j<=i;j++) s+=arr[j]; return s/p; }); }
function calcEMA(arr,p){ var k=2/(p+1),out=[arr[0]]; for(var i=1;i<arr.length;i++) out.push(arr[i]*k+out[i-1]*(1-k)); return out; }
function calcMACD(arr){ var e12=calcEMA(arr,12),e26=calcEMA(arr,26),ml=e12.map(function(v,i){return v-e26[i];}),sig=calcEMA(ml,9); return ml.map(function(v,i){return{hist:v-sig[i]};}); }
function calcRSI(arr){ var p=14,out=[]; for(var x=0;x<p;x++) out.push(null); var ag=0,al=0; for(var i=1;i<=p;i++){var diff2=arr[i]-arr[i-1];if(diff2>=0)ag+=diff2;else al-=diff2;} ag/=p;al/=p; out.push(100-100/(1+ag/(al||1e-9))); for(var j=p+1;j<arr.length;j++){var diff=arr[j]-arr[j-1];ag=(ag*(p-1)+Math.max(diff,0))/p;al=(al*(p-1)+Math.max(-diff,0))/p;out.push(100-100/(1+ag/(al||1e-9)));} return out; }
function calcBoll(arr){ var p=20,k=2; return arr.map(function(_,i){ if(i<p-1) return null; var bl=arr.slice(i-p+1,i+1),m=bl.reduce(function(a,b){return a+b;})/p,sd=Math.sqrt(bl.reduce(function(a,b){return a+(b-m)*(b-m);},0)/p); return{upper:m+k*sd,lower:m-k*sd}; }); }
function calcStoch(closes,highs,lows){ var p=14; return closes.map(function(_,i){ if(i<p-1) return null; var hi=Math.max.apply(null,highs.slice(i-p+1,i+1)),lo=Math.min.apply(null,lows.slice(i-p+1,i+1)); if(lo===hi) return 50; return((closes[i]-lo)/(hi-lo))*100; }); }

// ── Backtest ──────────────────────────────────────────────────────────────────
function runBacktest(closes) {
  var results=[], wins=0, total=0;
  for(var i=26; i<closes.length-5; i++){
    var slice=closes.slice(0,i+1);
    var macd=calcMACD(slice);
    var mn=macd[i], mp=macd[i-1];
    if(mn&&mp&&mn.hist>0&&mp.hist<=0){
      var buyPrice=closes[i];
      var sellPrice=closes[Math.min(i+5,closes.length-1)];
      var ret=(sellPrice-buyPrice)/buyPrice*100;
      total++; if(ret>0) wins++;
      results.push({ buyPrice:buyPrice.toFixed(2), sellPrice:sellPrice.toFixed(2), ret:ret.toFixed(2), win:ret>0 });
    }
  }
  return { results:results.slice(-10), winRate:total>0?(wins/total*100).toFixed(1):"0", total:total };
}

function analyzeStock(stock, pd) {
  var closes = pd.closes.slice(); // readonly対策
  var highs  = pd.highs.slice();
  var lows   = pd.lows.slice();
  var n=closes.length-1;
  var s20=calcSMA(closes,20)[n],s50=calcSMA(closes,50)[n];
  var macdArr=calcMACD(closes),rsiVal=calcRSI(closes)[n];
  var bollVal=calcBoll(closes)[n],stochVal=calcStoch(closes,highs,lows)[n];
  var mNow=macdArr[n],mPrev=macdArr[n-1],price=pd.currentPrice||closes[n];
  var sc=0,signals=[];
  if(s20&&s50){ if(price>s20&&s20>s50){sc+=20;signals.push({label:"トレンド",val:"上昇トレンド",state:1});}else if(price<s20&&s20<s50){signals.push({label:"トレンド",val:"下降トレンド",state:-1});}else{sc+=8;signals.push({label:"トレンド",val:"横ばい",state:0});} }
  if(mNow.hist>0&&mPrev&&mPrev.hist<=0){sc+=25;signals.push({label:"MACD",val:"ゴールデンクロス",state:1});}else if(mNow.hist>0){sc+=14;signals.push({label:"MACD",val:"強気ゾーン",state:1});}else if(mNow.hist<0&&mPrev&&mPrev.hist>=0){signals.push({label:"MACD",val:"デッドクロス",state:-1});}else{signals.push({label:"MACD",val:"弱気ゾーン",state:-1});}
  var rl="RSI("+rsiVal.toFixed(1)+")";
  if(rsiVal<30){sc+=20;signals.push({label:rl,val:"売られすぎ",state:1});}else if(rsiVal<45){sc+=12;signals.push({label:rl,val:"やや弱め",state:0});}else if(rsiVal>70){signals.push({label:rl,val:"買われすぎ",state:-1});}else{sc+=10;signals.push({label:rl,val:"中立",state:0});}
  if(bollVal){ if(price<=bollVal.lower){sc+=20;signals.push({label:"BB",val:"下限→反発",state:1});}else if(price>=bollVal.upper){signals.push({label:"BB",val:"上限→過熱",state:-1});}else{sc+=8;signals.push({label:"BB",val:"バンド内",state:0});} }
  if(stochVal!==null){ var sl="Stoch("+stochVal.toFixed(1)+")"; if(stochVal<20){sc+=15;signals.push({label:sl,val:"売られすぎ",state:1});}else if(stochVal>80){signals.push({label:sl,val:"買われすぎ",state:-1});}else{sc+=6;signals.push({label:sl,val:"中立",state:0});} }
  var winRate=Math.min(88,Math.max(28,sc*0.72));
  var expVal=(winRate/100*2.5-(1-winRate/100)*1.5).toFixed(2);
  var timing=sc>=68?"BUY":sc>=42?"WATCH":"SKIP";
  var change=pd.previousClose?((price-pd.previousClose)/pd.previousClose*100).toFixed(2):"0.00";
  var dispPrice=stock.market==="JP"?"¥"+Math.round(price).toLocaleString():"$"+price.toFixed(2);
  return { ticker:stock.ticker,tvSymbol:stock.tvSymbol,name:stock.name,market:stock.market,
    price:dispPrice,rawPrice:price,score:sc,winRate:winRate.toFixed(1),expVal:expVal,
    timing:timing,signals:signals,change:change,spark:closes.slice(-20),
    real:pd.real,closes:closes,yahooUrl:"https://finance.yahoo.co.jp/quote/"+stock.ticker };
}

// ── UI Parts ──────────────────────────────────────────────────────────────────
function Sparkline(p){
  var data=p.data,up=p.up;
  if(!data||data.length<2) return null;
  var W=72,H=26,mn=Math.min.apply(null,data),mx=Math.max.apply(null,data),rng=mx-mn||1;
  var pts=data.map(function(v,i){return(i/(data.length-1))*W+","+(H-((v-mn)/rng)*(H-2)-1);}).join(" ");
  return<svg width={W} height={H}><polyline points={pts} fill="none" stroke={up?"#22d3a0":"#f43f5e"} strokeWidth={1.5} strokeLinejoin="round"/></svg>;
}

function ScoreRing(p){ var sc=p.score,R=20,C=2*Math.PI*R,col=scoreColor(sc); return(<svg width={48} height={48} style={{flexShrink:0}}><circle cx={24} cy={24} r={R} fill="none" stroke="#1e3050" strokeWidth={4.5}/><circle cx={24} cy={24} r={R} fill="none" stroke={col} strokeWidth={4.5} strokeDasharray={C} strokeDashoffset={C-(sc/100)*C} strokeLinecap="round" transform="rotate(-90 24 24)"/><text x={24} y={29} textAnchor="middle" fill={col} style={{fontSize:10,fontWeight:800,fontFamily:"monospace"}}>{sc}</text></svg>); }

function TabBtn(p){ return(<button onClick={p.onClick} style={{background:p.active?p.color+"18":"transparent",border:"1px solid "+(p.active?p.color:"#1e3050"),borderRadius:6,color:p.active?p.color:"#4a6080",padding:"5px 14px",fontSize:11,cursor:"pointer",fontFamily:"monospace",fontWeight:p.active?700:400}}>{p.label}</button>); }

// ── Chart Modal ───────────────────────────────────────────────────────────────
function ChartModal(p) {
  var stock=p.stock,onClose=p.onClose;
  if(!stock) return null;
  var bc=BADGE[stock.timing],isUp=parseFloat(stock.change)>=0;
  var tvUrl="https://www.tradingview.com/chart/?symbol="+encodeURIComponent(stock.tvSymbol)+"&interval=D";
  return(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:200,background:"#040c18",display:"flex",flexDirection:"column"}}>
      <div style={{background:"#071428",borderBottom:"1px solid #1e4070",padding:"10px 14px",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",flexShrink:0}}>
        <button onClick={onClose} style={{background:"#1f0010",border:"1px solid #f43f5e",borderRadius:6,color:"#f43f5e",padding:"4px 14px",fontSize:11,cursor:"pointer",fontFamily:"monospace"}}>✕ 閉じる</button>
        <span style={{fontSize:15,fontWeight:800,color:"#e0f0ff"}}>{stock.ticker.replace(".T","")}</span>
        <span style={{fontSize:11,color:"#4a7090"}}>{stock.name}</span>
        <span style={{fontSize:11,fontWeight:700,color:bc.text}}>{stock.timing==="BUY"?"✅ 買い":stock.timing==="WATCH"?"👁 様子見":"⛔ 見送り"}</span>
      </div>
      <div style={{background:"#050f20",borderBottom:"1px solid #0f2040",padding:"8px 14px",display:"flex",gap:18,flexWrap:"wrap",flexShrink:0}}>
        {[["スコア",stock.score+"/100",scoreColor(stock.score)],["勝率",stock.winRate+"%","#22d3a0"],["期待値",stock.expVal+"%",parseFloat(stock.expVal)>=0?"#22d3a0":"#f43f5e"],["現在値",stock.price,"#b8cce0"],["前日比",(isUp?"▲":"▼")+" "+Math.abs(stock.change)+"%",isUp?"#22d3a0":"#f43f5e"]].map(function(item){
          return(<div key={item[0]}><div style={{fontSize:9,color:"#2a6090"}}>{item[0]}</div><div style={{fontSize:13,fontWeight:700,color:item[2]}}>{item[1]}</div></div>);
        })}
      </div>
      <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"#050f20",gap:16,padding:24}}>
        <div style={{fontSize:36}}>📈</div>
        <div style={{fontSize:14,fontWeight:700,color:"#e0f0ff"}}>{stock.ticker.replace(".T","")} · {stock.name}</div>
        <a href={tvUrl} target="_blank" rel="noreferrer" style={{background:"linear-gradient(135deg,#0d2d4a,#0369a1)",border:"1px solid #0ea5e9",borderRadius:8,color:"#fff",padding:"14px 32px",fontSize:13,fontWeight:700,fontFamily:"monospace",textDecoration:"none",display:"inline-block"}}>📊 日足チャートで開く</a>
        <a href={stock.yahooUrl} target="_blank" rel="noreferrer" style={{background:"#071428",border:"1px solid #3b82f6",borderRadius:8,color:"#93c5fd",padding:"10px 20px",fontSize:12,fontWeight:700,fontFamily:"monospace",textDecoration:"none"}}>🔗 Yahoo!ファイナンスで見る</a>
        <div style={{fontSize:9,color:"#1a3050"}}>TradingView（無料・登録不要）</div>
      </div>
      <div style={{background:"#050f20",borderTop:"1px solid #0f2040",padding:"8px 14px",display:"flex",gap:6,flexWrap:"wrap",flexShrink:0}}>
        {stock.signals.map(function(sig){ var c=sig.state===1?"#22d3a0":sig.state===-1?"#f43f5e":"#94a3b8"; return(<div key={sig.label} style={{background:"#071428",border:"1px solid "+c+"30",borderRadius:5,padding:"3px 8px"}}><span style={{fontSize:9,color:"#2a6090"}}>{sig.label}: </span><span style={{fontSize:9,fontWeight:700,color:c}}>{sig.val}</span></div>); })}
      </div>
    </div>
  );
}

// ── Portfolio Panel ───────────────────────────────────────────────────────────
function PortfolioPanel(p) {
  var stocks = p.stocks;
  var initPort = (function(){ try{ var v=localStorage.getItem("portfolio_v1"); return v?JSON.parse(v):[]; }catch(e){ return []; } })();
  var portS=useState(initPort); var portfolio=portS[0],setPortfolio=portS[1];
  var tabS=useState("list"); var ptab=tabS[0],setPtab=tabS[1];
  var formS=useState({ticker:"",name:"",buyPrice:"",shares:"",stopLoss:"",target:"",market:"US"});
  var form=formS[0],setForm=formS[1];
  var editS=useState(null); var editId=editS[0],setEditId=editS[1];
  var editFormS=useState(null); var editForm=editFormS[0],setEditForm=editFormS[1];

  function savePort(next){
    setPortfolio(next);
    try{ localStorage.setItem("portfolio_v1",JSON.stringify(next)); }catch(e){}
    var favs=(function(){try{return JSON.parse(localStorage.getItem("fav_tickers")||"[]");}catch(e){return[];}})();
    var uid=(function(){try{return localStorage.getItem("daytrade_user_id")||"u_default";}catch(e){return"u_default";}})();
    fetch("https://daytrade-simulator.vercel.app/api/sync?userId="+uid,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({favs:favs,portfolio:next})}).catch(function(){});
  }

  function addPosition() {
    if(!form.ticker||!form.buyPrice||!form.shares) return;
    var pos = { id:Date.now(), ticker:form.ticker.toUpperCase(), name:form.name||form.ticker.toUpperCase(), market:form.market, buyPrice:parseFloat(form.buyPrice), shares:parseFloat(form.shares), stopLoss:form.stopLoss?parseFloat(form.stopLoss):null, target:form.target?parseFloat(form.target):null, addedAt:new Date().toLocaleDateString("ja-JP") };
    savePort(portfolio.concat([pos]));
    setForm({ticker:"",name:"",buyPrice:"",shares:"",stopLoss:"",target:"",market:"US"});
    setPtab("list");
  }

  function removePos(id){ savePort(portfolio.filter(function(p){ return p.id!==id; })); }

  function startEdit(pos) {
    setEditId(pos.id);
    setEditForm({ buyPrice:String(pos.buyPrice), shares:String(pos.shares), stopLoss:pos.stopLoss?String(pos.stopLoss):"", target:pos.target?String(pos.target):"" });
  }

  function saveEdit(id) {
    if(!editForm.buyPrice||!editForm.shares) return;
    savePort(portfolio.map(function(pos){
      if(pos.id!==id) return pos;
      return Object.assign({},pos,{ buyPrice:parseFloat(editForm.buyPrice), shares:parseFloat(editForm.shares), stopLoss:editForm.stopLoss?parseFloat(editForm.stopLoss):null, target:editForm.target?parseFloat(editForm.target):null });
    }));
    setEditId(null); setEditForm(null);
  }

  function getCurrentPrice(ticker) {
    var found = stocks.find(function(s){ return s.ticker===ticker; });
    return found ? found.rawPrice : null;
  }

  var totalPnL = portfolio.reduce(function(sum,pos){
    var cur=getCurrentPrice(pos.ticker);
    return sum + (cur ? (cur-pos.buyPrice)*pos.shares : 0);
  }, 0);

  var inpStyle = {background:"#071428",border:"1px solid #1e3050",borderRadius:6,color:"#b8cce0",padding:"8px 10px",fontSize:12,fontFamily:"monospace",width:"100%",boxSizing:"border-box"};
  var inpStyleSm = {background:"#040c18",border:"1px solid #1e4070",borderRadius:6,color:"#b8cce0",padding:"6px 8px",fontSize:11,fontFamily:"monospace",width:"100%",boxSizing:"border-box"};

  return(
    <div>
      <div style={{display:"flex",gap:6,marginBottom:14}}>
        <TabBtn label="保有銘柄" active={ptab==="list"} onClick={function(){setPtab("list");}} color="#22d3a0"/>
        <TabBtn label="➕ 追加" active={ptab==="add"} onClick={function(){setPtab("add");}} color="#0ea5e9"/>
      </div>

      {ptab==="add"&&(
        <div style={{background:"#050e1c",border:"1px solid #1e3050",borderRadius:10,padding:16,marginBottom:16}}>
          <div style={{fontSize:12,fontWeight:700,color:"#e0f0ff",marginBottom:12}}>📝 ポジション追加</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
            {[["ティッカー *","ticker","AAPL / 7203.T","text"],["銘柄名","name","Apple","text"],["買値 *","buyPrice","150.00","number"],["株数 *","shares","100","number"],["損切りライン","stopLoss","140.00","number"],["目標価格","target","180.00","number"]].map(function(row){
              return(
                <div key={row[0]}>
                  <div style={{fontSize:9,color:"#2a6090",marginBottom:3}}>{row[0]}</div>
                  <input style={inpStyle} type={row[3]} value={form[row[1]]} placeholder={row[2]} onChange={function(e){ var up={}; up[row[1]]=e.target.value; setForm(Object.assign({},form,up)); }}/>
                </div>
              );
            })}
          </div>
          <div style={{display:"flex",gap:6,marginBottom:12}}>
            {["US","JP"].map(function(m){ return(<button key={m} onClick={function(){setForm(Object.assign({},form,{market:m}));}} style={{background:form.market===m?"#0ea5e9":"#071428",border:"1px solid "+(form.market===m?"#0ea5e9":"#1e3050"),borderRadius:6,color:form.market===m?"#fff":"#4a7090",padding:"5px 16px",fontSize:11,cursor:"pointer",fontFamily:"monospace"}}>{m==="US"?"🇺🇸 米国":"🇯🇵 日本"}</button>); })}
          </div>
          <button onClick={addPosition} style={{width:"100%",background:"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:8,color:"#fff",padding:"10px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>追加する</button>
        </div>
      )}

      {ptab==="list"&&(
        portfolio.length===0?(
          <div style={{textAlign:"center",padding:"60px 20px",color:"#2a6090"}}>
            <div style={{fontSize:36,marginBottom:12}}>📊</div>
            <div style={{fontSize:13,color:"#4a90c0",marginBottom:6}}>保有銘柄がありません</div>
            <div style={{fontSize:11,color:"#2a4060"}}>「➕ 追加」から登録してください</div>
          </div>
        ):(
          <div>
            <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"12px 16px",marginBottom:12,display:"flex",gap:20,flexWrap:"wrap"}}>
              <div><div style={{fontSize:9,color:"#2a6090"}}>保有銘柄</div><div style={{fontSize:16,fontWeight:800,color:"#e0f0ff"}}>{portfolio.length}銘柄</div></div>
              <div><div style={{fontSize:9,color:"#2a6090"}}>損益合計</div><div style={{fontSize:16,fontWeight:800,color:totalPnL>=0?"#22d3a0":"#f43f5e"}}>{totalPnL>=0?"+":""}{totalPnL.toFixed(2)}</div></div>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {portfolio.map(function(pos){
                var cur=getCurrentPrice(pos.ticker);
                var pnl=cur?(cur-pos.buyPrice)*pos.shares:null;
                var pct=cur?(cur-pos.buyPrice)/pos.buyPrice*100:null;
                var hitStop=cur&&pos.stopLoss&&cur<=pos.stopLoss;
                var hitTarget=cur&&pos.target&&cur>=pos.target;
                var isEditing=editId===pos.id;
                return(
                  <div key={pos.id} style={{background:"#050e1c",border:"1px solid "+(hitStop?"#f43f5e":hitTarget?"#22d3a0":"#1e3050"),borderRadius:10,padding:"14px 16px"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                      <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
                        <span style={{fontSize:15,fontWeight:800,color:"#d8eeff"}}>{pos.ticker.replace(".T","")}</span>
                        <span style={{fontSize:11,color:"#4a7090"}}>{pos.name}</span>
                        {hitStop&&<span style={bStyle("#1f0010","#f43f5e","#f43f5e")}>⚠ 損切りライン</span>}
                        {hitTarget&&<span style={bStyle("#052e16","#22d3a0","#22d3a0")}>🎯 目標達成</span>}
                      </div>
                      <div style={{display:"flex",gap:6}}>
                        <button onClick={function(){isEditing?setEditId(null):startEdit(pos);}} style={{background:"transparent",border:"1px solid "+(isEditing?"#fbbf24":"#2a3050"),borderRadius:6,color:isEditing?"#fbbf24":"#4a7090",padding:"3px 8px",fontSize:10,cursor:"pointer",fontFamily:"monospace"}}>{isEditing?"✕ 閉じる":"✏️ 編集"}</button>
                        <button onClick={function(){removePos(pos.id);}} style={{background:"transparent",border:"1px solid #2a3050",borderRadius:6,color:"#4a7090",padding:"3px 8px",fontSize:10,cursor:"pointer",fontFamily:"monospace"}}>削除</button>
                      </div>
                    </div>

                    {/* 編集フォーム */}
                    {isEditing&&editForm&&(
                      <div style={{background:"#040c18",border:"1px solid #1e4070",borderRadius:8,padding:"12px",marginBottom:10}}>
                        <div style={{fontSize:10,color:"#4a90c0",marginBottom:8,fontWeight:700}}>✏️ 内容を編集</div>
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8}}>
                          {[["買値 *","buyPrice"],["株数 *","shares"],["損切りライン","stopLoss"],["目標価格","target"]].map(function(row){
                            return(
                              <div key={row[0]}>
                                <div style={{fontSize:9,color:"#2a6090",marginBottom:2}}>{row[0]}</div>
                                <input style={inpStyleSm} type="number" value={editForm[row[1]]} onChange={function(e){ var up={}; up[row[1]]=e.target.value; setEditForm(Object.assign({},editForm,up)); }}/>
                              </div>
                            );
                          })}
                        </div>
                        <button onClick={function(){saveEdit(pos.id);}} style={{width:"100%",background:"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:6,color:"#fff",padding:"8px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>保存する</button>
                      </div>
                    )}

                    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(110px,1fr))",gap:6,marginBottom:8}}>
                      {[["買値",pos.market==="JP"?"¥"+pos.buyPrice.toLocaleString():"$"+pos.buyPrice,"#b8cce0"],["株数",pos.shares+"株","#b8cce0"],["現在値",cur?(pos.market==="JP"?"¥"+Math.round(cur).toLocaleString():"$"+cur.toFixed(2)):"─","#b8cce0"],["損益",pnl!==null?(pnl>=0?"+":"")+pnl.toFixed(2):"─",pnl!==null?(pnl>=0?"#22d3a0":"#f43f5e"):"#4a7090"],["損益率",pct!==null?(pct>=0?"+":"")+pct.toFixed(2)+"%":"─",pct!==null?(pct>=0?"#22d3a0":"#f43f5e"):"#4a7090"]].map(function(row){
                        return(<div key={row[0]} style={{background:"#071428",borderRadius:6,padding:"5px 8px"}}><div style={{fontSize:9,color:"#2a6090"}}>{row[0]}</div><div style={{fontSize:11,fontWeight:700,color:row[2]}}>{row[1]}</div></div>);
                      })}
                    </div>
                    <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
                      {pos.stopLoss&&<span style={{fontSize:10,color:"#f43f5e"}}>損切り: {pos.market==="JP"?"¥"+pos.stopLoss.toLocaleString():"$"+pos.stopLoss}</span>}
                      {pos.target&&<span style={{fontSize:10,color:"#22d3a0"}}>目標: {pos.market==="JP"?"¥"+pos.target.toLocaleString():"$"+pos.target}</span>}
                      <span style={{fontSize:10,color:"#2a6090",marginLeft:"auto"}}>追加日: {pos.addedAt}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )
      )}
    </div>
  );
}

// ── Backtest Panel ────────────────────────────────────────────────────────────
function BacktestPanel(p) {
  var stocks = p.stocks;
  var favs = p.favs || [];
  var selS=useState(""); var sel=selS[0],setSel=selS[1];
  var resS=useState(null); var result=resS[0],setResult=resS[1];

  var favStocks = stocks.filter(function(s){ return favs.indexOf(s.ticker)>=0; });
  var otherStocks = stocks.filter(function(s){ return favs.indexOf(s.ticker)<0; });

  function run() {
    var found=stocks.find(function(s){ return s.ticker===sel; });
    if(!found||!found.closes) return;
    setResult(runBacktest(found.closes));
  }

  return(
    <div>
      <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"12px 16px",marginBottom:14}}>
        <div style={{fontSize:12,fontWeight:700,color:"#e0f0ff",marginBottom:4}}>📊 バックテスト</div>
        <div style={{fontSize:10,color:"#4a7090"}}>「MACDゴールデンクロス → 5日後売却」の過去勝率を検証します。</div>
      </div>
      <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap"}}>
        <select value={sel} onChange={function(e){setSel(e.target.value);setResult(null);}} style={{background:"#071428",border:"1px solid #1e3050",borderRadius:6,color:"#b8cce0",padding:"8px 12px",fontSize:12,fontFamily:"monospace",flex:1}}>
          <option value="">銘柄を選択してください</option>
          {favStocks.length>0&&(
            <optgroup label="⭐ お気に入り">
              {favStocks.map(function(s){ return(<option key={s.ticker} value={s.ticker}>{s.ticker.replace(".T","")} {s.name}</option>); })}
            </optgroup>
          )}
          {otherStocks.length>0&&(
            <optgroup label="その他">
              {otherStocks.map(function(s){ return(<option key={s.ticker} value={s.ticker}>{s.ticker.replace(".T","")} {s.name}</option>); })}
            </optgroup>
          )}
        </select>
        <button onClick={run} disabled={!sel} style={{background:sel?"linear-gradient(135deg,#0ea5e9,#0369a1)":"#0a1828",border:"none",borderRadius:8,color:"#fff",padding:"8px 20px",fontSize:12,fontWeight:700,cursor:sel?"pointer":"not-allowed",fontFamily:"monospace"}}>実行</button>
      </div>

      {/* お気に入り銘柄クイック実行 */}
      {favStocks.length>0&&!result&&(
        <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:8,padding:"10px 14px",marginBottom:14}}>
          <div style={{fontSize:10,color:"#4a7090",marginBottom:8}}>⭐ お気に入り銘柄をワンタップで検証</div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {favStocks.map(function(s){
              return(<button key={s.ticker} onClick={function(){ setSel(s.ticker); var found=stocks.find(function(st){return st.ticker===s.ticker;}); if(found&&found.closes) setResult(runBacktest(found.closes)); }} style={{background:"#050e1c",border:"1px solid #fbbf24",borderRadius:6,color:"#fbbf24",padding:"5px 12px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>{s.ticker.replace(".T","")}</button>);
            })}
          </div>
        </div>
      )}

      {result&&(
        <div>
          <div style={{fontSize:11,color:"#4a90c0",marginBottom:10,fontWeight:700}}>{sel.replace(".T","")} の検証結果</div>
          <div style={{display:"flex",gap:10,marginBottom:14,flexWrap:"wrap"}}>
            <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:8,padding:"10px 16px"}}><div style={{fontSize:9,color:"#2a6090"}}>検証回数</div><div style={{fontSize:18,fontWeight:800,color:"#e0f0ff"}}>{result.total}回</div></div>
            <div style={{background:parseFloat(result.winRate)>=50?"#052e16":"#1f0010",border:"1px solid "+(parseFloat(result.winRate)>=50?"#22d3a0":"#f43f5e"),borderRadius:8,padding:"10px 16px"}}><div style={{fontSize:9,color:"#2a6090"}}>勝率</div><div style={{fontSize:18,fontWeight:800,color:parseFloat(result.winRate)>=50?"#22d3a0":"#f43f5e"}}>{result.winRate}%</div></div>
            <button onClick={function(){setResult(null);setSel("");}} style={{background:"transparent",border:"1px solid #2a3050",borderRadius:8,color:"#4a7090",padding:"8px 14px",fontSize:11,cursor:"pointer",fontFamily:"monospace",marginLeft:"auto"}}>← 戻る</button>
          </div>
          <div style={{fontSize:11,color:"#4a7090",marginBottom:8}}>直近10回のシグナル</div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {result.results.map(function(r,i){
              return(<div key={i} style={{background:"#050e1c",border:"1px solid "+(r.win?"#22d3a040":"#f43f5e40"),borderRadius:8,padding:"8px 12px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{display:"flex",gap:12}}>
                  <span style={{fontSize:11,color:"#4a7090"}}>買 <span style={{color:"#b8cce0"}}>{r.buyPrice}</span></span>
                  <span style={{fontSize:11,color:"#4a7090"}}>売 <span style={{color:"#b8cce0"}}>{r.sellPrice}</span></span>
                </div>
                <span style={{fontSize:12,fontWeight:700,color:r.win?"#22d3a0":"#f43f5e"}}>{r.win?"+":""}{r.ret}%</span>
              </div>);
            })}
          </div>
          <div style={{fontSize:9,color:"#1a3050",marginTop:10}}>※ 過去データに基づく検証です。将来の利益を保証するものではありません。</div>
        </div>
      )}

      {!result&&stocks.length===0&&(
        <div style={{textAlign:"center",padding:"40px",color:"#4a7090",fontSize:12}}>スキャナーでデータ取得後に利用できます</div>
      )}
    </div>
  );
}

// ── Trend / News / IPO data ───────────────────────────────────────────────────
var TREND_LINKS = [
  { category:"🇯🇵 日本株ランキング", links:[
    { label:"📈 値上がり率", url:"https://finance.yahoo.co.jp/stocks/ranking/up?market=all" },
    { label:"📉 値下がり率", url:"https://finance.yahoo.co.jp/stocks/ranking/down?market=all" },
    { label:"🔥 出来高",     url:"https://finance.yahoo.co.jp/stocks/ranking/volume?market=all" },
    { label:"💴 売買代金",   url:"https://finance.yahoo.co.jp/stocks/ranking/tradingValueHigh?market=all" },
    { label:"👁 出来高増加率",url:"https://finance.yahoo.co.jp/stocks/ranking/volumeIncrease?market=all" },
    { label:"💬 掲示板投稿数",url:"https://finance.yahoo.co.jp/stocks/ranking/bbs?market=all" },
  ]},
  { category:"🇺🇸 米国株ランキング", links:[
    { label:"📈 値上がり率",    url:"https://finance.yahoo.co.jp/stocks/us/ranking/up?market=all" },
    { label:"📉 値下がり率",    url:"https://finance.yahoo.co.jp/stocks/us/ranking/down?market=all" },
    { label:"🔥 出来高",        url:"https://finance.yahoo.co.jp/stocks/us/ranking/volume?market=all" },
    { label:"💴 売買代金",      url:"https://finance.yahoo.co.jp/stocks/us/ranking/tradingValue?market=all" },
    { label:"🏆 時価総額",      url:"https://finance.yahoo.co.jp/stocks/us/ranking/marketCapital?market=all" },
    { label:"🇺🇸 米国株トップ", url:"https://finance.yahoo.co.jp/stocks/us" },
  ]},
  { category:"📊 市況・指数", links:[
    { label:"🗾 日経平均", url:"https://finance.yahoo.co.jp/quote/998407.O" },
    { label:"🇺🇸 NYダウ",  url:"https://finance.yahoo.co.jp/quote/%5EDJI" },
    { label:"💻 NASDAQ",   url:"https://finance.yahoo.co.jp/quote/%5EIXIC" },
    { label:"📊 S&P500",   url:"https://finance.yahoo.co.jp/quote/%5EGSPC" },
    { label:"💱 ドル円",   url:"https://finance.yahoo.co.jp/quote/USDJPY=X" },
  ]},
  { category:"📰 ニュース", links:[
    { label:"📰 株式ニュース",    url:"https://finance.yahoo.co.jp/news" },
    { label:"🇯🇵 日本株ニュース", url:"https://finance.yahoo.co.jp/news/stocks" },
    { label:"🇺🇸 米国株ニュース", url:"https://finance.yahoo.co.jp/news/world" },
    { label:"🌍 マーケット情報",  url:"https://finance.yahoo.co.jp/stocks" },
  ]},
];
var IPO_DATA = [
  { name:"サンコーテクノ",   code:"3441", market:"東証スタンダード", listDate:"2025-06-10", price:1200, cap:36,   sector:"建設",   url:"https://finance.yahoo.co.jp/ipo/3441" },
  { name:"トライアルHD",     code:"141A", market:"東証プライム",     listDate:"2025-06-17", price:1450, cap:580,  sector:"小売",   url:"https://finance.yahoo.co.jp/ipo/141A" },
  { name:"グロービング",     code:"5575", market:"東証グロース",     listDate:"2025-06-19", price:880,  cap:18,   sector:"IT",     url:"https://finance.yahoo.co.jp/ipo/5575" },
  { name:"フォーラムエンジ", code:"7088", market:"東証プライム",     listDate:"2025-06-24", price:2100, cap:210,  sector:"人材",   url:"https://finance.yahoo.co.jp/ipo/7088" },
  { name:"ソシオネクスト",   code:"6526", market:"東証プライム",     listDate:"2025-07-01", price:3800, cap:1900, sector:"半導体", url:"https://finance.yahoo.co.jp/ipo/6526" },
  { name:"アストロスケール", code:"186A", market:"東証グロース",     listDate:"2025-07-08", price:750,  cap:310,  sector:"宇宙",   url:"https://finance.yahoo.co.jp/ipo/186A" },
  { name:"Hacomono",         code:"271A", market:"東証グロース",     listDate:"2025-07-15", price:1100, cap:42,   sector:"SaaS",   url:"https://finance.yahoo.co.jp/ipo/271A" },
];

// ── classifyStock ─────────────────────────────────────────────────────────────
function classifyStockFn(s) {
  var sigs=s.signals,macdSig=null;
  for(var i=0;i<sigs.length;i++){if(sigs[i].label==="MACD"){macdSig=sigs[i];break;}}
  if(!macdSig) return null;
  if(macdSig.val==="ゴールデンクロス") return{type:"GC_NOW", label:"🔥 GC発生中", color:"#22d3a0",bg:"#052e16",border:"#22d3a0",desc:"ゴールデンクロス発生中"};
  if(macdSig.val==="デッドクロス")     return{type:"DC_NOW", label:"💀 DC発生中", color:"#f43f5e",bg:"#1f0010",border:"#f43f5e",desc:"デッドクロス発生中"};
  if(macdSig.val==="強気ゾーン"&&s.score>=55) return{type:"GC_NEAR",label:"⚡ GC接近中",color:"#fbbf24",bg:"#1c1400",border:"#fbbf24",desc:"ゴールデンクロス間近の可能性"};
  if(macdSig.val==="弱気ゾーン"&&s.score<=30) return{type:"DC_NEAR",label:"⚠ DC接近中",color:"#fb923c",bg:"#1a0800",border:"#fb923c",desc:"デッドクロス間近の可能性"};
  if(macdSig.val==="強気ゾーン") return{type:"GC_WATCH",label:"👀 GC監視",color:"#60a5fa",bg:"#0a1e3a",border:"#3b82f6",desc:"上昇傾向・クロス監視中"};
  return{type:"NONE",label:"－ 中立",color:"#4a7090",bg:"#071428",border:"#1e3050",desc:"特筆なし"};
}

// ── Fav Panel ─────────────────────────────────────────────────────────────────
function FavPanel(p) {
  var stocks=p.stocks,favs=p.favs,toggleFav=p.toggleFav,onChart=p.onChart,onScan=p.onScan,loading=p.loading;
  var favStocks=stocks.filter(function(s){return favs.indexOf(s.ticker)>=0;});
  var order={GC_NOW:0,GC_NEAR:1,GC_WATCH:2,NONE:3,DC_NEAR:4,DC_NOW:5};
  var sorted=favStocks.slice().sort(function(a,b){var ca=classifyStockFn(a),cb=classifyStockFn(b);return(ca?order[ca.type]||3:3)-(cb?order[cb.type]||3:3);});
  var gcCount=favStocks.filter(function(s){var c=classifyStockFn(s);return c&&(c.type==="GC_NOW"||c.type==="GC_NEAR");}).length;
  var dcCount=favStocks.filter(function(s){var c=classifyStockFn(s);return c&&(c.type==="DC_NOW"||c.type==="DC_NEAR");}).length;

  // ティッカー検索で追加した銘柄の表示データ
  var extraS=useState({}); var extra=extraS[0],setExtra=extraS[1];
  var scannedTickers=stocks.map(function(s){return s.ticker;});
  var unscannedFavs=favs.filter(function(t){return scannedTickers.indexOf(t)<0;});

  var searchS=useState(""); var searchTicker=searchS[0],setSearchTicker=searchS[1];
  var searchStatusS=useState(null); var searchStatus=searchStatusS[0],setSearchStatus=searchStatusS[1];

  async function addByTicker() {
    var raw=searchTicker.trim().toUpperCase(); if(!raw) return;
    var ticker=(raw.match(/^\d{4}$/)? raw+".T" : raw);
    if(favs.indexOf(ticker)>=0){setSearchStatus("already");return;}
    setSearchStatus("loading");
    try {
      var res=await fetch(VERCEL_API+"?ticker="+encodeURIComponent(ticker),{signal:AbortSignal.timeout(10000)});
      if(!res.ok) throw new Error("not found");
      var json=await res.json();
      var meta=json?.chart?.result?.[0]?.meta;
      if(!meta) throw new Error("not found");
      var price=meta.regularMarketPrice||0;
      var prevClose=meta.chartPreviousClose||0;
      var change=prevClose?((price-prevClose)/prevClose*100).toFixed(2):"0.00";
      var isJP=ticker.endsWith(".T");
      var dispPrice=isJP?"¥"+Math.round(price).toLocaleString():"$"+price.toFixed(2);
      setExtra(function(prev){
        var next=Object.assign({},prev);
        next[ticker]={ticker:ticker,name:meta.shortName||meta.longName||ticker,market:isJP?"JP":"US",tvSymbol:(isJP?"TSE:":"NASDAQ:")+ticker.replace(".T",""),price:dispPrice,rawPrice:price,change:change,score:0,signals:[],spark:[],real:true,yahooUrl:"https://finance.yahoo.co.jp/quote/"+ticker};
        return next;
      });
      toggleFav(ticker);
      setSearchTicker(""); setSearchStatus("ok");
      setTimeout(function(){setSearchStatus(null);},2000);
    } catch(e){
      setSearchStatus("error");
      setTimeout(function(){setSearchStatus(null);},2000);
    }
  }

  var addFormS=useState(null); var addForm=addFormS[0],setAddForm=addFormS[1];
  function openAddForm(s){ setAddForm({ticker:s.ticker,name:s.name,market:s.market,price:s.rawPrice||"",buyPrice:"",shares:"",stopLoss:"",target:""}); }
  function submitAddForm(){
    if(!addForm.buyPrice||!addForm.shares) return;
    var portfolio=(function(){try{var v=localStorage.getItem("portfolio_v1");return v?JSON.parse(v):[];}catch(e){return[];}})();
    var pos={id:Date.now(),ticker:addForm.ticker,name:addForm.name,market:addForm.market,buyPrice:parseFloat(addForm.buyPrice),shares:parseFloat(addForm.shares),stopLoss:addForm.stopLoss?parseFloat(addForm.stopLoss):null,target:addForm.target?parseFloat(addForm.target):null,addedAt:new Date().toLocaleDateString("ja-JP")};
    try{localStorage.setItem("portfolio_v1",JSON.stringify(portfolio.concat([pos])));}catch(e){}
    setAddForm(null);
  }

  var inpStyle={background:"#071428",border:"1px solid #1e3050",borderRadius:6,color:"#b8cce0",padding:"7px 10px",fontSize:12,fontFamily:"monospace",width:"100%",boxSizing:"border-box"};
  var statusMsg=searchStatus==="loading"?"取得中…":searchStatus==="ok"?"✅ 追加しました":searchStatus==="error"?"❌ 銘柄が見つかりません":searchStatus==="already"?"既に登録済みです":null;
  var statusColor=searchStatus==="ok"?"#22d3a0":"#f43f5e";

  function Card(cp){
    var s=cp.s,mc=MKT[s.market]||MKT["US"],isUp=parseFloat(s.change)>=0;
    var cross=s.signals&&s.signals.length>0?classifyStockFn(s):null;
    var bc=s.timing?BADGE[s.timing]:null;
    return(
      <div style={{background:"#050e1c",border:"1px solid #1e3050",borderRadius:10,padding:"14px 16px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8,marginBottom:10}}>
          <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
            <span style={bStyle(mc.bg,mc.border,mc.text)}>{mc.label}</span>
            <span style={{fontSize:16,fontWeight:800,color:"#d8eeff"}}>{s.ticker.replace(".T","")}</span>
            <span style={{fontSize:11,color:"#4a7090"}}>{s.name}</span>
            {bc&&<span style={bStyle(bc.bg,bc.border,bc.text)}>{bc.label}</span>}
          </div>
          <button onClick={function(){toggleFav(s.ticker);}} style={{background:"transparent",border:"none",fontSize:20,cursor:"pointer",padding:0}}>⭐</button>
        </div>
        {cross&&cross.type!=="NONE"&&(<div style={{background:cross.bg,border:"1px solid "+cross.border,borderRadius:8,padding:"8px 14px",marginBottom:10,display:"flex",alignItems:"center",gap:10}}><span style={{fontSize:18}}>{cross.type==="GC_NOW"?"🔥":cross.type==="DC_NOW"?"💀":cross.type==="GC_NEAR"?"⚡":cross.type==="DC_NEAR"?"⚠":"👀"}</span><div><div style={{fontSize:12,fontWeight:800,color:cross.color}}>{cross.label}</div><div style={{fontSize:10,color:"#4a7090",marginTop:2}}>{cross.desc}</div></div></div>)}
        <div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:10}}>
          <span style={{fontSize:11,color:"#2a6090"}}>価格 <span style={{color:"#b8cce0",fontWeight:700}}>{s.price}</span></span>
          {s.score>0&&<span style={{fontSize:11,color:"#2a6090"}}>スコア <span style={{color:scoreColor(s.score),fontWeight:700}}>{s.score}/100</span></span>}
          <span style={{fontSize:11,fontWeight:700,color:isUp?"#22d3a0":"#f43f5e"}}>{isUp?"▲":"▼"} {Math.abs(s.change)}%</span>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
          <button onClick={function(){onChart(s);}} style={{background:"linear-gradient(135deg,#0d2d4a,#0a1f38)",border:"1px solid #1e6090",borderRadius:8,color:"#4a90c0",padding:"9px 6px",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>📈 チャート</button>
          <a href={s.yahooUrl} target="_blank" rel="noreferrer" style={{background:"linear-gradient(135deg,#1a0a2e,#0f0a20)",border:"1px solid #6366f1",borderRadius:8,color:"#a5b4fc",padding:"9px 6px",fontSize:10,fontWeight:700,fontFamily:"monospace",textDecoration:"none",textAlign:"center",display:"block"}}>{"🔗"} Yahoo!</a>
          <button onClick={function(){openAddForm(s);}} style={{background:"linear-gradient(135deg,#0a2e1a,#064020)",border:"1px solid #22d3a0",borderRadius:8,color:"#22d3a0",padding:"9px 6px",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>{"💼"} 追加</button>
        </div>
      </div>
    );
  }

  return(
    <div>
      <div style={{background:"#050e1c",border:"1px solid #1e3050",borderRadius:10,padding:"12px 14px",marginBottom:14}}>
        <div style={{fontSize:11,fontWeight:700,color:"#4a90c0",marginBottom:8}}>{"🔍"} ティッカーでお気に入り追加</div>
        <div style={{display:"flex",gap:8}}>
          <input style={{background:"#071428",border:"1px solid #1e3050",borderRadius:6,color:"#b8cce0",padding:"8px 10px",fontSize:12,fontFamily:"monospace",flex:1}} value={searchTicker} placeholder="AAPL / 7203（日本株は数字4桁）" onChange={function(e){setSearchTicker(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter") addByTicker();}}/>
          <button onClick={addByTicker} disabled={!searchTicker.trim()||searchStatus==="loading"} style={{background:searchTicker.trim()?"linear-gradient(135deg,#0ea5e9,#0369a1)":"#0a1828",border:"none",borderRadius:8,color:"#fff",padding:"8px 16px",fontSize:12,fontWeight:700,cursor:searchTicker.trim()?"pointer":"not-allowed",fontFamily:"monospace",whiteSpace:"nowrap"}}>{searchStatus==="loading"?"…":"追加"}</button>
        </div>
        {statusMsg&&<div style={{fontSize:10,color:statusColor,marginTop:6}}>{statusMsg}</div>}
      </div>
      {favs.length>0&&<div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"12px 16px",marginBottom:14,display:"flex",gap:16,flexWrap:"wrap",alignItems:"center"}}>
        <div><div style={{fontSize:9,color:"#2a6090"}}>お気に入り</div><div style={{fontSize:16,fontWeight:800,color:"#e0f0ff"}}>{favs.length}銘柄</div></div>
        {gcCount>0&&<div style={{background:"#052e16",border:"1px solid #22d3a060",borderRadius:8,padding:"6px 12px"}}><div style={{fontSize:9,color:"#2a6090"}}>GC発生・接近</div><div style={{fontSize:16,fontWeight:800,color:"#22d3a0"}}>{gcCount}銘柄</div></div>}
        {dcCount>0&&<div style={{background:"#1f0010",border:"1px solid #f43f5e60",borderRadius:8,padding:"6px 12px"}}><div style={{fontSize:9,color:"#2a6090"}}>DC発生・接近</div><div style={{fontSize:16,fontWeight:800,color:"#f43f5e"}}>{dcCount}銘柄</div></div>}
      </div>}
      {addForm&&(<div style={{background:"#050e1c",border:"1px solid #0ea5e9",borderRadius:10,padding:16,marginBottom:14}}>
        <div style={{fontSize:12,fontWeight:700,color:"#e0f0ff",marginBottom:10}}>{"💼"} {addForm.ticker.replace(".T","")} をポートフォリオに追加</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
          <div><div style={{fontSize:9,color:"#2a6090",marginBottom:3}}>買値 *</div><input style={inpStyle} type="number" value={addForm.buyPrice} placeholder={addForm.price?"現在値: "+addForm.price:""} onChange={function(e){setAddForm(Object.assign({},addForm,{buyPrice:e.target.value}));}}/></div>
          <div><div style={{fontSize:9,color:"#2a6090",marginBottom:3}}>株数 *</div><input style={inpStyle} type="number" value={addForm.shares} placeholder="100" onChange={function(e){setAddForm(Object.assign({},addForm,{shares:e.target.value}));}}/></div>
          <div><div style={{fontSize:9,color:"#2a6090",marginBottom:3}}>損切りライン</div><input style={inpStyle} type="number" value={addForm.stopLoss} placeholder="任意" onChange={function(e){setAddForm(Object.assign({},addForm,{stopLoss:e.target.value}));}}/></div>
          <div><div style={{fontSize:9,color:"#2a6090",marginBottom:3}}>目標価格</div><input style={inpStyle} type="number" value={addForm.target} placeholder="任意" onChange={function(e){setAddForm(Object.assign({},addForm,{target:e.target.value}));}}/></div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          <button onClick={function(){setAddForm(null);}} style={{background:"transparent",border:"1px solid #2a3050",borderRadius:8,color:"#4a7090",padding:"9px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>キャンセル</button>
          <button onClick={submitAddForm} disabled={!addForm.buyPrice||!addForm.shares} style={{background:addForm.buyPrice&&addForm.shares?"linear-gradient(135deg,#0ea5e9,#0369a1)":"#0a1828",border:"none",borderRadius:8,color:"#fff",padding:"9px",fontSize:11,fontWeight:700,cursor:addForm.buyPrice&&addForm.shares?"pointer":"not-allowed",fontFamily:"monospace"}}>{"💼"} 追加する</button>
        </div>
      </div>)}
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {sorted.map(function(s){ return <Card key={s.ticker} s={s}/>; })}
        {unscannedFavs.map(function(ticker){
          var s=extra[ticker];
          if(!s) return(<div key={ticker} style={{background:"#050e1c",border:"1px solid #1e3050",borderRadius:10,padding:"14px 16px",display:"flex",justifyContent:"space-between",alignItems:"center"}}><div style={{display:"flex",gap:8,alignItems:"center"}}><span style={{fontSize:14,fontWeight:800,color:"#d8eeff"}}>{ticker.replace(".T","")}</span><span style={{fontSize:10,color:"#4a7090"}}>データ取得待ち</span></div><button onClick={function(){toggleFav(ticker);}} style={{background:"transparent",border:"none",fontSize:20,cursor:"pointer",padding:0}}>{"⭐"}</button></div>);
          return <Card key={ticker} s={s}/>;
        })}
      </div>
      {favs.length===0&&<div style={{textAlign:"center",padding:"30px 20px",color:"#4a7090",fontSize:11}}>上の検索フォームからティッカーを入力して追加できます</div>}
    </div>
  );
}


// ── Cross Panel ───────────────────────────────────────────────────────────────
function CrossCard(cp) {
  var s=cp.item.stock,cr=cp.item.cross,mc=MKT[s.market],isUp=parseFloat(s.change)>=0;
  return(<div style={{background:"#050e1c",border:"1px solid "+cr.border+"40",borderRadius:10,padding:"12px 14px",display:"grid",gridTemplateColumns:"1fr auto",gap:10,alignItems:"center"}}>
    <div>
      <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap",marginBottom:4}}>
        <span style={bStyle(mc.bg,mc.border,mc.text)}>{mc.label}</span>
        <span style={{fontSize:14,fontWeight:800,color:"#d8eeff"}}>{s.ticker.replace(".T","")}</span>
        <span style={{fontSize:11,color:"#4a7090"}}>{s.name}</span>
        <span style={bStyle(cr.bg,cr.border,cr.color)}>{cr.label}</span>
      </div>
      <div style={{fontSize:10,color:"#4a7090",marginBottom:4}}>{cr.desc}</div>
      <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
        <span style={{fontSize:11,color:"#2a6090"}}>価格 <span style={{color:"#b8cce0"}}>{s.price}</span></span>
        <span style={{fontSize:11,color:"#2a6090"}}>スコア <span style={{color:scoreColor(s.score),fontWeight:700}}>{s.score}</span></span>
        <span style={{fontSize:11,fontWeight:700,color:isUp?"#22d3a0":"#f43f5e"}}>{isUp?"▲":"▼"} {Math.abs(s.change)}%</span>
      </div>
    </div>
    <button onClick={function(){cp.onChart(s);}} style={{background:"#071428",border:"1px solid #1e4070",borderRadius:6,color:"#4a90c0",padding:"8px 10px",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"monospace",whiteSpace:"nowrap"}}>📈 チャート</button>
  </div>);
}
function CrossSection(sp) {
  if(!sp.items||!sp.items.length) return null;
  return(<div style={{marginBottom:20}}><div style={{fontSize:12,fontWeight:700,color:sp.color,marginBottom:8,padding:"6px 0",borderBottom:"1px solid #0f2040"}}>{sp.title} ({sp.items.length}銘柄)</div><div style={{display:"flex",flexDirection:"column",gap:8}}>{sp.items.map(function(item){return<CrossCard key={item.stock.ticker} item={item} onChart={sp.onChart}/>;})}</div></div>);
}
function CrossPanel(p) {
  var stocks=p.stocks,onChart=p.onChart,loading=p.loading,onScan=p.onScan;
  var gcNow=[],dcNow=[],gcNear=[],dcNear=[],gcWatch=[];
  stocks.forEach(function(s){ var c=classifyStockFn(s); if(!c) return; var item={stock:s,cross:c};
    if(c.type==="GC_NOW")gcNow.push(item); else if(c.type==="DC_NOW")dcNow.push(item);
    else if(c.type==="GC_NEAR")gcNear.push(item); else if(c.type==="DC_NEAR")dcNear.push(item);
    else if(c.type==="GC_WATCH")gcWatch.push(item);
  });
  if(stocks.length===0) return(<div style={{textAlign:"center",padding:"80px 20px",color:"#2a6090"}}><div style={{fontSize:40,marginBottom:16}}>✨</div><div style={{fontSize:14,color:"#4a90c0",marginBottom:8}}>スキャン後に表示されます</div><button onClick={onScan} disabled={loading} style={{background:"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:8,color:"#fff",padding:"12px 24px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"monospace",marginTop:12}}>{loading?"取得中…":"▶ スキャン開始"}</button></div>);
  var hasAny=gcNow.length+dcNow.length+gcNear.length+dcNear.length+gcWatch.length>0;
  return(<div>
    <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"12px 16px",marginBottom:16}}>
      <div style={{fontSize:12,fontWeight:700,color:"#e0f0ff",marginBottom:4}}>✨ ゴールデンクロス / デッドクロス 予測</div>
      <div style={{fontSize:10,color:"#4a7090"}}>MACDのヒストグラム推移から自動判定。投資判断は自己責任でお願いします。</div>
    </div>
    {!hasAny&&<div style={{textAlign:"center",padding:"40px",color:"#4a7090",fontSize:12}}>現在クロス条件に該当する銘柄がありません</div>}
    <CrossSection title="⚡ ゴールデンクロス 接近中" items={gcNear} color="#fbbf24" onChart={onChart}/>
    <CrossSection title="🔥 ゴールデンクロス 発生中" items={gcNow} color="#22d3a0" onChart={onChart}/>
    <CrossSection title="👀 ゴールデンクロス 監視中" items={gcWatch} color="#60a5fa" onChart={onChart}/>
    <CrossSection title="⚠ デッドクロス 接近中" items={dcNear} color="#fb923c" onChart={onChart}/>
    <CrossSection title="💀 デッドクロス 発生中" items={dcNow} color="#f43f5e" onChart={onChart}/>
  </div>);
}

// ── IPO Panel ─────────────────────────────────────────────────────────────────
function IpoPanel() {
  var today=new Date();
  function daysUntil(d){ return Math.ceil((new Date(d)-today)/(1000*60*60*24)); }
  function ipoScore(ipo){ var s=0; if(ipo.market==="東証プライム")s+=30;else if(ipo.market==="東証スタンダード")s+=20;else s+=10; if(ipo.cap>=500)s+=30;else if(ipo.cap>=100)s+=20;else if(ipo.cap>=30)s+=10; if(["半導体","SaaS","IT","宇宙","AI"].indexOf(ipo.sector)>=0)s+=25;else s+=10; if(ipo.price>=2000)s+=15;else if(ipo.price>=1000)s+=10;else s+=5; return Math.min(100,s); }
  var sorted=IPO_DATA.map(function(ipo){return{ipo:ipo,score:ipoScore(ipo),days:daysUntil(ipo.listDate)};}).sort(function(a,b){return b.score-a.score;});
  return(<div>{sorted.map(function(item){var ipo=item.ipo,days=item.days,sc=item.score;var dLabel=days<0?"上場済み":days===0?"🎉 本日上場":days<=7?"⚡ あと"+days+"日":"📅 あと"+days+"日";var dColor=days<0?"#4a7090":days<=3?"#f43f5e":days<=7?"#fbbf24":"#4a90c0";var mColor=ipo.market==="東証プライム"?"#22d3a0":ipo.market==="東証スタンダード"?"#60a5fa":"#a78bfa";var sColor=sc>=70?"#22d3a0":sc>=50?"#fbbf24":"#94a3b8";return(<div key={ipo.code} style={{background:"#050e1c",border:"1px solid #0f2040",borderRadius:10,padding:"14px 16px",marginBottom:10}}><div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:12,alignItems:"start"}}><div><div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap",marginBottom:6}}><span style={{fontSize:15,fontWeight:800,color:"#d8eeff"}}>{ipo.name}</span><span style={{fontSize:10,color:"#4a7090"}}>{ipo.code}</span><span style={{background:"#0a1428",border:"1px solid "+mColor+"50",color:mColor,fontSize:9,fontWeight:700,padding:"1px 7px",borderRadius:4}}>{ipo.market}</span></div><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(110px,1fr))",gap:6,marginBottom:8}}>{[["上場日",ipo.listDate],["公開価格","¥"+ipo.price.toLocaleString()],["時価総額",ipo.cap+"億円"],["セクター",ipo.sector]].map(function(row){return(<div key={row[0]} style={{background:"#071428",borderRadius:6,padding:"5px 8px"}}><div style={{fontSize:9,color:"#2a6090"}}>{row[0]}</div><div style={{fontSize:11,fontWeight:700,color:"#b8cce0"}}>{row[1]}</div></div>);})}</div><div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}><span style={{fontSize:11,fontWeight:700,color:dColor}}>{dLabel}</span><a href={ipo.url} target="_blank" rel="noreferrer" style={{background:"#071428",border:"1px solid #3b82f6",borderRadius:6,color:"#93c5fd",padding:"4px 10px",fontSize:10,fontWeight:700,fontFamily:"monospace",textDecoration:"none"}}>🔗 Yahoo!</a></div></div><div style={{background:sc>=70?"#052e16":sc>=50?"#1c1400":"#0a1428",border:"1px solid "+sColor+"50",borderRadius:8,padding:"8px 12px",textAlign:"center",minWidth:60}}><div style={{fontSize:9,color:"#4a7090"}}>スコア</div><div style={{fontSize:18,fontWeight:800,color:sColor}}>{sc}</div></div></div></div>);})}<div style={{marginTop:12,textAlign:"center"}}><a href="https://finance.yahoo.co.jp/ipo" target="_blank" rel="noreferrer" style={{display:"inline-block",background:"linear-gradient(135deg,#0d2d4a,#0369a1)",border:"1px solid #0ea5e9",borderRadius:8,color:"#fff",padding:"10px 24px",fontSize:12,fontWeight:700,fontFamily:"monospace",textDecoration:"none"}}>🚀 IPO情報をすべて見る</a></div></div>);
}

// ── News Panel ────────────────────────────────────────────────────────────────
function NewsPanel() {
  var NEWS=[
    {label:"📰 株式ニュース（総合）",url:"https://finance.yahoo.co.jp/news",desc:"国内外の最新株式ニュース"},
    {label:"🇯🇵 日本株ニュース",url:"https://finance.yahoo.co.jp/news/stocks",desc:"日本株関連ニュース"},
    {label:"🇺🇸 米国株ニュース",url:"https://finance.yahoo.co.jp/news/world",desc:"米国株・Wall Street最新情報"},
    {label:"🌍 マーケット概況",url:"https://finance.yahoo.co.jp/stocks",desc:"日本株式市場の概況"},
    {label:"🏦 経済ニュース",url:"https://finance.yahoo.co.jp/news",desc:"金融・経済の最新ニュース"},
  ];
  return(<div style={{background:"#050e1c",border:"1px solid #0f2040",borderRadius:10,overflow:"hidden"}}><div style={{background:"#071428",borderBottom:"1px solid #0f2040",padding:"12px 16px",display:"flex",alignItems:"center",justifyContent:"space-between"}}><div style={{fontSize:13,fontWeight:700,color:"#e0f0ff"}}>📰 ニュース・リンク集</div><span style={{fontSize:10,color:"#2a6090"}}>Yahoo!ファイナンス</span></div><div style={{padding:"8px"}}>{NEWS.map(function(item,i){return(<a key={i} href={item.url} target="_blank" rel="noreferrer" style={{display:"flex",flexDirection:"column",padding:"12px 14px",margin:"4px 0",background:"#071428",border:"1px solid #1e3050",borderRadius:8,textDecoration:"none",gap:4}}><span style={{fontSize:13,fontWeight:700,color:"#93c5fd"}}>{item.label}</span><span style={{fontSize:10,color:"#4a7090"}}>{item.desc}</span></a>);})}</div></div>);
}

// ── Trend Panel ───────────────────────────────────────────────────────────────
function TrendPanel() {
  var cs=useState(0); var openCat=cs[0],setOpenCat=cs[1];
  return(<div style={{background:"#050e1c",border:"1px solid #0f2040",borderRadius:10,overflow:"hidden"}}><div style={{background:"#071428",borderBottom:"1px solid #0f2040",padding:"10px 14px"}}><div style={{fontSize:12,fontWeight:700,color:"#e0f0ff"}}>🔥 トレンド・ランキング</div></div>{TREND_LINKS.map(function(cat,ci){var isOpen=openCat===ci;return(<div key={ci}><div onClick={function(){setOpenCat(isOpen?-1:ci);}} style={{padding:"10px 14px",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid #0a1828",background:isOpen?"#071a2e":"transparent"}}><span style={{fontSize:12,fontWeight:700,color:"#b8cce0"}}>{cat.category}</span><span style={{fontSize:10,color:"#2a6090"}}>{isOpen?"▲":"▼"}</span></div>{isOpen&&<div style={{background:"#040c18",borderBottom:"1px solid #0a1828"}}>{cat.links.map(function(link,li){return(<a key={li} href={link.url} target="_blank" rel="noreferrer" style={{display:"flex",alignItems:"center",padding:"9px 20px",borderBottom:"1px solid #0a1828",textDecoration:"none",gap:8}}><span style={{fontSize:10,color:"#22d3a0"}}>→</span><span style={{fontSize:12,color:"#93c5fd"}}>{link.label}</span></a>);})}</div>}</div>);})}</div>);
}


// ── Sync Panel ────────────────────────────────────────────────────────────────
function SyncPanel(p) {
  var userId=p.userId, syncStatus=p.syncStatus;
  var copyStatusS=useState(null); var copyStatus=copyStatusS[0],setCopyStatus=copyStatusS[1];

  function copyUserId(){
    if(navigator.clipboard){ navigator.clipboard.writeText(userId).then(function(){ setCopyStatus("ok"); setTimeout(function(){setCopyStatus(null);},2000); }); }
    else{ prompt("ユーザーID（コピーしてください）",userId); }
  }

  var favCount=(function(){try{return JSON.parse(localStorage.getItem("fav_tickers")||"[]").length;}catch(e){return 0;}})();
  var portCount=(function(){try{return JSON.parse(localStorage.getItem("portfolio_v1")||"[]").length;}catch(e){return 0;}})();

  return(
    <div>
      <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:10,padding:"12px 16px",marginBottom:16}}>
        <div style={{fontSize:12,fontWeight:700,color:"#e0f0ff",marginBottom:4}}>🔄 デバイス間データ同期</div>
        <div style={{fontSize:10,color:"#4a7090"}}>お気に入りとポートフォリオはサーバーに自動保存されます。同じユーザーIDを別デバイスで使うと同期できます。</div>
      </div>

      {/* 同期状態 */}
      <div style={{background:"#050e1c",border:"1px solid #1e3050",borderRadius:10,padding:"14px 16px",marginBottom:14}}>
        <div style={{fontSize:11,fontWeight:700,color:"#b8cce0",marginBottom:10}}>📊 同期状態</div>
        <div style={{display:"flex",gap:12,marginBottom:14,flexWrap:"wrap"}}>
          <div style={{background:"#071428",borderRadius:8,padding:"10px 16px"}}><div style={{fontSize:9,color:"#2a6090"}}>お気に入り</div><div style={{fontSize:18,fontWeight:800,color:"#fbbf24"}}>{favCount}銘柄</div></div>
          <div style={{background:"#071428",borderRadius:8,padding:"10px 16px"}}><div style={{fontSize:9,color:"#2a6090"}}>ポートフォリオ</div><div style={{fontSize:18,fontWeight:800,color:"#22d3a0"}}>{portCount}銘柄</div></div>
          <div style={{background:syncStatus==="ok"?"#052e16":syncStatus==="error"?"#1f0010":"#071428",border:"1px solid "+(syncStatus==="ok"?"#22d3a0":syncStatus==="error"?"#f43f5e":"#1e3050"),borderRadius:8,padding:"10px 16px"}}>
            <div style={{fontSize:9,color:"#2a6090"}}>サーバー同期</div>
            <div style={{fontSize:13,fontWeight:700,color:syncStatus==="ok"?"#22d3a0":syncStatus==="error"?"#f43f5e":"#4a7090"}}>{syncStatus==="ok"?"✅ 完了":syncStatus==="error"?"❌ エラー":"⏳ 待機中"}</div>
          </div>
        </div>

        {/* ユーザーID */}
        <div style={{background:"#040c18",border:"1px solid #1e4070",borderRadius:8,padding:"12px 14px"}}>
          <div style={{fontSize:10,color:"#4a7090",marginBottom:6}}>🔑 あなたのユーザーID</div>
          <div style={{fontSize:13,fontWeight:700,color:"#b8cce0",fontFamily:"monospace",marginBottom:8,wordBreak:"break-all"}}>{userId}</div>
          <button onClick={copyUserId} style={{width:"100%",background:"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:6,color:"#fff",padding:"8px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>
            📋 IDをコピー
          </button>
          {copyStatus==="ok"&&<div style={{fontSize:10,color:"#22d3a0",textAlign:"center",marginTop:6}}>✅ コピーしました</div>}
        </div>
      </div>

      {/* 別デバイスで使う方法 */}
      <div style={{background:"#071428",border:"1px solid #0f2040",borderRadius:8,padding:"12px 14px"}}>
        <div style={{fontSize:10,color:"#4a7090",marginBottom:8,fontWeight:700}}>📱 別デバイスで同じデータを使う方法</div>
        {[
          ["1","「IDをコピー」をタップ"],
          ["2","iPhoneでアプリを開く"],
          ["3","🔄 同期タブ → 「IDを入力して同期」に貼り付け"],
          ["4","「このIDで同期」をタップ → 自動でデータが反映"],
        ].map(function(row){
          return(<div key={row[0]} style={{display:"flex",gap:10,marginBottom:6,alignItems:"flex-start"}}>
            <span style={{background:"#0ea5e9",color:"#fff",borderRadius:"50%",width:18,height:18,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:700,flexShrink:0}}>{row[0]}</span>
            <span style={{fontSize:11,color:"#b8cce0"}}>{row[1]}</span>
          </div>);
        })}
      </div>

      {/* ID入力で同期 */}
      <IdSyncBox/>
    </div>
  );
}

function IdSyncBox() {
  var inputS=useState(""); var input=inputS[0],setInput=inputS[1];
  var statusS=useState(null); var status=statusS[0],setStatus=statusS[1];
  var SYNC_API="https://daytrade-simulator.vercel.app/api/sync";

  async function syncById(){
    var id=input.trim();
    if(!id) return;
    setStatus("loading");
    try {
      var res=await fetch(SYNC_API+"?userId="+id);
      var data=await res.json();
      if(!data.favs) throw new Error("invalid");
      localStorage.setItem("fav_tickers",JSON.stringify(data.favs));
      localStorage.setItem("portfolio_v1",JSON.stringify(data.portfolio));
      localStorage.setItem("daytrade_user_id",id);
      setStatus("ok");
      setTimeout(function(){ window.location.reload(); },1500);
    } catch(e){
      setStatus("error");
      setTimeout(function(){setStatus(null);},2000);
    }
  }

  return(
    <div style={{background:"#050e1c",border:"1px solid #1e3050",borderRadius:10,padding:"14px 16px",marginTop:14}}>
      <div style={{fontSize:11,fontWeight:700,color:"#b8cce0",marginBottom:8}}>🔗 IDを入力して同期</div>
      <div style={{display:"flex",gap:8}}>
        <input style={{background:"#071428",border:"1px solid #1e3050",borderRadius:6,color:"#b8cce0",padding:"8px 10px",fontSize:12,fontFamily:"monospace",flex:1}} value={input} placeholder="別デバイスのユーザーIDを貼り付け" onChange={function(e){setInput(e.target.value);}}/>
        <button onClick={syncById} disabled={!input.trim()||status==="loading"} style={{background:input.trim()?"linear-gradient(135deg,#22d3a0,#059669)":"#0a1828",border:"none",borderRadius:8,color:"#fff",padding:"8px 14px",fontSize:11,fontWeight:700,cursor:input.trim()?"pointer":"not-allowed",fontFamily:"monospace",whiteSpace:"nowrap"}}>{status==="loading"?"…":"同期"}</button>
      </div>
      {status==="ok"&&<div style={{fontSize:10,color:"#22d3a0",marginTop:6}}>✅ 同期完了！再読み込みします…</div>}
      {status==="error"&&<div style={{fontSize:10,color:"#f43f5e",marginTop:6}}>❌ IDが見つかりません</div>}
    </div>
  );
}

export default function App() {
  var a=useState([]); var stocks=a[0],setStocks=a[1];
  var b=useState(false); var loading=b[0],setLoading=b[1];
  var c=useState({done:0,total:0}); var progress=c[0],setProgress=c[1];
  var d=useState(null); var openTicker=d[0],setOpenTicker=d[1];
  var e=useState(null); var chartStock=e[0],setChartStock=e[1];
  var f=useState("ALL"); var mktF=f[0],setMktF=f[1];
  var g=useState(null); var ts=g[0],setTs=g[1];
  var h=useState(0); var fbCount=h[0],setFbCount=h[1];
  var k=useState("scanner"); var activeTab=k[0],setActiveTab=k[1];
  var syncStatusS=useState(null); var syncStatus=syncStatusS[0],setSyncStatus=syncStatusS[1];

  // ── ユーザーID（デバイス固有・初回自動生成）────────────────────────────────
  var userId=(function(){
    try{
      var id=localStorage.getItem("daytrade_user_id");
      if(!id){ id="u_"+Math.random().toString(36).slice(2,10); localStorage.setItem("daytrade_user_id",id); }
      return id;
    }catch(e){ return "u_default"; }
  })();

  var SYNC_API="https://daytrade-simulator.vercel.app/api/sync";

  // サーバーに保存
  async function saveToServer(newFavs, newPortfolio) {
    try {
      await fetch(SYNC_API+"?userId="+userId, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({favs:newFavs, portfolio:newPortfolio})
      });
    } catch(e) {}
  }

  // お気に入り
  var favInit=(function(){try{var v=localStorage.getItem("fav_tickers");return v?JSON.parse(v):[];}catch(e){return[];}})();
  var fvS=useState(favInit); var favs=fvS[0],setFavs=fvS[1];

  function toggleFav(ticker){
    setFavs(function(prev){
      var next=prev.indexOf(ticker)>=0?prev.filter(function(t){return t!==ticker;}):prev.concat([ticker]);
      try{localStorage.setItem("fav_tickers",JSON.stringify(next));}catch(e){}
      var port=(function(){try{return JSON.parse(localStorage.getItem("portfolio_v1")||"[]");}catch(e){return[];}})();
      saveToServer(next, port);
      return next;
    });
  }
  function isFav(ticker){ return favs.indexOf(ticker)>=0; }

  // 起動時にサーバーからデータ取得
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
        setSyncStatus("ok");
        setTimeout(function(){setSyncStatus(null);},2000);
      })
      .catch(function(){ setSyncStatus("error"); });
  },[]);

  var scan=useCallback(async function(){
    setLoading(true); setOpenTicker(null); setChartStock(null); setFbCount(0);
    setProgress({done:0,total:0,msg:"出来高ランキング取得中…"});
    var universe = (await buildStockUniverse()).slice();

    // お気に入り銘柄をuniverseに追加（未含の場合のみ）
    var favList=(function(){try{var v=localStorage.getItem("fav_tickers");return v?JSON.parse(v):[];}catch(e){return[];}})();
    var uTickers=universe.map(function(s){return s.ticker;});
    favList.forEach(function(ticker){
      if(uTickers.indexOf(ticker)<0){
        var isJP=ticker.endsWith(".T");
        var code=ticker.replace(".T","");
        universe.push({ticker:ticker,name:code,market:isJP?"JP":"US",tvSymbol:(isJP?"TSE:":"NASDAQ:")+code});
      }
    });

    setProgress({done:0,total:universe.length,msg:null});
    var results=[],fb=0,BATCH=6;
    for(var i=0;i<universe.length;i+=BATCH){
      var batch=universe.slice(i,i+BATCH);
      await Promise.all(batch.map(async function(stock){
        var pd; try{pd=await fetchYahoo(stock.ticker);}catch(err){pd=genSim(stock.ticker);fb++;}
        results.push(analyzeStock(stock,pd));
        setProgress(function(p){return{done:p.done+1,total:p.total,msg:null};});
      }));
      if(i+BATCH<universe.length) await new Promise(function(r){setTimeout(r,300);});
    }
    results.sort(function(x,y){return y.score-x.score;});
    setStocks(results); setFbCount(fb);
    setTs(new Date().toLocaleTimeString("ja-JP")); setLoading(false);
  },[]);

  var displayed=stocks.filter(function(s){return mktF==="ALL"||s.market===mktF;});
  var realCount=stocks.filter(function(s){return s.real;}).length;
  function cnt(t){return stocks.filter(function(s){return s.timing===t;}).length;}

  // 起動時に自動スキャン
  useEffect(function(){ scan(); }, []);

  var TABS=[["scanner","📊"],["fav","⭐"],["portfolio","💼"],["backtest","📈"],["ipo","🚀"],["news","📰"],["trend","🔥"],["sync","🔄"]];
  var TAB_LABELS={"scanner":"スキャナー","fav":"お気に入り","portfolio":"ポートフォリオ","backtest":"バックテスト","ipo":"IPO","news":"ニュース","trend":"トレンド","sync":"同期"};

  return(
    <div style={{minHeight:"100vh",background:"#040c18",fontFamily:"'JetBrains Mono','IBM Plex Mono',monospace",color:"#b8cce0",display:"flex"}}>
      <ChartModal stock={chartStock} onClose={function(){setChartStock(null);}}/>

      {/* 左サイドバー タブ */}
      <div style={{width:56,background:"#050f20",borderRight:"1px solid #0f2040",display:"flex",flexDirection:"column",alignItems:"center",paddingTop:10,gap:4,flexShrink:0,position:"sticky",top:0,height:"100vh",overflowY:"auto"}}>
        {TABS.map(function(tab){
          var active=activeTab===tab[0];
          return(
            <button key={tab[0]} onClick={function(){setActiveTab(tab[0]);}} title={TAB_LABELS[tab[0]]} style={{width:44,height:44,background:active?"#0ea5e9":"transparent",border:"1px solid "+(active?"#0ea5e9":"transparent"),borderRadius:8,color:active?"#fff":"#4a6080",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transition:"all .15s"}}>
              {tab[1]}
            </button>
          );
        })}
      </div>

      {/* メインコンテンツ */}
      <div style={{flex:1,display:"flex",flexDirection:"column",minWidth:0}}>
        {/* Header */}
        <div style={{background:"linear-gradient(180deg,#071428,#050f20)",borderBottom:"1px solid #0f2040",padding:"10px 14px",position:"sticky",top:0,zIndex:10}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,flexWrap:"wrap"}}>
            <div>
              <div style={{fontSize:8,letterSpacing:2,color:"#2a6090",marginBottom:1}}>S&P500 · VTI · Most Active</div>
              <div style={{fontSize:15,fontWeight:800,color:"#e0f0ff"}}>デイトレード シミュレーター <span style={{fontSize:11,color:"#4a7090",fontWeight:400}}>/ {TAB_LABELS[activeTab]}</span></div>
            </div>
            {activeTab==="scanner"&&<button onClick={scan} disabled={loading} style={{background:loading?"#0a1828":"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:8,color:"#fff",padding:"8px 16px",fontSize:11,fontWeight:700,cursor:loading?"not-allowed":"pointer",fontFamily:"monospace"}}>{loading?"取得中…":stocks.length===0?"▶ スキャン":"▶ 再スキャン"}</button>}
          </div>
          {loading&&<div style={{marginTop:8}}><div style={{fontSize:10,color:"#4a7090",marginBottom:3}}>{progress.msg||("分析中… "+progress.done+" / "+progress.total+" 銘柄")}</div><div style={{background:"#0a1828",borderRadius:4,height:3}}><div style={{background:"linear-gradient(90deg,#0ea5e9,#22d3a0)",height:3,borderRadius:4,width:(progress.total?(progress.done/progress.total)*100:10)+"%",transition:"width .3s"}}/></div></div>}
          {!loading&&stocks.length>0&&activeTab==="scanner"&&(
            <div style={{display:"flex",gap:6,marginTop:8,flexWrap:"wrap",alignItems:"center"}}>
              {[["実データ",realCount+"銘柄","#22d3a0"],["買い",cnt("BUY"),"#22d3a0"],["様子見",cnt("WATCH"),"#fbbf24"],["見送り",cnt("SKIP"),"#f43f5e"],["更新",ts,"#4a90c0"]].map(function(item){
                return(<div key={item[0]} style={{background:"#071428",border:"1px solid #0f2040",borderRadius:6,padding:"3px 8px"}}><div style={{fontSize:8,color:"#2a6090"}}>{item[0]}</div><div style={{fontSize:12,fontWeight:700,color:item[2]}}>{item[1]}</div></div>);
              })}
              <div style={{marginLeft:"auto",display:"flex",gap:4}}>
                <TabBtn label="全" active={mktF==="ALL"} onClick={function(){setMktF("ALL");}} color="#4a90c0"/>
                <TabBtn label="🇺🇸" active={mktF==="US"} onClick={function(){setMktF("US");}} color="#3b82f6"/>
                <TabBtn label="🇯🇵" active={mktF==="JP"} onClick={function(){setMktF("JP");}} color="#f87171"/>
              </div>
            </div>
          )}
          {!loading&&fbCount>0&&activeTab==="scanner"&&<div style={{marginTop:4,background:"#1a1200",border:"1px solid #7c6010",borderRadius:6,padding:"3px 8px",fontSize:10,color:"#fbbf24"}}>⚠ {fbCount} 銘柄はSIMデータで表示</div>}
        </div>

        {/* Content */}
        <div style={{flex:1,padding:"12px 14px 60px",overflowY:"auto"}}>

          {/* Scanner + Cross 統合 */}
          {activeTab==="scanner"&&(
            <div>
              {!loading&&stocks.length===0&&(
                <div style={{textAlign:"center",padding:"80px 20px",color:"#2a6090"}}>
                  <div style={{fontSize:40,marginBottom:16}}>📡</div>
                  <div style={{fontSize:14,color:"#4a90c0",marginBottom:8}}>約50銘柄を5指標で分析</div>
                  <button onClick={scan} style={{background:"linear-gradient(135deg,#0ea5e9,#0369a1)",border:"none",borderRadius:8,color:"#fff",padding:"12px 28px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"monospace",marginTop:16}}>▶ スキャン開始</button>
                </div>
              )}
              {loading&&<div style={{textAlign:"center",padding:"60px 0",color:"#2a6090",fontSize:11}}>ランキング取得 → 分析中…</div>}
              {!loading&&displayed.length>0&&(
                <div>
                  <div style={{display:"flex",flexDirection:"column",gap:8}}>
                  {displayed.map(function(s){
                    var bc=BADGE[s.timing],mc=MKT[s.market],isUp=parseFloat(s.change)>=0,isOpen=openTicker===s.ticker;
                    var cross=classifyStockFn(s);
                    return(
                      <div key={s.ticker}>
                        <div onClick={function(){setOpenTicker(isOpen?null:s.ticker);}} style={{background:isOpen?"#071a2e":"#050e1c",border:"1px solid "+(isOpen?"#1e4070":"#0f2040"),borderRadius:isOpen?"10px 10px 0 0":10,padding:"10px 12px",cursor:"pointer",display:"grid",gridTemplateColumns:"48px 1fr auto",gap:10,alignItems:"center"}}>
                          <ScoreRing score={s.score}/>
                          <div>
                            <div style={{display:"flex",gap:5,alignItems:"center",flexWrap:"wrap"}}>
                              <span style={bStyle(mc.bg,mc.border,mc.text)}>{mc.label}</span>
                              <span style={{fontSize:14,fontWeight:800,color:"#d8eeff"}}>{s.ticker.replace(".T","")}</span>
                              <span style={{fontSize:11,color:"#4a7090"}}>{s.name}</span>
                              <span style={bStyle(bc.bg,bc.border,bc.text)}>{bc.label}</span>
                              {!s.real&&<span style={bStyle("#1a1200","#7c6010","#fbbf24")}>SIM</span>}
                              {cross&&cross.type!=="NONE"&&<span style={bStyle(cross.bg,cross.border,cross.color)}>{cross.label}</span>}
                            </div>
                            <div style={{display:"flex",gap:10,marginTop:4,flexWrap:"wrap"}}>
                              <span style={{fontSize:11,color:"#2a6090"}}>価格 <span style={{color:"#b8cce0"}}>{s.price}</span></span>
                              <span style={{fontSize:11,color:"#2a6090"}}>勝率 <span style={{color:"#22d3a0",fontWeight:700}}>{s.winRate}%</span></span>
                              <span style={{fontSize:11,color:"#2a6090"}}>期待値 <span style={{fontWeight:700,color:parseFloat(s.expVal)>=0?"#22d3a0":"#f43f5e"}}>{s.expVal}%</span></span>
                              <span style={{fontSize:11,fontWeight:700,color:isUp?"#22d3a0":"#f43f5e"}}>{isUp?"▲":"▼"} {Math.abs(s.change)}%</span>
                            </div>
                          </div>
                          <div style={{textAlign:"right",display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4}}>
                            <button onClick={function(ev){ev.stopPropagation();toggleFav(s.ticker);}} style={{background:"transparent",border:"none",fontSize:16,cursor:"pointer",lineHeight:1,padding:2}}>{isFav(s.ticker)?"⭐":"☆"}</button>
                            <Sparkline data={s.spark} up={isUp}/>
                            <div style={{fontSize:9,color:"#1a3050"}}>{isOpen?"▲":"▼"}</div>
                          </div>
                        </div>
                        {isOpen&&(
                          <div style={{background:"#040c18",border:"1px solid #1e4070",borderTop:"none",borderRadius:"0 0 10px 10px",padding:"12px 14px"}}>
                            {cross&&cross.type!=="NONE"&&(<div style={{background:cross.bg,border:"1px solid "+cross.border,borderRadius:8,padding:"8px 12px",marginBottom:10,display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:16}}>{cross.type==="GC_NOW"?"🔥":cross.type==="DC_NOW"?"💀":cross.type==="GC_NEAR"?"⚡":cross.type==="DC_NEAR"?"⚠":"👀"}</span><div><div style={{fontSize:11,fontWeight:800,color:cross.color}}>{cross.label}</div><div style={{fontSize:10,color:"#4a7090"}}>{cross.desc}</div></div></div>)}
                            <div style={{fontSize:10,color:"#2a6090",letterSpacing:2,marginBottom:8}}>── 5指標　{s.real?"（✓ リアルデータ）":"（⚠ SIM）"}</div>
                            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:5,marginBottom:10}}>
                              {s.signals.map(function(sig){ var c=sig.state===1?"#22d3a0":sig.state===-1?"#f43f5e":"#94a3b8"; return(<div key={sig.label} style={{background:"#071428",border:"1px solid "+c+"30",borderRadius:6,padding:"6px 8px"}}><div style={{fontSize:9,color:"#2a6090",marginBottom:2}}>{sig.label}</div><div style={{fontSize:11,fontWeight:700,color:c}}>{sig.val}</div></div>); })}
                            </div>
                            <div style={{background:bc.bg,border:"1px solid "+bc.border+"50",borderRadius:8,padding:"8px 12px",marginBottom:8}}>
                              <div style={{fontSize:9,color:"#2a6090",marginBottom:2}}>総合判断</div>
                              <div style={{fontSize:11,fontWeight:700,color:bc.text}}>
                                {s.timing==="BUY"&&"✅ 買いタイミング — スコア "+s.score+"/100 · 勝率 "+s.winRate+"% · 期待値 "+s.expVal+"%"}
                                {s.timing==="WATCH"&&"👁 エントリー待機 — 複数指標が中立"}
                                {s.timing==="SKIP"&&"⛔ 見送り推奨 — 複数指標が弱気"}
                              </div>
                            </div>
                            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                              <a href={"https://www.tradingview.com/chart/?symbol="+encodeURIComponent(s.tvSymbol)+"&interval=D"} target="_blank" rel="noreferrer" style={{background:"linear-gradient(135deg,#0d2d4a,#0a1f38)",border:"1px solid #1e6090",borderRadius:8,color:"#4a90c0",padding:"9px 8px",fontSize:11,fontWeight:700,fontFamily:"monospace",textDecoration:"none",textAlign:"center",display:"block"}}>📈 TradingView</a>
                              <a href={s.yahooUrl} target="_blank" rel="noreferrer" style={{background:"linear-gradient(135deg,#1a0a2e,#0f0a20)",border:"1px solid #6366f1",borderRadius:8,color:"#a5b4fc",padding:"9px 8px",fontSize:11,fontWeight:700,fontFamily:"monospace",textDecoration:"none",textAlign:"center",display:"block"}}>🔗 Yahoo!</a>
                            </div>
                          </div>
                        )}
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab==="fav"&&<FavPanel stocks={stocks} favs={favs} toggleFav={toggleFav} onChart={function(s){setChartStock(s);}} onScan={scan} loading={loading}/>}
          {activeTab==="portfolio"&&<PortfolioPanel stocks={stocks}/>}
          {activeTab==="backtest"&&<BacktestPanel stocks={stocks} favs={favs}/>}
          {activeTab==="ipo"&&<IpoPanel/>}
          {activeTab==="news"&&<NewsPanel/>}
          {activeTab==="trend"&&<TrendPanel/>}
          {activeTab==="sync"&&<SyncPanel userId={userId} syncStatus={syncStatus}/>}
        </div>
      </div>
    </div>
  );
}
