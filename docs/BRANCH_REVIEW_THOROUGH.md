# Branch review — feature/l1-silverscript-phase2 (thorough pass)

America/Phoenix local work; explorer links use https://tn10.kaspa.stream/transactions/<txid>.

## Claims vs primary sources

| Claim | Verdict | Source |
|-------|---------|--------|
| Fund SafeJSON is KasWare `signPskt` input | **Verified** | docs.kasware.xyz …/kaspa-transaction; example PSKT shape matches our `serializeToSafeJSON` (inputs+utxo+empty signatureScript; outputs value+scriptPublicKey). Round-trip `deserializeFromSafeJSON` in prepareFund. |
| `signPskt` → deserialize → sign → serialize | **Verified** | kasware-wallet/extension `wallet.ts` `signPskt` (lines ~824–901) |
| `pushTx` broadcasts SafeJSON | **Verified** | same file `pushTx` (~908–910) |
| `pushPskt` | **Docs only** | Documented on docs.kasware.xyz; **not** present in extension `main` source as of 2026-10-30. Prefer `signPskt`+`pushTx`. |
| `sendKaspa` can fund a P2SH | **Plausible** | Docs: send to any address + auto UTXO/fee/change. Simpler UX for plain fund; prepareFund still needed for explicit SafeJSON / multi-input visibility. |
| SilverScript unlock not filled by `signPskt` | **Verified by design** | Docs: wallet only signs inputs belonging to account pubkey. P2SH covenant unlock must be pre-filled → `pushTx`. |
| Dispatch tags 4-byte hex | **Verified** | silverc artifacts: tipjar withdraw `e36d1915`; vault timeout `bcce79af` / transfer `de5ac30f`; escrow spend tag in artifact. |
| Fee/mass via createTransactions | **Verified on TN10** | Fund fees ~336500 sompi; spend fee 300000 sompi accepted. MIN_FUND_SOMPI=1e7 (0.1 KAS) blocks dust. |
| Address prefixes | **Verified** | `assertAddressNetwork`: `kaspatest:` TN10, `kaspa:` mainnet. |
| Mainnet gate | **Verified** | `assertL1NetworkWritable` + MCP call without `KASPA_L1_MAINNET_WRITES` → gated error. Cannot bypass by omitting env. |
| Rate limit on silverscript_compile | **Verified** | `rate-limit.ts` treats it like compile. |
| Secrets never logged | **Reviewed** | No `console.log` of privateKey; e2e loads key from file, never prints. |
| Worker bundle | **Verified dry-run** | `wrangler deploy --dry-run`: Upload 2151.68 KiB / gzip 416.81 KiB (under ~3 MiB free limit). |
| kaspa-wasm on Workers | **Fails (documented)** | vendor Node build uses `__dirname`+`kaspa_bg.wasm`; Workers get clear self-host error. Templates + load_artifact still work. |

## Unverifiable / residual

- Live KasWare extension UI against our SafeJSON (no browser wallet in this pass) — format match is from docs+source+round-trip, not a signed KasWare popup.
- `pushPskt` implementation (docs ≠ open source main).
- Exact storage-mass constant table from rusty-kaspa (we use empirical MIN_FUND + createTransactions).
- Full cargo kaspa-redteam on all templates (browser API scan previously 0 findings; local rustc path was blocked).
- Pathological “many dust UTXOs” broadcast (selection-only tested).

## Remaining risks

1. **Workers cannot run prepare/fund/spend/derive** until a web wasm build is vendored — agents on shared demo must self-host Node for those tools.
2. **Kaspa txid excludes signature scripts** — rejected unlock and successful retry share an explorer id; rely on RPC error text for fail proofs.
3. **Mainnet still gated** — do not enable `KASPA_L1_MAINNET_WRITES` until redteam + Michael OK.
4. **Fee estimates** depend on createTransactions / network feerate; spikes could underpay if priorityFee=0 and mass rises.
5. **Pinned template artifacts** use demo key `0x…01` — not for real value.
6. **Escrow minerFee baked at 300000** — if network min fee rises, spends need template rebuild.
