#!/usr/bin/env bash
# Standalone onboarding, published as the setup-server.sh release asset.
set -euo pipefail
umask 077

DOMAIN="" EMAIL="" DIRECTORY="${QUANTA_HOME:-$HOME/.quanta}/server" YES=false
usage() {
  cat <<'EOF'
Quanta server setup

Usage: quanta setup [--directory PATH]
       bash setup-server.sh [--domain DOMAIN --email EMAIL --yes] [--directory PATH]

An interactive guide to your own workspace, accounts, and automatic HTTPS.
Requires Linux and a domain pointing at this server. No Node.js or source checkout needed.
Docker is installed if needed; administrator access is requested only when required.

Options:
  --domain DOMAIN    Public hostname, for example board.example.com
  --email EMAIL      Owner's sign-in email (invitations are sent manually)
  --directory PATH   Server configuration (default ~/.quanta/server)
  --yes              Accept the deployment plan without prompting
  -h, --help         Show this help
EOF
}
die() { printf '\n  Setup stopped: %s\n' "$*" >&2; exit 1; }
say() { printf '  %s\n' "$*"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain|--email|--directory)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || die "$1 needs a value."
      case "$1" in --domain) DOMAIN="$2";; --email) EMAIL="$2";; --directory) DIRECTORY="$2";; esac
      shift 2 ;;
    --yes) YES=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1. Use --help for options." ;;
  esac
done
[[ "$(uname -s)" == Linux ]] || die "Run this command on your Linux server. Local workspaces use quanta start."
[[ "$DIRECTORY" == /* && "$DIRECTORY" != *$'\n'* && "$DIRECTORY" != *$'\r'* ]] || die "Use an absolute configuration directory."

# Read from the terminal even when stdin holds the downloaded script (curl | bash).
ask() {
  local answer
  if ! { exec 3<>/dev/tty; } 2>/dev/null; then
    die "An interactive terminal is required. For automation, pass --domain, --email and --yes."
  fi
  printf '  %s ' "$1" >&3
  IFS= read -r answer <&3 || die "Input ended; nothing was deployed."
  exec 3>&-
  REPLY="$answer"
}
valid_domain() {
  local label
  [[ ${#1} -le 253 && "$1" == *.* && "$1" != *[!a-zA-Z0-9.-]* && "$1" != *. ]] || return 1
  local labels
  IFS=. read -r -a labels <<< "$1"
  for label in "${labels[@]}"; do
    [[ ${#label} -ge 1 && ${#label} -le 63 && "$label" != -* && "$label" != *- ]] || return 1
  done
}
valid_email() { [[ "$1" =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ && ${#1} -le 254 ]]; }

printf '\n  Q U A N T A\n  Your workspace. Your server.\n\n'
say "We'll set up accounts, persistent storage, and automatic HTTPS."
say "Point your domain at this server and allow inbound TCP ports 80 and 443."
printf '\n'

EXISTING=false
if [[ -f "$DIRECTORY/.env" ]]; then
  [[ -z "$DOMAIN" && -z "$EMAIL" ]] || die "An installation already exists at $DIRECTORY. Omit --domain and --email to keep its settings."
  # Read only display values. Never execute an environment file.
  DOMAIN="$(sed -n 's/^QUANTA_DOMAIN=//p' "$DIRECTORY/.env" | head -n 1)"
  EMAIL="$(sed -n 's/^QUANTA_ADMIN_EMAIL=//p' "$DIRECTORY/.env" | head -n 1)"
  EXISTING=true
  say "Found your server configuration. Keeping credentials and data."
else
  if [[ -z "$DOMAIN" ]]; then
    $YES && die "--domain is required with --yes."
    while true; do
      ask "Workspace domain (board.example.com):"; DOMAIN="$REPLY"
      valid_domain "$DOMAIN" && break
      say "Enter a hostname, without https://, a port, or a path."
    done
  fi
  if [[ -z "$EMAIL" ]]; then
    $YES && die "--email is required with --yes."
    while true; do
      ask "Owner email:"; EMAIL="$REPLY"
      valid_email "$EMAIL" && break
      say "Enter an email address such as you@example.com."
    done
  fi
fi
valid_domain "$DOMAIN" || die "Invalid domain. Use a hostname such as board.example.com."
valid_email "$EMAIL" || die "Invalid owner email."

INSTALL_DOCKER=false
command -v docker >/dev/null 2>&1 || INSTALL_DOCKER=true
if $INSTALL_DOCKER; then
  [[ -f /etc/os-release ]] || die "Install Docker Engine and its Compose plugin, then run setup again."
  DISTRO="$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"')"
  [[ "$DISTRO" == ubuntu || "$DISTRO" == debian ]] || die "Install Docker Engine and its Compose plugin on $DISTRO, then run setup again."
fi
printf '\n'
say "Workspace   https://$DOMAIN"
say "Owner       $EMAIL"
say "Config      $DIRECTORY"
say "Storage     Docker volumes (kept across updates)"
$INSTALL_DOCKER && say "Docker      Will install Docker Engine and Compose"
printf '\n'
if ! $YES; then
  ask "Ready to $($EXISTING && printf update || printf install)? [Y/n]"
  case "$REPLY" in ""|y|Y|yes|YES) ;; *) say "Cancelled. Nothing changed."; exit 0;; esac
fi

PRIVILEGE=()
as_admin() {
  if [[ $EUID -eq 0 ]]; then "$@";
  else
    command -v sudo >/dev/null 2>&1 || die "Administrator access is needed for Docker. Ask your server administrator to install it."
    sudo "$@"
  fi
}
if $INSTALL_DOCKER; then
  say "1/3  Installing Docker (your server may ask for its administrator password)..."
  command -v curl >/dev/null 2>&1 || die "curl is required to install Docker."
  TEMP="$(mktemp -d)"
  trap 'rm -rf "$TEMP"' EXIT
  curl -fsSL https://get.docker.com -o "$TEMP/docker.sh"
  as_admin sh "$TEMP/docker.sh"
  if command -v systemctl >/dev/null 2>&1; then as_admin systemctl enable --now docker; fi
else
  say "1/3  Checking Docker..."
fi
if ! docker info >/dev/null 2>&1; then
  say "Docker needs administrator access; your server may ask for its password."
  as_admin docker info >/dev/null || die "Docker is not running. Start Docker and run setup again."
  [[ $EUID -eq 0 ]] || PRIVILEGE=(sudo)
fi
"${PRIVILEGE[@]}" docker compose version >/dev/null 2>&1 || die "Docker Compose plugin is missing. Install it and run setup again."

mkdir -p "$DIRECTORY"
cd "$DIRECTORY"
PASSWORD=""
if ! $EXISTING; then
  PASSWORD="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
  # Exclusive creation protects credentials if two installers start together.
  (set -o noclobber; printf 'QUANTA_DOMAIN=%s\nQUANTA_ADMIN_EMAIL=%s\nQUANTA_ADMIN_PASSWORD=%s\n' "$DOMAIN" "$EMAIL" "$PASSWORD" > .env) || die "Configuration was created by another setup. Run setup again."
  touch .setup-pending
fi
if [[ ! -f compose.yaml ]]; then
  cat > compose.yaml <<'EOF'
name: quanta-server
services:
  quanta:
    image: ghcr.io/real-kijmoshi/quanta:latest
    restart: unless-stopped
    init: true
    environment:
      QUANTA_AUTH: "1"
      QUANTA_PUBLIC_URL: https://${QUANTA_DOMAIN:?}
      QUANTA_ADMIN_EMAIL: ${QUANTA_ADMIN_EMAIL:?}
      QUANTA_ADMIN_PASSWORD: ${QUANTA_ADMIN_PASSWORD:?}
      QUANTA_SECRET: ${QUANTA_SECRET:-}
    volumes:
      - quanta_data:/data
      - quanta_backups:/backups
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:4173/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 5s
      timeout: 5s
      start_period: 30s
      retries: 12
    stop_grace_period: 15s
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    environment:
      QUANTA_DOMAIN: ${QUANTA_DOMAIN:?}
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      quanta:
        condition: service_healthy
volumes:
  quanta_data:
  quanta_backups:
  caddy_data:
  caddy_config:
EOF
fi
if [[ ! -f Caddyfile ]]; then
  cat > Caddyfile <<'EOF'
{$QUANTA_DOMAIN} {
  request_body {
    max_size 48MB
  }
  reverse_proxy quanta:4173 {
    flush_interval -1
    transport http {
      keepalive 4s
    }
  }
  header Strict-Transport-Security "max-age=31536000"
}
EOF
fi
compose() { "${PRIVILEGE[@]}" docker compose "$@"; }
compose config --quiet
say "2/3  Downloading published images..."
compose pull || die "Image download failed. Your configuration is saved; run setup again to retry."
say "3/3  Starting your workspace and HTTPS proxy..."
if ! compose up -d --wait --wait-timeout 180; then
  compose logs --tail=40 quanta caddy >&2 || true
  die "The workspace did not become healthy. Check the logs above, DNS, and ports 80/443, then run setup again."
fi
printf '\n'
say "Your workspace is running: https://$DOMAIN"
say "HTTPS certificates may take a moment while your domain is verified."
say "Sign in as $EMAIL"
if [[ -f .setup-pending ]]; then
  PASSWORD="$(sed -n 's/^QUANTA_ADMIN_PASSWORD=//p' .env | head -n 1)"
fi
if [[ -n "$PASSWORD" ]]; then
  say "Temporary password: $PASSWORD"
  say "Change it in Workspace settings after signing in."
else
  say "Use your existing password. Setup does not reset accounts."
fi
say "Bootstrap credentials are saved in $DIRECTORY/.env (readable only by its owner)."
say "Invite your team from the Share button on a folder."
say "Run this setup again to update; back up your workspace first."
rm -f .setup-pending
printf '\n'
