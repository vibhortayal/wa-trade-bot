#!/usr/bin/env python3
"""tv.py - CLI for TradingView's official MCP server.

Usage:
  tv.py auth --start                  register (if needed) and print the authorize URL
  tv.py auth --callback "<pasted URL>" complete OAuth with the pasted redirect URL
  tv.py status                        show auth state (no secrets printed)
  tv.py tools                         list available MCP tools
  tv.py call <tool> '<json args>'     call a tool and pretty-print the result
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import auth
from auth import AuthError
import mcp_client
from mcp_client import MCPClient, MCPError


def cmd_auth_start(_args):
    as_meta = auth.discover()
    client = auth.register_client(as_meta)
    url = auth.build_authorize_url(as_meta, client)
    print("Open this URL in your browser and approve access with your TradingView account:")
    print()
    print(url)
    print()
    print("After approving, your browser will try to open")
    print("  http://localhost:8080/callback?code=...")
    print("which will NOT load on your phone - that is expected.")
    print("Copy the FULL address-bar URL (it contains ?code=...) and run:")
    print()
    print('  tv.py auth --callback "<paste the full URL here>"')


def cmd_auth_callback(args):
    try:
        auth.exchange_code(args.url)
    except AuthError as e:
        print("Authorization failed:", e, file=sys.stderr)
        sys.exit(1)
    print("Authorized. Access token stored (never printed). You can now use 'tv.py tools' and 'tv.py call'.")


def cmd_status(_args):
    s = auth.status()
    print("registered:      %s" % s["registered"])
    print("client_id:       %s" % (s["client_id"] or "-"))
    print("authorized:      %s" % s["authorized"])
    if s["authorized"]:
        print("token expires:   in %d s" % s["token_expires_in_s"])
        print("refresh token:   %s" % ("stored" if s["has_refresh_token"] else "missing"))
    print("pending approve: %s" % s["pending_authorize"])


def cmd_tools(_args):
    try:
        tools = MCPClient().list_tools()
    except (AuthError, MCPError) as e:
        print("Error:", e, file=sys.stderr)
        sys.exit(1)
    for t in tools:
        desc = (t.get("description") or "").split("\n")[0][:100]
        print("%-28s %s" % (t.get("name"), desc))
    print("\n%d tools" % len(tools))


def cmd_call(args):
    try:
        arguments = json.loads(args.json_args) if args.json_args else {}
    except ValueError as e:
        print("Invalid JSON args:", e, file=sys.stderr)
        sys.exit(1)
    if not isinstance(arguments, dict):
        print("Tool arguments must be a JSON object.", file=sys.stderr)
        sys.exit(1)
    try:
        result = MCPClient().call_tool(args.tool, arguments)
    except (AuthError, MCPError) as e:
        print("Error:", e, file=sys.stderr)
        sys.exit(1)
    for item in result.get("content", []):
        # Vendor patch (wa-trade-bot): allow large outputs for the outcome
        # scorer via TV_MAX_OUTPUT; default 20000 matches upstream.
        max_out = int(os.environ.get("TV_MAX_OUTPUT", "20000"))
        if isinstance(item, dict) and item.get("type") == "text":
            text = item.get("text", "")
            try:
                print(json.dumps(json.loads(text), indent=2)[:max_out])
            except ValueError:
                print(text[:max_out])
        else:
            print(json.dumps(item, indent=2)[:max_out])


def main():
    p = argparse.ArgumentParser(prog="tv.py", description="TradingView MCP CLI")
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("auth", help="OAuth authorize flow")
    a.add_argument("--start", action="store_true", help="print the authorize URL")
    a.add_argument("--callback", metavar="URL", help="complete auth with pasted redirect URL")
    a.set_defaults(func=_dispatch_auth)

    s = sub.add_parser("status", help="show auth state")
    s.set_defaults(func=cmd_status)

    t = sub.add_parser("tools", help="list MCP tools")
    t.set_defaults(func=cmd_tools)

    c = sub.add_parser("call", help="call an MCP tool")
    c.add_argument("tool", help="tool name")
    c.add_argument("json_args", nargs="?", default="{}", help="JSON object of arguments")
    c.set_defaults(func=cmd_call)

    args = p.parse_args()
    args.func(args)


def _dispatch_auth(args):
    if args.start:
        cmd_auth_start(args)
    elif args.callback:
        args.url = args.callback
        cmd_auth_callback(args)
    else:
        print("use 'tv.py auth --start' or 'tv.py auth --callback \"<URL>\"'", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
