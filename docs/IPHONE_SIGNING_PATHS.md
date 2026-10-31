# iPhone signing paths — research (2026-10-30)

Goal: let iPhone users approve `/sign/<id>` fund + SilverScript P2SH spend without
Chrome/Android. Investigated (1) KasWare Telegram Mini App, (2) our own Mini App
wrapper + handoff, (3) KasSigner / PSKB QR. **None are clearly feasible + verifiable
for our connector today** without KasWare or KasSigner product work. Do not ship
deeplinks that pretend otherwise.

---

## 1) KasWare Telegram Mini App (`t.me/KasWare_bot`)

### What official sources say

| Claim | Source | Result |
|-------|--------|--------|
| Mini App exists; no install | [docs.kasware.xyz/wallet](https://docs.kasware.xyz/wallet) | Confirmed — link `https://t.me/KasWare_bot` |
| Developer Kaspa API (`window.kasware`, `signPskt`, …) | [Kaspa Integration](https://docs.kasware.xyz/wallet/developer-documentation/kaspa) | Documented for **browser extension**: “new browser tabs have a `window.kasware` object” |
| Mini App injects `window.kasware` into **third-party HTTPS** pages | — | **No cite found** in KasWare docs |
| Mini App in-app browser / “open dApp URL” | — | **No cite found** |
| `startapp` / deep link that loads an external dApp for signing | Telegram generic: [core.telegram.org/bots/webapps](https://core.telegram.org/bots/webapps) | Telegram passes `startapp` → `start_param` / `tgWebAppStartParam` into **that bot’s own** Mini App URL (BotFather-configured). KasWare docs **never** document interpreting `startapp` as “open this dApp” or “sign this PSKT” |
| TON-Connect-like Kaspa handoff | KasWare wallet docs | “TON dApp integration via the TON Connect protocol is **coming soon**” — implies **no** published Connect protocol for Kaspa Mini App today |
| Public Mini App source | [kasware-wallet/kasware-app](https://github.com/kasware-wallet/kasware-app) | **APK release repo only** (README). Extension source is separate; **no open Mini App WebView injection code** to audit |

### Feasibility

**Not clearly feasible.** Best-supported reading: Mini App is KasWare’s **own** wallet UI inside Telegram. The documented `signPskt` path is the **extension** inject model. There is no primary-source proof that:

1. Opening `t.me/KasWare_bot?startapp=<url>` loads our `/sign` page with `window.kasware`, or  
2. Any Mini App API accepts an external SafeJSON / PSKT for signing.

**To verify (needs human on iPhone + Telegram):**  
open Mini App → look for any “Browser / DApps / Open link” → if none, try  
`https://t.me/KasWare_bot?startapp=` + base64url of a short token (not a full URL if length-limited) and see whether KasWare UI changes. Expect no effect until KasWare documents it.

**Implementation:** **Do not** add “Open in KasWare Telegram” as a working path until KasWare publishes Mini App open-dapp or a sign handoff. Asking KasWare (Discord/Telegram) for:  
`startapp=sign&pskt=…` or WebView inject for allowlisted origins.

---

## 2) Our own Telegram Mini App wrapping `/sign`

### What Telegram allows (primary)

- Host our HTTPS page as a BotFather Mini App ([webapps](https://core.telegram.org/bots/webapps)).
- Receive `Telegram.WebApp` / `start_param` in **our** app.
- `openTelegramLink('https://t.me/KasWare_bot?startapp=…')` opens KasWare Mini App ([TMA links](https://docs.telegram-mini-apps.com/packages/tma-js-sdk/features/links)) — typically **closes** our Mini App; **no** shared JS context, **no** automatic `signPskt`.
- `openLink('https://kaspa-mcp…/sign/…')` opens an **external** browser ([same](https://docs.telegram-mini-apps.com/packages/tma-js-sdk/features/links)) — **no** KasWare inject (Safari/Chrome on iOS).

### Feasibility

| Piece | Feasible? |
|-------|-----------|
| Show `/sign` UI inside Telegram | Yes — BotFather + Worker URL |
| Call `window.kasware.signPskt` inside **our** Mini App | **No** — KasWare does not inject into third-party Mini Apps |
| Handoff to KasWare Mini App and get a signature back | **No protocol published** (unlike TON Connect, which KasWare says is still “coming soon”) |
| Return txid to our session via `startapp` round-trip | Speculative; would need KasWare to cooperate |

**Implementation:** Only worth building after KasWare documents a Mini App signing API (or Connect). A wrapper alone does **not** unlock iPhone signing.

---

## 3) QR scan-to-sign (KasSigner PSKB / KSPT)

### What primary sources say

| Piece | Source | Notes |
|-------|--------|--------|
| Air-gap QR PSKB/KSPT | [InKasWeRust/KasSigner](https://github.com/InKasWeRust/KasSigner) | Hardware ESP32 signer; scan unsigned QR → review → signed QR; **covenant** KSPT v4 mentioned |
| Browser companion | [kassigner.org](https://kassigner.org/) / KasSee | Watch-only WASM; build TX, animated QR, scan signed QR, broadcast; PWA-capable |
| Standard PSKT/PSKB | [Kaspalytics PSKT & PSKB](https://www.kaspalytics.com/developer-docs/transactions/pskt-pskb) | BIP-370-style roles; serialize for transport |
| KaChat “Cold Storage … KasSigner” | [App Store KaChat 3.0 notes](https://apps.apple.com/us/app/kachat/id6759102359) | Scan/sign/broadcast for **KaChat’s own send** with a paired KasSigner — **not** documented as “import arbitrary third-party PSKB from a website” |
| Kaspium | App Store / GitHub | **No** PSKB/QR covenant path |

### Who can scan/sign our QR on iOS?

| App / device | Can sign our `/sign` PSKB? |
|--------------|----------------------------|
| **KasSigner hardware** + phone camera | Yes (device signs) |
| **KasSee** in iOS Safari / PWA | Builds/broadcasts; signing still needs KasSigner (or another PSKB-capable signer) |
| **KaChat** | Only its Cold Storage **send** flow — **no cite** for ingesting our page’s QR |
| **Kaspium** | No |

### Feasibility for our connector

**Technically feasible** as a desktop/hardware path:  
SafeJSON / unsigned spend → encode **standard PSKB** (or KasSee-compatible KSPT) → animated QR → user signs on KasSigner → scan signed QR → `finalizeCovenantSpend` (SilverScript unlock wrap) → broadcast.

**Not verifiable** for Michael’s stated iPhone setup (Kaspium + KaChat only) without a **KasSigner device**.  
**Not** a drop-in for “open link on iPhone and Approve.”

**Implementation plan (when we choose to build):**

1. Add `l1-build` helper: `safeJsonToPskb(unsigned)` using kaspa-wasm PSKT/PSKB APIs (verify against KasSee QR frames).  
2. `/sign` UI: “Air-gap / KasSigner” → show animated QR + “Paste signed PSKB / scan”.  
3. On signed payload: extract sighash signature → existing `finalizeCovenantSpend` → `submitSignedTx`.  
4. Verify on TN10 with a real KasSigner (or KasSee relay to hardware).  
5. Document: requires KasSigner; KaChat Cold Storage ≠ this button.

**Do not implement until** we have a KasSigner (or KasSee-compatible signer) available for e2e — otherwise unverifiable.

---

## Summary decision

| Path | Feasible now? | Verifiable on Michael’s iPhone? | Ship? |
|------|---------------|----------------------------------|-------|
| KasWare Mini App open-dapp / inject | **No** (undocumented) | No | **No** |
| Our Mini App → KasWare handoff | Wrapper yes; signing **no** | No | **No** |
| KasSigner PSKB QR | Yes with hardware | No (no KasSigner) | **Defer** |

**Honest iPhone guidance for users:** use KasWare/Kastle/Kaspire on **desktop or Android**; iOS Safari cannot inject those wallets. Ask KasWare for Mini App dApp signing; optional future: PSKB QR for KasSigner owners.

Related: [WALLET_COMPATIBILITY.md](./WALLET_COMPATIBILITY.md).
