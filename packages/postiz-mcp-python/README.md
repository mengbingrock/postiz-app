# post-truegrit-mcp

`post-truegrit-mcp` installs a `postiz-mcp` command that combines the remote
Postiz MCP endpoint with an opt-in local
egress connector. The MCP tools and scheduling logic stay on the Postiz
server. Only allow-listed HTTPS connections can leave through the local
machine, and only while a short-lived lease is active.

## Install and configure

```bash
python3 -m pip install post-truegrit-mcp
postiz-mcp configure \
  --url https://post.truegrit.dev/post/mcp \
  --device-name my-mac
```

The command prompts for the API key (or accepts `--api-key`) and writes the
server URL, API key and device ID to `~/.config/postiz-mcp/config.json`. The
file is created with owner-only permissions (`0600`). You can also write it by
hand:

```json
{
  "mcp_url": "https://post.truegrit.dev/post/mcp",
  "api_key": "your-postiz-api-key",
  "device_id": "my-mac"
}
```

`POSTIZ_MCP_URL`, `POSTIZ_API_KEY` and `POSTIZ_DEVICE_ID` override the file,
and `POSTIZ_MCP_CONFIG` points at a different config file. No system keyring
is used.

## Install from a development checkout

```bash
git clone https://github.com/mengbingrock/post-truegrit-mcp.git
cd post-truegrit-mcp
python3 -m venv .venv-postiz-mcp
.venv-postiz-mcp/bin/python -m pip install --upgrade pip
.venv-postiz-mcp/bin/python -m pip install -e .
.venv-postiz-mcp/bin/postiz-mcp configure \
  --url https://post.truegrit.dev/post/mcp \
  --device-name my-mac
```

Editable installation means later changes from `git pull` are immediately
used by the installed `postiz-mcp` command. Windows users can replace
`.venv-postiz-mcp/bin/` with `.venv-postiz-mcp\\Scripts\\`.

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

Multiple MCP clients can safely use the same configured device. A local
process lock elects one connector owner; additional `serve` processes continue
forwarding MCP calls without replacing the owner or interrupting an active
egress lease. If the owner exits, a waiting process automatically takes over.

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
