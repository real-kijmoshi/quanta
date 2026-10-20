#!/usr/bin/env bash
# One-command Quanta setup for a fresh Debian/Ubuntu VPS.
#   sudo ./deploy/install.sh board.example.com you@example.com
# Installs Docker if missing, writes .env with a random owner password, builds and
# starts the app + HTTPS proxy. Safe to re-run: an existing .env is never overwritten.
set -euo pipefail

DOMAIN="${1:-}"; EMAIL="${2:-}"
if [[ -z "$DOMAIN" || -z "$EMAIL" ]]; then
  echo "Usage: sudo $0 <domain> <owner-email>" >&2
  echo "Point the domain's DNS A record at this server first." >&2
  exit 1
fi
[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)." >&2; exit 1; }
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || { echo "Docker Compose plugin missing." >&2; exit 1; }
systemctl enable --now docker >/dev/null 2>&1 || true

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
fi

PASSWORD=""
if [[ -f .env ]]; then
  echo "Keeping existing .env"
else
  PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 20)"
  umask 077
  cat > .env <<EOF
QUANTA_DOMAIN=$DOMAIN
QUANTA_ADMIN_EMAIL=$EMAIL
QUANTA_ADMIN_PASSWORD=$PASSWORD
EOF
fi

docker compose up -d --build

echo "Waiting for the app to become healthy..."
for _ in $(seq 1 60); do
  [[ "$(docker compose ps --format '{{.Health}}' quanta 2>/dev/null)" == "healthy" ]] && break
  sleep 2
done
docker compose ps

echo
echo "Quanta is up:  https://$DOMAIN"
if [[ -n "$PASSWORD" ]]; then
  echo "Owner login:   $EMAIL"
  echo "Password:      $PASSWORD   (change it in Workspace settings; shown only once)"
fi
echo "Invite friends from the Share button on a folder, then send them the link."
echo "Backups: see docs/SELF_HOSTING.md. Never run 'docker compose down -v'."
