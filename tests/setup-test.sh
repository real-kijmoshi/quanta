#!/usr/bin/env bash
# Exercise deployment orchestration without Docker, network access, or privileges.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"
export CALLS="$WORK/calls"
export PATH="$WORK/bin:$PATH"
cat > "$WORK/bin/uname" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${TEST_OS:-Linux}"
EOF
cat > "$WORK/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALLS"
case "$*" in
  info) exit "${FAIL_INFO:-0}" ;;
  'compose version'|'compose config --quiet') exit 0 ;;
  'compose pull') exit "${FAIL_PULL:-0}" ;;
  'compose up -d --wait --wait-timeout 180') exit "${FAIL_START:-0}" ;;
  'compose logs --tail=40 quanta caddy') printf 'example diagnostic\n'; exit 0 ;;
  *) printf 'Unexpected Docker call: %s\n' "$*" >&2; exit 99 ;;
esac
EOF
cat > "$WORK/bin/sudo" <<'EOF'
#!/usr/bin/env bash
# No actual privilege escalation in tests; simulate permission failure safely.
exit 1
EOF
chmod +x "$WORK/bin/"*
SETUP="$ROOT/deploy/install.sh"
run_setup() { bash "$SETUP" --directory "$WORK/server config" "$@"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

bash -n "$SETUP"
bash "$SETUP" --help > "$WORK/help"
grep -q 'Quanta server setup' "$WORK/help"

# Reject malformed values and unsupported hosts before invoking Docker or writing files.
for domain in 'https://board.example.com' '-board.example.com' 'board..example.com' 'board.example.com:443' 'board.example.com/path' 'board.example.com.'; do
  if run_setup --domain "$domain" --email owner@example.com --yes > "$WORK/output" 2>&1; then fail "accepted $domain"; fi
done
if run_setup --domain board.example.com --email 'bad$email@example.com' --yes > "$WORK/output" 2>&1; then fail 'accepted unsafe email'; fi
if run_setup --yes > "$WORK/output" 2>&1; then fail 'missing unattended configuration accepted'; fi
if run_setup --domain > "$WORK/output" 2>&1; then fail 'missing option value accepted'; fi
if TEST_OS=Darwin run_setup --yes > "$WORK/output" 2>&1; then fail 'accepted unsupported host'; fi
[[ ! -e "$CALLS" && ! -d "$WORK/server config" ]] || fail 'validation changed server state'

# An interrupted first install still shows the bootstrap password on a successful retry.
if FAIL_PULL=1 run_setup --domain board.example.com --email owner+team@example.com --yes > "$WORK/output" 2>&1; then fail 'failed first pull accepted'; fi
[[ -f "$WORK/server config/.setup-pending" ]] || fail 'missing first-install recovery state'
cp "$WORK/server config/.env" "$WORK/first-env"

# First install uses the published image, protected credentials, and health-gated startup.
run_setup --yes > "$WORK/output"
cmp "$WORK/first-env" "$WORK/server config/.env"
[[ ! -f "$WORK/server config/.setup-pending" ]] || fail 'bootstrap completion not saved'
grep -q 'Your workspace is running: https://board.example.com' "$WORK/output"
grep -q 'Temporary password:' "$WORK/output"
grep -q '^QUANTA_ADMIN_PASSWORD=[a-f0-9]\{48\}$' "$WORK/server config/.env"
grep -q 'image: ghcr.io/real-kijmoshi/quanta:latest' "$WORK/server config/compose.yaml"
grep -q 'QUANTA_AUTH: "1"' "$WORK/server config/compose.yaml"
grep -q 'name: quanta-server' "$WORK/server config/compose.yaml"
grep -q 'reverse_proxy quanta:4173' "$WORK/server config/Caddyfile"
grep -q '^compose pull$' "$CALLS"
grep -q '^compose up -d --wait --wait-timeout 180$' "$CALLS"
if grep -q -- '--build' "$CALLS"; then fail 'setup built from source'; fi
if [[ "$(/usr/bin/uname -s)" == Linux ]]; then
  [[ "$(stat -c %a "$WORK/server config/.env")" == 600 ]] || fail 'credentials are not private'
fi
cp "$WORK/server config/.env" "$WORK/saved-env"
printf '\n# Custom configuration\n' >> "$WORK/server config/compose.yaml"
cp "$WORK/server config/compose.yaml" "$WORK/saved-compose"

# Reruns retain both configuration and password, without printing the password again.
run_setup --yes > "$WORK/output"
cmp "$WORK/saved-env" "$WORK/server config/.env"
cmp "$WORK/saved-compose" "$WORK/server config/compose.yaml"
grep -q 'Use your existing password' "$WORK/output"
if grep -q 'Temporary password:' "$WORK/output"; then fail 'password shown again'; fi
if run_setup --domain other.example.com --email other@example.com --yes > "$WORK/output" 2>&1; then fail 'existing settings replaced'; fi
cmp "$WORK/saved-env" "$WORK/server config/.env"

# A failed pull or unhealthy deployment cannot claim success; credentials survive retries.
if FAIL_PULL=1 run_setup --yes > "$WORK/output" 2>&1; then fail 'failed pull reported success'; fi
grep -q 'Image download failed' "$WORK/output"
if grep -q 'Your workspace is running' "$WORK/output"; then fail 'success after failed pull'; fi
if FAIL_START=1 run_setup --yes > "$WORK/output" 2>&1; then fail 'failed health check reported success'; fi
grep -q 'example diagnostic' "$WORK/output"
grep -q 'did not become healthy' "$WORK/output"
if grep -q 'Your workspace is running' "$WORK/output"; then fail 'success after failed start'; fi
cmp "$WORK/saved-env" "$WORK/server config/.env"
if FAIL_INFO=1 run_setup --yes > "$WORK/output" 2>&1; then fail 'broken Docker accepted'; fi
grep -q 'Docker is not running' "$WORK/output"

# Existing configuration is treated as data, never as shell code.
printf '\nUNTRUSTED=$(touch "%s")\n' "$WORK/executed" >> "$WORK/server config/.env"
run_setup --yes > "$WORK/output"
[[ ! -e "$WORK/executed" ]] || fail 'executed the environment file'

# A pseudo terminal exercises curl | bash, retries, and cancellation with real prompts.
if command -v script >/dev/null 2>&1; then
  export SETUP WORK
  cat > "$WORK/interactive.sh" <<'EOF'
#!/usr/bin/env bash
cat "$SETUP" | bash -s -- --directory "$WORK/interactive"
EOF
  printf 'https://wrong.example.com\nboard.example.com\ninvalid\nowner@example.com\nn\n' |
    script -q -e -c 'bash "$WORK/interactive.sh"' /dev/null > "$WORK/interactive-output"
  grep -q 'Enter a hostname' "$WORK/interactive-output"
  grep -q 'Enter an email address' "$WORK/interactive-output"
  grep -q 'Cancelled. Nothing changed.' "$WORK/interactive-output"
  [[ ! -d "$WORK/interactive" ]] || fail 'cancellation wrote configuration'
  printf 'board.example.com\nowner@example.com\ny\n' |
    script -q -e -c 'bash "$WORK/interactive.sh"' /dev/null > "$WORK/interactive-output"
  grep -q 'Your workspace is running: https://board.example.com' "$WORK/interactive-output"
  grep -q 'Temporary password:' "$WORK/interactive-output"
fi

printf 'Server setup checks passed\n'
