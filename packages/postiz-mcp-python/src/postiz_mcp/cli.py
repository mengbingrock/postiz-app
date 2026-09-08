from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import logging
import sys

from .bridge import run_stdio_bridge
from .config import config_path, load_settings, save_settings
from .connector import LocalEgressConnector
from .remote import RemoteMcp

TOOLS = {
    "status": "egressProxyStatusTool",
    "start": "egressProxyStartTool",
    "test": "egressProxyTestTool",
    "stop": "egressProxyStopTool",
}


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="postiz-mcp")
    result.add_argument("--url")
    result.add_argument("--api-key")
    result.add_argument("--device-id")
    commands = result.add_subparsers(dest="command")
    configure = commands.add_parser("configure")
    configure.add_argument("--url", help="Postiz server or MCP URL (kept from the existing config when omitted)")
    configure.add_argument("--api-key", help="Postiz API key (prompted when omitted)")
    configure.add_argument("--device-name")
    login = commands.add_parser("login", help="Link this device via your browser (no API key copy/paste)")
    login.add_argument("--url", help="Postiz server or MCP URL (kept from the existing config when omitted)")
    login.add_argument("--device-name")
    login.add_argument("--no-browser", action="store_true", help="Print the URL instead of opening a browser")
    commands.add_parser("serve")
    commands.add_parser("connector")
    proxy = commands.add_parser("proxy")
    proxy_commands = proxy.add_subparsers(dest="proxy_command", required=True)
    proxy_commands.add_parser("status")
    start = proxy_commands.add_parser("start")
    start.add_argument("--ttl-minutes", type=int, default=30)
    start.add_argument("--device-id", dest="lease_device_id")
    proxy_commands.add_parser("test")
    proxy_commands.add_parser("stop")
    return result


async def serve(args: argparse.Namespace) -> None:
    settings = load_settings(args.url, args.api_key, args.device_id)
    remote = RemoteMcp(settings.mcp_url, settings.api_key)
    connector = LocalEgressConnector(settings)
    connector_task = asyncio.create_task(connector.run_forever())
    try:
        await run_stdio_bridge(remote)
    finally:
        connector_task.cancel()
        await asyncio.gather(connector_task, return_exceptions=True)
        await remote.close()


async def connector_only(args: argparse.Namespace) -> None:
    settings = load_settings(args.url, args.api_key, args.device_id)
    await LocalEgressConnector(settings).run_forever()


async def proxy_command(args: argparse.Namespace) -> None:
    settings = load_settings(args.url, args.api_key, args.device_id)
    remote = RemoteMcp(settings.mcp_url, settings.api_key)
    arguments = {}
    if args.proxy_command == "start":
        arguments = {
            "ttlMinutes": args.ttl_minutes,
            "deviceId": args.lease_device_id or settings.device_id,
        }
    try:
        output = await remote.call_tool(TOOLS[args.proxy_command], arguments)
        print(json.dumps(output, indent=2, ensure_ascii=False))
    finally:
        await remote.close()


def main() -> None:
    args = parser().parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s", stream=sys.stderr)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    try:
        if args.command == "login":
            from .login import login as browser_login

            settings = browser_login(args.url, args.device_name, open_browser=not args.no_browser)
            print(f"Linked {settings.mcp_url} as device {settings.device_id}")
            print(f"Saved to {config_path()}")
        elif args.command == "configure":
            api_key = args.api_key or getpass.getpass("Postiz API key: ")
            settings = save_settings(args.url, api_key, args.device_name)
            print(f"Configured {settings.mcp_url} as device {settings.device_id}")
            print(f"Saved to {config_path()}")
        elif args.command in {None, "serve"}:
            asyncio.run(serve(args))
        elif args.command == "connector":
            asyncio.run(connector_only(args))
        elif args.command == "proxy":
            asyncio.run(proxy_command(args))
    except KeyboardInterrupt:
        pass
    except Exception as error:
        print(f"postiz-mcp: {error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
