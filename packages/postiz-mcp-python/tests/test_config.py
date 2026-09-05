import unittest

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
