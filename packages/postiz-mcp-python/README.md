# postiz-egress

`postiz-egress` installs a `postiz-mcp` command that combines the remote
Postiz MCP endpoint with an opt-in local
egress connector. The MCP tools and scheduling logic stay on the Postiz
server. Only allow-listed HTTPS connections can leave through the local
machine, and only while a short-lived lease is active.

## Install and configure

```bash
python3 -m pip install postiz-egress
postiz-mcp configure \
  --url https://post.example.com/api/mcp \
  --device-name my-mac
```

The command securely prompts for the API key, which is stored in the
operating-system keyring. The non-secret server URL and stable device ID are
stored in `~/.config/postiz-mcp/config.json`.
Set `POSTIZ_API_KEY` instead on systems without a usable keyring.

Add the local bridge to Codex:

```toml
[mcp_servers.postiz]
command = "postiz-mcp"
args = ["serve"]
```

Or add it to Claude Code:

```bash
claude mcp add postiz -- postiz-mcp serve
```

The `serve` process transparently forwards MCP JSON-RPC over stdio and keeps
an outbound secure WebSocket connected for local egress. It never opens a
listening port on the user's machine.

## On-demand egress

With the MCP client running, an agent can call `egressProxyStartTool`,
`egressProxyTestTool`, and `egressProxyStopTool`. The same controls are
available from a shell:

```bash
postiz-mcp proxy status
postiz-mcp proxy start --ttl-minutes 30
postiz-mcp proxy test
postiz-mcp proxy stop
```

The server currently permits only HTTPS port 443 to ChineseInLA domains and
the IP-check host used by the test command. Leases expire automatically after
5–60 minutes. Stopping the local process immediately closes all streams.
