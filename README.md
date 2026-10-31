# kaspa-mcp

**Public, open-source MCP connector** so anyone can connect Grok Bot / Claude / Cursor, brainstorm ideas for building on Kaspa, and have their agent **compile + deploy smart contracts** on Kaspa-ecosystem networks (Kasplex, Igra today; native L1 covenants/vProgs stubs for later).

MIT · Non-custodial · Designed for **$0** (public RPCs + free testnet faucets).

> ## ⚠️ UNAUDITED / USE AT YOUR OWN RISK
>
> **L1 SilverScript templates and prepare helpers are experimental and not security-audited.** Funding or spending covenants on mainnet can lose funds.  
> **Mainnet mode is prepare-only:** tools return unsigned KasWare SafeJSON for **your wallet** to sign (`signPskt` → `pushTx`). This connector **never accepts or stores mainnet private keys**.  
> Prefer **testnet-10** (`kaspatest:`) for all experiments. No warranty — you are solely responsible for any loss.
>


[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MikeyKaspa/kaspa-mcp)

> Deploy button = **keyless** copy (tap-to-approve). For chat-deploy **without popups**, use `npm run selfhost:setup` (see Self-host below).

**Legal:** [Privacy](https://kaspa-mcp.kaspa-mcp.workers.dev/privacy) · [Terms](https://kaspa-mcp.kaspa-mcp.workers.dev/terms) · [Support](https://kaspa-mcp.kaspa-mcp.workers.dev/support)  
**Listing kit:** [docs/LISTING.md](docs/LISTING.md) · Logo: [`assets/logo.svg`](assets/logo.svg)



## Network choice

Before build/deploy, the connector asks **Testnet or mainnet?** (`choose_network`, persisted in KV). Testnet is the safe default. Mainnet shows an UNAUDITED warning. Guided self-host: `self_host` (includes `own_node` for your REST). Live fees: `estimate_fee`. Chat-deploy: TipJar / TimeoutVault / Escrow. Share: `/page/<id>`.

## Spending wallet (chat-deploy, any phone)

Self-host only: create a **dedicated** hot wallet (`spending_wallet_create`), fund it once, then tools sign+broadcast with `autoSignBroadcast` / `l1_tipjar_chat_deploy` — no wallet popup. Key stays in **your** env/file/Worker secret, never on the shared demo. Testnet is the default; mainnet needs `KASPA_SPENDING_MAINNET=1` + balance cap (default 50 KAS). Tap-to-approve remains available. Details: [docs/SPENDING_WALLET.md](docs/SPENDING_WALLET.md). Roadmap / deferred mobile paths: [docs/ROADMAP.md](docs/ROADMAP.md).

## Quick-start wallet (no extension)

Brand-new users (including iPhone Safari) can create a **Quick-start wallet** on the approve page: keys stay on device (passkey / PIN), 50 KAS cap, backup required on mainnet. Details: [docs/QUICKSTART_WALLET.md](docs/QUICKSTART_WALLET.md). Send KAS via `l1_prepare_send` or the on-page Send form.

## Tap to approve (one-tap signing)

Every `l1_prepare_fund`, `l1_prepare_spend`, `prepare_deploy`, and `prepare_call` response includes `tapToApprove.url` (e.g. `https://…/sign/<id>`).

1. Open the link on a phone or desktop with **KasWare** (L1) or an injected **EVM** wallet (Kasplex).
2. The page loads the stored unsigned tx (KV, ~15 min TTL) and shows a summary **derived from the transaction bytes** (amounts, fee, outputs) — not from agent-provided prose.
3. **Connect** → **Approve** → wallet popup signs → explorer link. The page never sees private keys.
4. L1: KasWare `requestAccounts` → `signPskt` → `pushTx` (verified against KasWare extension source). Kastle `signAndBroadcastTx` / `signTx` when injected. Spends with a pre-filled SilverScript unlock use `pushTx` only.
5. Strict CSP (`default-src 'none'; script-src 'self'`).

**Mainnet** shows an **UNAUDITED / USE AT YOUR OWN RISK** banner. Prefer testnet-10.

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

## Self-host (recommended for heavy use + no-popup chat-deploy)

**Free Cloudflare — no-popup path (your own capped spending wallet):**

```bash
git clone https://github.com/MikeyKaspa/kaspa-mcp && cd kaspa-mcp
npm install
npx wrangler login
npm run selfhost:setup
# optional wallet in one go:
# npm run selfhost:setup -- --create-wallet --main-address kaspatest:YOUR_ADDRESS
```

That deploys `wrangler.selfhost.toml` (never overwrites the public shared demo). Then paste the printed `…/mcp` URL into your AI app, fund the spending address from the [TN10 faucet](https://faucet-tn10.kaspanet.io/), and say “build me a tip jar”. Guided steps also live in the `self_host` MCP tool.

**Keyless copy only (tap-to-approve, no spending key):** use the **Deploy to Cloudflare** button above, or `npx wrangler deploy` with the default `wrangler.toml` (`MCP_PUBLIC=true`).

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

**Claude (claude.ai / Desktop / Cowork)** — one-click custom connector:

https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Kaspa%20MCP&connectorUrl=https%3A%2F%2Fkaspa-mcp.kaspa-mcp.workers.dev%2Fmcp

Or: Settings → Connectors → Add custom connector → paste the HTTPS URL above → **No sign-in** (shared demo is open). Claude’s cloud must reach the URL (public internet only; localhost will not work as a custom connector). See [remote MCP help](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

**Claude Desktop local server** — for `npm start` on your machine, bridge with stdio (Custom Connectors cannot see localhost):

```bash
# claude_desktop_config.json (mcp-remote speaks Streamable HTTP to your local server)
claude mcp add --transport http kaspa http://127.0.0.1:8787/mcp
# or: npx -y mcp-remote http://127.0.0.1:8787/mcp --transport http-only
```

**Cursor** — Settings → MCP → Add new MCP server → Type **URL** / Streamable HTTP → paste the demo URL (or your self-hosted `/mcp`). Or install the repo plugin (`.cursor-plugin/plugin.json` + `mcp.json`) when listed on the Cursor marketplace.

**Grok Bot** — Connect Apps → add remote MCP URL above (or install when listed). Marketplace kit: [docs/LISTING.md](docs/LISTING.md).

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
