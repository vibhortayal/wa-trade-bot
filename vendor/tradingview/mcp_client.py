"""Minimal MCP streamable-HTTP client for TradingView's MCP server.

Transport: POST JSON-RPC 2.0 to https://mcp.tradingview.com/mcp with
  Content-Type: application/json
  Accept: application/json, text/event-stream
  Authorization: Bearer <token>
The server may answer with plain JSON or SSE; both are handled.
On 401 the access token is refreshed once and the request retried.
"""
import json

import requests

import auth

PROTOCOL_VERSION = "2024-11-05"
TIMEOUT = 60


class MCPError(Exception):
    pass


def _parse_sse(text):
    """Extract JSON payloads from SSE data: lines; returns list of parsed objects."""
    payloads = []
    buf = []
    for line in text.splitlines():
        if line.startswith("data:"):
            buf.append(line[5:].lstrip())
        elif line.strip() == "" and buf:
            payloads.append("\n".join(buf))
            buf = []
    if buf:
        payloads.append("\n".join(buf))
    out = []
    for p in payloads:
        p = p.strip()
        if not p or p == "[DONE]":
            continue
        try:
            out.append(json.loads(p))
        except ValueError:
            pass
    return out


class MCPClient:
    def __init__(self):
        self.session = requests.Session()
        self.session_id = None
        self._next_id = 1
        self._initialized = False

    def _headers(self):
        h = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": "Bearer " + auth.get_access_token(),
        }
        if self.session_id:
            h["Mcp-Session-Id"] = self.session_id
        return h

    def _post(self, payload, _retried=False):
        r = self.session.post(auth.MCP_URL, json=payload, headers=self._headers(),
                              timeout=TIMEOUT)
        if r.status_code == 401 and not _retried:
            auth.refresh_tokens()  # raises AuthError if refresh impossible
            r = self.session.post(auth.MCP_URL, json=payload, headers=self._headers(),
                                  timeout=TIMEOUT)
        if r.status_code == 401:
            raise MCPError("unauthorized even after refresh; re-run 'tv.py auth --start'")
        if r.status_code >= 400:
            raise MCPError("MCP HTTP %d: %s" % (r.status_code, r.text[:300]))
        sid = r.headers.get("Mcp-Session-Id") or r.headers.get("mcp-session-id")
        if sid:
            self.session_id = sid
        if isinstance(payload, dict) and "id" not in payload:
            # JSON-RPC notification: no response body expected (often 202 empty).
            return None
        ctype = r.headers.get("Content-Type", "")
        if "text/event-stream" in ctype:
            msgs = _parse_sse(r.text)
        else:
            try:
                body = r.json()
            except ValueError:
                raise MCPError("non-JSON MCP response: %s" % r.text[:200])
            msgs = body if isinstance(body, list) else [body]
        if isinstance(payload, dict) and "id" in payload:
            for m in msgs:
                if isinstance(m, dict) and m.get("id") == payload["id"]:
                    return m
            raise MCPError("no JSON-RPC response matching id %r" % payload["id"])
        return msgs

    def _rpc(self, method, params=None):
        rid = self._next_id
        self._next_id += 1
        resp = self._post({"jsonrpc": "2.0", "id": rid, "method": method,
                           "params": params or {}})
        if not isinstance(resp, dict) or resp.get("jsonrpc") != "2.0":
            raise MCPError("malformed JSON-RPC response: %s" % str(resp)[:200])
        if "error" in resp:
            err = resp["error"]
            raise MCPError("MCP error %s: %s" % (err.get("code"), err.get("message")))
        return resp.get("result")

    def _notify(self, method, params=None):
        self._post({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def initialize(self):
        if self._initialized:
            return
        result = self._rpc("initialize", {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "tradingview-mcp-skill", "version": "0.1.0"},
        })
        server_v = (result or {}).get("protocolVersion")
        if server_v and server_v != PROTOCOL_VERSION:
            pass  # tolerate server-chosen version; tools shape is stable
        self._notify("notifications/initialized")
        self._initialized = True

    def list_tools(self):
        self.initialize()
        result = self._rpc("tools/list", {})
        return (result or {}).get("tools", [])

    def call_tool(self, name, arguments=None):
        """Call a tool; returns the result object. Raises MCPError on tool error."""
        self.initialize()
        result = self._rpc("tools/call", {"name": name, "arguments": arguments or {}})
        result = result or {}
        if result.get("isError"):
            texts = [c.get("text", "") for c in result.get("content", [])
                     if isinstance(c, dict)]
            raise MCPError("tool %s error: %s" % (name, " ".join(texts)[:500]))
        return result
