# RedNote / Xiaohongshu deployment & operations

How the self-hosted Postiz RedNote integration is built, deployed and operated on
the production box (`post.truegrit.dev`, AWS EC2 `3.144.175.137`). Two repos are
involved:

- **`postiz-app`** — the Postiz web app (Next.js frontend + NestJS backend) and
  the `post-truegrit-mcp` Python bridge package.
- **`xiaohongshu-mcp`** — the Go MCP binary that drives the headless/headful
  browser for Xiaohongshu (小红书) and its international brand RedNote
  (rednote.com), plus ChineseInLA.

## Topology

```
internet:443  ──haproxy──▶  caddy:4443  ──┬─ /api/*   ─▶ backend  :3003
(TLS via SNI)                             ├─ /post/*  ─▶ backend  :3003  (MCP)
                                          ├─ /novnc/* ─▶ websockify:6080 (noVNC)
                                          └─ (rest)   ─▶ frontend :4200
```

- HAProxy terminates/pass-throughs 443 and forwards `post.truegrit.dev` to Caddy.
- Caddy config: `/etc/caddy/Caddyfile` (reload: `sudo systemctl reload caddy`).
- Backend `:3003`, frontend `:4200`, orchestrator (Temporal worker) — all
  systemd services: `postiz-backend`, `postiz-frontend`, `postiz-orchestrator`,
  `temporal`.

## Domestic vs international accounts (Site)

Xiaohongshu routes accounts it classifies as overseas to **rednote.com**; the
session lands on `.rednote.com` and neither `www` nor `creator .xiaohongshu.com`
will sign in. The MCP now detects this and drives the right hosts:

- CN account → `www.xiaohongshu.com` / `creator.xiaohongshu.com`
- INTL account → `www.rednote.com` / `creator.rednote.com`

The site is classified from the session cookies (an `id_token` on rednote.com ⇒
INTL) at login, stamped as `"site"` in the profile's `cookies.json`, and
re-derived on every login. Both creator centers are the same SPA served in
Chinese, so DOM selectors are shared — only the hosts differ. Env override:
`XHS_SITE=cn|intl`.

## The Go MCP binary (`xiaohongshu-mcp`)

The server **cannot build** these apps in place under memory pressure — build
locally and ship artifacts.

```bash
# in xiaohongshu-mcp/
GOOS=linux GOARCH=amd64 go build -o /tmp/xhs-mcp .
scp -i ~/.ssh/truegrit-default-key.pem /tmp/xhs-mcp \
    ubuntu@3.144.175.137:/tmp/xhs-mcp-new
```

Install (Postiz spawns one child per connected profile; the binary is shared):

```bash
ssh … 'B=/opt/postiz/config/rednote/v2.10.1/xiaohongshu-mcp-linux-amd64;
  cp -p "$B" "$B.backup-$(date +%Y%m%d)";      # always keep a backup
  for pid in $(pgrep -f "^$B"); do kill "$pid"; done;   # children respawn on demand
  sleep 3; cp /tmp/xhs-mcp-new "$B"; chmod 700 "$B"; md5sum "$B"'
```

Profiles live at `/opt/postiz/config/rednote/profiles/<id>/`:
`cookies.json` (v2: `{version,seed,site,cookies}`), `mcp.log`,
`debug/<ts>-*/` per-step screenshots (`REDNOTE_DEBUG_DIR`).

Key robustness behaviours baked into the binary:

- **Session check** uses a settle window (blank editor frame ≠ expired); a blank
  page raises `ErrCreatorPageBlank`, distinct from `ErrCreatorSessionExpired`,
  and never deletes cookies.
- **`DeleteCookies` preserves the fingerprint seed** (clears cookies, keeps the
  session file) so a reconnect is the *same device*, not a new one that trips
  risk control. Seed persisted on first login.
- **Per-step screenshots** + capture of any 4xx from `xiaohongshu.com` into the
  trace (`network-errors.log`).
- **SMS/OTP**: scan is latched across the post-scan redirect; OTP field detected
  in and outside `.r-captcha-modal` (never the login modal's own phone form);
  the SMS send control (`获取验证码/重新获取`) is auto-clicked and can be
  re-sent (`resend_login_code` tool); session extended 6 min after scan.
- **Headful login**: `get_login_qrcode({visible:true})` runs the *login* browser
  headful on `$DISPLAY` (publishing stays headless) — this drives the VNC login.

## Postiz app build & deploy (backend / frontend)

Build locally, ship `dist` / `.next`, swap, restart. **The frontend build bakes
`NEXT_PUBLIC_*` at build time** — you MUST export the production URLs or the
bundle points browsers at `localhost` (this took the site down once):

```bash
export NODE_OPTIONS=--max-old-space-size=6144 \
  NEXT_PUBLIC_BACKEND_URL="https://post.truegrit.dev/api" \
  BACKEND_INTERNAL_URL="http://127.0.0.1:3003" \
  FRONTEND_URL="https://post.truegrit.dev" \
  MAIN_URL="https://post.truegrit.dev"
pnpm build:backend      # -> apps/backend/dist
pnpm build:frontend     # -> apps/frontend/.next
# GUARD before shipping the frontend:
grep -rl 'localhost:3000' apps/frontend/.next/server | wc -l   # MUST be 0
grep -rl 'post.truegrit.dev/api' apps/frontend/.next/server | wc -l # >0
```

Ship + swap (keep `.old` for rollback), then restart:

```bash
scp -r apps/backend/dist  ubuntu@…:/opt/postiz/app/apps/backend/dist.new
rsync -az --exclude cache apps/frontend/.next/ ubuntu@…:/opt/postiz/app/apps/frontend/.next.new/
ssh … 'A=/opt/postiz/app;
  cd $A/apps/backend  && rm -rf dist.old  && mv dist  dist.old  && mv dist.new  dist
  cd $A/apps/frontend && rm -rf .next.old && mv .next .next.old && mv .next.new .next
  cp -rp .next.old/cache .next/cache 2>/dev/null
  sudo systemctl restart postiz-backend postiz-frontend'
```

Backend/orchestrator both compile the RedNote provider — if a provider change
must reach the publish worker, rebuild+ship the **orchestrator** dist too.

`.env` is at `/opt/postiz/app/.env` (loaded at runtime via `dotenv -e ../../.env`;
values with `&`/`?` **must be quoted**). Runtime env changes need only a restart,
no rebuild.

## VNC / noVNC live-browser login

For accounts that need a human scan + SMS, the login browser runs **headful on a
virtual display** and is shown to the operator in the Postiz UI via noVNC.

systemd services (boot-enabled):

| service | role |
|---|---|
| `postiz-xvfb` | Xvfb virtual display `:99` (1280×900) |
| `matchbox-login` | window manager on `:99` (required for keyboard focus/typing) |
| `x11vnc-login` | VNC of `:99` on `127.0.0.1:5900` (localhost only, password) |
| `novnc-login` | websockify+noVNC on `127.0.0.1:6080` |

Caddy exposes it at `post.truegrit.dev/novnc/*` (WebSocket auto-handled). The
backend hands the frontend a `viewUrl` (env `REDNOTE_VNC_VIEW_URL`) that
auto-connects with the VNC password, so the embedded iframe shows the live
browser with no prompt. VNC password: `x11vnc -storepasswd` file at
`~ubuntu/.vnc/passwd`.

Flow: Postiz "Log in with live browser" → `POST /integrations/rednote/login/start
{visible:true}` → MCP `get_login_qrcode({visible:true})` → headful browser on
`:99` → embedded noVNC → operator scans/types → background loop saves cookies +
stamps site. The original headless QR + OTP-relay method is unchanged and still
the default button.

### Security posture / TODO

- `/novnc/*` is currently gated only by the VNC password, which — with
  auto-connect — travels in the `viewUrl` (API response, iframe `src`, history).
  Acceptable for a single operator; **harden** with a Caddy source-IP allow-list
  or a short-lived per-session token before wider use.
- x11vnc/noVNC bind to `127.0.0.1` only; exposure is solely via the authenticated
  Caddy path. Never bind them to `0.0.0.0`.

## Client: `post-truegrit-mcp` (install on a workstation)

```bash
python3 -m venv ~/.local/share/postiz-mcp/venv
~/.local/share/postiz-mcp/venv/bin/python -m pip install --upgrade pip post-truegrit-mcp
```

Configure via env in the MCP client (no keyring required; the package also
supports `postiz-mcp configure` writing an owner-only `~/.config/postiz-mcp/
config.json`). Codex `~/.codex/config.toml`:

```toml
[mcp_servers.postiz-mcp]
command = "/…/.local/share/postiz-mcp/venv/bin/postiz-mcp"
args = ["serve"]
env = { POSTIZ_MCP_URL = "https://post.truegrit.dev/post/mcp", POSTIZ_API_KEY = "…", POSTIZ_DEVICE_ID = "my-mac" }
```

URL **must** be `/post/mcp` (plain `/mcp` routes to Browserless). On-demand egress
for ChineseInLA: `postiz-mcp proxy start|status|stop`.

## Rollback quick reference

- MCP binary: `…/v2.10.1/xiaohongshu-mcp-linux-amd64.backup-*`
- Backend/frontend: `apps/{backend/dist,frontend/.next}.old`
- Caddy: `/etc/caddy/Caddyfile.bak-*`
- `.env`: `/opt/postiz/app/.env.bak-*`
- Per-profile session snapshots: `cookies.json.bak-*` in each profile dir
