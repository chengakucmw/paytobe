# VelarumPay Developer Docs Site

Static developer documentation and quickstart for VelarumPay Platform API v0.1.
Plain HTML served by a tiny zero-dependency Node static server (same pattern as
`apps/website`).

## Pages

- `public/index.html` — overview and the "no API key" trust model.
- `public/quickstart.html` — connect an agent in 5 steps (JavaScript SDK).
- `public/api.html` — REST API reference (auth, endpoints, example).
- `public/protocol.html` — `payment_request.v1` and `transaction_context.v1`.
- `public/mcp.html` — MCP server setup for AI agents.

## Run locally

```bash
cd apps/docs
node server.mjs
# http://localhost:8092
```

Override the port with `PORT`. The site is fully static, so it can also be
served by any static host or by Caddy directly.

## Deploy

In production this site is built and served as the `docs` container in the
private infra repo at `/Users/yang/code/VelarumPayCloud`, reachable at
`https://docs.<your-domain>`.
