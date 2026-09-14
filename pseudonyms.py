#!/usr/bin/env python3
"""Shared sender-pseudonym map: stable 'Trader NN' labels.

One map, two consumers:
- parse-trades.py replaces real sender names/IDs with these labels BEFORE
  anything is sent to the LLM (pre-LLM anonymization).
- build-dashboard.py uses the same labels on the public dashboard / Supabase.

The map file lives in data/ (gitignored) and is private — it is the only
place that links a real sender identity to a label, and it never leaves the
machine / is never deployed.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
PSEUDO_PATH = os.path.join(DATA, "pseudonyms.json")


def load_pseudos(path=PSEUDO_PATH):
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return {}


def save_pseudos(pseudos, path=PSEUDO_PATH):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(pseudos, f, indent=1)


def _next_label(pseudos):
    nums = [int(v.split()[1]) for v in pseudos.values()
            if isinstance(v, str) and v.startswith("Trader ")]
    return f"Trader {max(nums or [0]) + 1:02d}"


def pseudo(pseudos, sender_id, sender_name, from_me):
    """Return (label, is_new) for a sender.

    Key priority matches the historical dashboard behavior: sender_id, then
    sender_name, then a stable key for the user's own messages. Everyone —
    including the user — gets an anonymous 'Trader NN' label; never 'You'.
    """
    key = sender_id or sender_name or ("__me__" if from_me else "unknown")
    if key not in pseudos:
        pseudos[key] = _next_label(pseudos)
        return pseudos[key], True
    return pseudos[key], False


def is_from_me(value):
    """messages.jsonl stores fromMe as a real bool; tolerate string forms."""
    return str(value).lower() == "true"
