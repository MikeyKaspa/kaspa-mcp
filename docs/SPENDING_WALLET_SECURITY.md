# Spending wallet — threat model & guarantees

## Goals

Let a user **chat-deploy** Kaspa L1 covenants on any phone without wallet popups,
while limiting blast radius if the **AI agent is prompt-injected** or the MCP
session is malicious.

## Where the key lives

| Location | Allowed? |
|----------|----------|
| User’s self-host Node env `KASPA_SPENDING_PRIVATE_KEY` | Yes |
| User’s local file `.kaspa-spending.key` (default) | Yes |
| User’s **own** Cloudflare Worker secret | Yes (their account) |
| Shared public demo Worker (`MCP_PUBLIC=true`) | **Never** — create/load/sign refused; env ignored |
| Chat / MCP tool responses after create | **Never** — no export tool; create does not echo key JSON |
| User’s main KasWare/Kaspium seed pasted into chat | **Rejected** — only freshly generated dedicated keys |

Backup: copy the local key file offline, or `wrangler secret put` **from that file**
on your account. There is no `spending_wallet_export_key` success path.

## Hard limits (code-enforced)

| Limit | Default | How changed |
|-------|---------|-------------|
| Mainnet balance cap | **50 KAS** | Deploy-time env `KASPA_SPENDING_MAX_KAS` may **lower** only (cannot exceed 50) |
| Per-tx cap | **50 KAS** mainnet / 500 tKAS testnet | `KASPA_SPENDING_MAX_TX_KAS` may lower within ceiling |
| Mainnet auto-sign | Off | `KASPA_SPENDING_MAINNET=1` at deploy |
| Chat `spending_wallet_set_limits` | Always refused | — |

## Allowlist (prompt-injection resistant)

The spending wallet **may**:

1. **Fund/deploy** only reviewed templates: `tipjar`, `timeout_vault`, `escrow`.
2. **Spend** only P2SH covenants recorded in `.kaspa-spending.registry.json` when this wallet funded them.
3. **withdraw_all** only to `mainAddress` locked at `spending_wallet_create`.

The spending wallet **may not**:

- Send P2PK to an arbitrary address (no destination parameter on withdraw).
- Auto-sign arbitrary bytecode / unknown templates.
- Spend a P2SH it did not register.
- Raise caps or export the key via chat tools.
- Operate on the shared demo, even if a secret is mis-set in that environment.

## What this cannot protect

| Threat | Reality |
|--------|---------|
| Compromised user device / disk | Attacker who can read `.kaspa-spending.key` or the process env owns the hot wallet |
| Compromised Cloudflare account | Attacker can read Worker secrets on **that** account |
| Compromised MCP host / laptop malware | Same as device compromise |
| User funds the spending address above the cap | Auto-sign stops until `withdraw_all`; funds can still sit on-chain until swept |
| Bugs in UNAUDITED SilverScript templates | Covenant logic risk remains — prefer testnet; tap-to-approve for large value |
| Social engineering to rotate mainAddress | Rotation requires deleting key+registry and re-creating (user must set a new mainAddress deliberately) |

## Shared demo invariant

`MCP_PUBLIC=true` ⇒ `loadSpendingPrivateKeyHex()` returns `null`; create / auto-sign /
withdraw_all throw. CI (`tests/spending-wallet-security.test.ts`) fails if shared-demo
mode can load a key or if create/status/export responses contain 32-byte key material.

## Related

- [SPENDING_WALLET.md](./SPENDING_WALLET.md) — operator setup
- [ROADMAP.md](./ROADMAP.md) — deferred mobile / WC paths
