# Contributing

```sh
git clone https://github.com/real-kijmoshi/quanta.git
cd quanta
npm ci --ignore-scripts   # Node.js 22+
npm start                 # http://localhost:4173, boards in ./data
npm test                  # syntax, rendering, storage, collaboration, hosted, AI (mocked)
```

- There is no build step; `client/src/` is served as native ES modules.
- Keep changes focused and add or extend a script in `tests/*-test.mjs` for behavior you change.
- `quanta` (see `bin/quanta.mjs`) is a thin wrapper around `server/index.mjs` and the scripts; run `node bin/quanta.mjs --help`.

## Repository layout

| Path | Purpose |
| --- | --- |
| `client/index.html` | Application shell |
| `client/src/` | Browser modules and workers |
| `client/styles/` | Application stylesheets, in the order linked by the shell |
| `client/diagnostics/` | Browser profiling and recovery tools |
| `server/` | HTTP entrypoint, storage, authentication, AI, and MCP |
| `shared/` | Search helpers and Python harness used by browser and server |
| `tests/` | Automated regression and integration checks |
| `scripts/` | Maintenance and development commands |
| `bin/` | Installed `quanta` CLI |
| `site/` | Independently deployed public website |
| `deploy/`, `install/` | Hosting configuration and release installers |
| `docs/` | Feature, operating, and release guides |

The server serves `client/` at `/`, shared runtime files at `/shared/`, and selected
dependencies at `/vendor/`. Browser module URLs stay under `/src/` and profiling
pages under `/diagnostics/`. Server code and repository metadata are outside the
static root. Keep shared code independent of browser and server modules.

Local boards stay in the root `data/` directory by default. `data/`, `backups/`,
`artifacts/`, and `node_modules/` are generated or personal files ignored by Git.

## Releasing

1. Update `version` in `package.json` and add notes to `CHANGELOG.md`.
2. Commit, then `git tag vX.Y.Z && git push origin main vX.Y.Z`.
3. The **Release** workflow tests, packs `quanta.tgz`, publishes `install.sh`, `install.ps1` and `SHA256SUMS` on a GitHub release, and pushes a multi-arch image to `ghcr.io/real-kijmoshi/quanta`.

The website in `site/` deploys to GitHub Pages on every push to `main` that touches it.
