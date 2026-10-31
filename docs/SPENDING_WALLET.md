# Spending wallet (chat-deploy, self-host)

Users should be able to **chat and deploy** on any phone without wallet popups.
The legit MCP mechanism: a **dedicated spending wallet** whose key lives only on
**their** deployment (local env / file / their Cloudflare Worker secret) — never
on the shared demo Worker, never their main KasWare/Kaspium seed.

## What shipped

| Tool | Purpose |
|------|---------|
| `spending_wallet_create` | Requires `mainAddress`; generates key → local file only (not echoed in chat) |
| `spending_wallet_status` | Address, mainAddress, caps, covenant count — **never** the key |
| `spending_wallet_withdraw_all` | Sweep **only** to locked `mainAddress` (no destination arg) |
| `spending_wallet_export_key` / `set_limits` | Always refused (injection honeypots) |
| `l1_tipjar_chat_deploy` | Allowlisted TipJar → fund → registry |
| `autoSignBroadcast` | Reviewed `templateId` only; spend only registered covenants |

Tap-to-approve (`tapToApprove.url`) remains the default non-custodial path.

## Setup (Node self-host — required for L1 auto-sign)

Free Cloudflare Workers cannot load Node `kaspa-wasm`, so **L1 auto-sign needs `npm start` (or equivalent Node)**. Worker secrets are fine for storing the key on *your* account, but chat-deploy signing today runs where wasm works.

```bash
git clone https://github.com/MikeyKaspa/kaspa-mcp && cd kaspa-mcp
npm install && npm test
# Optional: SILVERC_PATH=/path/to/silverc for TipJar owner compile
npm start   # http://127.0.0.1:8787/mcp
```

In chat: `spending_wallet_create` → fund the address (TN10 faucet) → `l1_tipjar_chat_deploy`.

Env:

| Var | Meaning |
|-----|---------|
| `KASPA_SPENDING_PRIVATE_KEY` | `0x` + 64 hex (preferred in prod) |
| `KASPA_SPENDING_WALLET_PATH` | Key file (default `.kaspa-spending.key`) |
| `KASPA_SPENDING_MAINNET` | Must be `1` to auto-sign on mainnet |
| `KASPA_SPENDING_MAX_KAS` | Mainnet balance cap (default **50**) |
| `MCP_PUBLIC=true` | Shared demo — **refuses** create/auto-sign |

```bash
# YOUR Cloudflare account only (not the shared demo):
printf '%s' '0x…' | npx wrangler secret put KASPA_SPENDING_PRIVATE_KEY
```

## Testnet vs mainnet

- **Testnet-10:** zero-friction default once the spending wallet is funded.
- **Mainnet:** loud warning; `KASPA_SPENDING_MAINNET=1`; balance must stay ≤ cap; still prefer tap-to-approve for real value.

## MCP client local-signing?

Claude / Cursor / Grok do **not** expose a built-in Kaspa signer for tool results.
Returning an unsigned tx for the *client* to sign is not realistic today unless the
user runs a local helper. Self-host spending wallet (server-side dedicated key) is
the workable path; client-side signing is listed on the roadmap.

## Security

- Never paste a main wallet mnemonic/key into chat.
- Fund only what you can lose on the spending address.
- Do not commit `.kaspa-spending.key`.
- Shared demo at `kaspa-mcp.workers.dev` will not create or use a spending wallet.

## Security
See [SPENDING_WALLET_SECURITY.md](./SPENDING_WALLET_SECURITY.md) for threat model, caps, and allowlist.
