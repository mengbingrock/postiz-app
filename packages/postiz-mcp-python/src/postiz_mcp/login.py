"""Browser-based login: obtain the Postiz API key without copy/paste.

`postiz-mcp login` starts a one-shot HTTP listener on 127.0.0.1, opens the
Postiz web app at /mcp/connect, and waits for the page to hand the API key
back to the local callback. The key only ever travels browser -> localhost
(the page hard-codes 127.0.0.1 as the callback host); a random `state` nonce
ties the callback to this run.
"""

from __future__ import annotations

import secrets
import threading
import webbrowser
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Optional
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

from .config import Settings, normalize_mcp_url, save_settings

LOGIN_TIMEOUT_SECONDS = 300
CALLBACK_PATH = "/callback"

_OK_HTML = (
    "<!doctype html><meta charset='utf-8'><title>Postiz MCP connected</title>"
    "<body style='font-family:system-ui;padding:40px'><h2>Connected ✅</h2>"
    "<p>This device is now linked to Postiz MCP. You can close this tab.</p></body>"
)
_ERR_HTML = (
    "<!doctype html><meta charset='utf-8'><title>Postiz MCP</title>"
    "<body style='font-family:system-ui;padding:40px'><h2>Login rejected</h2>"
    "<p>{reason}. Re-run <code>postiz-mcp login</code>.</p></body>"
)


def web_origin(mcp_url: str) -> str:
    """The Postiz web app origin for an MCP URL (https://host)."""
    parsed = urlparse(normalize_mcp_url(mcp_url))
    return urlunparse((parsed.scheme, parsed.netloc, "", "", "", ""))


def connect_url(mcp_url: str, state: str, port: int, device: str) -> str:
    query = urlencode({"state": state, "port": port, "device": device})
    return f"{web_origin(mcp_url)}/mcp/connect?{query}"


@dataclass
class CallbackResult:
    api_key: Optional[str] = None
    error: Optional[str] = None


def parse_callback(path: str, expected_state: str) -> CallbackResult:
    """Validate a callback request path against the expected state nonce."""
    parsed = urlparse(path)
    if parsed.path != CALLBACK_PATH:
        return CallbackResult(error="unexpected path")
    query = parse_qs(parsed.query)
    state = (query.get("state") or [""])[0]
    key = (query.get("key") or [""])[0].strip()
    if not state or not secrets.compare_digest(state, expected_state):
        return CallbackResult(error="state mismatch")
    if not key:
        return CallbackResult(error="missing key")
    return CallbackResult(api_key=key)


def login(url: Optional[str], device_name: Optional[str], open_browser: bool = True) -> Settings:
    from .config import _read_config  # local import: avoid widening the module API

    existing = _read_config()
    mcp_url = normalize_mcp_url(url or existing.get("mcp_url", ""))
    if not mcp_url:
        raise RuntimeError("No Postiz URL known. Run `postiz-mcp login --url https://<your-postiz>/post/mcp`.")
    device = device_name or existing.get("device_id") or "this device"
    state = secrets.token_urlsafe(24)
    result = CallbackResult()
    done = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 (http.server API)
            outcome = parse_callback(self.path, state)
            if outcome.api_key:
                result.api_key = outcome.api_key
                body, status = _OK_HTML, 200
            else:
                result.error = outcome.error
                body, status = _ERR_HTML.format(reason=outcome.error), 400
            data = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            if outcome.api_key:
                done.set()

        def log_message(self, *_args: object) -> None:  # silence default stderr logging
            return

    server = HTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        target = connect_url(mcp_url, state, port, device)
        print("Opening your browser to link this device to Postiz MCP:")
        print(f"  {target}")
        print("If you are asked to log in first, log in and then open the URL above again.")
        if open_browser:
            webbrowser.open(target)
        if not done.wait(LOGIN_TIMEOUT_SECONDS):
            raise RuntimeError(f"Timed out after {LOGIN_TIMEOUT_SECONDS}s waiting for the browser ({result.error or 'no callback'}).")
    finally:
        server.shutdown()
        server.server_close()
    assert result.api_key
    return save_settings(mcp_url, result.api_key, device_name)
