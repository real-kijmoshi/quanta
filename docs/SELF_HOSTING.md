# Quanta on your own server

Run an always-available workspace with personal accounts, private folder access,
live collaboration, and data that survives restarts. This deploys **one workspace
on one Node process**, suitable for a small team. It is not a multi-tenant service
or a horizontally scaled cluster. Boards, accounts, and sessions use persistent
JSON files; the existing workspace lock prevents two processes writing them.

## Deploy

**Fastest:** on a fresh Debian/Ubuntu VPS, with the domain's DNS pointing at it:

```sh
sudo ./deploy/install.sh board.example.com you@example.com
```

It installs Docker if needed, generates a random owner password, and starts
everything. The manual steps below do the same thing.

Use a Linux VPS with Docker Engine and the Docker Compose plugin installed. Point
a domain's DNS A record (and AAAA only if IPv6 works) at the server. Allow inbound
TCP 80 and 443; UDP 443 is optional for HTTP/3. Copy the project to the VPS.

```sh
cp .env.example .env
chmod 600 .env
# Edit .env: set QUANTA_DOMAIN, QUANTA_ADMIN_EMAIL, QUANTA_ADMIN_PASSWORD.
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 quanta caddy
```

Open `https://YOUR_DOMAIN` and sign in using the owner credentials from `.env`.
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

Back up the workspace, copy the updated project to the server, and run:

```sh
docker compose up -d --build
docker compose logs --tail=100 quanta
```

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
