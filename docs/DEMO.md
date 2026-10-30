# kaspa-mcp demo transcript (local Anvil)

**Date:** 2026-10-30 (America/Phoenix)  
**Cost:** $0 — local Anvil + local MCP HTTP. Nothing published. No mainnet.  
**Why local:** Kasplex public faucets were down or empty at the time of this run (KaspaFinance queue empty; faucet.kasplextest.xyz unreachable). Live Kasplex deploy blocked until free test KAS is available.

## Setup

- Anvil `1.8.7` with `--chain-id 167012` on `http://127.0.0.1:8545` (plain; fork of `rpc.kasplextest.xyz` timed out from this box)
- MCP server: `npx tsx src/node-server.ts` → `http://127.0.0.1:8787/mcp`
- Network id in connector: `local-anvil`
- Deployer: Anvil account #0 `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` (well-known local test key only)

## MCP tool flow (all over Streamable HTTP)

1. **`kaspa_ideas`** — theme *community tip jar for Kaspa builders* → recommended EVM on Kasplex/Igra; listed `local-anvil` among testnets.
2. **`list_networks`** (`kind=evm`, `testnetOnly`) — returned local-anvil, kasplex-testnet, igra-galleon-testnet.
3. **`verify_rpc`** `local-anvil` → `ok: true`, chainId **167012**.
4. **`get_balance`** anvil#0 → **10000 KAS** (prefunded).
5. **`compile_solidity`** `examples/CommunityTipJar.sol` → `CommunityTipJar`, solc 0.8.38.
6. **`deploy_contract`** → success.
7. **`read_contract`** `owner()` → anvil#0.
8. **`read_contract`** `totalTips()` before → `0`.
9. **`prepare_call`** `tip("Ship it for the Kaspa community")` value 1 KAS → unsigned call prepared.
10. Tip broadcast (ethers, same calldata path) → success.
11. **`read_contract`** `totalTips()` after → `1000000000000000000` (1e18).
12. **`read_contract`** `tipsOf(anvil#0)` → `1000000000000000000`.

## Results

| Field | Value |
|-------|-------|
| Contract | `CommunityTipJar` |
| Address | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| Deploy tx | `0x8b9c48ac1065ce1fb8314ffff97f78b03d8922b96de58d545751644980613baf` |
| Tip tx | `0x5ef623d3aa8a3ebcb15e2c624b5d13f60d1ae6036ebcd983544f1d1dd33b4c24` |
| `totalTips` after | 1 KAS (1e18 wei) |
| Explorer | n/a (local chain) |

## Reproduce

```bash
export PATH="$PATH:$HOME/.foundry/bin"
anvil --chain-id 167012 --port 8545 &
cd /workspace/kaspa-mcp && npm start &
# then drive MCP tools as in scripts / this transcript
```

## Not done on public testnet (this run)

- Kasplex live deploy: faucets dry/broken.
- Igra live deploy: throwaway `0x8d3c72145205518Dd8fAc22B3c45d3992a5edd88` balance on Galleon explorer API = **0**; Igra RPC TLS still unreachable from this box.

## Igra status (throwaway e2e wallet)

- Address: `0x8d3c72145205518Dd8fAc22B3c45d3992a5edd88`
- Galleon explorer `account/balance` API: **`0`**
- v2 address `coin_balance`: null / empty account
- Earlier faucet API returned daily-limit / tx-failed; **no funds credited**
- Igra RPC `https://galleon-testnet.igralabs.com:8545` still TLS-unreachable from this box → no live Igra deploy

## Other free Kasplex testnet funding routes

### A. Official / documented L2 faucets (currently failing)

1. https://faucet.kasplextest.xyz/ — official Kasplex docs faucet (often TLS/down).
2. https://app.kaspafinance.io/faucets — community Kasplex faucet (reCAPTCHA; often “no available queue”).

### B. Free path via Kaspa L1 testnet-10 + Kurve test bridge (best remaining $0 option)

1. Install a Kaspa L1 wallet that Kurve supports (Kasperia / Kasware / Kastle).
2. Get free **tKAS** from the official L1 faucet: https://faucet-tn10.kaspanet.io/ (paste L1 address).
3. Open the **Kurve test bridge**: https://kasbridge-tn10evm.kaspafoundation.org/
4. Connect L1 wallet → destination **Kasplex** → paste your EVM address (e.g. MetaMask on Kasplex testnet RPC `https://rpc.kasplextest.xyz`, chain id `167012`).
5. Bridge a small amount (docs cite ~1 KAS minimum on main Kurve; test portal may match — use whatever the UI allows). Arrival ~1 minute.
6. Re-run: `cd /workspace/kaspa-mcp && npm run e2e:testnet`

Sources: [Kurve-Test portal](https://kasbridge-tn10evm.kaspafoundation.org/), [Kurve tutorial](https://kaspafoundation.gitbook.io/kurve-docs/userguide/editor), [tn10 faucet](https://faucet-tn10.kaspanet.io/).

### C. Community asks (no guaranteed faucet bot found)

1. Telegram **Kasplex Official**: https://t.me/kasplex_official — ask in chat for testnet KAS / working faucet.
2. X: https://x.com/kasplex — check pinned/replies for faucet status.
3. No dedicated public Kasplex Discord faucet bot was found in this pass.

### D. Not Kasplex L2 (don’t confuse)

- https://faucet.zealousswap.com/ — currently framed as **Igra iKAS** faucet (captcha / often paused), not Kasplex KAS.
- https://faucet.igralabs.com — Igra only (API; $0 testnet).
- https://faucet-tn10.kaspanet.io/ — Kaspa **L1** tKAS only (useful as step B.2, not L2 by itself).
