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

import keyring
from keyring.errors import KeyringError

SERVICE_NAME = "postiz-mcp"


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


def save_settings(url: str, api_key: str, device_name: Optional[str] = None) -> Settings:
    mcp_url = normalize_mcp_url(url)
    device_id = device_name or f"{platform.node() or socket.gethostname()}-{secrets.token_hex(4)}"
    if not api_key.strip():
        raise ValueError("Postiz API key cannot be empty.")
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"mcp_url": mcp_url, "device_id": device_id}, indent=2) + "\n")
    path.chmod(0o600)
    try:
        keyring.set_password(SERVICE_NAME, mcp_url, api_key.strip())
    except KeyringError as error:
        raise RuntimeError(
            "Could not store the API key in the system keyring. Set POSTIZ_API_KEY instead."
        ) from error
    return Settings(mcp_url=mcp_url, api_key=api_key.strip(), device_id=device_id)


def load_settings(
    url: Optional[str] = None,
    api_key: Optional[str] = None,
    device_id: Optional[str] = None,
) -> Settings:
    data: dict[str, str] = {}
    path = config_path()
    if path.exists():
        data = json.loads(path.read_text())
    mcp_url = normalize_mcp_url(url or os.environ.get("POSTIZ_MCP_URL") or data.get("mcp_url", ""))
    resolved_key = api_key or os.environ.get("POSTIZ_API_KEY")
    if not resolved_key:
        try:
            resolved_key = keyring.get_password(SERVICE_NAME, mcp_url)
        except KeyringError:
            resolved_key = None
    if not resolved_key:
        raise RuntimeError("No Postiz API key found. Run `postiz-mcp configure` or set POSTIZ_API_KEY.")
    resolved_device = device_id or os.environ.get("POSTIZ_DEVICE_ID") or data.get("device_id")
    if not resolved_device:
        resolved_device = f"{platform.node() or socket.gethostname()}-{secrets.token_hex(4)}"
    return Settings(mcp_url=mcp_url, api_key=resolved_key.strip(), device_id=resolved_device)
