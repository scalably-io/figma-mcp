# Releasing

1. Bump `version` in `package.json`, `manifest.json`, `server.json` and the `new FastMCP({ version })` call; add a CHANGELOG entry; keep `server.json` `description` at 100 characters or fewer; `npm test`, the scanner; commit.
2. First version of a new package only: `npm ci && npm run build && npm publish --access public` from the maintainer's logged-in terminal (npm asks for the 2FA code), then add the trusted publisher on `npmjs.com/package/<name>/access`: GitHub, organization `scalably-io`, repository `<server>`, workflow `release.yml`, environment `npm`.
3. Tag and push: `git tag v<version> && git push origin main --tags`. CI publishes to npm by trusted publishing (skipped when the version is already there) and attaches `<server>.mcpb` plus `<server>.mcpb.sha256` to the GitHub release.
4. Confirm: `npm view @scalably-io/<server> version`; the release page shows both assets.
5. Add or update the `mcpb` entry in `server.json`: `identifier` = the release asset URL, `fileSha256` = the 64 hex characters in the `.sha256` asset. Commit and push.
6. Registry (local, maintainer's Mac only; on macOS use `/opt/homebrew/opt/openssl@3/bin/openssl`): `PRIVATE_KEY="$(openssl pkey -in ~/.config/scalably/mcp-registry/key.pem -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n')"` then `mcp-publisher login dns --domain scalably.io --private-key "$PRIVATE_KEY"` and `mcp-publisher publish`.
7. Confirm: `curl -s 'https://registry.modelcontextprotocol.io/v0.1/servers?search=io.scalably/<server>'` lists the version.
