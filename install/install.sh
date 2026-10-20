#!/usr/bin/env sh
# Install the Quanta command on macOS or Linux.
#   curl -fsSL https://github.com/real-kijmoshi/quanta/releases/latest/download/install.sh | sh
# Options (environment variables):
#   QUANTA_VERSION=1.2.3   install a specific version (default: latest release)
#   QUANTA_HOME=~/.quanta  install location
#   QUANTA_BIN=~/.local/bin  where the `quanta` command is linked
#   QUANTA_REPO=owner/name   fetch releases from a fork
set -eu

REPO="${QUANTA_REPO:-real-kijmoshi/quanta}"
HOME_DIR="${QUANTA_HOME:-$HOME/.quanta}"
BIN_DIR="${QUANTA_BIN:-$HOME/.local/bin}"
VERSION="${QUANTA_VERSION:-latest}"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but was not found. $2"; }

need node "Install Node.js 22 or newer from https://nodejs.org"
need npm "It ships with Node.js."
need tar "Install tar with your package manager."
if command -v curl >/dev/null 2>&1; then fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then fetch() { wget -q "$1" -O "$2"; }
else die "curl or wget is required."; fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js 22 or newer is required (found $(node -v))."

if [ -n "${QUANTA_BASE_URL:-}" ]; then
  BASE="$QUANTA_BASE_URL"   # testing: a directory holding quanta.tgz and SHA256SUMS
elif [ "$VERSION" = "latest" ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  BASE="https://github.com/$REPO/releases/download/v${VERSION#v}"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

say "Downloading Quanta ($VERSION)..."
fetch "$BASE/quanta.tgz" "$TMP/quanta.tgz" || die "could not download $BASE/quanta.tgz"
fetch "$BASE/SHA256SUMS" "$TMP/SHA256SUMS" || die "could not download checksums"

EXPECTED="$(grep ' quanta.tgz$' "$TMP/SHA256SUMS" | awk '{print $1}')"
if command -v sha256sum >/dev/null 2>&1; then ACTUAL="$(sha256sum "$TMP/quanta.tgz" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then ACTUAL="$(shasum -a 256 "$TMP/quanta.tgz" | awk '{print $1}')"
else die "sha256sum or shasum is required to verify the download."; fi
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || die "checksum mismatch; refusing to install."

APP="$HOME_DIR/app"
NEXT="$HOME_DIR/app.new"
rm -rf "$NEXT"
mkdir -p "$NEXT" "$BIN_DIR"
tar -xzf "$TMP/quanta.tgz" -C "$NEXT" --strip-components=1

say "Installing dependencies (this can take a minute)..."
(cd "$NEXT" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)

rm -rf "$HOME_DIR/app.old"
[ -d "$APP" ] && mv "$APP" "$HOME_DIR/app.old"
mv "$NEXT" "$APP"
rm -rf "$HOME_DIR/app.old"

ln -sf "$APP/bin/quanta.mjs" "$BIN_DIR/quanta"
chmod +x "$APP/bin/quanta.mjs"

say ""
say "Installed Quanta $("$BIN_DIR/quanta" --version) to $APP"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "Add $BIN_DIR to your PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
say "Your boards live in $HOME_DIR/data and are kept when you update."
say "Start it:  quanta start --open"
