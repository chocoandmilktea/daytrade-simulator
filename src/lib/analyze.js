// ── スコア計算の共有モジュール ────────────────────────────────────────────
// フロント（src/App.js）とサーバー（api/*.js）の両方から同じ計算を呼べるように、
// スコア計算まわりだけを App.js から切り出したファイル。
//
// このファイルのルール（サーバーでも動かすための制約）:
//   ・localStorage / window / document を一切参照しない
//   ・JSX を含まない素のJavaScript。Reactにも依存しない
//   ・ESM の export を使う（api/ 配下から import するため）
//
// localStorage が必要な処理は analyzeStock の第4引数 opts で受け渡しする:
//   opts.signalStats      … 実績による重み補正の集計結果（未指定なら補正なし＝係数1.0）
//   opts.scoreHist        … sh_<ticker> の既存履歴（未指定なら空）
//   opts.intradayHist     … sh_intraday_<ticker> の既存履歴（未指定なら空）
//   opts.resolveEventDate … 決算日・権利落ち日のローカル記憶（未指定なら取得値をそのまま使う）
//   opts.buildVerdict     … 🚦総合判定の組み立て（未指定なら判定なし＝null）
// スコア履歴の保存はこのファイルでは行わない。保存に必要な値は戻り値の save に入れて返す。

// ── 基本テクニカル指標 ────────────────────────────────────────────────────
export function calcEMA(arr,p){var k=2/(p+1),out=[arr[0]];for(var i=1;i<arr.length;i++)out.push(arr[i]*k+out[i-1]*(1-k));return out;}
export function calcMACD(arr){var e12=calcEMA(arr,12),e26=calcEMA(arr,26),ml=e12.map(function(v,i){return v-e26[i];}),sig=calcEMA(ml,9);return ml.map(function(v,i){return{hist:v-sig[i]};});}
export function calcRSI(arr){var p=14,out=[];for(var x=0;x<p;x++)out.push(null);var ag=0,al=0;for(var i=1;i<=p;i++){var diff2=arr[i]-arr[i-1];if(diff2>=0)ag+=diff2;else al-=diff2;}ag/=p;al/=p;out.push(100-100/(1+ag/(al||1e-9)));for(var j=p+1;j<arr.length;j++){var diff=arr[j]-arr[j-1];ag=(ag*(p-1)+Math.max(diff,0))/p;al=(al*(p-1)+Math.max(-diff,0))/p;out.push(100-100/(1+ag/(al||1e-9)));}return out;}
export function calcBoll(arr){var p=20,k=2;return arr.map(function(_,i){if(i<p-1)return null;var bl=arr.slice(i-p+1,i+1),m=bl.reduce(function(a,b){return a+b;})/p,sd=Math.sqrt(bl.reduce(function(a,b){return a+(b-m)*(b-m);},0)/p);return{upper:m+k*sd,lower:m-k*sd};});}
export function calcStoch(closes,highs,lows){var p=14;return closes.map(function(_,i){if(i<p-1)return null;var hi=Math.max.apply(null,highs.slice(i-p+1,i+1)),lo=Math.min.apply(null,lows.slice(i-p+1,i+1));if(lo===hi)return 50;return((closes[i]-lo)/(hi-lo))*100;});}

// VWAP（出来高加重平均価格）
export function calcVWAP(closes,highs,lows,volumes){var cumTPV=0,cumVol=0;for(var i=0;i<closes.length;i++){var tp=(highs[i]+lows[i]+closes[i])/3,v=volumes[i]||0;cumTPV+=tp*v;cumVol+=v;}return cumVol>0?cumTPV/cumVol:null;}

// ピボットポイント（前日相当26本から計算）
// 前日ピボット。日付配列から「データ内の最終日より1つ前の日」のバーだけを切り出す。
// 固定本数(1日=26本)での近似だと、東証は1日22本なうえ場中は当日の足がさらに少ないため、
// 窓が前々日側へ大きく滑って毎回違う値になっていた。日付が無い場合は誤値を出さずnull。
export function calcPivot(closes,highs,lows,dates){
  if(!dates||dates.length!==closes.length||dates.length<2) return null;
  var lastDate=dates[dates.length-1],end=-1;
  for(var i=dates.length-1;i>=0;i--){if(dates[i]!==lastDate){end=i;break;}}
  if(end<0) return null;
  var prevDate=dates[end],start=end;
  while(start>0&&dates[start-1]===prevDate) start--;
  var prevH=-Infinity,prevL=Infinity;
  for(var j=start;j<=end;j++){
    if(highs[j]!=null&&highs[j]>prevH) prevH=highs[j];
    if(lows[j]!=null&&lows[j]<prevL) prevL=lows[j];
  }
  var prevC=closes[end];
  if(!(prevH>-Infinity)||!(prevL<Infinity)||prevC==null) return null;
  var pp=(prevH+prevL+prevC)/3;
  return{pp:pp,r1:pp*2-prevL,s1:pp*2-prevH,r2:pp+(prevH-prevL),s2:pp-(prevH-prevL),prevHigh:prevH,prevLow:prevL,prevClose:prevC};
}
// ATR(真の値幅の平均)。period本分のTrue Rangeを単純平均。ボラティリティ判定に使用
export function calcATR(closes,highs,lows,period){var trs=[];for(var i=1;i<closes.length;i++){var h=highs[i]||closes[i],l=lows[i]||closes[i],pc=closes[i-1];trs.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));}var slice=trs.slice(-period);return slice.length?slice.reduce(function(a,b){return a+b;},0)/slice.length:null;}

// 15分足を日付でまとめ直して「日足ATR」を算出する。
// スコア計算で使うatrは15分足1本分の値幅（数円）しかなく、デイトレの
// 利確・損切り幅の基準にすると極端に狭くなるため、日足に換算し直して使う。
// 当日はまだ途中なので除外する。
export function calcDailyATR(closes,highs,lows,dates,period){
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

// 上位足の方向判定。factor本ごとに間引いた擬似終値列でEMA5/13クロスを見る（1:上昇 -1:下降 0:横ばい/データ不足）
export function resampleDir(closes,factor){var arr=[];for(var i=closes.length-1;i>=0&&arr.length<40;i-=factor){arr.unshift(closes[i]);}if(arr.length<14)return 0;var e5=calcEMA(arr,5),e13=calcEMA(arr,13),m=arr.length-1;return e5[m]>e13[m]?1:(e5[m]<e13[m]?-1:0);}

// ── 足データの前処理ヘルパー ──────────────────────────────────────────────
// 1営業日あたりのバー本数を実測する（東証・米国で取引時間が違い、制度変更でも変わるため）
// 最終日は取引途中の可能性があるので除外し、その手前の「完結した日」を最大5日分数えて
// 中央値を返す。1日だけを見ていると、その日にYahoo側の欠測があったとき本数が大きく
// 狂い、これを20倍して使う箇所（S1/R1の集計期間）まで巻き添えになるため。
export function barsPerDay(dates){
  if(!dates||dates.length<2) return null;
  var lastDate=dates[dates.length-1];
  var counts=[],curDate=null,c=0;
  for(var i=dates.length-1;i>=0;i--){
    if(dates[i]===lastDate) continue;        // 最終日（取引途中かもしれない日）は数えない
    if(curDate===null){curDate=dates[i];c=0;}
    if(dates[i]!==curDate){                  // 日付が変わった＝1日分を数え終えた
      counts.push(c);
      if(counts.length>=5) break;            // 直近5日分そろえば十分
      curDate=dates[i];c=0;
    }
    c++;
  }
  if(counts.length===0&&c>0) counts.push(c); // 完結した日が1日しか無い時の保険
  if(counts.length===0) return null;
  counts.sort(function(a,b){return a-b;});
  return counts[Math.floor(counts.length/2)]||null;
}

// 前日終値の特定（前日比・ギャップ判定で共通利用）
// meta.chartPreviousClose は「取得したチャート範囲の直前の終値」なので、15分足を
// 約20営業日分まとめて取得している本アプリでは約1ヶ月前の終値になり、前日比には
// 使えない。日付配列をさかのぼり「最終日より前の日の、最後の終値」を前日終値とする。
// 寄り付き前・休場（最終日＝前営業日）でも同じロジックで正しく機能する。
export function findPrevClose(closes,dates){
  if(!closes||!dates||dates.length!==closes.length||dates.length<2) return null;
  var lastDate=dates[dates.length-1];
  for(var i=dates.length-1;i>=0;i--){
    if(dates[i]!==lastDate&&closes[i]!=null) return closes[i];
  }
  return null;
}

// ── 営業日・時間帯まわり ──────────────────────────────────────────────────
// 東証の休場日（祝日＋大晦日）。土日は自動判定するので載せていません
// ★年に1回、翌年分をここに追記してください
export var JP_HOLIDAYS={
  "2026-01-01":1,"2026-01-02":1,"2026-01-12":1,"2026-02-11":1,"2026-02-23":1,"2026-03-20":1,
  "2026-04-29":1,"2026-05-04":1,"2026-05-05":1,"2026-05-06":1,"2026-07-20":1,"2026-08-11":1,
  "2026-09-21":1,"2026-09-22":1,"2026-09-23":1,"2026-10-12":1,"2026-11-03":1,"2026-11-23":1,"2026-12-31":1,
  "2027-01-01":1,"2027-01-11":1,"2027-02-11":1,"2027-02-23":1,"2027-03-22":1,"2027-04-29":1,
  "2027-05-03":1,"2027-05-04":1,"2027-05-05":1,"2027-07-19":1,"2027-08-11":1,"2027-09-20":1,
  "2027-09-23":1,"2027-10-11":1,"2027-11-03":1,"2027-11-23":1,"2027-12-31":1
};
// 日本時間の日付情報を取得（dayOffset=-1で前日）。key="YYYY-MM-DD" / dow=曜日(0:日〜6:土) / min=0時からの分
export function jstInfo(dayOffset){
  var j=new Date(Date.now()+9*60*60*1000);
  if(dayOffset)j.setUTCDate(j.getUTCDate()+dayOffset);
  var m=j.getUTCMonth()+1,d=j.getUTCDate();
  return {key:j.getUTCFullYear()+"-"+(m<10?"0":"")+m+"-"+(d<10?"0":"")+d,dow:j.getUTCDay(),min:j.getUTCHours()*60+j.getUTCMinutes()};
}
// その市場の「今のセッション日」をYYYY-MM-DDで返す。
// 取得データの最終日付がこれと違えば＝まだ今日の足が1本も無い（寄り付き前・休場中）と判断できる
export function currentSessionDate(market){
  var n=jstInfo(0);
  if(market==="JP")return n.key;
  return (n.min<12*60?jstInfo(-1):n).key; // 米国：日本時間の早朝は前日の米国営業日
}
// Dateオブジェクトを"YYYY-MM-DD"（ローカル時刻基準）に変換。JP_HOLIDAYSの照合用
export function localYmdKey(d){
  var m=d.getMonth()+1,dd=d.getDate();
  return d.getFullYear()+"-"+(m<10?"0":"")+m+"-"+(dd<10?"0":"")+dd;
}
// スキャンしない日があると「隣り合う記録」が数日離れることがあり、それを
// 「1日後の実績」として集計すると統計が汚れる。土日を除いた日数差を返し、
// 集計側で「想定の営業日差と一致するペアだけ」を採用するために使う
// isJP=true なら東証の祝日(JP_HOLIDAYS)も休みとして除外する。米国株の履歴に
// 日本の祝日を当てると逆に営業日を数え損なうため、呼び出し側で明示的に渡す
export function bizDayDiff(dStr1,dStr2,isJP){
  var a=new Date(dStr1+"T00:00:00"),b=new Date(dStr2+"T00:00:00");
  if(isNaN(a.getTime())||isNaN(b.getTime())||b<=a) return null;
  var n=0,cur=new Date(a);
  while(cur<b){
    cur.setDate(cur.getDate()+1);
    var dw=cur.getDay();
    if(dw===0||dw===6) continue;                          // 土日
    if(isJP&&JP_HOLIDAYS[localYmdKey(cur)]) continue;      // 東証の祝日
    n++;
    if(n>30)return n; // 異常に離れたペアの無限ループ防止
  }
  return n;
}

// 現在時刻（端末のローカル時刻＝日本国内利用前提でJST）から取引時間帯ラベルを判定
// 日本株の寄り付き〜引けの目安で区切り、それ以外（米国株スキャン・時間外）は"時間外"にまとめる
export var INTRADAY_SESSIONS=["寄り付き","前場","後場前半","後場後半"];
export function currentSessionLabel(){
  var now=new Date();
  var mins=now.getHours()*60+now.getMinutes();
  if(mins>=9*60&&mins<10*60) return "寄り付き";
  if(mins>=10*60&&mins<11*60+30) return "前場";
  if(mins>=12*60+30&&mins<14*60) return "後場前半";
  if(mins>=14*60&&mins<15*60+30) return "後場後半";
  return "時間外";
}

// ── 勝敗判定の共通しきい値 ──────────────────────────────────────────────
// スキャン時刻が日によってバラバラなため、極小の値動き（誤差レベル）まで
// 勝ち/負けとして数えると統計がブレる。しきい値未満の変動は「引き分け」として
// 集計対象から除外する（的中率の分母・分子どちらにも数えない）
export var WIN_THRESHOLD_PCT=0.3;
// basePrice→nextPriceの変化率がしきい値以上なら1(上昇)/-1(下降)、しきい値未満は0(判定対象外)
export function priceMoveState(basePrice,nextPrice){
  if(basePrice==null||nextPrice==null||basePrice===0) return null;
  var changePct=(nextPrice-basePrice)/basePrice*100;
  if(Math.abs(changePct)<WIN_THRESHOLD_PCT) return 0;
  return changePct>0?1:-1;
}
// シグナル統計が「何営業日分（何日分の記録）から作られたか」を返す
// 同じ日に多数の銘柄をスキャンすると件数だけが水増しされるため、日数でも信頼性を測る
export function sigStatDays(st){
  return st&&st.dd?Object.keys(st.dd).length:0;
}

// スコア高銘柄の翌日実績を算出
// scoreHist: [{d,s,p},...] pは記録日の終値
// threshold: 対象スコア下限（デフォルト60）
// 戻り値: {winRate, total, byBand}
export function calcActualWinRate(scoreHist,threshold,isJP){
  threshold=threshold||60;
  var wins=0,total=0;
  var byBand={"60":{w:0,t:0},"80":{w:0,t:0},"100":{w:0,t:0}};
  for(var i=0;i<scoreHist.length-1;i++){
    var cur=scoreHist[i],nxt=scoreHist[i+1];
    if(cur.s<threshold||cur.p==null||nxt.p==null) continue;
    if(bizDayDiff(cur.d,nxt.d,isJP)!==1) continue; // 記録が飛んだペア（数日分の値動き）は翌日実績に含めない
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
export function baseSigLabel(label){return label.replace(/\([^)]*\)$/,"");}

// シグナルの方向（強気/弱気/中立）を踏まえた「精度」を0〜1で返す共通関数。
// 弱気(state=-1)シグナルは「翌営業日に上がらなかった率」、それ以外は「上がった率」が精度の目安。
// （画面の的中率表示・スコアの重み調整・AIへの参考情報、すべてここを通す）
export function signalQuality(stat,sigKey){
  var state=parseInt(sigKey.split("#")[1],10);
  var winRate=stat.w/stat.t;
  return state===-1?(1-winRate):winRate;
}

// ── 呼値（値段の刻み）と買値プラン ────────────────────────────────────
// 東証の呼値（値段の刻み）。これに丸めないと実際には発注できない価格になる
export var TICKS_JP=[[3000,1],[5000,5],[30000,10],[50000,50],[300000,100],[500000,500],[3000000,1000],[5000000,5000]];
export function tickSizeFor(v,isJP){
  if(!isJP) return 0.01;
  for(var i=0;i<TICKS_JP.length;i++){ if(v<=TICKS_JP[i][0]) return TICKS_JP[i][1]; }
  return 10000;
}
// 呼値に丸める（dir: 1=切り上げ / -1=切り捨て / 0=四捨五入）
export function roundTickPrice(v,dir,isJP){
  var t=tickSizeFor(v,isJP),q=v/t;
  var out=(dir>0?Math.ceil(q):dir<0?Math.floor(q):Math.round(q))*t;
  return isJP?Math.round(out):parseFloat(out.toFixed(2));
}
// 買値・利確・損切りを組み立てる
// mode: "now"=現在値で追随 / "break"=上抜け待ち(逆指値)　※押し目待ち(dip)は廃止
// anchor: 買値の基準になる価格（dipならVWAP、breakなら当日高値+1ティック）
// 利確幅は「日足ATR×0.4」。ただし最低+1.0%・最大+3.0%に収める。損切り幅はその半分（RR約1:2）
export function buildBuyPlan(mode,anchor,atrDaily,isJP,reason,warn){
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

// ── 手法バッジ（値動きの荒さ）──────────────────────────────────────────
// analyzeStockのvolType（値動きの荒さ）がそのまま手法バッジになる。トレード登録時に
// styleAtAddとして記録し、📊的中率パネルの「手法別 成績」で集計する
export var TRADE_STYLES=[
  {key:"short",label:"⚡スキャル",color:"#f43f5e"},
  {key:"mid",label:"📈デイトレ",color:"#fbbf24"},
  {key:"stable",label:"🌊スイング",color:"#22d3a0"}
];
export function tradeStyleInfo(key){
  for(var i=0;i<TRADE_STYLES.length;i++){if(TRADE_STYLES[i].key===key)return TRADE_STYLES[i];}
  return null;
}

// ── 実績に基づくシグナルの重み補正 ────────────────────────────────────
// シグナル1件分の重み係数（1.0=調整なし、0=ミュート）。
// サンプル10件未満 または 5営業日分未満 は調整なし（同日に多銘柄スキャンした水増し対策）
// 10〜19件は最大±10%／20件以上は最大±20%
// 30件以上あって的中率45%未満のシグナルは「ノイズ」と判断し配点ゼロ（自動ミュート）
// stats は呼び出し側（App.js）が localStorage から集計して渡す。未指定なら補正なし
export function getSignalWeight(sigKey,stats){
  var s=(stats||{})[sigKey];
  if(!s||s.t<10||sigStatDays(s)<5) return 1;
  var quality=signalQuality(s,sigKey);
  if(s.t>=30&&quality<0.45) return 0; // 自動ミュート
  var maxAdjust=s.t>=20?0.2:0.1;
  var mult=1+(quality-0.5)*2*maxAdjust;
  return Math.max(1-maxAdjust,Math.min(1+maxAdjust,mult));
}
// breakdown表示名 → 実際に積み上がるシグナルラベル群のマッピング（重み適用用）
export var CATEGORY_SIGNAL_MAP={
  "VWAP":["VWAP"],"VWAP傾き":["VWAP傾き"],"Pivot":["Pivot"],"ATR(値幅)":["ATR"],"ATR消化率":["ATR消化率"],"対TOPIX":["対TOPIX"],
  "トレンド":["トレンド","上位足一致(5本毎)","上位足一致(15本毎)"],"EMA整列":["EMA整列"],
  "MACD":["MACD"],"RSI":["RSI"],"BB":["BB","BB収束"],"Stoch":["Stoch"],
  "出来高/OBV":["OBV","出来高"],
  "ギャップ":["ギャップ"],"当日ブレイク":["当日ブレイク"],"寄り付きレンジ":["寄り付きレンジ"],"コンフルエンス":["コンフルエンス"]
};
// 過去の的中率に基づき、breakdownカテゴリごとの点数を補正する
export function applySignalWeights(sc,signals,breakdown,stats){
  var adjust=0;
  breakdown.forEach(function(b){
    var labels=CATEGORY_SIGNAL_MAP[b.label];
    if(!labels||!b.delta) return;
    var fired=signals.filter(function(sig){return labels.indexOf(baseSigLabel(sig.label))>=0;});
    if(!fired.length) return;
    var mults=fired.map(function(sig){return getSignalWeight(baseSigLabel(sig.label)+"#"+sig.state,stats);});
    var avgMult=mults.reduce(function(a,b){return a+b;},0)/mults.length;
    adjust+=b.delta*(avgMult-1);
  });
  return sc+adjust;
}

// ── 初動スコア（0〜100点・既存の総合スコアとは完全に別枠）─────────────────
// 既存スコアは「すでに動き出した銘柄」を高く評価する設計のため、これから動く銘柄は
// 構造的に低スコアになる。そこで「数日で動き出す直前〜動き始め」を拾う別スコアを持つ。
//   方向(最大40点) : 対TOPIX相対の直近3営業日累積。上か下かを決める主軸
//   連続性(最大20点): 3日ともプラスか。一発の急騰ではなく、じわじわ強い状態を評価
//   出来高(最大20点): 動き始め(1.2〜2.5倍)が最高点。2.5倍超は「祭りの後」で0点
//   BB収束(最大20点): 値幅が縮んでいるほど、この後の値動き拡大が期待できる
//   減点(最大-20点) : ATR消化率90%以上／下降トレンド・デッドクロス
// 対TOPIX相対を使うため日本株のみ。履歴が3日分揃わない銘柄はnull（判定不可）。
export var MOMENTUM_LOOKBACK=3;
export function calcMomentumScore(a){
  if(a.market!=="JP") return null;
  var rels=(a.hist||[]).slice(-MOMENTUM_LOOKBACK)
    .map(function(e){return e&&e.ctx?e.ctx.rel:null;})
    .filter(function(v){return v!=null;});
  if(rels.length<MOMENTUM_LOOKBACK) return null;
  var relSum=rels.reduce(function(x,y){return x+y;},0);
  var parts=[];
  // ① 方向：初動ゾーン(+0.5〜+3%)が最高点。+6%超は上げ切っているとみなす
  var dir=relSum>=6?5:relSum>=3?25:relSum>=0.5?40:relSum>=-1?25:0;
  parts.push({label:"対TOPIX累積",val:(relSum>=0?"+":"")+relSum.toFixed(1)+"%",delta:dir});
  // ② 連続性
  var upCount=rels.filter(function(v){return v>0;}).length;
  var cont=upCount>=3?20:upCount>=2?10:0;
  parts.push({label:"連続性",val:upCount+"/"+MOMENTUM_LOOKBACK+"日プラス",delta:cont});
  // ③ 出来高（動き始めを拾う配点）
  var vs=a.volSurge||1;
  var vol=vs>2.5?0:vs>=1.2?20:vs>=0.8?12:0;
  parts.push({label:"出来高",val:vs.toFixed(1)+"倍",delta:vol});
  // ④ BB収束（既存のbwRatioをそのまま流用）
  var bb=a.bwRatio==null?0:a.bwRatio<=0.7?20:a.bwRatio<=0.85?12:0;
  parts.push({label:"BB収束",val:a.bwRatio==null?"─":Math.round(a.bwRatio*100)+"%",delta:bb});
  // ⑤ 減点
  var pen=0;
  if(a.atrUsedPct!=null&&a.atrUsedPct>=90){pen-=10;parts.push({label:"ATR消化",val:Math.round(a.atrUsedPct)+"%(使い切り)",delta:-10});}
  if(a.bearish){pen-=10;parts.push({label:"下降/DC",val:"トレンド逆行",delta:-10});}
  return{score:Math.max(0,Math.min(100,dir+cont+vol+bb+pen)),
    relSum:Math.round(relSum*10)/10,parts:parts};
}

// 決算日・権利落ち日のローカル記憶が渡されなかった場合の既定動作（取得値をそのまま使う）
function passThroughEventDate(ticker,field,freshDate){return freshDate||null;}

// ── 銘柄1件分のスコア計算（このモジュールの本体）──────────────────────────
// stock : {ticker,name,market,tvSymbol,volume}
// pd    : 株価データ（closes/highs/lows/opens/volumes/dates/currentPrice など）
// vixVal: VIX（US指数。nullなら未使用）
// opts  : localStorage 由来の情報の受け渡し口（ファイル冒頭のコメント参照）
export function analyzeStock(stock,pd,vixVal,opts){
  opts=opts||{};
  var signalStats=opts.signalStats||{};                                   // 実績による重み補正（未指定＝補正なし）
  var resolveEventDate=opts.resolveEventDate||passThroughEventDate;       // 決算日・権利落ち日のローカル記憶
  var makeVerdict=opts.buildVerdict||null;                                // 🚦総合判定の組み立て
  var closes=pd.closes.slice(),highs=pd.highs.slice(),lows=pd.lows.slice();
  var volumes=pd.volumes?pd.volumes.slice():[];
  var n=closes.length-1;
  // ── 足種別パラメータ切替 ──────────────────────────────────────────────────
  var isJP=stock.market==="JP";
  // デイトレ対応：JP/US共に15分足に統一（取引時間が約6.5時間で揃うため1日≒26本で共通化）
  // JP: J-Quantsの1分足をサーバー側(api/stock.js)で15分足に集計 / US: Yahoo Financeから15分足を直接取得
  var DAY_BARS   =26;   // 1日あたりのバー数（実測できない場合のフォールバック）
  var BPD=barsPerDay(pd.dates)||DAY_BARS; // 実測した1営業日あたりのバー数（東証22・米国26）
  var BB_P       =BPD*20; // 20日相当（実測した1日の本数×20日。市場や取引時間が変わっても追従する）
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
  // 計算には丸めていない値をそのまま使う。整数に丸めると米国株や低位株でATRが0や1に
  // 潰れ、「値幅不足」判定・利確損切り幅・買いプランまで連鎖して壊れるため。
  // 丸めるのは画面表示とAIプロンプトに渡すとき(atrDisp)だけにする
  var atr=atrRaw!=null?atrRaw:price*0.02;
  var atrDisp=isJP?Math.round(atr):parseFloat(atr.toFixed(2));
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
  // 当日の足が1本しか無い寄り付き直後(9:00〜9:15)でも、必ず当日分だけで算出する。
  // 以前は2本目が出るまで全期間累積(約20営業日の平均価格)に落ちていたため、
  // 上昇中の銘柄では毎朝「VWAP上方乖離」という誤ったシグナルが点灯していた
  var vwap=null;
  if(volumes.length>0&&sessionStarted){
    if(todayStart!==null){
      vwap=calcVWAP(closes.slice(todayStart),highs.slice(todayStart),lows.slice(todayStart),volumes.slice(todayStart));
    }else{
      vwap=calcVWAP(closes,highs,lows,volumes); // 日付データが無い時だけ全期間で代替
    }
  }
  var pivot=calcPivot(closes,highs,lows,pd.dates);

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
  // 本日の値幅(高値-安値)が「1日の平均値幅(日足ATR)」の何%に達しているかを見る。
  // 既に値幅の大部分を使い切っている場合、その日のうちにさらに同方向へ伸びる余地は
  // 乏しく、高値掴み・追いかけ買いのリスクが高いと判断してスコアを抑える（ボーナスなし）
  // ※基準は必ず日足ATR。15分足ATRと比べると常に700〜800%になり判定が成立しない
  // ここで算出した atrDaily は後段の買値プラン（buildBuyPlan）でも使い回す
  var atrDaily=calcDailyATR(closes,highs,lows,pd.dates,14);
  if(todayStart!==null&&atrDaily>0){
    var tHighsAtr=highs.slice(todayStart,n+1),tLowsAtr=lows.slice(todayStart,n+1);
    if(tHighsAtr.length>0){
      var todayRange=Math.max.apply(null,tHighsAtr)-Math.min.apply(null,tLowsAtr);
      var atrUsedPct=todayRange/atrDaily*100;
      if(atrUsedPct>=130){sc-=8;signals.push({label:"ATR消化率",val:"消化"+atrUsedPct.toFixed(0)+"%(過熱・追随危険)",state:-1});}
      else if(atrUsedPct>=90){sc-=4;signals.push({label:"ATR消化率",val:"消化"+atrUsedPct.toFixed(0)+"%(値幅使い切り注意)",state:-1});}
      else if(atrUsedPct>=50){signals.push({label:"ATR消化率",val:"消化"+atrUsedPct.toFixed(0)+"%(順調)",state:0});}
      else{signals.push({label:"ATR消化率",val:"消化"+atrUsedPct.toFixed(0)+"%(値幅余地あり)",state:0});}
    }
  }
  breakdown.push({label:"ATR消化率",delta:sc-scChk});scChk=sc;

  // ── 前日終値 ──────────────────────────────────────────────────────────────
  // 個別株の終値は15:30のクロージング・オークション(大引け)で決まるため、15分足の
  // 最終バーの終値とは1%近くズレることがある。公式の前営業日終値を最優先で使い、
  // 前日の値幅から大きく外れている場合だけ15分足ベースに戻す（誤配信への保険）。
  var prevClose=findPrevClose(closes,pd.dates)||pd.previousClose;
  if(pd.officialPrevClose>0){
    if(!pivot) prevClose=pd.officialPrevClose; // 検算材料が無い時も公式値の方が確か
    else if(pd.officialPrevClose>=pivot.prevLow*0.98&&pd.officialPrevClose<=pivot.prevHigh*1.02) prevClose=pd.officialPrevClose;
  }
  var change=prevClose?((price-prevClose)/prevClose*100).toFixed(2):"0.00";

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

  // ※「対業種相対強弱」は、業種平均を集計する処理がAPI側に無く常に空だったため撤去。
  //   復活させる場合は api/stock.js で sectorChange / sectorName を返すところから。

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
  // 高値=安値の足（その15分間に値動きなし＝昼休みの埋め足や薄商いの足）は、
  // 「終値位置0＝安値引けで最弱」ではなく単に判断材料が無いだけなので、平均から外す。
  // 以前は0点として数えていたため、常に売り方向へ引っ張られていた
  var obvBars=Math.min(BPD,n+1);
  var cpSum=0,cpCnt=0;
  for(var oi=n-obvBars+1;oi<=n;oi++){
    var dr=highs[oi]-lows[oi];
    if(!(dr>0)) continue;                  // 値動きゼロの足は数えない
    cpSum+=(closes[oi]-lows[oi])/dr; cpCnt++;
  }
  // 有効な足が少なすぎる時は判定しない（残った数本のブレで方向が決まってしまうため）
  var cpMin=Math.max(3,Math.floor(obvBars/3));
  var closePosition=cpCnt>=cpMin?cpSum/cpCnt:null;
  var cpUp=closePosition!==null&&closePosition>=0.6;   // 買い優勢と言える終値位置
  var cpDown=closePosition!==null&&closePosition<=0.4; // 売り優勢と言える終値位置
  if(closePosition===null){signals.push({label:"OBV",val:"判定不可(値動き少)",state:0});}
  else if(closePosition>=0.8){obScore+=7;signals.push({label:"OBV",val:"買い優勢",state:1});}
  else if(closePosition>=0.6){obScore+=4;signals.push({label:"OBV",val:"やや買い優勢",state:1});}
  else if(closePosition<=0.2){obScore-=6;signals.push({label:"OBV",val:"売り優勢",state:-1});}
  else if(closePosition<=0.4){obScore-=3;signals.push({label:"OBV",val:"やや売り優勢",state:-1});}
  else{signals.push({label:"OBV",val:"中立",state:0});}

  // 出来高: 直近5日分合計 vs 長期20日平均（同期間）で比較
  if(volumes.length>0){
    var volDay5=BPD*5,volDay20=BPD*20;
    var recentSum=volumes.slice(-volDay5).reduce(function(a,b){return a+b;},0);
    var longVols=volumes.slice(-volDay20,-volDay5);
    var avgSum=longVols.length>0?longVols.reduce(function(a,b){return a+b;},0)/longVols.length*volDay5:0;
    var surge=avgSum>0?recentSum/avgSum:1;
    if(surge>=2.0){
      obScore+=(cpUp?8:cpDown?-8:2);
      signals.push({label:"出来高",val:surge.toFixed(1)+"倍"+(cpUp?"(買い)":cpDown?"(売り)":"(中立)"),state:cpUp?1:cpDown?-1:0});
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
    var gapPct=prevClose?((todayOpen-prevClose)/prevClose*100):0;
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
  sc=applySignalWeights(sc,signals,breakdown,signalStats);
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
  // ラベル・色はTRADE_STYLES（手法別集計と共通の定義）から引く
  var tradeType=volType,tsInfo=tradeStyleInfo(tradeType)||TRADE_STYLES[2];
  var tradeLabel=tsInfo.label,tradeColor=tsInfo.color;

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
  var atrUpper=isJP?Math.round(price+atr):parseFloat((price+atr).toFixed(2));
  var atrLower=isJP?Math.round(price-atr):parseFloat((price-atr).toFixed(2));
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
  // 日足ATRはATR消化率の判定時に算出済み。ここでは換算できなかった場合の保険のみ
  if(!(atrDaily>0)) atrDaily=atr*5; // 日足に換算できない時の近似（15分足26本ぶん≒√26倍）
  // planSkip: 買いプランを出さなかった「実際の理由」。プロンプトでそのままAIに渡す。
  // 「いずれかのため」という曖昧な表記だと、シグナル欄の内容と食い違って見えるため
  var buyPlan=null,planSkip=null;
  if(!pd.real){ planSkip="株価データの取得に失敗"; }
  else if(!sessionStarted){ planSkip="休場中（本日の取引が未開始のため場中指標を算出できず）"; }
  else if(vwap===null){ planSkip="VWAP算出不可（出来高データなし）"; }
  else if(!(atr>0)){ planSkip="ATR算出不可"; }
  else if(price<=vwap){ planSkip="VWAP割れ"; }
  else{
    var sigState=function(lbl){var h=signals.find(function(x){return x.label===lbl;});return h?h.state:0;};
    var overheat=signals.find(function(x){return x.label==="ATR消化率"&&x.state===-1;});
    var todayHigh=null;
    if(todayStart!==null&&todayStart<n){
      var hArr=highs.slice(todayStart,n);
      if(hArr.length) todayHigh=Math.max.apply(null,hArr);
    }
    // ※押し目待ち(dip)は廃止。勢いの条件に当てはまらない銘柄は買いプランを表示しない
    if(overheat){
      planSkip="本日の値幅を使い切り（"+overheat.val+"）";
    }else if(!(sigState("VWAP傾き")===1&&sigState("出来高")===1)){
      planSkip="勢い不足（VWAP傾き上昇と出来高急増が揃っていない）";
    }else if(todayHigh===null){
      planSkip="当日の値動きデータ不足";
    }else{
      var bpMode,bpAnchor,bpReason;
      if(price>todayHigh){
        bpMode="now"; bpAnchor=price; bpReason="当日高値を更新中（現在値で追随）";
      }else{
        bpMode="break"; bpAnchor=todayHigh+tickSizeFor(todayHigh,isJPmkt);
        bpReason="当日高値"+roundTickPrice(todayHigh,0,isJPmkt)+"の上抜け待ち（逆指値）";
      }
      // 残り時間チェック（日本株・14:30以降のブレイク狙いは伸びきらない可能性）
      var jstNow=new Date(Date.now()+9*3600*1000);
      var jstMin=jstNow.getUTCHours()*60+jstNow.getUTCMinutes();
      var lateWarn=(isJPmkt&&jstMin>=870)?"引けまで残りわずか":null;
      buyPlan=buildBuyPlan(bpMode,bpAnchor,atrDaily,isJPmkt,bpReason,lateWarn);
      if(!buyPlan) planSkip="買値の算出に失敗";
    }
  }
  // ── 週足高安値（直近5営業日）──────────────────────────────────────────────
  // 固定本数(26本×5日)だと、東証は1日22本なうえ場中は当日の足が少ないため、窓が
  // 時間とともに後ろへずれて同じ日でも値が動いてしまう。日付で5営業日ぶんを切り出す。
  var weekHigh=null,weekLow=null;
  if(pd.dates&&pd.dates.length===closes.length&&closes.length>0){
    var wDays=[],wStart=0;
    for(var wi=pd.dates.length-1;wi>=0;wi--){
      if(wDays.indexOf(pd.dates[wi])===-1){
        if(wDays.length>=5) break;
        wDays.push(pd.dates[wi]);
      }
      wStart=wi;
    }
    for(var wj=wStart;wj<=n;wj++){
      if(highs[wj]!=null&&(weekHigh===null||highs[wj]>weekHigh)) weekHigh=highs[wj];
      if(lows[wj]!=null&&(weekLow===null||lows[wj]<weekLow)) weekLow=lows[wj];
    }
  }
  var wDec=stock.market==="JP"?0:2;
  weekHigh=weekHigh!=null?parseFloat(weekHigh.toFixed(wDec)):null;
  weekLow=weekLow!=null?parseFloat(weekLow.toFixed(wDec)):null;
  // ── サポートレベル（下値目安）──────────────────────────────────────────────
  var support=null;
  if(lows.length>=BB_P){
    var validLows=lows.filter(function(v){return v!=null&&v>0&&!isNaN(v)&&isFinite(v);});
    var isJPfmt=stock.market==="JP";
    var s1v=validLows.length>=BB_P?Math.min.apply(null,validLows.slice(-BB_P)):null; // 20日相当
    // ※旧S2(全期間安値)は削除。15分足の取得期間が約20営業日しかなく、S1とほぼ同値に
    //   なるだけで意味が無かった。中期の安値は日足ベース(calc52wのlow60)を使う。
    var atrFv=price-atr*1.5;
    if(s1v!==null&&isFinite(s1v)){
      support={
        s1:isJPfmt?Math.round(s1v):parseFloat(s1v.toFixed(2)),
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

  // ── 🚦 総合判定（各機能の結果を1つに集約）──────────────────────────────
  // 判定に使う統計は localStorage 由来のため、組み立て関数を opts で受け取る
  var verdict=(pd.real&&makeVerdict)?makeVerdict({score:sc,signals:signals,ticker:stock.ticker,relStrength:relStrength,
    buyPlan:buyPlan}):null;
  var verdictKey=verdict?verdict.key:null;

  // ── スコア履歴（保存はしない。呼び出し側の saveScoreHistory が書き込む）────
  // 休場中・寄り付き前はVWAP等の場中指標が算出できず、スコアの土俵が場中と変わる。
  // そのまま記録するとスコア推移・的中率の統計が汚れるため記録しない。
  // 取得失敗で疑似データ(genSim)に置き換わった場合も、乱数の価格を「その日の実績」として
  // 残すと翌日の本物の価格と比較され、シグナル的中率・スコア帯実績・重み補正の
  // すべてが汚染されるため記録しない
  var recordDaily=!!(sessionStarted&&pd.real);
  var today=currentSessionDate(stock.market); // UTCではなく市場のセッション日（JST基準）
  var sigKeys=signals.map(function(x){return baseSigLabel(x.label)+"#"+x.state;});
  // 地合い情報（対TOPIX前日比・VIX・時間帯）も一緒に記録しておく（Cの機能）
  // → 「上げ相場ではこのシグナルが効く」等の分析に後日使うための記録のみ。現時点では集計には使わない
  // relは対TOPIX相対（個別銘柄の前日比 − TOPIXの前日比）。トレンド局面（初動/過熱）の判定に使う
  var ctx={topix:topixChange!=null?topixChange:null,vix:vixVal!=null?parseFloat(vixVal):null,session:currentSessionLabel(),market:stock.market,rel:relStrength!=null?relStrength:null};
  var scoreHist=(opts.scoreHist||[]).slice();
  if(recordDaily){
    var entry={d:today,s:sc,atr:atrDisp,p:price,sig:sigKeys,ctx:ctx,v:verdictKey};
    if(scoreHist.length&&scoreHist[scoreHist.length-1].d===today){
      scoreHist[scoreHist.length-1]=entry;
    }else{
      scoreHist.push(entry);
      if(scoreHist.length>40)scoreHist.shift();
    }
  }
  // 初動スコア（既存スコアの計算には一切影響しない・scoreHist確定後に算出）
  var momentum=calcMomentumScore({
    market:stock.market,hist:scoreHist,
    volSurge:(typeof surge!=="undefined"?surge:1),
    bwRatio:(typeof bwRatio!=="undefined"?bwRatio:null),
    atrUsedPct:(typeof atrUsedPct!=="undefined"?atrUsedPct:null),
    bearish:!!(hasDC||hasBearTrend)
  });
  // ────────────────────────────────────────────────────────────────────────

  // ── 時間帯別検証用のイントラデイ履歴（①のscoreHistとは別キー・別ロジック）───
  // 1日に複数件残す（同一日・同一時間帯の再スキャンのみ上書き）。Dの機能専用。
  // JP銘柄のみ記録（時間帯ラベルが日本市場基準のため、US銘柄を混ぜると統計が汚れる）。
  // sigは点灯中（state≠0）のみ保存し、localStorage容量を大幅節約する
  var recordIntraday=!!(stock.market==="JP"&&sessionStarted&&pd.real);
  var itoday=currentSessionDate("JP"); // UTCではなくJSTの営業日（この記録はJP限定）
  var isession=currentSessionLabel();
  var inow=new Date(); // 記録時刻(HH:MM)。比較する2点が何分離れているかの判定に使う
  var itime=("0"+inow.getHours()).slice(-2)+":"+("0"+inow.getMinutes()).slice(-2);
  var isigKeys=signals.filter(function(x){return x.state!==0;}).map(function(x){return baseSigLabel(x.label)+"#"+x.state;});
  var intradayHist=(opts.intradayHist||[]).slice();
  if(recordIntraday){
    var ilast=intradayHist[intradayHist.length-1];
    var ientry={d:itoday,session:isession,t:itime,s:sc,p:price,sig:isigKeys,v:verdictKey};
    if(ilast&&ilast.d===itoday&&ilast.session===isession){
      intradayHist[intradayHist.length-1]=ientry;
    }else{
      intradayHist.push(ientry);
      if(intradayHist.length>200)intradayHist.shift(); // 目安：1日最大4件×約50日分
    }
  }

  // ── 当日の出来高（15分足から自前で集計）──────────────────────────────────
  // ランキングAPIのstock.volumeは0が返るため、取得済みの15分足を合計して使う。
  // 「データ内の最終日」ぶんを合計するので、寄り付き前・休場中は前営業日の合計になる
  var dayVolume=0;
  if(pd.dates&&pd.dates.length===volumes.length&&volumes.length>0){
    var lastVolDate=pd.dates[pd.dates.length-1];
    for(var vi=volumes.length-1;vi>=0&&pd.dates[vi]===lastVolDate;vi--) dayVolume+=volumes[vi]||0;
  }
  // Yahoo公式の当日出来高(meta.regularMarketVolume)が届いていればそちらを優先する。
  // 15分足には大引け(15:30のクロージング・オークション)が含まれず、自前集計は実績より
  // 1割強少なく出るため。公式値は必ず自前集計以上になるはずなので、下回る場合は
  // 誤配信や寄り付き前(公式値0)とみなして採用しない＝この比較が検算も兼ねている
  if(pd.officialVolume>0&&pd.officialVolume>=dayVolume) dayVolume=pd.officialVolume;

  return{ticker:stock.ticker,tvSymbol:stock.tvSymbol,name:stock.name,market:stock.market,
    volume:dayVolume||stock.volume||0,volSurge:(typeof surge!=="undefined"?surge:1),
    price:dispPrice,rawPrice:pd.real?price:null,score:sc,winRate:winRate.toFixed(1),expVal:expVal,
    timing:timing,verdict:verdictKey,verdictInfo:verdict,signals:signals,breakdown:breakdown,change:change,spark:closes.slice(-30),
    real:pd.real,failReason:pd.error||null,closes:closes,highs:highs,lows:lows,volumes:volumes,per:pd.per||null,pbr:pd.pbr||null,
    analystTarget:pd.analystTarget||null,earningsDate:resolveEventDate(stock.ticker,"earningsDate",pd.earningsDate||null),exRightsDate:resolveEventDate(stock.ticker,"exRightsDate",pd.exRightsDate||null),weekHigh:weekHigh,weekLow:weekLow,
    topixChange:topixChange,relStrength:relStrength,
    high52:high52,low52:low52,fromHigh:fromHigh,fromLow:fromLow,position52:position52,
    overlapLabels:overlapLabels,
    tradeType:tradeType,tradeLabel:tradeLabel,tradeColor:tradeColor,
    aptScore:aptScore,
    atr:atrDisp,atrRawVal:atr,atrUpper:atrUpper,atrLower:atrLower,support:support,resistance:resistance,profitLoss:profitLoss,buyPlan:buyPlan,planSkip:planSkip,
    sessionStarted:sessionStarted, // 休場中・寄り付き前かどうか（プロンプトの注記に使用）
    scoreHist:scoreHist,
    momentum:momentum,
    actualWinRate:calcActualWinRate(scoreHist,null,stock.market==="JP"),
    vwap:vwap?parseFloat(vwap.toFixed(stock.market==="JP"?0:2)):null,
    pivot:pivot?{pp:parseFloat(pivot.pp.toFixed(stock.market==="JP"?0:2)),r1:parseFloat(pivot.r1.toFixed(stock.market==="JP"?0:2)),s1:parseFloat(pivot.s1.toFixed(stock.market==="JP"?0:2)),r2:parseFloat(pivot.r2.toFixed(stock.market==="JP"?0:2)),s2:parseFloat(pivot.s2.toFixed(stock.market==="JP"?0:2)),prevHigh:parseFloat(pivot.prevHigh.toFixed(stock.market==="JP"?0:2)),prevLow:parseFloat(pivot.prevLow.toFixed(stock.market==="JP"?0:2)),prevClose:parseFloat(pivot.prevClose.toFixed(stock.market==="JP"?0:2))}:null,
    yahooUrl:"https://finance.yahoo.co.jp/quote/"+stock.ticker,
    // ── 保存用の値（localStorage / Redis への書き込みは呼び出し側が行う）──
    // daily     : sh_<ticker> に記録してよいか
    // intraday  : sh_intraday_<ticker> に記録してよいか（JP銘柄のみ）
    // dailyHist / intradayHist は上限件数まで整理済みで、そのまま保存できる配列
    save:{
      daily:recordDaily,intraday:recordIntraday,
      date:today,score:sc,atr:atrDisp,price:price,sigKeys:sigKeys,session:isession,
      time:itime,ctx:ctx,verdict:verdictKey,intradaySigKeys:isigKeys,
      dailyHist:scoreHist,intradayHist:intradayHist
    }};
}
