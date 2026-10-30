# kaspa-mcp

**Public, open-source MCP connector** so anyone can connect Grok Bot / Claude / Cursor, brainstorm ideas for building on Kaspa, and have their agent **compile + deploy smart contracts** on Kaspa-ecosystem networks (Kasplex, Igra today; native L1 covenants/vProgs stubs for later).

MIT · Non-custodial · Designed for **$0** (public RPCs + free testnet faucets).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MikeyKaspa/kaspa-mcp)

## Shared demo: limits

A shared demo runs at `https://kaspa-mcp.kaspa-mcp.workers.dev/mcp` on a **dedicated free Cloudflare account** (not tied to anyone's other products).

| Cap | What it means |
|-----|----------------|
| **100,000 requests/day** | Whole free account, resets **midnight UTC**. When hit, Cloudflare returns Error 1027. |
| **~10 ms CPU / request** | Free Workers CPU budget. Heavy `compile_solidity` (CDN solc) fails first. |
| **60 requests / min / IP** | Per-IP rate limit on the shared demo. |
| **5 compiles / 10 min / IP** | Tighter limit for `compile_solidity` (Cache API window + 1/min binding floor). |

Over the per-IP limit you get a JSON-RPC `-32000` / HTTP 429 asking you to **self-host**. Limits are enforced with the free Workers Rate Limiting binding plus a Cache API counter (per colo; approximate under multi-colo load). Optional header `X-Kaspa-Demo-Key` gives a stable bucket behind NAT. Anyone with real usage should: one-click Deploy button (or one `wrangler deploy`) to **your own free Cloudflare account** → your own 100k/day; or run locally with `npx` / `npm start` for **no shared limits**.

Rate limits are **off by default** for self-hosters. Set `RATE_LIMIT_ENABLED=true` (and optional `RATE_LIMIT_*` vars) only if you want them.

## Self-host (recommended for heavy use)

**Free Cloudflare (own account, own 100k/day):**

```bash
npm install
npx wrangler deploy   # workers.dev only — stay on the free plan; no custom domain required
```

Or use the **Deploy to Cloudflare** button above (opens Cloudflare’s one-click deploy for this public repo).

**Local (no shared limits, offline solc):**

```bash
npm install && npm test && npm start
# MCP: http://127.0.0.1:8787/mcp
```

```bash
claude mcp add --transport http kaspa http://127.0.0.1:8787/mcp
```

## Connect the shared demo to your AI

Paste this MCP URL into your AI app’s custom connector / MCP settings:

```
https://kaspa-mcp.kaspa-mcp.workers.dev/mcp
```

## Testnet gas (Kasplex)

Official Kasplex L2 faucets (`faucet.kasplextest.xyz`, `app.kaspafinance.io/faucets`) are **often down or empty**. Recommended free path today:

1. Claim L1 tKAS from the [Kaspa TN10 faucet](https://faucet-tn10.kaspanet.io/) (paste a `kaspatest:` address from a Kaspa testnet wallet).
2. Bridge to Kasplex testnet with the official [Kurve-Test bridge](https://kasbridge-tn10evm.kaspafoundation.org/) — destination **Kasplex**, paste your EVM address (MetaMask on RPC `https://rpc.kasplextest.xyz`, chain id `167012`).
3. Then `deploy_contract` on `kasplex-testnet` (or use `local-anvil` for a fully offline practice deploy).

Igra has its own faucet API: https://faucet.igralabs.com/docs

## Why this exists

Existing Kaspa MCP servers cover L1 wallet/RPC reads or paid covenant helpers. **None** give a free, public, agent-friendly path to write + deploy Solidity on Kasplex/Igra with a non-custodial model.

| Project | Deploy Solidity on Kasplex/Igra? |
|---------|----------------------------------|
| pichukov / kasanova / moldis Kaspa MCPs | No (L1 focus) |
| k402-mcp | Paid metered CaaS |
| foundry-mcp-server | Generic EVM, not Kaspa-aware |
| **kaspa-mcp (this)** | **Yes (testnet first)** |

## Architecture

```
MCP tools → Network registry → Backend
                               ├─ EvmBackend (Kasplex, Igra)     ✅
                               ├─ L1ReadBackend (api.kaspa.org)  ✅
                               ├─ CovenantBackend                🚧 stub
                               └─ VProgsBackend                  🚧 stub
```

Native L1: Toccata covenants live since 2026-06-30; Silverscript pre-audit; vProgs roadmap. v0.1 ships **EVM deploy** because agents can finish that path today.

## Networks

**Kasplex** — testnet `167012` (`rpc.kasplextest.xyz`) · mainnet `202555` (`evmrpc.kasplex.org`)  
**Igra** — Galleon `38836` · mainnet `38833`  
**L1 reads** — `api.kaspa.org` / `api-tn10.kaspa.org`

## Safety

1. Never stores keys / mnemonics.  
2. **Mainnet:** private keys **rejected** → `prepare_*` + wallet sign + `send_raw_transaction`.  
3. **Testnet only:** optional per-call ephemeral `privateKey`.  
4. Secrets redacted from errors.

## Tools

`list_networks` · `kaspa_network_info` · `verify_rpc` · `kaspa_ideas` · `compile_solidity` · `deploy_contract` · `prepare_deploy` · `read_contract` · `prepare_call` · `send_raw_transaction` · `get_balance` · `get_tx` · `faucet_info` · `l1_blockdag_info`

Prompt: `build_on_kaspa`. Resources under `kaspa-mcp://docs/*`.

### Agent flow

1. `kaspa_ideas` → 2. `list_networks` → 3. `compile_solidity` → 4. `faucet_info` → 5. `deploy_contract` (testnet) or `prepare_deploy` → 6. `read_contract`

## Cost

| Item | Cost |
|------|------|
| Public RPCs + testnet faucets | $0 |
| Local `npm start` | $0 |
| Cloudflare `*.workers.dev` free plan | $0 — **do not add paid plans / custom domains** |
| Mainnet gas / bridging | Real money — not default |

Workers note: solc is loaded from `binaries.soliditylang.org` at runtime (not bundled). See `docs/COST.md`.

## License

MIT
