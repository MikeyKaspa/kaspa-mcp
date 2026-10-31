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

## Setup (Cloudflare Worker — free tier, pure-JS signer)

Free Workers cannot load Node `kaspa-wasm`. This repo ships a **pure-JS L1 signer**
(`src/l1/pure`) so auto-sign + tipjar chat-deploy run on **your** free Worker.

```bash
git clone https://github.com/MikeyKaspa/kaspa-mcp && cd kaspa-mcp
npm install && npm test
# One-click: use the Deploy to Cloudflare button in README, OR:
npx wrangler deploy -c wrangler.selfhost.toml   # separate name from shared demo
```

In chat against **your** Worker MCP URL:

1. `spending_wallet_create({ mainAddress: "kaspatest:…" })` — returns address + **one-shot** `privateKeyHex`
2. Set the secret (never commit / never paste into shared demo):
   `printf '%s' '0x…' | npx wrangler secret put KASPA_SPENDING_PRIVATE_KEY -c wrangler.selfhost.toml`
3. Fund the spending address (TN10 faucet)
4. `l1_tipjar_chat_deploy` or `l1_prepare_fund` with `autoSignBroadcast: true` + reviewed `templateId`

### Node self-host (optional)

```bash
npm start   # http://127.0.0.1:8787/mcp — key file persist, optional SILVERC_PATH
```

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

## Cloudflare Worker self-host (pure-JS signer)

Free Workers cannot load Node `kaspa-wasm`. This repo ships a **pure-JS L1 signer**
(`src/l1/pure`) — Blake2b TransactionSigningHash + Schnorr (`@noble/curves`) + P2SH wrap —
differential-tested against kaspa-wasm.

```bash
# Separate worker name (do not overwrite the shared demo):
npx wrangler deploy -c wrangler.selfhost.toml
# In chat on THAT worker: spending_wallet_create({ mainAddress })
# Copy the one-shot key → set secret on YOUR account:
printf '%s' '0xYOUR_KEY' | npx wrangler secret put KASPA_SPENDING_PRIVATE_KEY -c wrangler.selfhost.toml
```

Shared demo (`MCP_PUBLIC=true`) never loads a spending key.
