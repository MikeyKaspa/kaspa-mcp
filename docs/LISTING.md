# Marketplace listing kit (do not auto-submit)

Materials for listing **kaspa-mcp** on Grok Bot / Cursor marketplaces.  
**Do not submit** until a human approves. Contact for forms: `michaelhale9019@gmail.com`.

## One-liner (≤200 chars)

Build and deploy on Kaspa from chat: tip jars, vaults, escrow, and all-or-nothing crowdfunds. Non-custodial; shared demo is keyless; tap-to-approve in your wallet.

## Short description

kaspa-mcp is an open-source MCP connector for Kaspa. Connect Claude, Cursor, or Grok Bot, pick testnet or mainnet, and build L1 SilverScript products (tip jar, timeout vault, escrow, lockbox, crowdfund) plus Kasplex/Igra EVM helpers. The shared demo never holds keys — you approve spends in KasWare (or self-host a capped spending wallet on your own Worker). Prefer testnet. Software is UNAUDITED.

## MCP URL

```
https://kaspa-mcp.kaspa-mcp.workers.dev/mcp
```

## Legal / support

| Page | URL |
|------|-----|
| Privacy | https://kaspa-mcp.kaspa-mcp.workers.dev/privacy |
| Terms | https://kaspa-mcp.kaspa-mcp.workers.dev/terms |
| Support | https://kaspa-mcp.kaspa-mcp.workers.dev/support |
| Logo (SVG) | https://kaspa-mcp.kaspa-mcp.workers.dev/brand/logo.svg |
| Logo (PNG) | https://kaspa-mcp.kaspa-mcp.workers.dev/brand/logo.png |
| Docs / source | https://github.com/MikeyKaspa/kaspa-mcp |
| Health | https://kaspa-mcp.kaspa-mcp.workers.dev/health |

## Three demo prompts (reviewer)

1. **Tip jar (testnet):** “Connect to Kaspa on testnet. Build me a tip jar owned by `kaspatest:REVIEWER_ADDRESS`. Give me the one-tap approve link and the share page.”
2. **Crowdfund:** “Create an all-or-nothing crowdfund for 5 test KAS, deadline in 2 days, owner `kaspatest:REVIEWER_ADDRESS`. Show the campaign page and how a backer pledges.”
3. **Version / self-host:** “What version is this connector? How do I deploy my own free Cloudflare copy so I don’t hit the shared demo limits?”

## Reviewer testnet steps

1. Install KasWare (or another Kaspa testnet wallet). Create/import a **testnet** address (`kaspatest:`…).
2. Claim free test KAS from https://faucet-tn10.kaspanet.io/ (user clicks faucet; bots should not trigger anti-bot).
3. Add the MCP URL above as a custom connector / HTTP MCP (no sign-in on the shared demo).
4. Run demo prompt 1 → open `tapToApprove.url` → Connect → Approve → confirm explorer link.
5. Run demo prompt 2 → open `/campaign/…` → Pledge with one tap → check `campaign_status`.
6. Confirm `/privacy`, `/terms`, `/support` load. Confirm `/health` shows `ok: true`.

**Notes for reviewers:** Campaign status tracks **registered** pledges (MCP/API/one-tap), not arbitrary chain sends. Mainnet is prepare-only + wallet approve; templates are UNAUDITED.

## Grok Bot form field draft (`https://x.ai/bot/marketplace/submit-a-plugin`)

| Field | Value |
|-------|--------|
| Name | kaspa-mcp |
| Work email | michaelhale9019@gmail.com |
| Organization name | MikeyKaspa / kaspa-mcp |
| Organization handle | mikeykaspa |
| Logo URL | https://kaspa-mcp.kaspa-mcp.workers.dev/brand/logo.png |
| Where to list | Grok Bot, Cursor |
| Server or repo | https://kaspa-mcp.kaspa-mcp.workers.dev/mcp **or** https://github.com/MikeyKaspa/kaspa-mcp |
| Short description | Build and deploy on Kaspa from chat: tip jars, vaults, escrow, crowdfunds. Non-custodial tap-to-approve; shared demo is keyless. Prefer testnet. |
| Testing instructions | See “Reviewer testnet steps” above. Faucet: https://faucet-tn10.kaspanet.io/ . No secrets in repo. |
| Testing confirmation | Confirm after local + in-app test before submit |

## Cursor marketplace

Repo already includes `.cursor-plugin/plugin.json` + root `mcp.json`. Submit at https://cursor.com/marketplace/publish with the public GitHub URL when approved.
