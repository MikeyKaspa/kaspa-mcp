# One-tap `/sign/<id>` flow

## Storage
- Worker: Cloudflare KV `SIGN_SESSIONS` (free), per-key `expirationTtl` ≈ 15 minutes.
- Node: in-memory store (`SIGN_PUBLIC_BASE_URL` for link host).

## Payload
Never includes private keys. Holds SafeJSON and/or EVM unsigned fields + network metadata.

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
