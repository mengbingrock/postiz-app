from __future__ import annotations

import json
from typing import Any, Optional

import httpx

from . import __version__

ACCEPT = "application/json, text/event-stream"


def decode_response(response: httpx.Response) -> list[dict[str, Any]]:
    if response.status_code == 202 or not response.content:
        return []
    response.raise_for_status()
    content_type = response.headers.get("content-type", "")
    if "text/event-stream" not in content_type:
        return [response.json()]
    events: list[dict[str, Any]] = []
    for line in response.text.splitlines():
        if line.startswith("data:"):
            payload = line[5:].strip()
            if payload and payload != "[DONE]":
                events.append(json.loads(payload))
    return events


class RemoteMcp:
    def __init__(self, url: str, api_key: str):
        self.url = url
        self.session_id: Optional[str] = None
        self.client = httpx.AsyncClient(
            timeout=httpx.Timeout(60, connect=15),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Accept": ACCEPT,
                "Content-Type": "application/json",
            },
        )

    async def close(self) -> None:
        if self.session_id:
            try:
                await self.client.delete(
                    self.url, headers={"Mcp-Session-Id": self.session_id}, timeout=5
                )
            except httpx.HTTPError:
                pass
        await self.client.aclose()

    async def send(self, message: dict[str, Any]) -> list[dict[str, Any]]:
        headers = {"Mcp-Session-Id": self.session_id} if self.session_id else None
        response = await self.client.post(self.url, json=message, headers=headers)
        new_session = response.headers.get("Mcp-Session-Id")
        if new_session:
            self.session_id = new_session
        return decode_response(response)

    async def initialize(self) -> None:
        events = await self.send(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "postiz-mcp", "version": __version__},
                },
            }
        )
        if not events or "error" in events[-1]:
            raise RuntimeError(f"Postiz MCP initialization failed: {events[-1] if events else 'empty response'}")
        await self.send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        await self.initialize()
        events = await self.send(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            }
        )
        if not events:
            raise RuntimeError("Postiz MCP returned an empty tool response.")
        result = events[-1]
        if "error" in result:
            raise RuntimeError(result["error"].get("message", str(result["error"])))
        tool_result = result.get("result")
        if isinstance(tool_result, dict) and tool_result.get("isError"):
            content = tool_result.get("content") or []
            message = next(
                (
                    item.get("text")
                    for item in content
                    if isinstance(item, dict) and item.get("type") == "text"
                ),
                "Postiz MCP tool execution failed.",
            )
            raise RuntimeError(message)
        return tool_result
