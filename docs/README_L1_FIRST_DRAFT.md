# kaspa-mcp (L1-first draft)

**Primary:** native Kaspa L1 SilverScript covenants (Toccata).  
**Secondary:** Kasplex / Igra EVM Solidity.  
**Upcoming:** KCC-20 helpers (not shipped yet).

MIT · Non-custodial · Designed for **$0** (public RPCs + free TN10 faucet).

> This file is the Phase-2 README draft on branch `feature/l1-silverscript-phase2`.  
> Main README on `main` is unchanged until merge is approved. No public Worker redeploy from this branch by default.

## Shared demo limits

- **No SilverScript compile on Workers** (no official WASM `silverc`; Workers also block `eval` for solc).  
  Use **`silverscript_templates`** or paste an artifact into **`silverscript_load_artifact`**.  
  Arbitrary `.sil` → self-host Node + `silverc` (`silverscript_compile`).
- Existing request / compile rate limits still apply on the shared demo account.

## L1 flow (testnet-10)

1. `silverscript_templates` → pick TipJar / TimeoutVault / Escrow (or compile your own with silverc v1.0.0).
2. `l1_derive_p2sh` → P2SH address.
3. `l1_prepare_fund` → send KAS to that address (**that is the deploy**).
4. `l1_prepare_spend` → SafeJSON / signed testnet unlock → **KasWare** `signPskt` / `pushPskt` first.

Mainnet L1 write helpers stay **off** until templates pass **kaspa-redteam** and `KASPA_L1_MAINNET_WRITES=1` is set after owner approval.

## Wallet

Prefer **KasWare** PSKT (`signPskt` / `pushPskt`). See KasWare transaction docs. Kastle deposit support exists in Studio; signing support varies.

## Safety

SilverScript tooling is **pre-audit**. Run `kaspa-redteam` on contracts before mainnet value. Never paste mainnet private keys into this connector.

## Self-host

```bash
npm install
# install silverc v1.0.0 onto PATH or export SILVERC_PATH=...
npm test
npm start   # http://127.0.0.1:8787/mcp
```


## TN10 explorer / API

- Explorer: https://tn10.kaspa.stream/transactions/<txid> (explorer-tn10.kaspa.org was returning 402)
- API: https://api-tn10.kaspa.org

## Phase 2 TN10 e2e (recorded)

See `docs/E2E_TN10_RESULTS.json`. TipJar, TimeoutVault, and Escrow each funded + spent successfully.
