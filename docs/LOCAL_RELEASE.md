# Local release and recovery

Quanta is a local, single-workspace application. Run it with Node.js 22 or newer:

```powershell
npm ci --ignore-scripts
npm test
npm start
```

Open `http://127.0.0.1:4173`. Keep the server running while you work. One server owns each data directory; starting another against the same directory fails. A stale process lease is recovered automatically after a crash. Do not manually remove an active `.quanta.lock`.

## Saving

Board changes are serialized per board. The server syncs a temporary file and atomically replaces the board JSON before acknowledging the change. The previous file remains as `.json.bak`. The sidebar index is derived from board files and rebuilt on startup. If the primary JSON is unreadable, startup restores its valid backup and preserves the corrupt bytes. If both copies are unreadable, startup stops instead of replacing your data with an empty workspace.

The browser stores board snapshots in IndexedDB and journals pending incremental edits locally. Failed requests retain their journal, including across board switches and reloads; reconnecting retries them. `Saved` means the server acknowledged the current edits. Browser storage is a recovery aid, not a backup: clearing site data or changing origin/profile removes access to it. Keep using the same address and browser profile. Private-mode storage and quotas can restrict recovery. A warning appears when a local recovery copy cannot be written.

Atomic replacement does not guarantee recovery from every hardware failure, filesystem failure, or abrupt power loss. Keep independent backups on another device.

## Deleted boards

Use **Board menu → Recently deleted boards → Restore**. Deleting a board first stores its full document in `data/trash/`. Restoring preserves its ID and contents. Uploaded assets are retained; there is no automatic trash expiry or permanent-delete UI.

## Backups

For a consistent workspace backup, wait for `Saved`, stop the server with Ctrl+C, and then run:

```powershell
npm run backup -- "D:\QuantaBackups\2026-10-15"
npm run backup:verify -- "D:\QuantaBackups\2026-10-15"
```

Choose a new destination outside `data/`. The backup contains `data/` plus a manifest with byte counts and SHA-256 checksums. Verification detects missing or altered listed files. A backup taken while the server is running is a per-file snapshot and may span several workspace revisions. `QUANTA_DATA` selects a different source directory.

To restore, stop the server, verify the backup, copy its `data/` into a **new** workspace directory, and start with that directory:

```powershell
Copy-Item -LiteralPath 'D:\QuantaBackups\2026-10-15\data' -Destination 'D:\QuantaRestored' -Recurse
$env:QUANTA_DATA = 'D:\QuantaRestored'
npm start
```

Check the boards before changing your normal launch configuration. Keep the original directory intact. If an old browser has pending edits from a different workspace state, use a separate browser profile to inspect a restored backup before reconnecting that browser.

## Local access boundary

The default server binds to `127.0.0.1`. Host, Origin, and cross-site requests are checked; private data, backups, environment files, and server internals are not served as static files. JSON mutation inputs are bounded and validated. Requests have IDs for correlating errors with the server log.

Workspace ownership is limited to loopback requests addressed to localhost, 127.0.0.1, or ::1, plus requests holding the private owner link printed by `npm run tunnel`. Remote clients need a named folder invitation; its bearer token grants edit access to the folder and its descendants. Separate invitations support individual revocation. Tokens are random, only their hashes are persisted, and the browser keeps an accepted invitation in an HttpOnly cookie. API reads/writes, search, assets, and SSE enforce folder scope; MCP, AI, host code execution, trash, deletion, and invitation management are owner-only. Existing downloaded copies remain on recipients' devices after revocation.

There are no verified user accounts, passwords, SSO, encrypted storage, audit trails, or enterprise tenant isolation. Anyone holding an invitation can use it. Use HTTPS when sharing outside a trusted network. Host code cards run with the host user's privileges. Custom trusted hostnames can be added with `QUANTA_ALLOWED_HOSTS` (comma-separated hostname values); tunnel requests still require a folder invitation or the private owner link printed by `npm run tunnel`, and an anonymous tunnel request never inherits localhost ownership.

## Verification

`npm test` checks syntax, rendering invariants, low-zoom geometry, concurrent durable writes, failed-write rollback, corruption recovery, workspace ownership, trash restore, outbox recovery, board switching, input validation, and mocked AI/provider routes. `npm audit --omit=dev` checks the installed runtime dependency tree. GitHub Actions is configured for Windows and Ubuntu on Node 22 and 24; configuration alone is not evidence that hosted CI has run.

For browser profiling use `/diagnostics/canvas-profile.html`. Keep the tab foregrounded. CPU submission timings exclude deferred GPU work; runs with scheduling interruptions cannot establish input latency or FPS. Native cursor and bounded live ink rendering reduce work, but Miro-equivalent latency has not been established on the user's machine.
