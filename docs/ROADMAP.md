# Roadmap / deferred options

Built now: **self-host spending wallet** (chat-deploy, allowlist + withdraw_all + hard caps) — see
[SPENDING_WALLET.md](./SPENDING_WALLET.md). Everything below is deferred or blocked
on upstream / hardware. Agents should keep proposing these without waiting to be asked.

## Deferred signing / mobile UX

| Item | Status | Why deferred |
|------|--------|--------------|
| **iPhone KasWare Telegram Mini App handoff** | Blocked | No primary-source proof Mini App injects `window.kasware` into third-party URLs or accepts `startapp` PSKT. See [IPHONE_SIGNING_PATHS.md](./IPHONE_SIGNING_PATHS.md). Ask KasWare for open-dapp / Connect. |
| **Our Telegram Mini App wrapper for `/sign`** | Blocked | Wrapper can show UI; cannot get KasWare signatures without a published handoff (TON Connect still “coming soon” on KasWare). |
| **KasSigner PSKB / KSPT QR scan-to-sign** | Feasible with hardware | Needs KasSigner device (+ KasSee). KaChat cold-storage ≠ arbitrary `/sign` QRs. Build when hardware available for e2e. |
| **Kaspire WalletConnect (Reown ID)** | Research | Prove Kaspire WC session can sign Kaspa PSKT / covenant unlock; wire Reown project id for self-hosters. |
| **Kastle / Kaspire deeper mobile deep links** | Research | Universal links into approve flows if apps document them. |
| **Client-side MCP signing** (Claude/Cursor/Grok holds key) | Unrealistic today | Clients don’t run Kaspa signers on tool results. Revisit if a client adds a signing extension / local helper protocol. |

## Deferred self-host / platform

| Item | Status | Notes |
|------|--------|-------|
| **`self_host` guided tool** | Deferred | One-shot MCP tool that prints Deploy-to-Cloudflare + `wrangler secret put` + MCP URL checklist (no remote deploy from shared demo). |
| **Worker L1 auto-sign via web wasm assets** | Deferred | Free Workers can’t load Node wasm; investigate instantiating `/kaspa-wasm` inside the Worker for spending-wallet broadcast without Node. |
| **One-click CF deploy that sets spending secret** | Partial | Button deploys code; secret still needs `wrangler secret put` on the user’s account (Cloudflare won’t let a public demo write their secrets). |
| **Compile on Worker (solc / silverc)** | Blocked | `eval` / no official WASM silverc on free Workers. |

## Other UX gaps (proactive)

1. **Faucet reliability** — TN10 faucet + Kasplex bridge often flaky; document fallbacks; optional “fund me” using operator tipjar only in private self-host.
2. **UTXO wait helper** — `l1_wait_utxo` tool so chat-deploy doesn’t race after fund.
3. **Plain-English fee / storage-mass warnings** before broadcast (avoid dust traps).
4. **Session resume** — spending wallet status in `kaspa_ideas` / overview so agents discover chat-deploy without tribal knowledge.
5. **Multi-network spending wallet** — separate keys for L1 vs Kasplex EVM hot wallet.
6. **Rate-limit / 1027 UX** — clearer “self-host now” card when shared demo hits free-tier caps.
7. **Template constructor wizard** — pass owner pubkey without raw silverc JSON for TimeoutVault/Escrow chat-deploy.
8. **Explorer links + receipt resource** after every auto-broadcast.
9. **Hardware wallet path** (Ledger via KasWare) still tap-to-approve only.
10. **Audited templates** — third-party review before recommending mainnet spending wallet.

## Principles

- Never require users’ main wallet keys in chat.
- Shared demo stays prepare + tap-to-approve only.
- Prefer shipping honest “not yet” over fake deep links.
- Keep proposing mobile + self-host improvements unprompted when gaps appear.
