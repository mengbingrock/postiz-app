from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import struct
from pathlib import Path
from typing import Any, BinaryIO, Optional

from websockets.asyncio.client import ClientConnection, connect

from .config import Settings, config_path, egress_url

LOGGER = logging.getLogger("postiz-mcp.egress")
MAX_FRAME_BYTES = 1024 * 1024
CONNECTOR_LOCK_RETRY_SECONDS = 2


# Xiaohongshu / RedNote first-party hosts (web + creator SPAs, API hosts, the
# xhscdn media CDN). Must match the server relay allowlist.
REDNOTE_HOST_SUFFIXES = (
    "xiaohongshu.com",
    "xhscdn.com",
    "rednotecdn.com",  # static/avatar/image CDN used by the overseas edge
    "rednote.com",
    "rnote.com",  # INTL API/telemetry hosts (t2., apm-fe.)
    "rednote.life",  # INTL risk-control (redtrust) endpoints
    "xhslink.com",
    "xhs.cn",
)


def _host_matches_suffix(host: str, suffix: str) -> bool:
    return host == suffix or host.endswith("." + suffix)


def _is_allowed_egress_host(host: str) -> bool:
    normalized = host.lower().rstrip(".")
    return (
        _host_matches_suffix(normalized, "chineseinla.com")
        or normalized == "c3.nychinaren.com"
        or normalized == "api.ipify.org"
        or any(_host_matches_suffix(normalized, suffix) for suffix in REDNOTE_HOST_SUFFIXES)
    )


class ConnectorProcessLock:
    """Ensure only one local connector owns a configured device ID."""

    def __init__(self, settings: Settings):
        identity = f"{settings.mcp_url}\0{settings.device_id}".encode()
        suffix = hashlib.sha256(identity).hexdigest()[:16]
        self.path = config_path().parent / f"connector-{suffix}.lock"
        self.file: Optional[BinaryIO] = None

    def acquire(self) -> bool:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        lock_file = self.path.open("a+b")
        os.chmod(self.path, 0o600)
        try:
            self._lock(lock_file)
        except (BlockingIOError, OSError):
            lock_file.close()
            return False
        self.file = lock_file
        return True

    def release(self) -> None:
        lock_file = self.file
        if not lock_file:
            return
        self.file = None
        try:
            self._unlock(lock_file)
        finally:
            lock_file.close()

    @staticmethod
    def _lock(lock_file: BinaryIO) -> None:
        if os.name == "nt":
            import msvcrt

            lock_file.seek(0)
            if not lock_file.read(1):
                lock_file.write(b"\0")
                lock_file.flush()
            lock_file.seek(0)
            msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
            return

        import fcntl

        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    @staticmethod
    def _unlock(lock_file: BinaryIO) -> None:
        if os.name == "nt":
            import msvcrt

            lock_file.seek(0)
            msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
            return

        import fcntl

        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


class LocalEgressConnector:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.streams: dict[int, tuple[asyncio.StreamReader, asyncio.StreamWriter, asyncio.Task[None]]] = {}
        self.socket: Optional[ClientConnection] = None

    async def run_forever(self) -> None:
        process_lock = ConnectorProcessLock(self.settings)
        waiting_logged = False
        while not process_lock.acquire():
            if not waiting_logged:
                LOGGER.info(
                    "local egress connector for %s is already owned by another process; waiting",
                    self.settings.device_id,
                )
                waiting_logged = True
            await asyncio.sleep(CONNECTOR_LOCK_RETRY_SECONDS)

        if waiting_logged:
            LOGGER.info("local egress connector ownership acquired for %s", self.settings.device_id)

        try:
            await self._connect_forever()
        finally:
            process_lock.release()

    async def _connect_forever(self) -> None:
        delay = 1
        while True:
            try:
                async with connect(
                    egress_url(self.settings.mcp_url),
                    additional_headers={
                        "Authorization": f"Bearer {self.settings.api_key}",
                        "X-Postiz-Device-Id": self.settings.device_id,
                    },
                    max_size=MAX_FRAME_BYTES + 4,
                    ping_interval=20,
                    ping_timeout=20,
                ) as socket:
                    self.socket = socket
                    delay = 1
                    LOGGER.info("local egress connector online as %s", self.settings.device_id)
                    async for message in socket:
                        if isinstance(message, bytes):
                            await self._binary(message)
                        else:
                            await self._control(message)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                LOGGER.warning("egress connector offline: %s; retrying in %ss", error, delay)
            finally:
                self.socket = None
                await self._close_all()
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)

    async def _control(self, raw: str) -> None:
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            return
        message_type = message.get("type")
        if message_type == "open":
            await self._open(message)
        elif message_type == "close":
            await self._close(int(message.get("streamId", -1)), notify=False)
        elif message_type in {"lease_start", "lease_stop"}:
            LOGGER.info("egress lease %s", "active" if message_type == "lease_start" else "stopped")

    async def _open(self, message: dict[str, Any]) -> None:
        stream_id = int(message.get("streamId", -1))
        host = str(message.get("host", "")).lower().rstrip(".")
        port = int(message.get("port", 0))
        allowed = _is_allowed_egress_host(host)
        if stream_id < 1 or not allowed or port != 443:
            await self._send_control("error", streamId=stream_id, message="Destination is not allowed")
            return
        try:
            reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=15)
        except Exception as error:
            await self._send_control("error", streamId=stream_id, message=str(error)[:300])
            return
        task = asyncio.create_task(self._read_local(stream_id, reader))
        self.streams[stream_id] = (reader, writer, task)
        await self._send_control("opened", streamId=stream_id)

    async def _read_local(self, stream_id: int, reader: asyncio.StreamReader) -> None:
        try:
            while True:
                chunk = await reader.read(64 * 1024)
                if not chunk:
                    break
                socket = self.socket
                if not socket:
                    break
                await socket.send(struct.pack(">I", stream_id) + chunk)
        except (ConnectionError, asyncio.CancelledError):
            pass
        finally:
            await self._close(stream_id, notify=True, from_reader=True)

    async def _binary(self, frame: bytes) -> None:
        if len(frame) < 4 or len(frame) > MAX_FRAME_BYTES + 4:
            return
        stream_id = struct.unpack(">I", frame[:4])[0]
        stream = self.streams.get(stream_id)
        if not stream:
            return
        writer = stream[1]
        writer.write(frame[4:])
        try:
            await writer.drain()
        except ConnectionError:
            await self._close(stream_id, notify=True)

    async def _send_control(self, message_type: str, **values: Any) -> None:
        if self.socket:
            await self.socket.send(json.dumps({"type": message_type, **values}))

    async def _close(self, stream_id: int, notify: bool, from_reader: bool = False) -> None:
        stream = self.streams.pop(stream_id, None)
        if not stream:
            return
        _, writer, task = stream
        writer.close()
        try:
            await writer.wait_closed()
        except ConnectionError:
            pass
        if not from_reader:
            task.cancel()
        if notify:
            try:
                await self._send_control("close", streamId=stream_id)
            except Exception:
                # A normal WebSocket shutdown can race the local TCP reader's
                # EOF. The server already closes every stream when the socket
                # goes away, so there is nothing left to notify in that case.
                pass

    async def _close_all(self) -> None:
        await asyncio.gather(
            *(self._close(stream_id, notify=False) for stream_id in list(self.streams)),
            return_exceptions=True,
        )
