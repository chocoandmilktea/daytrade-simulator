// components/StockCard.js
import { useState } from "react";

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
  return {
    background: bg, border: "1px solid " + border, color: text,
    fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 4,
    flexShrink: 0,
  };
}

function scoreColor(n) {
  return n >= 65 ? "#22d3a0" : n >= 50 ? "#fbbf24" : "#f43f5e";
}

function ScoreRing({ score }) {
  var R = 14, C = 2 * Math.PI * R, col = scoreColor(score);
  return (
    <svg width={34} height={34} style={{ flexShrink: 0 }}>
      <circle cx={17} cy={17} r={R} fill="none" stroke="#1e3050" strokeWidth={3} />
      <circle cx={17} cy={17} r={R} fill="none" stroke={col} strokeWidth={3}
        strokeDasharray={C} strokeDashoffset={C - (score / 100) * C}
        strokeLinecap="round" transform="rotate(-90 17 17)" />
      <text x={17} y={21} textAnchor="middle" fill={col}
        style={{ fontSize: 8, fontWeight: 800, fontFamily: "monospace" }}>{score}</text>
    </svg>
  );
}

export default function StockCard({ s, isFav, toggleFav, onSelect, isSelected, usdJpy }) {
  var bc = BADGE[s.timing] || BADGE.SKIP;
  var mc = MKT[s.market] || MKT.US;
  var isUp = parseFloat(s.change) >= 0;
  var changeColor = isUp ? "#22d3a0" : "#f43f5e";
  var cardBorder = isSelected ? "#60a5fa" : scoreColor(s.score);
  var momColor = s.momentumPlus ? "#22d3a0" : "#f43f5e";
  var momBg    = s.momentumPlus ? "#052e16" : "#1f0010";

  var surgeTag = null;
  if (s.surge >= 2.0) {
    surgeTag = { label: "出来高"+s.surge.toFixed(1)+"倍", color:"#f97316", bg:"#1a0800" };
  } else if (s.surge >= 1.5) {
    surgeTag = { label: "出来高"+s.surge.toFixed(1)+"倍", color:"#fbbf24", bg:"#1c1400" };
  }

  function stopProp(e) { e.stopPropagation(); }

  return (
    <div
      onClick={onSelect}
      style={{
        background: isSelected ? "#071e38" : "#050e1c",
        border: "2px solid " + cardBorder,
        borderRadius: 10,
        padding: "8px 10px",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 5,
      }}
    >
      {/* 行1: スコアリング・銘柄情報・株価（右側） */}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <ScoreRing score={s.score} />

        {/* 銘柄名エリア */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
            <span style={bStyle(mc.bg, mc.border, mc.text)}>{mc.label}</span>
            <span style={{ fontSize: 14, fontWeight: 800, color: "#d8eeff" }}>
              {s.ticker.replace(".T", "")}
            </span>
            {s.timing === "BUY" && (
              <span style={bStyle("#052e16", "#22d3a0", "#22d3a0")}>📈デイトレ</span>
            )}
            {!s.real && (
              <span style={bStyle("#1a1200", "#7c6010", "#fbbf24")}>SIM</span>
            )}
          </div>
          <div style={{ fontSize: 11, color: "#4a7090", marginTop: 1,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {s.name}
          </div>
        </div>

        {/* 株価・上昇率（銘柄名の右側） */}
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#d8eeff", lineHeight: 1.2 }}>
            {s.price}
          </div>
          <div style={{ fontSize: 12, fontWeight: 700, color: changeColor }}>
            {isUp ? "▲" : "▼"}{Math.abs(s.change)}%
          </div>
          {s.market === "US" && usdJpy && (
            <div style={{ fontSize: 9, color: "#4a7090" }}>
              ¥{Math.round(s.rawPrice * usdJpy).toLocaleString()}
            </div>
          )}
        </div>

        <button
          onClick={function(e) { stopProp(e); toggleFav(s.ticker); }}
          style={{ background: "transparent", border: "none", fontSize: 16,
            cursor: "pointer", color: isFav ? "#fbbf24" : "#2a4060",
            padding: 0, flexShrink: 0 }}
        >
          {isFav ? "★" : "☆"}
        </button>
      </div>

      {/* 行2: シグナルタグ・BUYバッジ */}
      <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
        <span style={bStyle(momBg, momColor, momColor)}>
          {s.momentumPlus ? "↑ 上昇" : "↓ 下降"}
        </span>
        {surgeTag && (
          <span style={bStyle(surgeTag.bg, surgeTag.color, surgeTag.color)}>
            {surgeTag.label}
          </span>
        )}
        {s.signals && s.signals.map(function(sig, i) {
          if (sig.label === "モメンタム" || sig.label === "出来高") return null;
          if (sig.state === 0) return null;
          return (
            <span key={i} style={bStyle(
              sig.state === 1 ? "#052e16" : "#1f0010",
              sig.state === 1 ? "#22d3a0" : "#f43f5e",
              sig.state === 1 ? "#22d3a0" : "#f43f5e"
            )}>{sig.label}</span>
          );
        })}
        {s.dataWarn && (
          <span style={{ fontSize: 9, color: "#fbbf24" }}>{s.dataWarn}</span>
        )}
        <span style={{ ...bStyle(bc.bg, bc.border, bc.text), marginLeft: "auto" }}>
          {bc.label}
        </span>
      </div>
    </div>
  );
}
