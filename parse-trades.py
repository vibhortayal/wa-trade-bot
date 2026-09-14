#!/usr/bin/env python3
"""Extract structured trades from WhatsApp messages via Gemini."""
import hashlib
import json, re, subprocess, sys, os
from datetime import datetime, timezone

# Shared pseudonym map (same "Trader NN" labels the dashboard uses).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pseudonyms import load_pseudos, save_pseudos, pseudo, is_from_me

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

# Phone-ish patterns are PII, not trade signal (same judgment the dashboard
# already applies to notes). Scrubbed from message bodies pre-LLM. URLs and
# ISO dates are protected first: a tweet ID or an expiry date is not a phone
# number, and mangling them would hurt parsing.
PHONE_HINT = re.compile(r"@?\+?\d[\d\-\s]{7,}\d(@[a-zA-Z]+)?")
_PROTECT_HINT = re.compile(r"https?://\S+|\d{4}-\d{2}-\d{2}")
def scrub_phones(t):
    t = t or ""
    protected = {}
    def _hold(m):
        k = f"\ue000{len(protected)}\ue001"  # private-use chars: can't collide with chat text
        protected[k] = m.group(0)
        return k
    t = _PROTECT_HINT.sub(_hold, t)
    t = PHONE_HINT.sub("", t)
    for k, v in protected.items():
        t = t.replace(k, v)
    return t

GEMINI = os.path.expanduser("~/workspace/skills/google-gemini/bin/gemini.py")
# Repo-local data dir (works wherever the repo is cloned, not just the Hatch VM).
DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
# Self-hosted mode: use a personal Gemini API key directly (set GEMINI_API_KEY,
# optionally GEMINI_API_KEY_BACKUP as an automatic failover when the primary
# hits its quota). Otherwise falls back to the Hatch google-gemini skill CLI.
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_API_KEY_BACKUP = os.environ.get("GEMINI_API_KEY_BACKUP", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL") or "gemini-3.5-flash-lite"
# Primary + optional backup key. On quota/rate-limit errors the parser fails
# over to the next key instead of burning retries on an exhausted one.
_GEMINI_KEYS = list(dict.fromkeys(
    k for k in (GEMINI_API_KEY, GEMINI_API_KEY_BACKUP) if k))
_key_idx = 0

def _gemini_key():
    return _GEMINI_KEYS[_key_idx % len(_GEMINI_KEYS)] if _GEMINI_KEYS else ""

def _rotate_gemini_key():
    """Move to the next configured key. Returns True when we actually
    switched to a different key."""
    global _key_idx
    if len(_GEMINI_KEYS) < 2:
        return False
    _key_idx = (_key_idx + 1) % len(_GEMINI_KEYS)
    return True
# Generic LLM provider (optional): any OpenAI-compatible chat-completions API —
# OpenAI, OpenRouter, Together, Ollama, vLLM, LM Studio, etc. Takes precedence
# over GEMINI_API_KEY when set. Gemini remains the suggested free default.
LLM_API_BASE = os.environ.get("LLM_API_BASE", "").rstrip("/")
LLM_API_KEY = os.environ.get("LLM_API_KEY", "")
LLM_MODEL = os.environ.get("LLM_MODEL", "")

PROMPT = """You parse WhatsApp trading-group messages into structured trade records. Today is {today}.

INPUT: a JSON array of messages. Each has id, date (YYYY-MM-DD), sender, text, and optionally quoted (the message being replied to, with its own sender/date/text).
Note: "sender" is an anonymized label like "Trader 07" — real identities never reach you. Do not attempt to identify anyone; treat the label as an opaque speaker id.

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
    """Direct Gemini API call using the active key (GEMINI_API_KEY primary,
    GEMINI_API_KEY_BACKUP on failover)."""
    import urllib.request, urllib.error
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{GEMINI_MODEL}:generateContent?key={_gemini_key()}")
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
            if _GEMINI_KEYS:
                return call_gemini_rest(payload)
            p = subprocess.run([sys.executable, GEMINI, "--json", "--temperature", "0.1"],
                               input=payload.encode(), capture_output=True, timeout=300)
        except Exception as e:
            last_err = f"{type(e).__name__}: {e}"
            if "HTTP 400" in last_err:
                raise RuntimeError("llm failed: " + last_err)
            quota_hit = ("429" in last_err or "quota" in last_err.lower()
                         or "ResourceExhausted" in last_err)
            if quota_hit and not LLM_API_BASE and _rotate_gemini_key():
                print(f"    key quota hit, failing over to backup key"
                      f" (attempt {attempt+1})...", flush=True)
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

def msg_keys(m):
    """Identity keys for dedup. Record ids are positional (msg-<line>), so a
    re-appended line looks new even when it's the same message. Prefer the
    WhatsApp message id when present, but always include a content hash
    (sender + second + body + quoted body) so id-less records still match a
    re-pulled copy of the same message."""
    keys = []
    if m.get("id"):
        keys.append("wa:" + str(m["id"]))
    q = (m.get("quoted") or {}).get("body") or ""
    h = hashlib.sha1("|".join([str(m.get("senderId") or ""), str(m.get("t") or ""),
                               m.get("body") or "", q]).encode()).hexdigest()[:16]
    keys.append("h:" + h)
    return keys


def _write_parse_stats(new_messages, new_actions):
    with open(f"{DATA}/parse-stats.json", "w") as f:
        json.dump({
            "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "new_messages": new_messages,
            "new_actions": new_actions,
        }, f)


def main():
    msgs_path = f"{DATA}/messages.jsonl"
    if not os.path.exists(msgs_path):
        print("no messages yet (nothing pulled), nothing to parse")
        _write_parse_stats(0, 0)
        return
    msgs = [json.loads(l) for l in open(msgs_path) if l.strip()]
    # Pre-LLM anonymization: real sender names/IDs never leave the machine.
    # Labels come from the shared map, so they're the same "Trader NN" names
    # the dashboard shows — one numbering everywhere.
    pseudos = load_pseudos()
    def trader_of(sender_id, sender_name=None, from_me=False):
        label, _ = pseudo(pseudos, sender_id, sender_name, from_me)
        return label
    batch_msgs = []
    key_of = {}  # "msg-<idx>" -> identity keys of the raw message
    for idx, m in enumerate(msgs):
        if not m.get("body"):
            continue
        item = {"id": f"msg-{idx}", "date": datetime.fromtimestamp(int(m["t"]), tz=timezone.utc).strftime("%Y-%m-%d"),
                "sender": trader_of(m.get("senderId"), m.get("senderName"), is_from_me(m.get("fromMe"))),
                "text": scrub_phones(m["body"])}
        if m.get("quoted") and m["quoted"].get("body"):
            item["quoted"] = {"sender": trader_of(m["quoted"].get("senderId")),
                              "text": scrub_phones(m["quoted"]["body"])}
        batch_msgs.append(item)
        key_of[item["id"]] = msg_keys(m)
    # Persist newly assigned labels BEFORE the first LLM call, so a mid-run
    # crash can't shift numbering on the retry.
    save_pseudos(pseudos)

    print(f"parsing {len(batch_msgs)} messages with text...", flush=True)
    results = []
    # Messages per LLM call. The prompt takes a JSON array and returns one
    # record per message, so batching cuts API requests ~Bx for the same
    # tokens. Tunable via PARSE_BATCH_SIZE.
    B = max(1, int(os.environ.get("PARSE_BATCH_SIZE", "20")))
    done_ids = set()
    done_keys = set()
    # resume from checkpoint if present
    ckpt_path = f"{DATA}/trades.json"
    n_done_before = 0
    n_trades_before = 0
    if os.path.exists(ckpt_path):
        try:
            prev = json.load(open(ckpt_path))
            if isinstance(prev, list) and prev and all("id" in r for r in prev):
                results = prev
                done_ids = {r["id"] for r in prev}
                # identity keys of already-parsed messages, mapped back
                # through the current message list (robust to index shifts)
                for r in prev:
                    mm = re.match(r"msg-(\d+)$", r.get("id", ""))
                    if mm:
                        i0 = int(mm.group(1))
                        if 0 <= i0 < len(msgs):
                            done_keys.update(msg_keys(msgs[i0]))
                n_done_before = len(done_ids)
                n_trades_before = sum(len(r.get("trades", [])) for r in prev)
                print(f"  resuming: {len(done_ids)} already parsed", flush=True)
        except Exception:
            pass
    import time
    n_skipped = 0
    def checkpoint():
        with open(ckpt_path, "w") as f:
            json.dump(results, f, indent=1, ensure_ascii=False)
    def _mark_done(mid):
        done_ids.add(mid)
        done_keys.update(key_of.get(mid, ()))

    for i in range(0, len(batch_msgs), B):
        # Drop already-parsed messages individually: a chunk may straddle
        # the resume boundary, and skipping it whole would lose messages.
        # A message counts as parsed by positional id OR by identity key
        # (catches re-appended copies of a message parsed under another id).
        chunk = [m for m in batch_msgs[i:i+B]
                 if m["id"] not in done_ids
                 and not any(k in done_keys for k in key_of.get(m["id"], ()))]
        if not chunk:
            continue
        if (i // B) % 20 == 0:
            print(f"  {i+1}/{len(batch_msgs)}...", flush=True)
        # Per-message prefilter: only trade-like messages spend an LLM call.
        to_parse = [m for m in chunk if looks_like_trade(m)]
        to_parse_ids = {m["id"] for m in to_parse}
        for m in chunk:
            if m["id"] not in to_parse_ids:
                results.append({"id": m["id"], "no_trade": True, "trades": [],
                                "note": "prefilter: no trade signals, Gemini call skipped"})
                _mark_done(m["id"])
                n_skipped += 1
        if to_parse:
            try:
                res = call_llm(to_parse)
                assert len(res) == len(to_parse), f"count mismatch: {len(res)} vs {len(to_parse)}"
            except Exception as e:
                for m in to_parse:
                    results.append({"id": m["id"], "no_trade": True, "trades": [],
                                    "note": f"PARSE_FAILED: {e}"[:300]})
                    _mark_done(m["id"])
                print(f"    parse failed for {len(to_parse)} msgs: {e}", flush=True)
            else:
                results.extend(res)
                for r in res:
                    _mark_done(r["id"])
        checkpoint()
        time.sleep(4)  # stay under free-tier RPM
    print(f"  {len(batch_msgs)}/{len(batch_msgs)} done", flush=True)

    with open(f"{DATA}/trades.json", "w") as f:
        json.dump(results, f, indent=1, ensure_ascii=False)
    n_trades = sum(len(r.get("trades", [])) for r in results)
    n_msgs = sum(1 for r in results if r.get("trades"))
    print(f"DONE: {n_trades} trade actions in {n_msgs} messages "
          f"({n_skipped} skipped by prefilter) -> {DATA}/trades.json")
    # per-run stats for the dashboard health pill (via push-supabase -> wa_meta)
    _write_parse_stats(len(done_ids) - n_done_before, n_trades - n_trades_before)

if __name__ == "__main__":
    main()
