import asyncio
import unittest

from postiz_mcp.config import Settings
from postiz_mcp.connector import LocalEgressConnector


class ClosedSocket:
    async def send(self, _message):
        raise RuntimeError("WebSocket is already closed")


class Writer:
    def close(self):
        pass

    async def wait_closed(self):
        pass


class ConnectorTest(unittest.IsolatedAsyncioTestCase):
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
