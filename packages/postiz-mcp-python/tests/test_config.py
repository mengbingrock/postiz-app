import unittest
from pathlib import Path

from postiz_mcp.config import egress_url, normalize_mcp_url


class ConfigTest(unittest.TestCase):
    def test_normalize_server_root(self):
        self.assertEqual(
            normalize_mcp_url("https://post.example.com"),
            "https://post.example.com/api/mcp",
        )

    def test_keep_explicit_mcp_route(self):
        self.assertEqual(
            normalize_mcp_url("https://post.example.com/mcp"),
            "https://post.example.com/mcp",
        )

    def test_egress_url_follows_backend_prefix(self):
        self.assertEqual(
            egress_url("https://post.example.com/api/mcp"),
            "wss://post.example.com/api/egress/connect",
        )
        self.assertEqual(
            egress_url("http://localhost:4200/mcp"),
            "ws://localhost:4200/egress/connect",
        )


if __name__ == "__main__":
    unittest.main()


class SettingsFileTest(unittest.TestCase):
    def setUp(self):
        import os
        import tempfile

        self._tmp = tempfile.TemporaryDirectory()
        self._config = os.path.join(self._tmp.name, "nested", "config.json")
        self._env = dict(os.environ)
        os.environ["POSTIZ_MCP_CONFIG"] = self._config
        for key in ("POSTIZ_API_KEY", "POSTIZ_MCP_URL", "POSTIZ_DEVICE_ID"):
            os.environ.pop(key, None)

    def tearDown(self):
        import os

        os.environ.clear()
        os.environ.update(self._env)
        self._tmp.cleanup()

    def test_save_writes_api_key_to_owner_only_file(self):
        import json
        import os
        import stat

        from postiz_mcp.config import load_settings, save_settings

        saved = save_settings("https://post.example.com", " secret ", "dev-1")
        data = json.loads(Path(self._config).read_text())
        self.assertEqual(data, {
            "mcp_url": "https://post.example.com/api/mcp",
            "api_key": "secret",
            "device_id": "dev-1",
        })
        self.assertEqual(stat.S_IMODE(os.stat(self._config).st_mode), 0o600)
        self.assertEqual(load_settings(), saved)

    def test_reconfigure_keeps_url_and_device_when_omitted(self):
        from postiz_mcp.config import save_settings

        save_settings("https://post.example.com/mcp", "old", "dev-1")
        updated = save_settings(None, "new", None)
        self.assertEqual(updated.mcp_url, "https://post.example.com/mcp")
        self.assertEqual(updated.device_id, "dev-1")
        self.assertEqual(updated.api_key, "new")

    def test_environment_overrides_file(self):
        import os

        from postiz_mcp.config import load_settings, save_settings

        save_settings("https://post.example.com/mcp", "file-key", "dev-1")
        os.environ["POSTIZ_API_KEY"] = "env-key"
        self.assertEqual(load_settings().api_key, "env-key")

    def test_missing_key_is_reported(self):
        from postiz_mcp.config import load_settings

        with self.assertRaises(RuntimeError):
            load_settings("https://post.example.com")
