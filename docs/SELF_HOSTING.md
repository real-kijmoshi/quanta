# Quanta on your own server

Run an always-available workspace with personal accounts, private folder access,
live collaboration, and data that survives restarts. This deploys **one workspace
on one Node process**, suitable for a small team. It is not a multi-tenant service
or a horizontally scaled cluster. Boards, accounts, and sessions use persistent
JSON files; the existing workspace lock prevents two processes writing them.

## Deploy

On a Debian or Ubuntu VPS, point your domain's DNS A record at the server (and
AAAA only if IPv6 works). Allow inbound TCP 80 and 443; UDP 443 is optional for
HTTP/3. Then run:

```sh
curl -fsSL https://github.com/real-kijmoshi/quanta/releases/latest/download/setup-server.sh | bash
```

Already have the Quanta command installed? Run `quanta setup` on the server.
The same wizard asks for your domain and owner email, shows a deployment plan,
and then:

- Installs Docker Engine and Compose if needed, requesting administrator access
  only when required. Other Linux distributions need Docker installed first.
- Saves configuration in `~/.quanta/server`, with a randomly generated owner
  password in a private `.env` file.
- Pulls published images, starts Quanta and Caddy, and waits for the app to become
  healthy. No source checkout, local build, or host Node.js installation needed.
- Prints your workspace URL and first login details. HTTPS certificate issuance
  can take a moment after startup.

Change the temporary password in Workspace settings after signing in. Setup keeps
existing credentials and configuration when run again. A failed download or start
can be retried with the same command; your saved bootstrap credentials stay in `.env`.

For automation, download `setup-server.sh` from the release and run:

```sh
bash setup-server.sh --domain board.example.com --email you@example.com --yes
```

Use `--directory /absolute/path` for a different configuration directory. Pass the
same directory on later runs; omit `--domain` and `--email` for an existing install.

Run the management commands in this guide from the configuration directory:

```sh
cd ~/.quanta/server
docker compose ps
docker compose logs --tail=100 quanta caddy
```

If your user cannot access Docker directly, these management commands need
administrator access. The wizard handles that automatically during setup.

Caddy obtains and renews HTTPS certificates. Only Caddy publishes a host port;
the app stays on the internal Docker network. The service starts again after
crashes and server reboots, provided Docker starts at boot. A health check reports
unhealthy app instances; Docker's restart policy handles process exits, not an
unhealthy-but-running process.

See the official [Caddy HTTPS guide](https://caddyserver.com/docs/quick-starts/https)
and [Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/).

The bootstrap password creates the owner only on the first run. Change it through
Workspace settings after signing in; editing `.env` does not reset an existing
account. There is no public signup or email delivery service.

## Invite your team

1. Create a folder, or click **Share** on a board and choose an existing folder.
2. Enter your teammate's email address and click **Invite teammate**.
3. Copy the invitation and send it to them yourself. The app does not send email.
4. They open the link, create an account (or sign in), and join the folder.

Invitations expire after seven days and can be claimed by only one account using
the specified email. The link proves possession of the invitation; there is no
independent email verification. Existing local invitations without an email can
also be claimed once after migration; revoke and reissue them if you want email
binding. Accepting another invitation adds that folder to the same account.
Folder access includes nested folders. Remove a member from the sharing dialog
to revoke that membership, including active connections. Independent membership
in a parent or another folder continues to grant access through that membership.
The owner manages folders, invitations, and deletion; members can create and edit
boards within their folders. Read-only roles and multiple owners are not included.

## Let everyone use their own assistant

Every signed-in person can connect their own AI in **Workspace settings → Your assistants**.
Nothing is configured on the server for this, and members never use the owner's keys.

- **Their own API key** (OpenAI, Anthropic or OpenRouter) powers the assistant panel. The key is
  checked with the provider when saved, encrypted with AES-256-GCM, and used only for that
  person's requests, which can touch only boards in their folders. A ChatGPT or Claude *chat
  subscription* is not an API key and cannot be used here; the provider bills API usage
  separately.
- **Their own assistant over MCP.** Creating a connection gives a personal token. Paste
  `https://YOUR_DOMAIN/mcp` and `Authorization: Bearer <token>` into Claude Code, Cursor, Codex or
  any client that accepts headers. Clients that cannot send headers (ChatGPT and Claude custom
  connectors) can use `https://YOUR_DOMAIN/mcp/<token>` instead. The assistant then runs on the
  person's own subscription and sees only the folders they can open. Tokens are shown once, stored
  only as hashes, and can be revoked immediately. Treat the connector URL like a password.

Keys are encrypted with a random key in `connections.key` next to `connections.json` in the data
volume, which protects against accidental exposure of the JSON file but not against someone who
copies the whole volume. To keep the key elsewhere, set `QUANTA_SECRET` in `.env` before people
connect keys; changing it later disconnects saved keys (people re-enter them). Local models and
terminal assistants (Ollama, Codex, Claude Code) stay unavailable on a hosted server because they
would share the server's login. Server-wide `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or
`OPENROUTER_API_KEY` values, if you add them to the service environment, are for the owner only.

## Data and backups

`quanta_data` holds boards, images, account password hashes, membership records,
and hashed sessions. `caddy_data` holds HTTPS certificate state. These named volumes
survive rebuilds and `docker compose down`. **Do not use `down -v`** unless you intend
to delete them.

For a consistent backup, stop the app before copying data. Caddy may stay running.
Use a fresh timestamped destination each time:

```sh
docker compose stop quanta
docker compose run --rm --no-deps quanta node scripts/backup.mjs /backups/manual-2026-10-18
docker compose start quanta
docker compose run --rm --no-deps quanta node scripts/backup.mjs --verify /backups/manual-2026-10-18
```

The backup command includes accounts and sessions. Copy the backup off the VPS;
another volume on the same disk does not protect against disk failure. To restore,
stop Quanta and replace the data volume's contents with the verified backup's
`data/` directory, maintaining ownership by UID 1000. Keep the old volume until the
restore is checked. No application secret is needed to read the JSON files.

To migrate local boards, first stop the local server and create a verified backup
with `npm run backup`. With hosted Quanta stopped, copy that backup's `data/`
contents to the hosted data volume, with UID 1000 ownership. The first hosted
startup creates the owner account if none exists; existing board files stay intact.

## Recover an account password

There is no email reset service. A server administrator can reset a password while
the app is stopped. This revokes all of that account's sessions. On the VPS:

```sh
docker compose stop quanta
read -s -p 'New password: ' QUANTA_RESET_PASSWORD; echo
export QUANTA_RESET_PASSWORD
docker compose run --rm --no-deps -e QUANTA_RESET_PASSWORD quanta node scripts/reset-password.mjs you@example.com
unset QUANTA_RESET_PASSWORD
docker compose start quanta
```

## Update

Back up the workspace, then run the onboarding command again (or `quanta setup`).
It keeps your `.env`, Compose configuration, and volumes, downloads updated images,
and waits for the workspace to become healthy. To update without prompts:

```sh
bash setup-server.sh --yes
```

For an existing deployment built from a source checkout, continue using its original
directory: update the checkout and run `docker compose up -d --build`. The wizard
creates a deployment in its own directory; it does not migrate an existing workspace.

## Build from source

For development or a custom build, the repository's Compose file remains available:

```sh
cp .env.example .env
chmod 600 .env
# Set your domain, owner email, and a long random password in .env.
docker compose up -d --build
```

Run all management commands from that checkout instead of `~/.quanta/server`.

## Without Docker

Run Node.js 22+ under your preferred service manager, with `HOST=0.0.0.0`,
`QUANTA_AUTH=1`, `QUANTA_PUBLIC_URL=https://your-domain`, `QUANTA_DATA` pointing to
persistent storage, and the two `QUANTA_ADMIN_*` variables for bootstrap. Proxy
HTTPS to port 4173 and preserve Host and Origin headers. Do not expose the Node
port publicly. HTTP localhost origins are accepted for development tests.

Hosted mode never inherits owner access from localhost or a proxy's address.
Host-side code execution and local terminal AI providers are disabled; code cards
run in browser workers. Passwords use salted [Node scrypt](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback).
Session cookies are HttpOnly, SameSite=Lax, and Secure for HTTPS deployments, expire
after 30 days, and are revoked on logout or password change. Login attempts are
rate limited per email and socket address; when proxied, the IP limit is shared
by clients on that proxy. Persistent data files and `.env` are never served.

### WebSocket live sync

Board updates and presence share `/api/events` over WebSockets. HTTPS pages use `wss://`; local HTTP uses `ws://`. The bundled Caddy proxy forwards upgrades automatically. For nginx, forward `Upgrade` and `Connection: upgrade`, use `proxy_http_version 1.1`, and set `proxy_read_timeout 75s` or longer. Keep the public Host and Origin intact; the upgrade uses the same account/invitation cookie and access checks as the HTTP API. Board writes remain HTTP requests with disk-backed acknowledgements.

`quanta --tunnel` keeps the local server on `127.0.0.1` and forwards WebSocket upgrades through the existing Cloudflare Quick Tunnel. The private owner link and folder invitations still apply. Restart Quanta and reload open tabs after this upgrade.
