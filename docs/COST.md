# Cost policy ($0)

Allowed without asking:
- Public RPCs (Kasplex, Igra, api.kaspa.org)
- Free testnet faucets
- Local `npm start`

Needs the account owner's approval (may leave $0):
- `wrangler deploy` / Cloudflare Workers beyond free tier
- Custom domains, paid Workers, Containers
- Any mainnet gas or bridging
- GitHub paid features (not required)

Never:
- Spend real money automatically
- Store user keys on a host

## Workers compile tradeoff (2026-10-30)

Free Workers script limit cannot fit `solc` soljson (~11 MB). The deployed Worker therefore:

- Serves MCP Streamable HTTP at `/mcp` with all read / prepare / testnet-deploy tools
- Loads solc from the official CDN (`binaries.soliditylang.org`) on first `compile_solidity` call per isolate
- Does **not** enable paid Workers plans or custom domains

If CDN compile hits free-plan CPU limits, compile locally with `npm start` (offline `solc` package) or pass pre-built ABI+bytecode into deploy tools.

## Shared demo rate limits (2026-10-30)

Enabled only when `RATE_LIMIT_ENABLED=true` (set on the shared Worker; **off by default** for self-host).

- 60 MCP requests / minute / IP (Cache API + Workers Rate Limiting binding, free)
- 5 `compile_solidity` / 10 minutes / IP (Cache API + isolate) + 1/min binding floor
- Over limit → JSON-RPC `-32000` + HTTP 429 asking users to self-host

**Workers demo:** `compile_solidity` is unavailable (Cloudflare blocks eval). Self-host with `npm start` for compile, or pass `bytecode`+`abi` on the shared demo.
