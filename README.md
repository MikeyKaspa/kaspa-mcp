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
| **60 requests / min / actor** | Per IP, or per `X-Kaspa-Demo-Key` when set. |
| **180 requests / min / IP** | Secondary ceiling so rotating demo keys cannot bypass limits. |
| **5 compiles / 10 min / actor** | Tighter limit for `compile_solidity` (Cache API window + 1/min binding floor). |
| **Worker compile** | **Not available on the shared Workers demo** (Cloudflare blocks `eval`/`new Function`; solc cannot load). Self-host with `npm start` for compile, or pass `bytecode`+`abi` to `prepare_deploy` / `deploy_contract`. |

Over the limit you get a JSON-RPC `-32000` / HTTP 429 asking you to **self-host**. Limits use Cloudflare’s trusted `CF-Connecting-IP` (not spoofable `X-Forwarded-For`), the free Rate Limiting binding, and a Cache API counter (per colo; approximate under multi-colo load). Optional header `X-Kaspa-Demo-Key` gives a stable bucket behind NAT, still capped by the per-IP ceiling. Anyone with real usage should: one-click Deploy button (or one `wrangler deploy`) to **your own free Cloudflare account** → your own 100k/day; or run locally with `npx` / `npm start` for **no shared limits**.

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

MCP URL:

```
https://kaspa-mcp.kaspa-mcp.workers.dev/mcp
```

**Claude (claude.ai / Desktop / Cowork)** — [Custom connectors (remote MCP)](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp): Settings → Connectors → Add custom connector → paste the HTTPS URL above → choose **No sign-in** (this demo is open). Claude’s cloud must reach the URL (public internet only; localhost will not work as a custom connector).

**Claude Desktop local server** — for `npm start` on your machine, bridge with stdio (Custom Connectors cannot see localhost):

```bash
# claude_desktop_config.json (mcp-remote speaks Streamable HTTP to your local server)
claude mcp add --transport http kaspa http://127.0.0.1:8787/mcp
# or: npx -y mcp-remote http://127.0.0.1:8787/mcp --transport http-only
```

**Cursor** — Settings → MCP → Add new MCP server → Type **URL** / Streamable HTTP → paste the demo URL (or your self-hosted `/mcp`).

**Other MCP clients** — any client that supports Streamable HTTP MCP can POST to `/mcp`.

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

1. Never stores keys / mnemonics / keystores.  
2. **Mainnet:** private keys **rejected** (including whitespace / 0x-less / mnemonic / JSON keystore attempts) → `prepare_*` + wallet sign + `send_raw_transaction`.  
3. **Testnet only:** optional per-call ephemeral `privateKey` (strict `0x` + 64 hex).  
4. Secrets redacted from errors. See [SECURITY.md](./SECURITY.md).

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
