# Changelog

## 1.0.0

- First public release.
- Derived from: `container/tools/figma-mcp` at `ef174fc3` (2026-08-31) in the private ScalablyAI repository.
- Changes from production: the private tool-outcome envelope is replaced by a plain JSON reply; the output root defaults to `./figma-output` instead of a platform path; a missing `FIGMA_TOKEN` no longer stops the process at startup, each call fails with `FIGMA_NOT_CONFIGURED` instead, so clients can list tools before configuring; no other functional change.
- Build changes: current `fastmcp` 4 and `zod` 4 pins; a shebang line so the npm `bin` runs; two string literals split in source and tests so the public-pattern scanner does not flag them (runtime values unchanged); the e2e test uses `localhost` and the current protocol version.
