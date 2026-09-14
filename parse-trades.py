#!/usr/bin/env python3
"""Extract structured trades from WhatsApp messages via Gemini."""
import json, re, subprocess, sys, os
from datetime import datetime, timezone

# Pre-filter: skip messages with no trade signals before spending a Gemini call.
# Biased hard toward recall (100% on a 200-message calibration set) — a false
# pass just costs one Gemini call, a false negative loses a trade forever.
TRADE_HINT = re.compile(r'''(?ix)
    \$[A-Za-z]{1,6}\b
  | \$\d[\d,\.]*
  | \b\d+[cCpP]\b
  | \b\d{1,2}/\d{1,2}\b
  | \b(calls?|puts?|leaps?|shares?|contracts?|options?|futures?|spreads?|straddles?|strangles?|iron\s?condors?|trade|trading|traded)\b
  | \b(bought|buy|buying|sold|sells?|selling|long|short|shorted|trim\w*|added|adding|holding|hold|exit|exited|entered|entry|entries|stop|stops|target|targets|roll|rolled|assigned|exercised|swing|scalps?)\b
  | \b(OTM|ITM|ATM)\b
  | \bout\ of\b
''')

def looks_like_trade(item):
    t = item.get("text") or ""
    q = item.get("quoted") or {}
    if q.get("text"):
        t += " " + q["text"]
    return bool(TRADE_HINT.search(t))

GEMINI = os.path.expanduser("~/workspace/skills/google-gemini/bin/gemini.py")
# Repo-local data dir (works wherever the repo is cloned, not just the Hatch VM).
DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
# Self-hosted mode: use a personal Gemini API key directly (set GEMINI_API_KEY).
# Otherwise falls back to the Hatch google-gemini skill CLI.
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL") or "gemini-3.5-flash-lite"
# Generic LLM provider (optional): any OpenAI-compatible chat-completions API —
# OpenAI, OpenRouter, Together, Ollama, vLLM, LM Studio, etc. Takes precedence
# over GEMINI_API_KEY when set. Gemini remains the suggested free default.
LLM_API_BASE = os.environ.get("LLM_API_BASE", "").rstrip("/")
LLM_API_KEY = os.environ.get("LLM_API_KEY", "")
LLM_MODEL = os.environ.get("LLM_MODEL", "")

PROMPT = """You parse WhatsApp trading-group messages into structured trade records. Today is {today}.

INPUT: a JSON array of messages. Each has id, date (YYYY-MM-DD), sender, text, and optionally quoted (the message being replied to, with its own sender/date/text).

TASK: For each message, decide if it describes a TRADE ACTION by the sender (opening, adding to, trimming, closing a position; stating a held position; a conditional/planned order). Extract one record per distinct action in the message.

Rules:
- Use the quoted reply for context: fragments like "2028 Jan", "yes", "trimmed 10%" only make sense with the quoted message. If the quoted text lets you resolve the symbol/instrument, do so and say so in "context_used".
- DO NOT extract from questions ("Any trade for ORCL?"), news, jokes, reactions ("Thank you 🙏"), or someone describing another person's trade. Those are no_trade.
- NEVER invent details. Missing symbol/strike/expiry/price -> null. If a value is ambiguous (e.g. "12/17" could be Dec 2026 or 2027), pick the most plausible given date context but set confidence to "low" and explain in "note".
- GROUNDING RULE (strict): the symbol MUST appear in THIS message or its quoted reply — verbatim as a ticker ($META, META), or as an unambiguous company name ("Amazon"->AMZN, "Rubrik"->RBRK, "Bitcoin"/$BTC->BTC). If the symbol appears nowhere in the message+quote, set symbol to null and confidence to "low", and say what is missing in "note". NEVER borrow a symbol from any other message.
- "Added $META $670 C Dec 27 @ 76.60" = BUY call, symbol META, strike 670, expiry 2027-12, premium 76.60.
- "Commons"/"shares" = stock. "leaps" = long-dated calls. "140p 10/16" = put, strike 140, expiry Oct 16. Crypto like BTC counts as a trade with instrument "crypto".
- action: one of BUY, ADD, SELL, TRIM, EXIT, HOLD, PLAN (conditional/planned), WATCH (mentions watching, no position).
- If the message states an explicit price target for the trade (e.g. "TSLA to 300", "target 250", "looking for 4800"), extract it as "target" (a number). Otherwise null.
- confidence: high / medium / low.

OUTPUT: a JSON array, one object per input message, in the same order:
{"id": "<message id>", "no_trade": true|false, "trades": [ {"action": "...", "symbol": "..."|null, "instrument": "stock"|"call"|"put"|"spread"|"crypto"|null, "strike": number|null, "expiry": "YYYY-MM"|null, "price": number|null, "target": number|null, "quantity": "..."|null, "confidence": "high"|"medium"|"low", "note": "...", "context_used": true|false} ], "note": "..." }
Return ONLY the JSON array, no other text.

MESSAGES:
"""

def call_gemini_rest(payload):
    """Direct Gemini API call using GEMINI_API_KEY (self-hosted mode)."""
    import urllib.request, urllib.error
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}")
    body = json.dumps({
        "contents": [{"parts": [{"text": payload}]}],
        "generationConfig": {"temperature": 0.1, "responseMimeType": "application/json"},
    }).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            resp = json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode()[:200]}")
    text = resp["candidates"][0]["content"]["parts"][0]["text"].strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0]
    return json.loads(text)


def call_openai_compat(payload):
    """Any OpenAI-compatible chat-completions API (OpenAI, OpenRouter, Ollama,
    vLLM, LM Studio...). Deliberately avoids response_format so providers
    without JSON-mode support (e.g. local Ollama builds) still work — the
    prompt instruction plus fence-stripping keeps output parseable."""
    import urllib.request, urllib.error
    url = f"{LLM_API_BASE}/chat/completions"
    body = json.dumps({
        "model": LLM_MODEL,
        "temperature": 0.1,
        "messages": [{"role": "user",
                      "content": payload + "\n\nReturn ONLY a JSON array, no markdown fences."}],
    }).encode()
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer " + LLM_API_KEY,
    })
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            resp = json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode()[:200]}")
    text = resp["choices"][0]["message"]["content"].strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0]
    return json.loads(text)


def call_llm(batch, tries=6):
    payload = (PROMPT.replace("{today}", datetime.now(timezone.utc).strftime("%Y-%m-%d"))
               + json.dumps(batch, ensure_ascii=False))
    last_err = None
    for attempt in range(tries):
        try:
            if LLM_API_BASE:
                if not LLM_API_KEY or not LLM_MODEL:
                    raise RuntimeError("LLM_API_BASE is set but LLM_API_KEY/LLM_MODEL is missing")
                return call_openai_compat(payload)
            if GEMINI_API_KEY:
                return call_gemini_rest(payload)
            p = subprocess.run([sys.executable, GEMINI, "--json", "--temperature", "0.1"],
                               input=payload.encode(), capture_output=True, timeout=300)
        except Exception as e:
            last_err = f"{type(e).__name__}: {e}"
            if "HTTP 400" in last_err:
                raise RuntimeError("llm failed: " + last_err)
            wait = min(2 ** attempt * 5, 120)
            print(f"    transport error, waiting {wait}s (attempt {attempt+1})...", flush=True)
            import time; time.sleep(wait)
            continue
        out = p.stdout.decode().strip()
        if p.returncode == 0:
            # strip any markdown fences just in case
            if out.startswith("```"):
                out = out.split("\n", 1)[1].rsplit("```", 1)[0]
            return json.loads(out)
        last_err = p.stderr.decode()[-500:] + " / " + out[:300]
        # retry on rate limits / transient server errors
        if any(s in last_err for s in ("429", "500", "503", "400", "ResourceExhausted")):
            wait = min(2 ** attempt * 5, 120)
            print(f"    rate-limited, waiting {wait}s (attempt {attempt+1})...", flush=True)
            import time; time.sleep(wait)
            continue
        raise RuntimeError("llm failed: " + last_err)
    raise RuntimeError(f"llm failed after {tries} tries: " + (last_err or ""))

def main():
    msgs_path = f"{DATA}/messages.jsonl"
    if not os.path.exists(msgs_path):
        print("no messages yet (nothing pulled), nothing to parse")
        return
    msgs = [json.loads(l) for l in open(msgs_path) if l.strip()]
    batch_msgs = []
    for idx, m in enumerate(msgs):
        if not m.get("body"):
            continue
        item = {"id": f"msg-{idx}", "date": datetime.fromtimestamp(int(m["t"]), tz=timezone.utc).strftime("%Y-%m-%d"),
                "sender": m.get("senderName"), "text": m["body"]}
        if m.get("quoted") and m["quoted"].get("body"):
            item["quoted"] = {"sender": m["quoted"].get("senderId"), "text": m["quoted"]["body"]}
        batch_msgs.append(item)

    print(f"parsing {len(batch_msgs)} messages with text...", flush=True)
    results = []
    B = 1
    done_ids = set()
    # resume from checkpoint if present
    ckpt_path = f"{DATA}/trades.json"
    if os.path.exists(ckpt_path):
        try:
            prev = json.load(open(ckpt_path))
            if isinstance(prev, list) and prev and all("id" in r for r in prev):
                results = prev
                done_ids = {r["id"] for r in prev}
                print(f"  resuming: {len(done_ids)} already parsed", flush=True)
        except Exception:
            pass
    import time
    n_skipped = 0
    for i in range(0, len(batch_msgs), B):
        chunk = batch_msgs[i:i+B]
        if chunk[0]["id"] in done_ids:
            continue
        if (i // B) % 20 == 0:
            print(f"  {i+1}/{len(batch_msgs)}...", flush=True)
        if not looks_like_trade(chunk[0]):
            # No trade signals — skip the Gemini call entirely.
            results.append({"id": chunk[0]["id"], "no_trade": True, "trades": [],
                            "note": "prefilter: no trade signals, Gemini call skipped"})
            done_ids.add(chunk[0]["id"])
            n_skipped += 1
            with open(ckpt_path, "w") as f:
                json.dump(results, f, indent=1, ensure_ascii=False)
            continue
        try:
            res = call_llm(chunk)
            assert len(res) == len(chunk), f"count mismatch: {len(res)} vs {len(chunk)}"
        except Exception as e:
            results.append({"id": chunk[0]["id"], "no_trade": True, "trades": [],
                            "note": f"PARSE_FAILED: {e}"[:300]})
            done_ids.add(chunk[0]["id"])
            with open(ckpt_path, "w") as f:
                json.dump(results, f, indent=1, ensure_ascii=False)
            print(f"    parse failed for {chunk[0]['id']}: {e}", flush=True)
            time.sleep(4)
            continue
        results.extend(res)
        done_ids.update(r["id"] for r in res)
        with open(ckpt_path, "w") as f:
            json.dump(results, f, indent=1, ensure_ascii=False)
        time.sleep(4)  # stay under free-tier RPM
    print(f"  {len(batch_msgs)}/{len(batch_msgs)} done", flush=True)

    with open(f"{DATA}/trades.json", "w") as f:
        json.dump(results, f, indent=1, ensure_ascii=False)
    n_trades = sum(len(r.get("trades", [])) for r in results)
    n_msgs = sum(1 for r in results if r.get("trades"))
    print(f"DONE: {n_trades} trade actions in {n_msgs} messages "
          f"({n_skipped} skipped by prefilter) -> {DATA}/trades.json")

if __name__ == "__main__":
    main()
