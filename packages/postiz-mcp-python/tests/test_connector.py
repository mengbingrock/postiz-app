import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from postiz_mcp.config import Settings
from postiz_mcp.connector import (
    ConnectorProcessLock,
    LocalEgressConnector,
    _is_allowed_egress_host,
)


class ClosedSocket:
    async def send(self, _message):
        raise RuntimeError("WebSocket is already closed")


class Writer:
    def close(self):
        pass

    async def wait_closed(self):
        pass


class ConnectorTest(unittest.IsolatedAsyncioTestCase):
    async def test_rednote_first_party_hosts_are_allowed(self):
        for host in (
            "xiaohongshu.com",
            "www.xiaohongshu.com",
            "creator.xiaohongshu.com",
            "EDITH.XIAOHONGSHU.COM.",
            "sns-img-qc.xhscdn.com",
            "sns-web-i10.rednotecdn.com",
            "creator.rednote.com",
            "xhslink.com",
        ):
            self.assertTrue(_is_allowed_egress_host(host), host)
        for host in (
            "xiaohongshu.com.attacker.example",
            "notxiaohongshu.com",
            "xhscdn.com.evil.example",
            "example.com",
        ):
            self.assertFalse(_is_allowed_egress_host(host), host)

    async def test_chineseinla_static_cdn_is_allowed_without_open_proxy_wildcards(self):
        self.assertTrue(_is_allowed_egress_host("c3.nychinaren.com"))
        self.assertTrue(_is_allowed_egress_host("C3.NYCHINAREN.COM."))
        self.assertFalse(_is_allowed_egress_host("nychinaren.com"))
        self.assertFalse(_is_allowed_egress_host("evil.nychinaren.com"))
        self.assertFalse(_is_allowed_egress_host("c3.nychinaren.com.example.org"))

    async def test_only_one_process_can_own_a_device_connector(self):
        settings = Settings("https://post.example.com/api/mcp", "secret", "test-device")
        with tempfile.TemporaryDirectory() as directory, patch(
            "postiz_mcp.connector.config_path",
            return_value=Path(directory) / "config.json",
        ):
            first = ConnectorProcessLock(settings)
            second = ConnectorProcessLock(settings)

            self.assertTrue(first.acquire())
            self.assertFalse(second.acquire())

            first.release()
            self.assertTrue(second.acquire())
            second.release()

    async def test_normal_websocket_shutdown_does_not_leak_stream_error(self):
        connector = LocalEgressConnector(
            Settings("https://post.example.com/api/mcp", "secret", "test-device")
        )
        connector.socket = ClosedSocket()
        reader_task = asyncio.create_task(asyncio.sleep(60))
        connector.streams[1] = (asyncio.StreamReader(), Writer(), reader_task)

        await connector._close(1, notify=True)
        await asyncio.gather(reader_task, return_exceptions=True)

        self.assertNotIn(1, connector.streams)
        self.assertTrue(reader_task.cancelled())


if __name__ == "__main__":
    unittest.main()
