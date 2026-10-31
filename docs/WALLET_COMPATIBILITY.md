# Kaspa wallet compatibility — tap-to-approve `/sign`

Primary-source matrix for funding a P2SH covenant and spending it (SilverScript unlock:
schnorr **transaction sighash** + redeem). Updated 2026-10-30.

Legend: **Fund** = sign P2PK inputs of a SafeJSON (or sendKaspa to P2SH).  
**Spend** = produce a Schnorr signature over the P2SH input sighash so the page can wrap
`pk`+`sig`+dispatch+redeem and broadcast. `signMessage` (arbitrary text) is **not** enough.

| Wallet | Platforms | dApp connection | Fund | Covenant spend | Testnet | Status |
|--------|-----------|-----------------|------|----------------|---------|--------|
| **KasWare** extension | Chrome/Chromium desktop | Injected `window.kasware` | Yes — `signPskt`→`pushTx` | Yes — `signPskt` (sighash) → page wraps unlock → `pushTx` ([wallet.ts](https://github.com/kasware-wallet/extension) `signPskt` ~824–901; docs [kaspa-transaction](https://docs.kasware.xyz/wallet/developer-documentation/kaspa/kaspa-transaction)) | Yes (`kaspa_testnet_10`) | **Supported** |
| **KasWare** Android APK | Android | In-app / injected provider (same API) | Yes (same) | Yes (same) | Yes | **Supported** (no iOS app — [docs](https://docs.kasware.xyz/wallet)) |
| **KasWare** Telegram Mini App | iOS/Android via Telegram | `t.me/KasWare_bot` | Unknown for *arbitrary* HTTPS origins | Unknown — docs describe Mini App as a wallet surface; integration API examples assume browser injection ([docs](https://docs.kasware.xyz/wallet)) | Likely | **Not verified** — no public cite that Mini App injects `window.kasware` into third-party `/sign` URLs |
| **Kastle** extension | Chrome | Injected `window.kastle` | Yes — `signAndBroadcastTx` / `signTx` ([API](https://docs.kastle.cc/readme/how-to-integrate/kastle-wallet-api)) | Yes* — `signTx(networkId, txJson, scripts?)` with custom script for P2SH; page wraps SilverScript unlock then submits via wasm RPC if no `pushTx` | Yes (`testnet-10`) | **Supported** (extension) |
| **Kastle** mobile | iOS App Store, Android | **No** in-app browser yet; WalletConnect mobile “in progress” ([FAQ](https://docs.kastle.cc/kastle-wallet-help-center/faqs)) | API exists on mobile ≥1.19.0 but web page in Safari does **not** get `window.kastle` | Same blocker | Yes (faucet docs) | **Impossible today from Safari** — waiting on in-app browser / mobile WC |
| **Kaspire** extension | Chrome | `window.kaspire` `signPskt` ([devs](https://kaspire.kaslab.space/developers/extension)) | Yes | Yes — `signPskt` then dApp `pushTx` | Yes (`kaspa:testnet-10` in WC docs) | **Supported** when extension present |
| **Kaspire** Mobile | **Android only** | WalletConnect v2 `kaspa_signPskt` ([devs](https://kaspire.kaslab.space/developers)) | Yes | Yes | Yes | **Supported** (Android WC) — needs Reown project ID; **not iOS** |
| **Kasanova** | iOS App Store, Android | Deeplink `kasanova://open-dapp?url=` + WebView inject | `sendKaspa` yes | **`signPsbt` / `pushTx` throw — not implemented** ([npm `@kasanovaio/dapp-sdk`](https://www.npmjs.com/package/@kasanovaio/dapp-sdk)); dApp browser “not yet available in production” ([docs 0.8.0](https://docs.kasanova.app/exchange-and-tools/using-dapps)) | `kaspa_testnet` | **Impossible for covenant spend until they ship `signPskt`** |
| **Kaspium** | iOS + Android ([App Store](https://apps.apple.com/us/app/kaspium/id1671845538), [GitHub](https://github.com/azbuky/kaspium_wallet)) | None — native send / **text** `signMessage` only (v1.3.0 notes) | No web/dApp path | **No** — no PSKT, no WC, no WebView provider (source has no walletconnect/pskt) | Manual node / mainnet-focused | **Impossible** for our `/sign` page |
| **KaChat** / **KaPay** | KaChat iOS App Store; KaPay TestFlight ([home.kachat.app](https://home.kachat.app/)) | None for third-party dApps — native chat payments + Cold Storage via **KasSigner** QR for *their* send flow | No | **No** — no injected provider / WC for arbitrary SafeJSON | N/A | **Impossible** for our `/sign` page |
| **Tangem** | iOS + Android | WalletConnect (Igra / EVM-style dApps; [help](https://tangem.com/en/help-center/tangem-dapps/)) | Unclear for Kaspa L1 SafeJSON | **No public Kaspa L1 `kaspa_signPskt` cite** for Tangem; Igra WC is L2 | — | **Impossible / unproven** for SilverScript L1 spend |
| **Ledger + KasVault** | Desktop Chrome/Edge + Ledger; BT on some devices ([kasvault.io](https://kasvault.io/), [Ledger guide](https://support.ledger.com/article/Connect-your-Ledger-device-to-KasVault-Web-App)) | KasVault’s **own** send UI only | Via KasVault send-to-address only | **No** — KasVault does not expose PSKT signing to third-party dApps | Limited | **Impossible** for our `/sign` covenant spend |
| **KasSigner + KasSee** | Hardware + web companion ([kassigner.org](https://kassigner.org/)) | Air-gap PSKB QR (not a browser inject) | Possible via PSKB | Possible for covenants in KasSee’s own tools; **not** wired into our Worker `/sign` yet | TN tools exist | **Fallback candidate** (PSKB QR) — not implemented here |
| **Kurncy** | iOS App Store | No public dApp/PSKT docs found | Unknown | Unknown | — | **Unknown / treat as impossible** until docs appear |
| **Zelcore** | Multi-platform | Multi-asset; no Kaspa PSKT dApp cite found for covenants | Unknown | Unknown | — | **Unknown / treat as impossible** |

## Michael’s iPhone (Kaspium + KaChat)

Neither can connect to `https://kaspa-mcp…/sign/…` and sign a fund or covenant spend.  
**Best real options for him today:** (1) desktop/Android **KasWare** or **Kastle** extension, (2) wait for **Kastle** iOS in-app browser or **Kasanova** `signPskt`, (3) future **KasSigner PSKB** QR from this page.

## Quick-start wallet (this page)

| | Fund | Spend | Send | iPhone Safari |
|--|------|-------|------|---------------|
| **Quick-start** (passkey/PIN, IndexedDB) | Yes | Yes | Yes | **Yes** |

Keys never leave the device. 50 KAS cap. See [QUICKSTART_WALLET.md](./QUICKSTART_WALLET.md).

## What this page implements

| Provider detected | Fund | Spend |
|-------------------|------|-------|
| Quick-start (on-page) | sign in-page → push | sign → unlock wrap → push |
| `window.kasware` | `signPskt` → `pushTx` | `signPskt` → `finalizeCovenantSpend` → `pushTx` |
| `window.kastle` | `signAndBroadcastTx` | `signTx` → finalize unlock → wasm `RpcClient.submitTransaction` |
| `window.kaspire` | `signPskt` → `pushTx` (or request bridge) | same pattern as KasWare |


## iPhone deep-dive
See [IPHONE_SIGNING_PATHS.md](./IPHONE_SIGNING_PATHS.md) (KasWare Mini App, our TMA wrapper, KasSigner PSKB).
