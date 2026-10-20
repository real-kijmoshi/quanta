# Security policy

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/real-kijmoshi/quanta/security/advisories/new)
rather than a public issue. Include the version (`quanta --version`), how you run it, and steps to reproduce.

Only the latest release receives fixes.

Things worth knowing when you deploy Quanta:

- Local mode (`quanta start`) binds to `127.0.0.1` only. `quanta share` binds to every network interface; use it on networks you trust.
- `quanta tunnel` prints an **Owner URL**. Anyone who opens it becomes the workspace owner, so never share it.
- Never commit `.env`, API keys, or the `data/` folder. Both are in `.gitignore`.
- Hosted deployments are described in [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).
