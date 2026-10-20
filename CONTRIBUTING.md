# Contributing

```sh
git clone https://github.com/real-kijmoshi/quanta.git
cd quanta
npm ci --ignore-scripts   # Node.js 22+
npm start                 # http://localhost:4173, boards in ./data
npm test                  # syntax, rendering, storage, collaboration, hosted, AI (mocked)
```

- There is no build step; `src/` is served as native ES modules.
- Keep changes focused and add or extend a script in `scripts/*-test.mjs` for behavior you change.
- `quanta` (see `bin/quanta.mjs`) is a thin wrapper around `server.mjs` and the scripts; run `node bin/quanta.mjs --help`.

## Releasing

1. Update `version` in `package.json` and add notes to `CHANGELOG.md`.
2. Commit, then `git tag vX.Y.Z && git push origin main vX.Y.Z`.
3. The **Release** workflow tests, packs `quanta.tgz`, publishes `install.sh`, `install.ps1` and `SHA256SUMS` on a GitHub release, and pushes a multi-arch image to `ghcr.io/real-kijmoshi/quanta`.

The website in `site/` deploys to GitHub Pages on every push to `main` that touches it.
