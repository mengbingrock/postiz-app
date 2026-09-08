from __future__ import annotations

import json
import os
import platform
import secrets
import socket
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse, urlunparse


def config_path() -> Path:
    configured = os.environ.get("POSTIZ_MCP_CONFIG")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".config" / "postiz-mcp" / "config.json"


def normalize_mcp_url(value: str) -> str:
    value = value.strip().rstrip("/")
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Postiz URL must be an absolute http:// or https:// URL.")
    path = parsed.path.rstrip("/")
    if not path or path == "/":
        path = "/api/mcp"
    elif not (path.endswith("/mcp") or "/mcp/" in path):
        path += "/api/mcp"
    return urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))


def egress_url(mcp_url: str) -> str:
    parsed = urlparse(normalize_mcp_url(mcp_url))
    scheme = "wss" if parsed.scheme == "https" else "ws"
    path = parsed.path
    if path.endswith("/api/mcp"):
        path = path[: -len("/mcp")] + "/egress/connect"
    elif path.endswith("/mcp"):
        path = path[: -len("/mcp")] + "/egress/connect"
    else:
        path = "/api/egress/connect"
    return urlunparse((scheme, parsed.netloc, path, "", "", ""))


@dataclass(frozen=True)
class Settings:
    mcp_url: str
    api_key: str
    device_id: str


def _read_config() -> dict[str, str]:
    path = config_path()
    if not path.exists():
        return {}
    data = json.loads(path.read_text())
    return data if isinstance(data, dict) else {}


def _new_device_id() -> str:
    return f"{platform.node() or socket.gethostname()}-{secrets.token_hex(4)}"


def save_settings(
    url: Optional[str],
    api_key: str,
    device_name: Optional[str] = None,
) -> Settings:
    """Write the URL, API key and device ID to the owner-only config file."""
    existing = _read_config()
    mcp_url = normalize_mcp_url(url or existing.get("mcp_url", ""))
    api_key = api_key.strip()
    if not api_key:
        raise ValueError("Postiz API key cannot be empty.")
    device_id = device_name or existing.get("device_id") or _new_device_id()

    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"mcp_url": mcp_url, "api_key": api_key, "device_id": device_id}
    # Create with owner-only permissions before the secret is written.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(json.dumps(payload, indent=2) + "\n")
    path.chmod(0o600)
    return Settings(mcp_url=mcp_url, api_key=api_key, device_id=device_id)


def load_settings(
    url: Optional[str] = None,
    api_key: Optional[str] = None,
    device_id: Optional[str] = None,
) -> Settings:
    """Resolve settings from CLI flags, then environment, then the config file."""
    data = _read_config()
    mcp_url = normalize_mcp_url(url or os.environ.get("POSTIZ_MCP_URL") or data.get("mcp_url", ""))
    resolved_key = (api_key or os.environ.get("POSTIZ_API_KEY") or data.get("api_key") or "").strip()
    if not resolved_key:
        raise RuntimeError(
            f"No Postiz API key found. Run `postiz-mcp login` (browser) or `postiz-mcp configure`, or add \"api_key\" to {config_path()}."
        )
    resolved_device = device_id or os.environ.get("POSTIZ_DEVICE_ID") or data.get("device_id") or _new_device_id()
    return Settings(mcp_url=mcp_url, api_key=resolved_key, device_id=resolved_device)
