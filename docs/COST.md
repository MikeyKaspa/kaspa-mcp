# Cost policy ($0)

Allowed without asking:
- Public RPCs (Kasplex, Igra, api.kaspa.org)
- Free testnet faucets
- Local `npm start`

Needs the account owner's approval (may leave $0):
- Cloudflare Workers beyond free tier / custom domains / Containers
- Any mainnet gas or bridging
- GitHub paid features (not required)

Never:
- Spend real money automatically
- Store user keys on a host

## Workers compile (2026-10-30)

Free Workers cannot ship `solc` soljson (~11 MB) in the script, and the runtime blocks `eval` / `new Function`, so **`compile_solidity` does not run on the shared Worker demo**.

- Reads, `prepare_*`, `send_raw_transaction`, tip-jar reads: work on the shared demo
- Compile: self-host with `npm start` (local `solc`), or pass `bytecode` + `abi` into `prepare_deploy` / `deploy_contract`
- No paid Workers plans or custom domains

## Shared demo rate limits

Enabled only when `RATE_LIMIT_ENABLED=true` (set on the shared Worker; **off by default** for self-host).

- 60 MCP requests / minute / actor (IP or `X-Kaspa-Demo-Key`)
- 180 requests / minute / real IP (secondary ceiling; stops demo-key rotation bypass)
- 5 `compile_solidity` / 10 minutes / actor + 1/min binding floor (relevant for self-host with limits on)
- Trusted IP: Cloudflare `CF-Connecting-IP` only (not `X-Forwarded-For`)
- Over limit → JSON-RPC `-32000` + HTTP 429 asking users to self-host
