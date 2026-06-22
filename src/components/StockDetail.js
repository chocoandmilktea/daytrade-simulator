// components/StockDetail.js
// 右ペイン詳細パネル
// 削除: MACDシグナル・ポートフォリオ追加
// 追加: BBグラフ（SVG描画）

import { useState, useEffect } from "react";

var BADGE = {
  BUY:   { bg:"#052e16", border:"#22d3a0", text:"#22d3a0", label:"買い"   },
  WATCH: { bg:"#1c1400", border:"#fbbf24", text:"#fbbf24", label:"様子見" },
  SKIP:  { bg:"#1f0010", border:"#f43f5e", text:"#f43f5e", label:"見送り" },
};
var MKT = {
  US: { bg:"#0a1e3a", border:"#3b82f6", text:"#93c5fd", label:"US" },
  JP: { bg:"#1a0a0a", border:"#f87171", text:"#fca5a5", label:"JP" },
};

function bStyle(bg, border, text) {
  return { background:bg, border:"1px solid "+border, color:text,
    fontSize:9, fontWeight:700, padding:"1px 5px", borderRadius:4, flexShrink:0 };
}
function scoreColor(n) { return n>=65?"#22d3a0":n>=50?"#fbbf24":"#f43f5e"; }
function stateColor(s) { return s===1?"#22d3a0":s===-1?"#f43f5e":"#fbbf24"; }
function stateLabel(s) { return s===1?"▲ 強気":s===-1?"▼ 弱気":"→ 中立"; }

// ── BBグラフ（SVG） ──────────────────────────────────────────────────────────
// 設計書仕様:
//   BB上限（白）・BB中央/MA（黄緑）・BB下限（白）
//   MA5（黄）・MA25（紫）・現在値縦線（シアン）
function BBGraph({ graphCloses, graphBB, graphMA5, graphMA25, currentPrice, isJP }) {
  if (!graphCloses || graphCloses.length < 2) return null;

  var W = 480, H = 140, PAD = { t:8, b:24, l:44, r:12 };
  var innerW = W - PAD.l - PAD.r;
  var innerH = H - PAD.t - PAD.b;
  var len = graphCloses.length;

  // 当日現在値を最右端に追加（設計書: "当日現在値を最右端に追加"）
  var allCloses = graphCloses.slice();
  var allBB = graphBB ? graphBB.slice() : [];
  var allMA5 = graphMA5 ? graphMA5.slice() : [];
  var allMA25 = graphMA25 ? graphMA25.slice() : [];

  // 価格範囲計算（BB上限/下限も含む）
  var allVals = allCloses.filter(Boolean);
  allBB.forEach(function(b) { if(b){ allVals.push(b.upper, b.lower); } });
  if (currentPrice) allVals.push(currentPrice);
  if (!allVals.length) return null;

  var minV = Math.min.apply(null, allVals);
  var maxV = Math.max.apply(null, allVals);
  var range = maxV - minV || 1;
  // 上下に5%余白
  minV -= range * 0.05;
  maxV += range * 0.05;
  range = maxV - minV;

  var totalLen = len + 1; // 現在値の分を+1

  function toX(i) { return PAD.l + (i / (totalLen - 1)) * innerW; }
  function toY(v) { return PAD.t + innerH - ((v - minV) / range) * innerH; }
  function pts(arr, valFn) {
    return arr.map(function(v, i) {
      var val = valFn ? valFn(v) : v;
      if (val == null) return null;
      return toX(i) + "," + toY(val);
    }).filter(Boolean).join(" ");
  }

  // 現在値縦線のX座標
  var curX = toX(len); // 最右端（len番目）
  var curY = currentPrice ? toY(currentPrice) : null;

  // Y軸ラベル（3本）
  var yLabels = [minV, (minV+maxV)/2, maxV];
  function fmtPrice(v) {
    return isJP ? Math.round(v).toLocaleString() : v.toFixed(2);
  }

  return (
    <svg width="100%" viewBox={"0 0 "+W+" "+H} style={{ display:"block", overflow:"visible" }}>
      {/* グリッド横線 */}
      {yLabels.map(function(v, i) {
        var y = toY(v);
        return (
          <g key={i}>
            <line x1={PAD.l} y1={y} x2={W-PAD.r} y2={y}
              stroke="#0f2040" strokeWidth={1} strokeDasharray="3,3" />
            <text x={PAD.l-4} y={y+4} textAnchor="end"
              fill="#2a5070" style={{ fontSize:8, fontFamily:"monospace" }}>
              {fmtPrice(v)}
            </text>
          </g>
        );
      })}

      {/* BB上限・下限（白・点線） */}
      {allBB.length > 0 && (
        <>
          <polyline
            points={pts(allBB, function(b){ return b ? b.upper : null; })}
            fill="none" stroke="#ffffff" strokeWidth={0.8} opacity={0.4}
            strokeDasharray="4,3"
            strokeLinejoin="round" strokeLinecap="round" />
          <polyline
            points={pts(allBB, function(b){ return b ? b.lower : null; })}
            fill="none" stroke="#ffffff" strokeWidth={0.8} opacity={0.4}
            strokeDasharray="4,3"
            strokeLinejoin="round" strokeLinecap="round" />
          {/* BB帯塗りつぶし */}
          <polygon
            points={
              allBB.map(function(b, i){ return b ? toX(i)+","+toY(b.upper) : ""; }).filter(Boolean).join(" ") + " " +
              allBB.slice().reverse().map(function(b, i, arr){ return b ? toX(arr.length-1-i)+","+toY(b.lower) : ""; }).filter(Boolean).join(" ")
            }
            fill="#ffffff" opacity={0.03} />
          {/* BB中央線（黄緑） */}
          <polyline
            points={pts(allBB, function(b){ return b ? b.mid : null; })}
            fill="none" stroke="#86efac" strokeWidth={0.8}
            strokeLinejoin="round" strokeLinecap="round" />
        </>
      )}

      {/* MA25（紫・細く） */}
      {allMA25.length > 0 && (
        <polyline
          points={pts(allMA25, function(v){ return v; })}
          fill="none" stroke="#a78bfa" strokeWidth={0.8}
          strokeLinejoin="round" strokeLinecap="round" />
      )}

      {/* MA5（黄・細く） */}
      {allMA5.length > 0 && (
        <polyline
          points={pts(allMA5, function(v){ return v; })}
          fill="none" stroke="#fbbf24" strokeWidth={0.8}
          strokeLinejoin="round" strokeLinecap="round" />
      )}

      {/* 終値ライン（薄いグレー） */}
      <polyline
        points={pts(allCloses, function(v){ return v; })}
        fill="none" stroke="#4a7090" strokeWidth={1} opacity={0.6}
        strokeLinejoin="round" strokeLinecap="round" />

      {/* 凡例（現在値なし） */}
      {[
        ["BB上下限", "#ffffff"],
        ["BB中央",   "#86efac"],
        ["MA5",      "#fbbf24"],
        ["MA25",     "#a78bfa"],
      ].map(function(item, i) {
        return (
          <g key={i} transform={"translate("+(PAD.l + i*76)+","+(H-8)+")"}>
            <line x1={0} y1={0} x2={12} y2={0} stroke={item[1]} strokeWidth={1.5} />
            <text x={15} y={4} fill={item[1]} style={{ fontSize:8, fontFamily:"monospace" }}>
              {item[0]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ── 損益シミュレーション ──────────────────────────────────────────────────────
function SimPanel({ s, usdJpy }) {
  var isJP = s.market === "JP";
  var [simBuy, setSimBuy] = useState(
    s.rawPrice ? (isJP ? String(Math.round(s.rawPrice)) : s.rawPrice.toFixed(2)) : ""
  );
  var [simShares, setSimShares] = useState("100");
  var [simTarget, setSimTarget] = useState(5);
  var [simStop, setSimStop] = useState(-3);

  useEffect(function() {
    setSimBuy(s.rawPrice ? (isJP ? String(Math.round(s.rawPrice)) : s.rawPrice.toFixed(2)) : "");
  }, [s.ticker]);

  var bp = parseFloat(simBuy) || 0;
  var sh = parseFloat(simShares) || 0;

  function fmtP(v) { return isJP ? "¥"+Math.round(v).toLocaleString() : "$"+v.toFixed(2); }
  function fmtPnL(v) {
    if (isJP) return (v>=0?"+":"")+"¥"+Math.round(Math.abs(v)).toLocaleString();
    var jpy = usdJpy ? Math.round(Math.abs(v)*usdJpy) : null;
    return (v>=0?"+":"")+"$"+Math.abs(v).toFixed(2)+(jpy?"  (¥"+jpy.toLocaleString()+")":"");
  }

  var inp = { background:"#040c18", border:"1px solid #1e4070", borderRadius:5,
    color:"#b8cce0", padding:"6px 8px", fontSize:13, fontFamily:"monospace",
    width:"100%", boxSizing:"border-box" };

  var scenarios = [
    { label:"損切り", pct:simStop, color:"#f43f5e" },
    { label:"-3%",    pct:-3,       color:"#fb923c" },
    { label:"+3%",    pct:3,        color:"#22d3a0" },
    { label:"+5%",    pct:5,        color:"#22d3a0" },
    { label:"+10%",   pct:10,       color:"#22d3a0" },
    { label:"目標",   pct:simTarget, color:"#fbbf24" },
  ];

  return (
    <div style={{ background:"#040c18", border:"1px solid #a78bfa30",
      borderRadius:10, padding:"12px" }}>
      <div style={{ fontSize:13, fontWeight:700, color:"#a78bfa", marginBottom:8 }}>
        💹 損益シミュレーション
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:8 }}>
        <div>
          <div style={{ fontSize:11, color:"#2a6090", marginBottom:3 }}>買値</div>
          <input style={inp} type="number" value={simBuy}
            onChange={function(e){ setSimBuy(e.target.value); }} />
        </div>
        <div>
          <div style={{ fontSize:11, color:"#2a6090", marginBottom:3 }}>株数</div>
          <input style={inp} type="number" value={simShares}
            onChange={function(e){ setSimShares(e.target.value); }} />
        </div>
      </div>
      {/* 目標・損切りスライダー */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:8 }}>
        <div>
          <div style={{ fontSize:11, color:"#fbbf24", marginBottom:2 }}>
            目標 +{simTarget}%
          </div>
          <input type="range" min={1} max={30} value={simTarget}
            onChange={function(e){ setSimTarget(parseInt(e.target.value)); }}
            style={{ width:"100%", accentColor:"#fbbf24" }} />
        </div>
        <div>
          <div style={{ fontSize:11, color:"#f43f5e", marginBottom:2 }}>
            損切り {simStop}%
          </div>
          <input type="range" min={-20} max={-1} value={simStop}
            onChange={function(e){ setSimStop(parseInt(e.target.value)); }}
            style={{ width:"100%", accentColor:"#f43f5e" }} />
        </div>
      </div>
      {bp > 0 && sh > 0 && (
        <>
          <div style={{ background:"#071428", borderRadius:6, padding:"6px 10px",
            fontSize:12, color:"#4a7090", marginBottom:8 }}>
            投資総額:{" "}
            <span style={{ color:"#d8eeff", fontWeight:700 }}>{fmtP(bp*sh)}</span>
            {!isJP && usdJpy && (
              <span style={{ color:"#4a7090", fontSize:11 }}>
                {"  "}(¥{Math.round(bp*sh*usdJpy).toLocaleString()})
              </span>
            )}
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
            {scenarios.sort(function(a,b){ return a.pct-b.pct; }).map(function(sc, i) {
              var pnl = (bp*(1+sc.pct/100) - bp) * sh;
              return (
                <div key={i} style={{ display:"flex", justifyContent:"space-between",
                  alignItems:"center", background:"#071428", borderRadius:6, padding:"5px 8px" }}>
                  <div>
                    <span style={{ fontSize:12, color:sc.color, fontWeight:700 }}>{sc.label}</span>
                    <span style={{ fontSize:11, color:"#4a7090", marginLeft:4 }}>
                      {sc.pct>=0?"+":""}{sc.pct}%
                    </span>
                  </div>
                  <span style={{ fontSize:13, fontWeight:800,
                    color:pnl>=0?"#22d3a0":"#f43f5e" }}>{fmtPnL(pnl)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ── メイン: StockDetail ───────────────────────────────────────────────────────
export default function StockDetail({ s, isFav, toggleFav, vix, usdJpy }) {
  // 未選択
  if (!s) {
    return (
      <div style={{ textAlign:"center", padding:"80px 20px", color:"#2a6090" }}>
        <div style={{ fontSize:36, marginBottom:12 }}>👈</div>
        <div style={{ fontSize:14, color:"#4a90c0" }}>銘柄を選択してください</div>
      </div>
    );
  }

  var isJP = s.market === "JP";
  var isUp = parseFloat(s.change) >= 0;
  var mc = MKT[s.market] || MKT.US;
  var bc = BADGE[s.timing] || BADGE.SKIP;
  var borderColor = scoreColor(s.score);
  var fromHighColor = s.fromHigh >= -10 ? "#f43f5e" : s.fromHigh >= -30 ? "#fbbf24" : "#22d3a0";
  var fromLowColor  = s.fromLow  <=  20 ? "#22d3a0" : s.fromLow  <=  50 ? "#fbbf24" : "#f43f5e";
  var pos52 = s.position52 != null ? Math.min(98, Math.max(2, s.position52)) : null;
  var pos52Color = pos52 != null ? (pos52<=25?"#22d3a0":pos52<=75?"#fbbf24":"#f43f5e") : null;

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10,
      padding:"14px", background:"#050e1c",
      border:"1px solid "+borderColor, borderRadius:10 }}>

      {/* ヘッダー：銘柄名・お気に入り */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div style={{ display:"flex", gap:6, alignItems:"center" }}>
          <span style={bStyle(mc.bg, mc.border, mc.text)}>{mc.label}</span>
          <span style={{ fontSize:16, fontWeight:800, color:"#d8eeff" }}>
            {s.ticker.replace(".T","")}
          </span>
          {!s.real && <span style={bStyle("#1a1200","#7c6010","#fbbf24")}>SIM</span>}
        </div>
        <button onClick={function(){ toggleFav(s.ticker); }}
          style={{ background:"transparent", border:"none", fontSize:18,
            cursor:"pointer", color:isFav?"#fbbf24":"#2a4060", padding:0 }}>
          {isFav ? "★" : "☆"}
        </button>
      </div>
      <div style={{ fontSize:12, color:"#4a7090" }}>{s.name}</div>

      {/* 現在値・騰落率・BUYバッジ */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
        background:"#071428", borderRadius:8, padding:"10px 14px" }}>
        <div>
          <div style={{ fontSize:20, fontWeight:800, color:"#d8eeff" }}>{s.price}</div>
          {!isJP && usdJpy && (
            <div style={{ fontSize:12, color:"#4a7090" }}>
              ¥{Math.round(s.rawPrice * usdJpy).toLocaleString()}
            </div>
          )}
          {s.dataWarn && (
            <div style={{ fontSize:10, color:"#fbbf24", marginTop:2 }}>{s.dataWarn}</div>
          )}
        </div>
        <div style={{ textAlign:"right" }}>
          <div style={{ fontSize:16, fontWeight:700, color:isUp?"#22d3a0":"#f43f5e" }}>
            {isUp?"▲":"▼"}{Math.abs(s.change)}%
          </div>
          <div style={{ marginTop:4 }}>
            <span style={bStyle(bc.bg, bc.border, bc.text)}>{bc.label}</span>
          </div>
        </div>
      </div>

      {/* 52週レンジバー */}
      {pos52 != null && s.high52 && (
        <div>
          <div style={{ display:"flex", justifyContent:"space-between",
            fontSize:11, color:"#4a7090", marginBottom:4 }}>
            <span>52W安値</span>
            <span style={{ color:pos52Color, fontWeight:700 }}>
              {pos52<=25?"安値圏":pos52<=75?"中間":"高値圏"}
            </span>
            <span>52W高値</span>
          </div>
          <div style={{ background:"#0a1828", borderRadius:3, height:5,
            position:"relative", marginBottom:8 }}>
            <div style={{ background:"linear-gradient(90deg,#22d3a0,#fbbf24,#f43f5e)",
              height:5, borderRadius:3, width:"100%", opacity:0.25 }} />
            <div style={{ position:"absolute", top:-2,
              left:"calc("+pos52+"% - 5px)", width:10, height:10,
              borderRadius:"50%", background:pos52Color, border:"1px solid #071428" }} />
          </div>
          {/* 高値比・安値比・VIX */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6 }}>
            {[
              ["高値比", s.fromHigh.toFixed(1)+"%", fromHighColor],
              ["安値比", "+"+s.fromLow.toFixed(1)+"%", fromLowColor],
              ["VIX", vix ? parseFloat(vix).toFixed(2) : "─",
                vix && parseFloat(vix)>=20 ? "#f43f5e" : "#d8eeff"],
            ].map(function(row) {
              return (
                <div key={row[0]} style={{ background:"#071428", borderRadius:6, padding:"5px 8px" }}>
                  <div style={{ fontSize:11, color:"#2a6090" }}>{row[0]}</div>
                  <div style={{ fontSize:14, fontWeight:700, color:row[2] }}>{row[1]}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ borderTop:"1px solid #0f2040" }} />

      {/* シグナル詳細 */}
      <div>
        <div style={{ fontSize:13, fontWeight:700, color:"#4a90c0", marginBottom:6 }}>
          📊 シグナル詳細
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
          {s.signals && s.signals.map(function(sig, i) {
            return (
              <div key={i} style={{ background:"#071428", borderRadius:6,
                padding:"6px 10px", display:"flex",
                justifyContent:"space-between", alignItems:"center",
                border:"1px solid #0f2040" }}>
                <span style={{ fontSize:12, color:"#4a7090" }}>{sig.label}</span>
                <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                  <span style={{ fontSize:13, fontWeight:700, color:stateColor(sig.state) }}>
                    {sig.val}
                  </span>
                  <span style={{ fontSize:10, color:stateColor(sig.state) }}>
                    {stateLabel(sig.state)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ borderTop:"1px solid #0f2040" }} />

      {/* BBグラフ（新規追加） */}
      <div>
        <div style={{ fontSize:13, fontWeight:700, color:"#4a90c0", marginBottom:6 }}>
          📈 BBグラフ（過去60日 + 現在値）
        </div>
        <div style={{ background:"#040c18", borderRadius:8, padding:"8px 4px" }}>
          <BBGraph
            graphCloses={s.graphCloses}
            graphBB={s.graphBB}
            graphMA5={s.graphMA5}
            graphMA25={s.graphMA25}
            currentPrice={s.rawPrice}
            isJP={isJP}
          />
        </div>
      </div>

      <div style={{ borderTop:"1px solid #0f2040" }} />

      {/* 下値サポート目安 */}
      {s.support && (
        <div style={{ background:"#071428", border:"1px solid #2a4060",
          borderRadius:8, padding:"8px 10px" }}>
          <div style={{ fontSize:12, fontWeight:700, color:"#fbbf24", marginBottom:6 }}>
            📉 下値サポート目安
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6 }}>
            {[
              ["🟡 S1 20日", s.support.s1, "#fbbf24"],
              ["🔴 S2 60日", s.support.s2, "#f43f5e"],
              ["⚡ ATR×1.5", s.support.atrFloor, "#a78bfa"],
            ].map(function(row) {
              return (
                <div key={row[0]} style={{ background:"#040c18",
                  border:"1px solid #1e3050", borderRadius:6, padding:"5px 8px" }}>
                  <div style={{ fontSize:9, color:row[2], marginBottom:2 }}>{row[0]}</div>
                  <div style={{ fontSize:13, fontWeight:800, color:row[2] }}>
                    {isJP ? "¥"+row[1].toLocaleString() : "$"+row[1]}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ fontSize:10, color:"#2a5070", marginTop:5 }}>
            S1割れ→S2、S2割れ→ATR下限が次の下値目安
          </div>
        </div>
      )}

      <div style={{ borderTop:"1px solid #0f2040" }} />

      {/* 損益シミュレーション */}
      <SimPanel s={s} usdJpy={usdJpy} />

      {/* 外部リンク */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6 }}>
        <a href={
            s.market === "JP"
              ? "https://finance.yahoo.co.jp/quote/"+s.ticker.replace(".T","") + ".T"
              : "https://finance.yahoo.co.jp/quote/"+s.ticker
          }
          target="_blank" rel="noreferrer"
          style={{ background:"#071428", border:"1px solid #4f46e5", borderRadius:8,
            color:"#a5b4fc", padding:"10px", fontSize:12, fontWeight:700,
            fontFamily:"monospace", textDecoration:"none", textAlign:"center",
            display:"block" }}>
          🔗 Yahoo!
        </a>
        <a
          href="ispeed://"
          onClick={function(){
            var code = s.ticker.replace(".T","");
            if(navigator.clipboard){
              navigator.clipboard.writeText(code).catch(function(){});
            }
          }}
          style={{ background:"#071428", border:"1px solid #22d3a0", borderRadius:8,
            color:"#22d3a0", padding:"10px", fontSize:12, fontWeight:700,
            fontFamily:"monospace", textDecoration:"none", textAlign:"center",
            display:"block" }}>
          📱 iSPEED
        </a>
      </div>
    </div>
  );
}
