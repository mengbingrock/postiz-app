from __future__ import annotations

import asyncio
import json
import sys

from .remote import RemoteMcp


async def run_stdio_bridge(remote: RemoteMcp) -> None:
    while True:
        line = await asyncio.to_thread(sys.stdin.buffer.readline)
        if not line:
            return
        message = None
        try:
            message = json.loads(line)
            events = await remote.send(message)
            for event in events:
                sys.stdout.write(json.dumps(event, separators=(",", ":")) + "\n")
            sys.stdout.flush()
        except Exception as error:
            request_id = message.get("id") if isinstance(message, dict) else None
            if request_id is not None:
                failure = {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32000, "message": f"Postiz MCP bridge: {error}"},
                }
                sys.stdout.write(json.dumps(failure, separators=(",", ":")) + "\n")
                sys.stdout.flush()
            else:
                print(f"postiz-mcp bridge: {error}", file=sys.stderr, flush=True)
