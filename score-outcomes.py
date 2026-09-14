#!/usr/bin/env python3
"""Score trade outcomes using daily market-data bars.

Reads parsed actions via build-dashboard.build_records(), resolves each
symbol to a provider ticker (cached per provider), fetches daily OHLCV
(cached per provider), and writes per-action outcomes to data/outcomes.json
keyed by action id (msg-<n>-<j>).

Market-data providers (MARKET_DATA_PROVIDER env, default "tradingview"):
  - tradingview: your connected account via the vendored tv.py CLI.
    Suggested default: symbol search + broad coverage (stocks, ETFs,
    crypto, futures). Caches in data/tv_symbols.json / data/tv_bars.json.
  - yahoo: free, no key, no account, via Yahoo Finance chart API.
    US stocks/ETFs as bare tickers, crypto as BTC-USD. Caches in
    data/yahoo_symbols.json / data/yahoo_bars.json. Bars are
    split/dividend-adjusted. Coverage is narrower than TradingView's
    search (no fuzzy symbol search; exotic tickers may not resolve).

Outcome model (WINDOW trading days, NOISE flat band):
  - bullish opens (BUY/ADD, or instrument=call): favorable if ret > +NOISE
  - bearish opens (instrument=put):              favorable if ret < -NOISE
  - exits (SELL/TRIM/EXIT): exit-timing favorable if price fell > NOISE
    in the window after the exit
  - PLAN with an explicit price target: tgt_hit if the target was touched
    within 14 calendar days (high >= target for bullish, low <= for bearish)
  - round trips: FIFO match per (trader, symbol, instrument) of BUY/ADD ->
    SELL/TRIM/EXIT; the exit action gets roundtrip {entry_id, ret}

Entry price: the message's price when present AND the instrument is
stock/crypto, else that day's close (entry_src "msg" vs "close" records
which). For options the message price is usually the contract premium,
which is meaningless against underlying bars, so it is never used.
UNDERLYING's direction only -- without the contract premium we cannot
compute real P&L, and the outcome says so.

Unresolved symbols / missing bars -> scored:false with a reason. Nothing is
invented: no score is emitted without real bars.

Env:
  MARKET_DATA_PROVIDER  "tradingview" (default) or "stooq"
  TV_CLI  path to tv.py (default: vendor/tradingview/tv.py next to this file)
  WINDOW  trading-day window (default 5)
  NOISE   flat band, e.g. 0.01 = 1% (default 0.01)
"""
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
PROVIDER = os.environ.get("MARKET_DATA_PROVIDER", "tradingview").strip().lower()
if PROVIDER not in ("tradingview", "yahoo"):
    sys.exit(f"score-outcomes: unknown MARKET_DATA_PROVIDER={PROVIDER!r} "
             f"(expected 'tradingview' or 'yahoo')")
TV_CLI = os.environ.get("TV_CLI", os.path.join(HERE, "vendor", "tradingview", "tv.py"))
WINDOW = int(os.environ.get("WINDOW", "5"))
NOISE = float(os.environ.get("NOISE", "0.01"))
TARGET_DAYS = 14

# build-dashboard.py has a hyphen; load it without renaming.
import importlib.util
_spec = importlib.util.spec_from_file_location(
    "build_dashboard", os.path.join(HERE, "build-dashboard.py"))
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
build_records = _mod.build_records

try:
    from zoneinfo import ZoneInfo
    ET = ZoneInfo("America/New_York")
except Exception:
    ET = timezone.utc  # tzdata missing: fall back to UTC bucketing

# Per-provider caches: ticker namespaces differ (NASDAQ:TSLA vs TSLA),
# so each provider gets its own symbol/bar cache files.
SYM_CACHE = os.path.join(DATA, "tv_symbols.json" if PROVIDER == "tradingview"
                         else "yahoo_symbols.json")
BAR_CACHE = os.path.join(DATA, "tv_bars.json" if PROVIDER == "tradingview"
                         else "yahoo_bars.json")
OUT_PATH = os.path.join(DATA, "outcomes.json")

PREF_EXCH = ["NASDAQ", "NYSE", "NYSEARCA", "AMEX"]
PREF_TYPE = {"stock", "fund", "etf", "unit", "trust", "crypto"}
CRYPTO = {"BTC", "ETH", "SOL", "DOGE", "XRP", "ADA", "AVAX", "LINK", "DOT", "MATIC"}

TARGET_RE = re.compile(
    r"\b(?:to|target|tgt|price target)\s*\$?\s*(\d+(?:\.\d+)?)", re.IGNORECASE)


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def tv_call(tool, args, timeout=90):
    """Call the vendored TradingView CLI; return parsed JSON or None."""
    env = dict(os.environ, TV_MAX_OUTPUT="500000")  # don't truncate bar lists
    try:
        p = subprocess.run(
            [sys.executable, TV_CLI, "call", tool, json.dumps(args)],
            capture_output=True, text=True, timeout=timeout, env=env)
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"  tv_call {tool}: {e}", file=sys.stderr)
        return None
    if p.returncode != 0:
        print(f"  tv_call {tool}: {p.stderr.strip()[:160] or p.stdout.strip()[:160]}",
              file=sys.stderr)
        return None
    try:
        return json.loads(p.stdout)
    except ValueError:
        print(f"  tv_call {tool}: unparseable output", file=sys.stderr)
        return None


def tv_get_bars(ticker, count):
    """Daily [t,o,h,l,c,v] bars via the vendored TradingView CLI."""
    res = tv_call("get_ohlcv", {"symbol": ticker, "interval": "1D",
                                "count": count})
    bars = []
    if res and isinstance(res.get("bars"), list):
        for b in res["bars"]:
            t = b.get("t")
            if t:
                bars.append([t, b.get("o"), b.get("h"), b.get("l"),
                             b.get("c"), b.get("v")])
    return bars


def yahoo_get_bars(ticker, period1=None):
    """Daily split/dividend-adjusted [t,o,h,l,c,v] bars via the Yahoo Finance
    chart API (free, no key). Returns [] when the ticker has no data, None on
    transport/rate-limit problems (so callers don't cache a negative answer
    for a transient failure)."""
    import urllib.request
    import urllib.error
    import urllib.parse
    import json
    import time
    t = urllib.parse.quote(ticker, safe="")
    if period1:
        url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{t}"
               f"?interval=1d&period1={period1}&period2={int(time.time()) + 86400}")
    else:
        url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{t}"
               f"?interval=1d&range=2y")
    req = urllib.request.Request(
        url, headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return []  # unknown ticker
        print(f"  yahoo {ticker}: HTTP {e.code}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"  yahoo {ticker}: {type(e).__name__}", file=sys.stderr)
        return None
    chart = d.get("chart") or {}
    if chart.get("error") or not chart.get("result"):
        return []
    res = chart["result"][0]
    ts = res.get("timestamp") or []
    ind = res.get("indicators") or {}
    q = (ind.get("quote") or [{}])[0]
    adj = (ind.get("adjclose") or [{}])[0].get("adjclose") or []
    opens, highs, lows = q.get("open") or [], q.get("high") or [], q.get("low") or []
    closes, vols = q.get("close") or [], q.get("volume") or []
    bars = []
    for i, tstamp in enumerate(ts):
        if i >= len(closes):
            break
        c = closes[i]
        if c is None or c <= 0:
            continue
        o, h, l = opens[i], highs[i], lows[i]
        if o is None or h is None or l is None:
            continue
        a = adj[i] if i < len(adj) and adj[i] else c
        f = a / c  # split/dividend adjustment factor
        v = vols[i] if i < len(vols) and vols[i] else 0
        bars.append([tstamp, round(o * f, 4), round(h * f, 4),
                     round(l * f, 4), round(a, 4), v])
    return bars


def yahoo_candidates(sym):
    """Ticker candidates for a chat symbol on Yahoo (no search API used)."""
    s = sym.upper().strip()
    if s in CRYPTO:
        return [f"{s}-USD"]
    return [s, f"{s}-USD"]
def resolve_symbol(sym, sym_cache, bar_cache):
    """Map a chat symbol ('TSLA') to a provider ticker ('NASDAQ:TSLA' on
    TradingView, 'TSLA' on Yahoo). Providers without a search API validate
    candidates by fetching bars (which also fills the bar cache)."""
    if sym in sym_cache:
        return sym_cache[sym]
    s = sym.upper().strip()
    ticker = None
    if PROVIDER == "tradingview":
        if s in CRYPTO:
            ticker = f"CRYPTO:{s}USD"
        else:
            res = tv_call("search_symbols", {"query": s})
            cands = (res or {}).get("data", {}).get("symbols", []) if res else []
            # Prefer an exact ticker match on a major US exchange.
            def rank(c):
                exch = c.get("exchange", "")
                exact = c.get("symbol", "").split(":")[-1].upper() == s
                return (0 if exch in PREF_EXCH else 1,
                        0 if exact else 1,
                        0 if c.get("type") in PREF_TYPE else 1)
            cands = sorted(cands, key=rank)
            if cands and rank(cands[0])[0] == 0:
                ticker = cands[0]["symbol"]
        sym_cache[sym] = ticker  # cache misses too (as null) to avoid re-searching
    else:
        for cand in yahoo_candidates(s):
            bars, _ = fetch_bars(cand, bar_cache, None)
            if bars:
                ticker = cand
                break
        if ticker:
            sym_cache[sym] = ticker
        # No negative caching for Yahoo: an empty answer may be a transient
        # rate-limit, and re-probing next run is cheap.
    return ticker


def fetch_bars(ticker, bar_cache, min_day):
    """Return sorted [t,o,h,l,c,v] bars for ticker, fetching what is missing."""
    entry = bar_cache.get(ticker, {"bars": []})
    bars = entry["bars"]
    have = {b[0] for b in bars}
    if PROVIDER == "tradingview":
        # Enough bars to cover min_day..today+margin, or a small top-up when
        # we already have history.
        fresh = tv_get_bars(ticker, 400 if not bars else 40)
    else:
        # Yahoo supports period1/period2 for incremental top-ups.
        if bars:
            fresh = yahoo_get_bars(ticker, period1=bars[-1][0] + 1)
        else:
            fresh = yahoo_get_bars(ticker)
        if fresh is None:
            fresh = []  # transient failure: keep serving the cache
    new = 0
    for b in fresh:
        if b[0] not in have:
            bars.append(b)
            have.add(b[0])
            new += 1
    bars.sort(key=lambda b: b[0])
    bar_cache[ticker] = {"bars": bars}
    return bars, new


def bar_date(t):
    return datetime.fromtimestamp(t, ET).date().isoformat()


def close_on_or_before(bars, day):
    """Index of the last bar with date <= day (handles weekends)."""
    lo = None
    for i, b in enumerate(bars):
        if bar_date(b[0]) <= day:
            lo = i
        else:
            break
    return lo


def main():
    records = build_records()
    print(f"score-outcomes: {len(records)} actions (market data: {PROVIDER})")
    sym_cache = load_json(SYM_CACHE, {})
    bar_cache = load_json(BAR_CACHE, {})
    outcomes = load_json(OUT_PATH, {})

    # Group symbols needing bars.
    syms = sorted({r["symbol"] for r in records if r.get("symbol")})
    tickers = {}
    for s in syms:
        t = resolve_symbol(s, sym_cache, bar_cache)
        tickers[s] = t
        print(f"  {s} -> {t or 'UNRESOLVED'}")
    save_json(SYM_CACHE, sym_cache)

    min_day = min((r["day"] for r in records if r.get("day")), default=None)
    bars_by_sym = {}
    for s in syms:
        t = tickers[s]
        if not t:
            continue
        days = [r["day"] for r in records if r.get("symbol") == s and r.get("day")]
        bars, new = fetch_bars(t, bar_cache, min(days) if days else None)
        bars_by_sym[s] = bars
        if new:
            print(f"  {t}: +{new} bars ({len(bars)} cached)")
    save_json(BAR_CACHE, bar_cache)

    stats = {"scored": 0, "favorable": 0, "unfavorable": 0, "flat": 0,
             "roundtrips": 0, "targets": 0, "targets_hit": 0}

    # FIFO open lots per (trader, symbol, instrument) for round-trip matching.
    lots = {}

    for r in sorted(records, key=lambda r: (r["ts"], r["id"])):
        rid = r["id"]
        out = {"scored": False}
        sym = r.get("symbol")
        action = r.get("action")
        day = r.get("day")
        bars = bars_by_sym.get(sym) if sym else None
        if not bars:
            out["reason"] = "unresolved symbol" if sym else "no symbol"
            outcomes[rid] = out
            continue
        i = close_on_or_before(bars, day)
        if i is None:
            out["reason"] = "no bars before trade date"
            outcomes[rid] = out
            continue

        entry_bar = bars[i]
        instr = (r.get("instrument") or "").lower()
        # For options the message price is usually the contract PREMIUM, not the
        # underlying price -- never compare bars against it. Only stock/crypto
        # message prices are usable as entries.
        is_option = instr in ("call", "put", "spread")
        if r.get("price") and not is_option:
            entry, entry_src = r["price"], "msg"
        else:
            entry, entry_src = entry_bar[4], "close"
        j = min(i + WINDOW, len(bars) - 1)
        late = bars[j][4]
        ret = (late / entry - 1) if entry else None
        out.update({
            "scored": True,
            "entry": round(entry, 4) if entry else None,
            "entry_src": entry_src,
            "window_days": WINDOW,
            "asof": bar_date(bars[j][0]),
            "ret": round(ret, 4) if ret is not None else None,
        })
        stats["scored"] += 1

        # Buying a put is a bearish bet, even though the action is BUY.
        bearish = instr == "put"
        bullish = not bearish and (action in ("BUY", "ADD") or instr == "call")

        if action in ("SELL", "TRIM", "EXIT"):
            # Exit timing: favorable if the price fell after the exit.
            fav = ret < -NOISE if ret is not None else None
            out["kind"] = "exit"
            out["favorable"] = fav
            # Round-trip match against oldest open lot of the same instrument
            # (a stock trim must not close an option lot).
            key = (r["trader"], sym, instr)
            if lots.get(key):
                eid, eprice, eday = lots[key].pop(0)
                rt_ret = (entry / eprice - 1) if eprice else None
                out["roundtrip"] = {"entry_id": eid,
                                   "ret": round(rt_ret, 4) if rt_ret is not None else None}
                stats["roundtrips"] += 1
        elif action == "PLAN":
            target = r.get("target")
            if target is None and r.get("note"):
                m = TARGET_RE.search(r["note"])
                if m:
                    target = float(m.group(1))
            if target:
                stats["targets"] += 1
                out["kind"] = "plan"
                out["target"] = target
                bear = bearish
                hit = False
                cutoff = (datetime.fromisoformat(day).date()
                          + timedelta(days=TARGET_DAYS)).isoformat()
                for b in bars[i + 1:]:
                    d = bar_date(b[0])
                    if d <= day or d > cutoff:
                        continue
                    if (b[3] <= target) if bear else (b[2] >= target):
                        hit = True
                        out["target_hit_day"] = d
                        break
                out["tgt_hit"] = hit
                out["favorable"] = hit
                if hit:
                    stats["targets_hit"] += 1
            else:
                out["kind"] = "plan"
                out["favorable"] = None
        elif bullish or bearish:
            out["kind"] = "direction"
            if ret is None:
                out["favorable"] = None
            elif abs(ret) <= NOISE:
                out["favorable"] = None
                out["flat"] = True
                stats["flat"] += 1
            else:
                fav = (ret > 0) if bullish else (ret < 0)
                out["favorable"] = fav
            # Open a FIFO lot for round-trip matching on bullish opens.
            if bullish and action in ("BUY", "ADD"):
                lots.setdefault((r["trader"], sym, instr), []).append(
                    (rid, entry, day))
        else:
            out["kind"] = "other"
            out["favorable"] = None

        fav = out.get("favorable")
        if fav is True:
            stats["favorable"] += 1
        elif fav is False:
            stats["unfavorable"] += 1
        outcomes[rid] = out

    save_json(OUT_PATH, outcomes)
    print(f"score-outcomes: wrote {len(outcomes)} outcomes "
          f"(scored={stats['scored']}, favorable={stats['favorable']}, "
          f"unfavorable={stats['unfavorable']}, flat={stats['flat']}, "
          f"roundtrips={stats['roundtrips']}, "
          f"targets_hit={stats['targets_hit']}/{stats['targets']})")


if __name__ == "__main__":
    main()
