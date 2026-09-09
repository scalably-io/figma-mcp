# Figma MCP

Figma REST API MCP server. 2 tools list the top-level frames in a file and fetch one frame's rendered PNG plus its node JSON and image-fill map into a local output directory.

<!-- mcp-name: io.scalably/figma-mcp -->

## Install

Claude Code:

```bash
claude mcp add figma -e FIGMA_TOKEN=your-token -- npx -y @scalably-io/figma-mcp
```

Codex:

```bash
codex mcp add figma --env FIGMA_TOKEN=your-token -- npx -y @scalably-io/figma-mcp
```

Claude Desktop: download `figma-mcp.mcpb` from the latest GitHub release and open it.

## Setup

1. Create a personal access token at figma.com under account settings, with `file_content:read` scope.
2. Find the file key in any Figma file URL: it is the segment after `/design/` or `/file/`, for example `https://www.figma.com/design/AbC123xyz/My-file` gives `AbC123xyz`. Both tools take it as `file_key`.
3. If `FIGMA_TOKEN` is not set the server still starts and lists its tools; every call then fails with `FIGMA_NOT_CONFIGURED` until the token is provided.
4. `fetch_frame` is the only tool that writes files (so it is not marked read-only); it writes `frame.png`, `node.json`, and `fills.json` into a directory below the configured output root (default `./figma-output`). The other tool is fully read-only.

## Tools (2)

| Tool | What it does |
|---|---|
| `list_frames` | List and optionally filter all top-level FRAME nodes in a Figma file, with exact page/name/node-id data, dimensions, and file metadata |
| `fetch_frame` | Fetch one Figma frame and transactionally write frame.png, node.json, and a normalized image-fill map into a directory below the output root |

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `FIGMA_TOKEN` | yes | Figma personal access token with `file_content:read` |
| `FIGMA_API_BASE_URL` | no | Override the Figma REST API base URL (default `https://api.figma.com/v1`) |
| `FIGMA_REQUEST_TIMEOUT_MS` | no | Per-request timeout in milliseconds (default 60000) |
| `FIGMA_MAX_JSON_BYTES` | no | Upper bound on a Figma JSON response, in bytes (default 104857600) |
| `FIGMA_MAX_FRAME_BYTES` | no | Upper bound on a downloaded frame PNG, in bytes (default 104857600) |
| `FIGMA_OUTPUT_ROOT` | no | Directory that every `fetch_frame` output directory must stay below (default `./figma-output`, created on first use) |
| `FIGMA_ALLOW_HTTP_FOR_TESTS` | no | Test suite only: `1` allows a plain-HTTP loopback API base. Never set it in normal use |

## Reply shape

Every tool returns plain JSON with `status` (`succeeded`, `partial`, `no_op`), `summary`, `target`, `result`, `proof`, `warnings`, `recovery`. Failures throw a plain error string: `<code>: <message> <hint>`.

## Limits

`fetch_frame` renders through Figma's image API, so very large frames or extreme scale values can exceed the configured JSON or frame byte limits; lower `scale` or split the frame if that happens. `fills.json` URLs are temporary and expire within 14 days.

## Verify

Each release lists the package version, the `.mcpb` sha256 and the production commit it was derived from in CHANGELOG.md. CI runs the tests and a clean install of the packed tarball on every push.

## Privacy Policy

This server runs locally, on your machine, under your own credentials. It collects no personal data, contains no telemetry, stores nothing persistently beyond the frame bundles you explicitly fetch, and talks only to the vendor API it wraps. No third party, including Scalably, receives your data. Contact: hello@scalably.io. Canonical copy: https://scalably.io/connector-privacy.html

## License

MIT. Copyright Scalably.
