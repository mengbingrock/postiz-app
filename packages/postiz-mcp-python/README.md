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

The command securely prompts for the API key, which is stored in the
operating-system keyring. The non-secret server URL and stable device ID are
stored in `~/.config/postiz-mcp/config.json`.
Set `POSTIZ_API_KEY` instead on systems without a usable keyring.

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
