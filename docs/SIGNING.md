# One-tap `/sign/<id>` flow

## Storage
- Worker: Cloudflare KV `SIGN_SESSIONS` (free), per-key `expirationTtl` ≈ 15 minutes.
- Node: in-memory store (`SIGN_PUBLIC_BASE_URL` for link host).

## Payload
Never includes private keys. Holds SafeJSON and/or EVM unsigned fields + network metadata.


## Shared Worker (free tier) — browser build
Workers cannot ship Node `kaspa-wasm` in the script. The web build is served from
`/kaspa-wasm/*` as static assets (~11 MiB wasm; assets do not count toward script
size; per-file limit 25 MiB). `l1_prepare_fund` / `l1_prepare_spend` store
`l1Build` (params + bytecode + UTXO API base) in the sign session and return a
tap link (`mode: browser_build`). The page (`/sign/l1-build.js`) fetches UTXOs
from api.kaspa.org / api-tn10.kaspa.org, runs `createTransactions` / P2SH / unlock
assembly in-browser, shows a summary derived from the built SafeJSON, then
KasWare `signPskt` → `pushTx`.

CSP on `/sign` includes `'unsafe-eval'` because official kaspa-wasm web glue uses
`new Function` (wasm-bindgen); `'wasm-unsafe-eval'` alone is insufficient. Same
wasm lineage as KasWare — preferred over a hand-rolled pure-JS builder.

Playwright harness: `scripts/e2e-sign-browser.mjs` (mocks `window.kasware` with
operator TN10 key; never prints secrets).

## Summary trust model
`/api/sign/:id` re-derives the human summary with `summarizeL1SafeJson` / `summarizeEvmPrepared` from the stored tx. Agent text cannot mislabel amounts.

## KasWare (source-checked)
- `requestAccounts` — docs + `pageProvider/index.ts`
- `signPskt({ txJsonString, options })` — `wallet.ts` deserializeFromSafeJSON → walletSignTransaction → serializeToSafeJSON
- `pushTx(txJsonString)` — deserializeFromSafeJSON → submit

## Kastle
- Docs: `signAndBroadcastTx`, `signTx` (kas:sign_tx). Detected via `window.kastle` when present.
- SilverScript P2SH unlock still must be pre-filled for spends (same as KasWare).

## Needs Michael’s real wallet
- End-to-end Approve on phone (KasWare mobile / in-app browser) for TN10 fund.
- Kastle path on a device with Kastle installed.
- Mainnet Approve (optional, after he’s happy with TN10) — prepare-only connector; he signs in wallet.
