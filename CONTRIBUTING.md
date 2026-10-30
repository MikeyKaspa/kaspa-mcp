# Contributing

Thanks for helping improve kaspa-mcp.

## Setup

```bash
npm install
npm test
npm start   # http://127.0.0.1:8787/mcp
```

## Guidelines

- Keep the connector **non-custodial** and **$0 by default** (public RPCs + free testnet faucets).
- Do not commit keys, wallets, `.env`, or operator scripts.
- Prefer small PRs with tests for safety-sensitive paths (`src/safety.ts`, rate limits, deploy).
- Free Cloudflare Workers only in docs/examples — no paid-plan assumptions.

## PR checklist

- [ ] `npm test` and `npm run typecheck` pass
- [ ] No secrets in the diff
- [ ] README / SECURITY updated if behavior changed
