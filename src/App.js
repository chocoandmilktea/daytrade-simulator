// App.js
// スキャルピング・デイトレ特化スクリーナー
// タブ: 全銘柄 / お気に入り / 指数リンク / 市場予測 / デバイス同期

import { useState, useEffect, useCallback } from "react";
import { analyzeStock } from "./calc/score";
import StockCard from "./components/StockCard";
import StockDetail from "./components/StockDetail";

// ── 定数 ─────────────────────────────────────────────────────────────────────
var VERCEL_API   = "https://daytrade-simulator.vercel.app/api/stock";
var RANKING_API  = "https://daytrade-simulator.vercel.app/api/ranking";
var SYNC_API     = "https://daytrade-simulator.vercel.app/api/sync";
var NOTIFY_API   = "https://daytrade-simulator.vercel.app/api/notify";
var AI_API       = "https://daytrade-simulator.vercel.app/api/ai";
var CACHE = {}, CACHE_TTL = 30 * 60 * 1000;

// ── ランキング取得 ────────────────────────────────────────────────────────────
async function fetchRanking(market) {
  try {
    var res = await fetch(RANKING_API + "?market=" + market, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error("ranking " + res.status);
    var json = await res.json();
    return (json.stocks || []).map(function(s) {
      return { ticker:s.ticker, name:s.name, market:s.market, tvSymbol:s.tvSymbol,
               volume:s.volume||0, change:s.change||0, avgVolume:s.avgVolume||0 };
    });
  } catch(e) { return []; }
}

async function buildStockUniverse() {
  var [us, jp] = await Promise.all([fetchRanking("us"), fetchRanking("jp")]);
  var seen = {}, out = [];
  us.concat(jp).forEach(function(s) {
    if (!seen[s.ticker]) { seen[s.ticker] = true; out.push(s); }
  });
  return out;
}

// ── Yahoo Finance 日足取得 ───────────────────────────────────────────────────
async function fetchYahoo(ticker) {
  var now = Date.now();
  if (CACHE[ticker] && now - CACHE[ticker].ts < CACHE_TTL) {
    var c = CACHE[ticker].data;
    return { closes:c.closes.slice(), highs:c.highs.slice(), lows:c.lows.slice(),
             volumes:c.volumes.slice(), currentPrice:c.currentPrice,
             previousClose:c.previousClose, real:c.real };
  }
  var res = await fetch(VERCEL_API + "?ticker=" + encodeURIComponent(ticker) + "&range=1y",
    { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error("HTTP " + res.status);
  var json = await res.json();
  var result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result) throw new Error("empty");
  var q = result.indicators.quote[0], meta = result.meta;
  function fill(arr) {
    var out = (arr || []).slice();
    for (var i = 0; i < out.length; i++) if (out[i] == null) out[i] = i > 0 ? out[i-1] : 0;
    return out;
  }
  var closes = fill(q.close), highs = fill(q.high), lows = fill(q.low), volumes = fill(q.volume);
  var validCloses = closes.filter(function(v){ return v > 0; });
  var previousClose = validCloses.length >= 2
    ? validCloses[validCloses.length - 2]
    : (meta.chartPreviousClose || 0);
  var data = { closes, highs, lows, volumes,
    currentPrice: meta.regularMarketPrice || closes[closes.length-1],
    previousClose, real: true };
  CACHE[ticker] = { ts: now, data };
  return { closes:data.closes.slice(), highs:data.highs.slice(), lows:data.lows.slice(),
           volumes:data.volumes.slice(), currentPrice:data.currentPrice,
           previousClose:data.previousClose, real:data.real };
}

// フォールバック用シミュレーションデータ
function genSim(ticker) {
  var h = 0;
  for (var i = 0; i < ticker.length; i++) h = (Math.imul(31,h) + ticker.charCodeAt(i)) | 0;
  var s = Math.abs(h);
  function rng(){ s = (s*1664525+1013904223) & 0x7fffffff; return s/0x7fffffff; }
  var price = rng()*400+60, closes = [], highs = [], lows = [], volumes = [];
  for (var d = 0; d < 252; d++) {
    var v = rng()*0.025;
    price = Math.max(5, price*(1 + rng()*0.006 - 0.003 + (rng()-0.5)*v));
    closes.push(price); highs.push(price*(1+rng()*0.008));
    lows.push(price*(1-rng()*0.008)); volumes.push(Math.floor(rng()*1000000+100000));
  }
  return { closes, highs, lows, volumes, currentPrice:price,
           previousClose:closes[closes.length-2], real:false };
}

// ── MarketHours ──────────────────────────────────────────────────────────────
function MarketHours() {
  var [now, setNow] = useState(new Date());
  useEffect(function() {
    var t = setInterval(function(){ setNow(new Date()); }, 30000);
    return function(){ clearInterval(t); };
  }, []);
  var jst = new Date(now.getTime() + 9*60*60*1000);
  var h = jst.getUTCHours(), m = jst.getUTCMinutes(), dow = jst.getUTCDay();
  var tm = h*60+m;
  var jpAm = dow>=1&&dow<=5 && tm>=540&&tm<690;
  var jpPm = dow>=1&&dow<=5 && tm>=750&&tm<930;
  var jpOpen = jpAm || jpPm;
  var mo = jst.getUTCMonth()+1, dy = jst.getUTCDate();
  var isSummer = (mo>3&&mo<11)||(mo===3&&dy>=8)||(mo===11&&dy<=7);
  var usStart = isSummer ? 22*60+30 : 23*60+30;
  var usEnd   = isSummer ? 5*60 : 6*60;
  var usOpen  = dow>=1&&dow<=5 && (tm>=usStart||tm<usEnd);
  var usLabel = isSummer ? "22:30〜翌5:00" : "23:30〜翌6:00";
  var season  = isSummer ? "[夏]" : "[冬]";
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:2, alignItems:"flex-end" }}>
      <div style={{ display:"flex", gap:10 }}>
        <span style={{ fontSize:10, color:jpOpen?"#22d3a0":"#4a7090",
          fontWeight:jpOpen?700:400, whiteSpace:"nowrap" }}>
          🇯🇵 9:00〜11:30
        </span>
        <span style={{ fontSize:10, color:usOpen?"#22d3a0":"#4a7090",
          fontWeight:usOpen?700:400, whiteSpace:"nowrap" }}>
          🇺🇸 {usLabel} {season}
        </span>
      </div>
      <div style={{ display:"flex", gap:10 }}>
        <span style={{ fontSize:10, color:jpPm?"#22d3a0":"#4a7090",
          fontWeight:jpPm?700:400, whiteSpace:"nowrap" }}>
          🇯🇵 12:30〜15:30
        </span>
      </div>
    </div>
  );
}

// ── MarketBar（指数バー・画像1スタイル） ──────────────────────────────────────
function MarketBar() {
  var [data, setData] = useState({});
  var INDICES = [
    { key:"nikkei", ticker:"^N225",    label:"日経平均", prefix:"¥", round:true  },
    { key:"dow",    ticker:"^DJI",     label:"NYダウ",   prefix:"$", round:true  },
    { key:"sp500",  ticker:"^GSPC",    label:"S&P500",  prefix:"",  round:false },
    { key:"usdjpy", ticker:"USDJPY=X", label:"ドル円",   prefix:"¥", round:false },
    { key:"vix",    ticker:"^VIX",     label:"VIX",     prefix:"",  round:false },
  ];
  useEffect(function() {
    Promise.all(INDICES.map(async function(idx) {
      try {
        var res = await fetch(VERCEL_API+"?ticker="+encodeURIComponent(idx.ticker),
          { signal:AbortSignal.timeout(8000) });
        var json = await res.json();
        var meta = json?.chart?.result?.[0]?.meta;
        if (!meta) return { key:idx.key, error:true, label:idx.label };
        var price = meta.regularMarketPrice||0;
        var prev  = meta.chartPreviousClose||price;
        var change = prev ? ((price-prev)/prev*100).toFixed(2) : "0.00";
        return { key:idx.key, price, change, label:idx.label, prefix:idx.prefix, round:idx.round };
      } catch(e) { return { key:idx.key, error:true, label:idx.label }; }
    })).then(function(results) {
      var obj = {};
      results.forEach(function(r){ obj[r.key] = r; });
      setData(obj);
    });
  }, []);
  return (
    <div style={{ display:"flex", gap:6, overflowX:"auto",
      WebkitOverflowScrolling:"touch" }}>
      {INDICES.map(function(idx) {
        var d = data[idx.key];
        var isVix = idx.key === "vix";
        if (!d || d.error) return (
          <div key={idx.key} style={{ flexShrink:0, minWidth:100,
            background:"#071428", border:"1px solid #0f2040",
            borderRadius:6, padding:"6px 14px" }}>
            <div style={{ fontSize:10, color:"#2a6090", marginBottom:2 }}>{idx.label}</div>
            <div style={{ fontSize:18, color:"#1e3050", fontWeight:800 }}>─</div>
          </div>
        );
        var isUp = parseFloat(d.change) >= 0;
        var vixAlert = isVix && d.price >= 20;
        var price = idx.key === "sp500"
          ? parseFloat(d.price).toFixed(0)
          : idx.key === "usdjpy"
            ? parseFloat(d.price).toFixed(2)
            : idx.key === "vix"
              ? parseFloat(d.price).toFixed(2)
              : Math.round(d.price).toLocaleString();
        return (
          <div key={idx.key} style={{ flexShrink:0, minWidth:100,
            background:vixAlert?"#1f0010":"#071428",
            border:"1px solid "+(vixAlert?"#f43f5e60":"#0f2040"),
            borderRadius:6, padding:"6px 14px" }}>
            <div style={{ fontSize:10, color:vixAlert?"#f43f5e":"#4a7090", marginBottom:2 }}>
              {idx.label}{vixAlert?" ⚠":""}
            </div>
            <div style={{ fontSize:18, fontWeight:800, color:vixAlert?"#f43f5e":"#d8eeff",
              lineHeight:1.2, letterSpacing:-0.5 }}>
              {d.prefix}{price}
            </div>
            <div style={{ fontSize:11, fontWeight:700,
              color:isUp?"#22d3a0":"#f43f5e", marginTop:1 }}>
              {isUp?"▲":"▼"}{Math.abs(d.change)}%
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── AllStocksPanel ────────────────────────────────────────────────────────────
function AllStocksPanel({ stocks, loading, progress, ts, vix, usdJpy,
  favs, toggleFav, onScan, selectedStock, setSelectedStock }) {
  var [mkt, setMkt] = useState("ALL");
  var [sort, setSort] = useState("score");
  var isMobile = window.innerWidth < 768;

  var displayed = stocks
    .filter(function(s){ return mkt==="ALL" || s.market===mkt; })
    .slice()
    .sort(function(a,b){
      if (sort === "score")  return b.score - a.score;
      if (sort === "change") return parseFloat(b.change) - parseFloat(a.change);
      return 0;
    });

  function fBtn(val, label, color) {
    var active = mkt === val;
    return (
      <button onClick={function(){ setMkt(val); }}
        style={{ background:active?color+"20":"transparent",
          border:"1px solid "+(active?color:"#1e3050"),
          borderRadius:6, color:active?color:"#4a6080",
          padding:"3px 10px", fontSize:11, cursor:"pointer",
          fontFamily:"monospace", fontWeight:active?700:400 }}>
        {label}
      </button>
    );
  }
  function sBtn(val, label) {
    var active = sort === val;
    return (
      <button onClick={function(){ setSort(val); }}
        style={{ background:active?"#0ea5e920":"transparent",
          border:"1px solid "+(active?"#0ea5e9":"#1e3050"),
          borderRadius:6, color:active?"#0ea5e9":"#4a6080",
          padding:"3px 8px", fontSize:11, cursor:"pointer",
          fontFamily:"monospace", fontWeight:active?700:400 }}>
        {label}
      </button>
    );
  }

  var cardList = (
    <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
      {displayed.map(function(s) {
        return (
          <StockCard key={s.ticker} s={s}
            isFav={favs.indexOf(s.ticker) >= 0}
            toggleFav={toggleFav}
            usdJpy={usdJpy}
            isSelected={!isMobile && selectedStock && selectedStock.ticker === s.ticker}
            onSelect={function(){
              if (isMobile) return;
              setSelectedStock(s);
            }}
          />
        );
      })}
      {displayed.length === 0 && !loading && (
        <div style={{ textAlign:"center", padding:"40px", color:"#4a7090", fontSize:13 }}>
          該当する銘柄がありません
        </div>
      )}
    </div>
  );

  return (
    <div style={{ display:"flex", flexDirection:"column",
      height:"100%", overflow:"hidden" }}>
      {/* スキャンボタン・進捗 */}
      <div style={{ background:"#071428", border:"1px solid #0f2040",
        borderRadius:10, padding:"10px 14px", marginBottom:8, flexShrink:0 }}>
        <div style={{ display:"flex", justifyContent:"space-between",
          alignItems:"center", gap:8 }}>
          <div>
            {ts && <div style={{ fontSize:11, color:"#2a6090" }}>更新: {ts}</div>}
            {progress.msg && (
              <div style={{ fontSize:11, color:"#4a90c0" }}>{progress.msg}</div>
            )}
            {!progress.msg && progress.total > 0 && (
              <div style={{ fontSize:11, color:"#4a90c0" }}>
                {progress.done}/{progress.total} 分析中...
              </div>
            )}
          </div>
          <button onClick={onScan} disabled={loading}
            style={{ background:loading?"#0a1828":"linear-gradient(135deg,#0ea5e9,#0369a1)",
              border:"none", borderRadius:8, color:"#fff",
              padding:"8px 16px", fontSize:13, fontWeight:700,
              cursor:loading?"not-allowed":"pointer", fontFamily:"monospace",
              flexShrink:0 }}>
            {loading ? "スキャン中..." : "🔍 スキャン"}
          </button>
        </div>
        {loading && progress.total > 0 && (
          <div style={{ background:"#0a1828", borderRadius:3, height:4,
            marginTop:8, overflow:"hidden" }}>
            <div style={{ background:"#0ea5e9", height:4,
              width:(progress.done/progress.total*100)+"%",
              transition:"width 0.3s" }} />
          </div>
        )}
      </div>

      {/* フィルター＋ソート */}
      <div style={{ display:"flex", gap:6, alignItems:"center",
        marginBottom:8, flexWrap:"nowrap", overflowX:"auto",
        WebkitOverflowScrolling:"touch", flexShrink:0 }}>
        {fBtn("ALL","全銘柄","#60a5fa")}
        {fBtn("US","🇺🇸 US","#3b82f6")}
        {fBtn("JP","🇯🇵 JP","#f87171")}
        <span style={{ width:1, height:16, background:"#1e3050", flexShrink:0 }} />
        {sBtn("score","スコア順")}
        {sBtn("change","上昇率順")}
        <span style={{ fontSize:11, color:"#2a6090", marginLeft:"auto",
          flexShrink:0, whiteSpace:"nowrap" }}>{displayed.length}銘柄</span>
      </div>

      {/* 2ペイン（高さ残り全部・各自独立スクロール） */}
      {isMobile ? (
        <div style={{ flex:1, overflowY:"auto", WebkitOverflowScrolling:"touch" }}>
          {cardList}
        </div>
      ) : (
        <div style={{ flex:1, display:"flex", gap:12, minHeight:0 }}>
          <div style={{ width:"40%", flexShrink:0,
            overflowY:"auto", WebkitOverflowScrolling:"touch" }}>
            {cardList}
          </div>
          <div style={{ flex:1,
            overflowY:"auto", WebkitOverflowScrolling:"touch" }}>
            <StockDetail
              s={selectedStock}
              isFav={selectedStock && favs.indexOf(selectedStock.ticker) >= 0}
              toggleFav={toggleFav}
              vix={vix}
              usdJpy={usdJpy}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── FavPanel ─────────────────────────────────────────────────────────────────
function FavPanel({ stocks, favs, toggleFav, vix, usdJpy, selectedStock, setSelectedStock }) {
  var [search, setSearch]     = useState("");
  var [status, setStatus]     = useState(null);
  var [sort, setSort]         = useState("score");
  var isMobile = window.innerWidth < 768;

  var favStocks = stocks
    .filter(function(s){ return favs.indexOf(s.ticker) >= 0; })
    .slice()
    .sort(function(a,b){
      if (sort==="score")  return b.score - a.score;
      if (sort==="change") return parseFloat(b.change) - parseFloat(a.change);
      return 0;
    });

  async function addByTicker() {
    var raw = search.trim().toUpperCase();
    if (!raw) return;
    var ticker = raw.match(/^\d{4}$/) ? raw+".T" : raw;
    if (favs.indexOf(ticker) >= 0) { setStatus("already"); return; }
    setStatus("loading");
    try {
      var res = await fetch(VERCEL_API+"?ticker="+encodeURIComponent(ticker)+"&range=1y",
        { signal:AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error("not found");
      toggleFav(ticker);
      setSearch(""); setStatus("ok");
      setTimeout(function(){ setStatus(null); }, 2000);
    } catch(e) {
      setStatus("error");
      setTimeout(function(){ setStatus(null); }, 2000);
    }
  }

  var statusMsg = { loading:"取得中...", ok:"追加しました",
    error:"見つかりません", already:"登録済みです" }[status] || null;

  var cardList = (
    <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
      {favStocks.map(function(s) {
        return (
          <StockCard key={s.ticker} s={s}
            isFav={true}
            toggleFav={toggleFav}
            usdJpy={usdJpy}
            isSelected={!isMobile && selectedStock && selectedStock.ticker === s.ticker}
            onSelect={function(){ if (!isMobile) setSelectedStock(s); }}
          />
        );
      })}
      {favStocks.length === 0 && (
        <div style={{ textAlign:"center", padding:"30px", color:"#4a7090", fontSize:13 }}>
          ティッカーを入力して追加できます
        </div>
      )}
    </div>
  );

  return (
    <div style={{ display:"flex", flexDirection:"column",
      height:"100%", overflow:"hidden" }}>
      {/* 検索追加 */}
      <div style={{ background:"#050e1c", border:"1px solid #1e3050",
        borderRadius:10, padding:"12px 14px", marginBottom:8, flexShrink:0 }}>
        <div style={{ display:"flex", gap:8 }}>
          <input
            style={{ background:"#071428", border:"1px solid #1e3050",
              borderRadius:6, color:"#b8cce0", padding:"8px 10px",
              fontSize:13, fontFamily:"monospace", flex:1 }}
            value={search} placeholder="AAPL / 7203"
            onChange={function(e){ setSearch(e.target.value); }}
            onKeyDown={function(e){ if(e.key==="Enter") addByTicker(); }}
          />
          <button onClick={addByTicker}
            style={{ background:"linear-gradient(135deg,#0ea5e9,#0369a1)",
              border:"none", borderRadius:8, color:"#fff",
              padding:"8px 14px", fontSize:13, fontWeight:700,
              cursor:"pointer", fontFamily:"monospace" }}>
            追加
          </button>
        </div>
        {statusMsg && (
          <div style={{ fontSize:12, marginTop:6,
            color:status==="ok"?"#22d3a0":"#f43f5e" }}>{statusMsg}</div>
        )}
      </div>

      {/* ソート */}
      {favStocks.length > 0 && (
        <div style={{ display:"flex", gap:6, marginBottom:8, flexShrink:0 }}>
          {["score","change"].map(function(val) {
            var label = val==="score" ? "スコア順" : "上昇率順";
            var active = sort === val;
            return (
              <button key={val} onClick={function(){ setSort(val); }}
                style={{ background:active?"#0ea5e920":"transparent",
                  border:"1px solid "+(active?"#0ea5e9":"#1e3050"),
                  borderRadius:6, color:active?"#0ea5e9":"#4a6080",
                  padding:"3px 8px", fontSize:11, cursor:"pointer",
                  fontFamily:"monospace" }}>
                {label}
              </button>
            );
          })}
        </div>
      )}

      {isMobile ? (
        <div style={{ flex:1, overflowY:"auto", WebkitOverflowScrolling:"touch" }}>
          {cardList}
        </div>
      ) : (
        <div style={{ flex:1, display:"flex", gap:12, minHeight:0 }}>
          <div style={{ width:"40%", flexShrink:0,
            overflowY:"auto", WebkitOverflowScrolling:"touch" }}>
            {cardList}
          </div>
          <div style={{ flex:1,
            overflowY:"auto", WebkitOverflowScrolling:"touch" }}>
            <StockDetail
              s={selectedStock}
              isFav={selectedStock && favs.indexOf(selectedStock.ticker) >= 0}
              toggleFav={toggleFav}
              usdJpy={usdJpy}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── IndexPanel（既存流用） ────────────────────────────────────────────────────
function IndexPanel() {
  var LINKS = [
    { label:"eMAXIS Slim 全世界株式（オール・カントリー）",
      url:"https://www.rakuten-sec.co.jp/web/fund/detail/?ID=JP90C000H1T1",
      desc:"楽天証券 投資信託詳細ページ" },
    { label:"楽天証券 ホーム",
      url:"https://member.rakuten-sec.co.jp/app/home.do",
      desc:"保有資産・取引状況の確認" },
    { label:"実質損益",
      url:"https://member.rakuten-sec.co.jp/app/ass_real_gain_loss.do;BV_SessionID=11B8DED5279E4D6008E75A4ACDAF15EF.c0240dbc?eventType=init&gmn=S&smn=07&lmn=01&fmn=01",
      desc:"楽天証券 実質損益確認" },
  ];
  return (
    <div style={{ background:"#050e1c", border:"1px solid #0f2040",
      borderRadius:10, overflow:"hidden" }}>
      <div style={{ background:"#071428", borderBottom:"1px solid #0f2040",
        padding:"12px 16px" }}>
        <div style={{ fontSize:14, fontWeight:700, color:"#e0f0ff" }}>🌍 リンク</div>
      </div>
      <div style={{ padding:"8px" }}>
        {LINKS.map(function(item, i) {
          return (
            <a key={i} href={item.url} target="_blank" rel="noreferrer"
              style={{ display:"flex", flexDirection:"column",
                padding:"12px 14px", margin:"4px 0",
                background:"#071428", border:"1px solid #1e3050",
                borderRadius:8, textDecoration:"none", gap:4 }}>
              <span style={{ fontSize:14, fontWeight:700, color:"#93c5fd" }}>{item.label}</span>
              <span style={{ fontSize:11, color:"#4a7090" }}>{item.desc}</span>
            </a>
          );
        })}
      </div>
    </div>
  );
}

// ── MarketPanel（既存流用・スキャル向けプロンプトに更新） ─────────────────────
function MarketPanel({ stocks, vix }) {
  var [result, setResult]   = useState("");
  var [loading, setLoading] = useState(false);
  var [lastUpd, setLastUpd] = useState(null);
  var [section, setSection] = useState("env");

  var SECTIONS = [
    { key:"env",    icon:"📊", label:"相場環境" },
    { key:"mkt",    icon:"📈", label:"注目市場" },
    { key:"stock",  icon:"🔥", label:"注目銘柄" },
    { key:"risk",   icon:"⚠️", label:"リスク"   },
    { key:"advice", icon:"💡", label:"アドバイス" },
  ];
  var MARKERS = ["📊","📈","🔥","⚠️","💡"];
  var KEYS    = ["env","mkt","stock","risk","advice"];

  function buildSectionMap(text) {
    var map = {};
    MARKERS.forEach(function(m, i) {
      var start = text.indexOf(m);
      if (start === -1) return;
      var end = text.length;
      for (var j = i+1; j < MARKERS.length; j++) {
        var ni = text.indexOf(MARKERS[j], start+1);
        if (ni !== -1) { end = ni; break; }
      }
      map[KEYS[i]] = text.slice(start, end).trim();
    });
    if (!Object.keys(map).length) map["env"] = text;
    return map;
  }

  async function run() {
    if (loading || !stocks.length) return;
    setLoading(true); setResult("");
    var top5 = stocks.slice().sort(function(a,b){ return b.score-a.score; }).slice(0,5);
    var buyList = stocks.filter(function(s){ return s.timing==="BUY"; }).slice(0,5);
    var usUp = stocks.filter(function(s){ return s.market==="US"&&parseFloat(s.change)>=0; }).length;
    var jpUp = stocks.filter(function(s){ return s.market==="JP"&&parseFloat(s.change)>=0; }).length;
    var usTotal = stocks.filter(function(s){ return s.market==="US"; }).length;
    var jpTotal = stocks.filter(function(s){ return s.market==="JP"; }).length;

    var prompt =
      "【現在の市場データ】\n"+
      "VIX: "+(vix?parseFloat(vix).toFixed(2):"不明")+"\n"+
      "US上昇銘柄: "+usUp+"/"+usTotal+"\n"+
      "JP上昇銘柄: "+jpUp+"/"+jpTotal+"\n\n"+
      "【BUY判定銘柄】\n"+
      (buyList.length?buyList.map(function(s){
        return s.ticker+"("+s.market+") スコア:"+s.score+" 騰落:"+s.change+"%";
      }).join("\n"):"なし")+"\n\n"+
      "【スコア上位5銘柄】\n"+
      top5.map(function(s){
        return s.ticker+" スコア:"+s.score+" 騰落:"+s.change+"%";
      }).join("\n")+"\n\n"+
      "スキャルピング・デイトレ向けに以下の5セクションで出力してください:\n"+
      "📊 今日の相場環境（3〜4行）\n"+
      "📈 注目市場・セクター（3〜4行）\n"+
      "🔥 注目銘柄（2〜3銘柄、エントリー根拠含む）\n"+
      "⚠️ リスク要因（2〜3点）\n"+
      "💡 スキャル・デイトレのアドバイス（2〜3行）";

    try {
      var res = await fetch(AI_API, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ prompt, system:"あなたは株式アナリストです。スキャルピング・デイトレ向けに具体的で実践的な分析を日本語で提供してください。", useWebSearch:true }),
        signal: AbortSignal.timeout(60000),
      });
      var data = await res.json();
      if (data.error) throw new Error(data.error);
      setResult(typeof data.text==="string" ? data.text : "分析できませんでした。");
      setLastUpd(new Date().toLocaleTimeString("ja-JP"));
    } catch(e) {
      setResult("エラー: " + e.message);
    }
    setLoading(false);
  }

  var sectionMap = result ? buildSectionMap(result) : {};

  return (
    <div>
      <div style={{ background:"#071428", border:"1px solid #0f2040",
        borderRadius:10, padding:"14px 16px", marginBottom:12 }}>
        <div style={{ display:"flex", justifyContent:"space-between",
          alignItems:"center" }}>
          <div>
            <div style={{ fontSize:14, fontWeight:700, color:"#e0f0ff" }}>📡 市場予測</div>
            <div style={{ fontSize:11, color:"#4a7090", marginTop:2 }}>
              AIがニュースと市場データを分析します
            </div>
            {lastUpd && <div style={{ fontSize:11, color:"#2a6090", marginTop:2 }}>更新: {lastUpd}</div>}
          </div>
          <button onClick={run} disabled={loading || !stocks.length}
            style={{ background:loading?"#0a1828":"linear-gradient(135deg,#0ea5e9,#0369a1)",
              border:"none", borderRadius:8, color:"#fff",
              padding:"10px 14px", fontSize:13, fontWeight:700,
              cursor:loading||!stocks.length?"not-allowed":"pointer",
              fontFamily:"monospace", flexShrink:0 }}>
            {loading?"分析中...":"📡 分析する"}
          </button>
        </div>
        {!stocks.length && (
          <div style={{ fontSize:11, color:"#f43f5e", marginTop:6 }}>
            ※ 先にスキャンを実行してください
          </div>
        )}
      </div>

      {loading && (
        <div style={{ textAlign:"center", padding:"32px",
          background:"#040c18", border:"1px solid #0ea5e940", borderRadius:10 }}>
          <div style={{ fontSize:24, marginBottom:8 }}>⏳</div>
          <div style={{ fontSize:13, color:"#4a90c0" }}>AIが分析中...</div>
          <div style={{ fontSize:11, color:"#2a6090", marginTop:4 }}>
            30〜60秒かかることがあります
          </div>
        </div>
      )}

      {!loading && result && (
        <div>
          <div style={{ display:"flex", gap:6, overflowX:"auto",
            WebkitOverflowScrolling:"touch", marginBottom:10, paddingBottom:2 }}>
            {SECTIONS.map(function(sec) {
              var active = section === sec.key;
              return (
                <button key={sec.key} onClick={function(){ setSection(sec.key); }}
                  style={{ background:active?"#0ea5e920":"transparent",
                    border:"1px solid "+(active?"#0ea5e9":"#1e3050"),
                    borderRadius:6, color:active?"#0ea5e9":"#4a6080",
                    padding:"4px 10px", fontSize:11, cursor:"pointer",
                    fontFamily:"monospace", whiteSpace:"nowrap", flexShrink:0 }}>
                  {sec.icon} {sec.label}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize:13, color:"#b8cce0", lineHeight:1.8, whiteSpace:"pre-wrap" }}>
            {sectionMap[section] || "このセクションのデータがありません"}
          </div>
          <button onClick={run}
            style={{ marginTop:16, width:"100%", background:"transparent",
              border:"1px solid #1e4070", borderRadius:8, color:"#4a7090",
              padding:"10px", fontSize:12, cursor:"pointer", fontFamily:"monospace" }}>
            🔄 再分析
          </button>
        </div>
      )}

      {!loading && !result && (
        <div style={{ textAlign:"center", padding:"60px 20px", color:"#2a6090" }}>
          <div style={{ fontSize:36, marginBottom:12 }}>📡</div>
          <div style={{ fontSize:13, color:"#4a90c0" }}>市場予測を実行してください</div>
        </div>
      )}
    </div>
  );
}

// ── SyncPanel（既存流用） ─────────────────────────────────────────────────────
function SyncPanel({ userId, setFavs, scan }) {
  var [copyStatus, setCopyStatus] = useState(null);
  var [input, setInput]           = useState("");
  var [syncStatus, setSyncStatus] = useState(null);

  function copyId() {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(userId).then(function() {
        setCopyStatus("ok"); setTimeout(function(){ setCopyStatus(null); }, 2000);
      });
    }
  }

  async function syncById() {
    var id = input.trim();
    if (!id) return;
    setSyncStatus("loading");
    try {
      var res = await fetch(SYNC_API + "?userId=" + id);
      var data = await res.json();
      if (!data.favs) throw new Error("invalid");
      setFavs(data.favs.slice());
      try { localStorage.setItem("fav_tickers", JSON.stringify(data.favs)); } catch(e) {}
      try { localStorage.setItem("daytrade_uid", id); } catch(e) {}
      setSyncStatus("ok");
      setTimeout(function(){ setSyncStatus(null); scan(); }, 1500);
    } catch(e) {
      setSyncStatus("error");
      setTimeout(function(){ setSyncStatus(null); }, 2500);
    }
  }

  var favCount = (function(){
    try { return JSON.parse(localStorage.getItem("fav_tickers")||"[]").length; } catch(e){ return 0; }
  })();

  return (
    <div>
      <div style={{ background:"#071428", border:"1px solid #0f2040",
        borderRadius:10, padding:"14px 16px", marginBottom:14 }}>
        <div style={{ fontSize:14, fontWeight:700, color:"#e0f0ff", marginBottom:10 }}>
          🔗 デバイス間同期
        </div>
        <div style={{ background:"#050e1c", borderRadius:8,
          padding:"10px 16px", marginBottom:14 }}>
          <div style={{ fontSize:11, color:"#2a6090" }}>お気に入り</div>
          <div style={{ fontSize:18, fontWeight:800, color:"#fbbf24" }}>{favCount}銘柄</div>
        </div>
        <div style={{ fontSize:12, color:"#4a7090", marginBottom:8 }}>あなたのデバイスID</div>
        <div style={{ background:"#040c18", border:"1px solid #1e4070",
          borderRadius:8, padding:"10px 12px", fontFamily:"monospace",
          fontSize:13, color:"#b8cce0", wordBreak:"break-all", marginBottom:10 }}>
          {userId}
        </div>
        <button onClick={copyId}
          style={{ width:"100%", background:"linear-gradient(135deg,#0ea5e9,#0369a1)",
            border:"none", borderRadius:8, color:"#fff", padding:"10px",
            fontSize:13, fontWeight:700, cursor:"pointer",
            fontFamily:"monospace", marginBottom:8 }}>
          {copyStatus==="ok" ? "✅ コピーしました！" : "📋 IDをコピー"}
        </button>
      </div>

      <div style={{ background:"#071428", border:"1px solid #0f2040",
        borderRadius:10, padding:"14px 16px", marginBottom:14 }}>
        <div style={{ fontSize:13, fontWeight:700, color:"#e0f0ff", marginBottom:4 }}>
          別デバイスのIDで同期
        </div>
        <div style={{ fontSize:11, color:"#4a7090", marginBottom:10 }}>
          他のデバイスのIDを入力するとお気に入りが引き継がれます
        </div>
        <input
          style={{ background:"#040c18", border:"1px solid #1e4070",
            borderRadius:6, color:"#b8cce0", padding:"10px 12px",
            fontSize:13, fontFamily:"monospace", width:"100%",
            boxSizing:"border-box", marginBottom:10 }}
          value={input} placeholder="別デバイスのIDを貼り付け"
          onChange={function(e){ setInput(e.target.value); }}
        />
        <button onClick={syncById} disabled={!input.trim()||syncStatus==="loading"}
          style={{ width:"100%",
            background:input.trim()?"linear-gradient(135deg,#22d3a0,#059669)":"#0a1828",
            border:"none", borderRadius:8, color:"#fff", padding:"10px",
            fontSize:13, fontWeight:700,
            cursor:input.trim()?"pointer":"not-allowed",
            fontFamily:"monospace" }}>
          {syncStatus==="loading"?"同期中...":syncStatus==="ok"?"✅ 同期完了！":
           syncStatus==="error"?"❌ IDが見つかりません":"このIDで同期する"}
        </button>
      </div>
    </div>
  );
}

// ── メインApp ─────────────────────────────────────────────────────────────────
export default function App() {
  var [stocks, setStocks]           = useState([]);
  var [loading, setLoading]         = useState(false);
  var [progress, setProgress]       = useState({ done:0, total:0, msg:null });
  var [ts, setTs]                   = useState(null);
  var [vix, setVix]                 = useState(null);
  var [usdJpy, setUsdJpy]           = useState(null);
  var [activeTab, setActiveTab]     = useState("all");
  var [selectedStock, setSelectedStock] = useState(null);

  // お気に入り
  var [favs, setFavs] = useState(function() {
    try { var v = localStorage.getItem("fav_tickers"); return v ? JSON.parse(v) : []; }
    catch(e) { return []; }
  });

  // ユーザーID
  var userId = (function() {
    try {
      var id = localStorage.getItem("daytrade_uid");
      if (!id) { id = "u_"+Math.random().toString(36).slice(2,10); localStorage.setItem("daytrade_uid", id); }
      return id;
    } catch(e) { return "u_default"; }
  })();

  function toggleFav(ticker) {
    setFavs(function(prev) {
      var isAdding = prev.indexOf(ticker) < 0;
      var next = isAdding ? prev.concat([ticker]) : prev.filter(function(t){ return t!==ticker; });
      try { localStorage.setItem("fav_tickers", JSON.stringify(next)); } catch(e) {}
      fetch(SYNC_API+"?userId="+userId, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ favs:next }),
      }).catch(function(){});
      if (isAdding) {
        fetch(NOTIFY_API, {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ title:" ", message:userId }),
        }).catch(function(){});
      }
      return next;
    });
  }

  // スキャン
  var scan = useCallback(async function() {
    setLoading(true);
    setProgress({ done:0, total:0, msg:"ランキング取得中..." });
    try {
      var universe = await buildStockUniverse();

      // お気に入りを追加
      var favList = (function(){
        try { var v = localStorage.getItem("fav_tickers"); return v ? JSON.parse(v) : []; }
        catch(e) { return []; }
      })();
      var tickers = universe.map(function(s){ return s.ticker; });
      favList.forEach(function(ticker) {
        if (tickers.indexOf(ticker) < 0) {
          var isJP = ticker.endsWith(".T");
          var code = ticker.replace(".T","");
          universe.push({ ticker, name:code, market:isJP?"JP":"US",
            tvSymbol:(isJP?"TSE:":"NASDAQ:")+code });
        }
      });

      setProgress({ done:0, total:universe.length, msg:null });

      var results = [], BATCH = 6;
      for (var i = 0; i < universe.length; i += BATCH) {
        var batch = universe.slice(i, i+BATCH);
        await Promise.all(batch.map(async function(stock) {
          var pd;
          try { pd = await fetchYahoo(stock.ticker); }
          catch(e) { pd = genSim(stock.ticker); }
          try {
            var analyzed = analyzeStock(stock, pd);
            if (analyzed) results.push(analyzed);
          } catch(e) { console.error("analyzeStock:", stock.ticker, e); }
          setProgress(function(p){ return { done:p.done+1, total:p.total, msg:null }; });
        }));
        if (i+BATCH < universe.length) await new Promise(function(r){ setTimeout(r, 300); });
      }

      results.sort(function(a,b){ return b.score - a.score; });
      setStocks(results);
      setTs(new Date().toLocaleTimeString("ja-JP"));
    } catch(e) {
      setProgress({ done:0, total:0, msg:"❌ エラー: "+e.message });
    } finally {
      setLoading(false);
    }
  }, []);

  // VIX・ドル円取得
  useEffect(function() {
    fetch(VERCEL_API+"?ticker="+encodeURIComponent("^VIX")+"&range=5d")
      .then(function(r){ return r.json(); })
      .then(function(json) {
        var meta = json?.chart?.result?.[0]?.meta;
        if (meta) setVix(meta.regularMarketPrice||null);
      }).catch(function(){});
    fetch(VERCEL_API+"?ticker="+encodeURIComponent("USDJPY=X")+"&range=5d")
      .then(function(r){ return r.json(); })
      .then(function(json) {
        var meta = json?.chart?.result?.[0]?.meta;
        if (meta) setUsdJpy(meta.regularMarketPrice||null);
      }).catch(function(){});
  }, []);

  // 起動時同期 → スキャン
  useEffect(function() {
    fetch(SYNC_API+"?userId="+userId)
      .then(function(r){ return r.json(); })
      .then(function(data) {
        if (data.favs && data.favs.length > 0) {
          setFavs(data.favs.slice());
          try { localStorage.setItem("fav_tickers", JSON.stringify(data.favs)); } catch(e) {}
        }
      })
      .catch(function(){})
      .finally(function(){ scan(); });
  }, []);

  var isMobile = window.innerWidth < 768;
  var TABS = [
    ["all",    "📋", "全銘柄"],
    ["fav",    "⭐", "お気に入り"],
    ["index",  "🌍", "リンク"],
    ["market", "📡", "市場予測"],
    ["sync",   "🔗", "同期"],
  ];

  return (
    <div style={{ minHeight:"100vh", background:"#040c18",
      fontFamily:"monospace", color:"#b8cce0" }}>

      {/* ヘッダー */}
      <div style={{ background:"linear-gradient(180deg,#071428,#050f20)",
        borderBottom:"1px solid #0f2040", padding:"8px 12px 6px",
        position:"sticky", top:0, zIndex:20,
        marginLeft:isMobile?0:50 }}>
        {/* 上段: タイトル + 開場時間 */}
        <div style={{ display:"flex", justifyContent:"space-between",
          alignItems:"center", marginBottom:6 }}>
          <div style={{ fontSize:14, fontWeight:800, color:"#e0f0ff" }}>
            ScalpScreener
            <span style={{ fontSize:11, color:"#4a7090", fontWeight:400,
              marginLeft:6 }}>/ {{all:"全銘柄",fav:"お気に入り",
                index:"リンク",market:"市場予測",sync:"同期"}[activeTab]}</span>
          </div>
          <MarketHours />
        </div>
        {/* 下段: 指数バー（大きめ） */}
        <MarketBar />

        {/* モバイルタブ */}
        {isMobile && (
          <div style={{ display:"flex", gap:4, marginTop:8,
            overflowX:"auto", WebkitOverflowScrolling:"touch", paddingBottom:2 }}>
            {TABS.map(function(tab) {
              var active = activeTab === tab[0];
              return (
                <button key={tab[0]} onClick={function(){ setActiveTab(tab[0]); }}
                  style={{ background:active?"#0ea5e9":"#050f20",
                    border:"1px solid "+(active?"#0ea5e9":"#1e3050"),
                    borderRadius:8, color:active?"#fff":"#4a6080",
                    padding:"4px 8px", fontSize:10, cursor:"pointer",
                    display:"flex", flexDirection:"column",
                    alignItems:"center", gap:1, flexShrink:0, minWidth:44 }}>
                  <span style={{ fontSize:15 }}>{tab[1]}</span>
                  <span style={{ fontSize:9, whiteSpace:"nowrap" }}>{tab[2]}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* デスクトップサイドバー */}
      {!isMobile && (
        <div style={{ width:50, background:"#050f20",
          borderRight:"1px solid #0f2040",
          display:"flex", flexDirection:"column",
          alignItems:"center", paddingTop:10, gap:4,
          flexShrink:0, position:"fixed", top:0, left:0,
          height:"100vh", zIndex:15 }}>
          {TABS.map(function(tab) {
            var active = activeTab === tab[0];
            return (
              <button key={tab[0]} onClick={function(){ setActiveTab(tab[0]); }}
                title={tab[2]}
                style={{ width:40, height:40,
                  background:active?"#0ea5e9":"transparent",
                  border:"1px solid "+(active?"#0ea5e9":"transparent"),
                  borderRadius:8, color:active?"#fff":"#4a6080",
                  fontSize:17, cursor:"pointer",
                  display:"flex", alignItems:"center",
                  justifyContent:"center" }}>
                {tab[1]}
              </button>
            );
          })}
        </div>
      )}

      {/* メインコンテンツ */}
      <div style={{ marginLeft:isMobile?0:50, padding:"10px 10px 0",
        height:"calc(100vh - 110px)", overflow:"hidden", boxSizing:"border-box" }}>
        {activeTab==="all" && (
          <AllStocksPanel
            stocks={stocks} loading={loading} progress={progress} ts={ts}
            vix={vix} usdJpy={usdJpy}
            favs={favs} toggleFav={toggleFav}
            onScan={scan}
            selectedStock={selectedStock} setSelectedStock={setSelectedStock}
          />
        )}
        {activeTab==="fav" && (
          <FavPanel
            stocks={stocks} favs={favs} toggleFav={toggleFav}
            vix={vix} usdJpy={usdJpy}
            selectedStock={selectedStock} setSelectedStock={setSelectedStock}
          />
        )}
        {activeTab==="index"  && (
          <div style={{ height:"100%", overflowY:"auto" }}><IndexPanel /></div>
        )}
        {activeTab==="market" && (
          <div style={{ height:"100%", overflowY:"auto" }}><MarketPanel stocks={stocks} vix={vix} /></div>
        )}
        {activeTab==="sync"   && (
          <div style={{ height:"100%", overflowY:"auto" }}>
            <SyncPanel userId={userId} setFavs={setFavs} scan={scan} />
          </div>
        )}
      </div>
    </div>
  );
}
