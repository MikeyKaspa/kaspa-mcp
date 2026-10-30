# Security Policy

## Model

kaspa-mcp is **non-custodial**:

- Private keys, mnemonics, and keystores are never stored.
- **Mainnet / real-value networks:** any `privateKey` argument is rejected. Use `prepare_deploy` / `prepare_call`, sign in your own wallet, then `send_raw_transaction`.
- **Testnet only:** an optional per-call `privateKey` (0x-prefixed 32-byte hex) may be used for demos. It exists only in that request’s memory.
- The shared demo never holds user funds.

## Reporting

Open a [GitHub issue](https://github.com/MikeyKaspa/kaspa-mcp/issues) with `security` in the title, or contact the maintainers listed on the repo. Do not include mainnet keys or seed phrases in reports.

## Shared demo notes

- Rate limits use Cloudflare’s `CF-Connecting-IP` (not spoofable `X-Forwarded-For`).
- Optional `X-Kaspa-Demo-Key` gives a stable bucket behind NAT, with a secondary per-IP ceiling so key rotation cannot bypass limits.
- `compile_solidity` on Workers depends on solc preload at isolate startup; prefer self-hosting (`npm start`) for reliable compiles, or pass `bytecode` + `abi`.
