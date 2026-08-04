"""
お気に入り銘柄の5営業日先を Chronos-Bolt で予測し、public/forecasts.json に書き出す。
GitHub Actions から毎晩1回だけ実行される想定。

必要な環境変数（GitHubのSecretsに登録する）
  SYNC_URL : アプリのURL 例) https://xxxx.vercel.app
  USER_ID  : アプリの「デバイス同期」タブに出ているID 例) u_a1b2c3d4
"""

import json
import os
import pathlib
import time

import requests
import torch
from chronos import BaseChronosPipeline

SYNC_URL = os.environ["SYNC_URL"].rstrip("/")
USER_ID = os.environ["USER_ID"]
MODEL = os.environ.get("MODEL", "amazon/chronos-bolt-small")

HORIZON = 5        # 何営業日先まで予測するか（アプリ側のBAND_DAYSと揃える）
CONTEXT = 512      # 直近何日ぶんを材料にするか
BATCH = 16         # 一度に予測する銘柄数
MIN_BARS = 60      # これ未満しか日足が無い銘柄は対象外
OUT = pathlib.Path("public/forecasts.json")
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}


def get_favorites():
    """アプリの同期APIからお気に入り銘柄を取り出す"""
    r = requests.get(f"{SYNC_URL}/api/sync", params={"userId": USER_ID}, timeout=20)
    r.raise_for_status()
    favs = r.json().get("favs") or []
    return [t for t in favs if isinstance(t, str) and t.strip()]


def get_daily(ticker, retries=3):
    """Yahooから日足の終値を取る。429（アクセス過多）が出たら間を空けて再挑戦する"""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
    for i in range(retries):
        try:
            r = requests.get(url, params={"interval": "1d", "range": "2y"},
                             headers=UA, timeout=25)
        except Exception:
            time.sleep(5)
            continue
        if r.status_code == 429:
            time.sleep(20 * (i + 1))
            continue
        if not r.ok:
            return None
        result = (r.json().get("chart") or {}).get("result")
        if not result:
            return None
        res = result[0]
        stamps = res.get("timestamp") or []
        closes = ((res.get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
        rows = []
        for ts, c in zip(stamps, closes):
            if c is not None:
                rows.append((time.strftime("%Y-%m-%d", time.gmtime(ts)), float(c)))
        return rows
    return None


def main():
    favs = get_favorites()
    print(f"お気に入り {len(favs)} 銘柄")

    series, meta = [], []
    for t in favs:
        rows = get_daily(t)
        time.sleep(1.2)                       # Yahooに連続で叩きすぎないための間隔
        if not rows or len(rows) < MIN_BARS:
            print(f"  skip {t}（日足不足）")
            continue
        closes = [c for _, c in rows][-CONTEXT:]
        series.append(torch.tensor(closes, dtype=torch.float32))
        meta.append({"ticker": t, "date": rows[-1][0], "base": closes[-1]})
    print(f"予測対象 {len(series)} 銘柄")

    items = {}
    if series:
        pipe = BaseChronosPipeline.from_pretrained(
            MODEL, device_map="cpu", torch_dtype=torch.float32)
        for i in range(0, len(series), BATCH):
            chunk = series[i:i + BATCH]
                        q, _ = pipe.predict_quantiles(
                chunk, prediction_length=HORIZON,
                quantile_levels=[0.1, 0.5, 0.9])
            for j, m in enumerate(meta[i:i + BATCH]):
                                a = q[j]
                if a.ndim == 3:
                    a = a[0]
                items[m["ticker"]] = {
                    "d": m["date"],
                    "p": round(m["base"], 2),
                    "q10": [round(float(v), 2) for v in a[:, 0]],
                    "q50": [round(float(v), 2) for v in a[:, 1]],
                    "q90": [round(float(v), 2) for v in a[:, 2]],
                }
            print(f"  {min(i + BATCH, len(series))}/{len(series)} 完了")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "horizon": HORIZON,
        "model": MODEL,
        "items": items,
    }, ensure_ascii=False), encoding="utf-8")
    print(f"書き出し完了: {OUT}（{len(items)}銘柄）")


if __name__ == "__main__":
    main()
