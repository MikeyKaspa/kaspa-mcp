# Quick-start wallet

For brand-new Kaspa users (including **iPhone Safari**) who do not have KasWare / Kastle / Kaspire.

## What it is

A tiny wallet that lives **only in your browser** on the approve page (`/sign/<id>`).

1. You tap **Create Quick-start wallet**.
2. The page makes a Kaspa key on your device (never uploaded).
3. It locks the key with a **passkey** (Face ID / fingerprint via WebAuthn PRF) when the browser supports it, otherwise a **PIN**.
4. You fund it (testnet faucet link, or mainnet QR), then tap **Approve**.

Extension wallets still work the same way if you already have one.

## Limits (by design)

| Rule | Why |
|------|-----|
| **50 KAS hard cap** | Quick-start is for small experiments, not a vault |
| **Keys never touch our server** | A Worker hack cannot drain you |
| **Clearing site data loses the wallet** | Unless you saved the backup phrase / key |
| **Mainnet requires backup acknowledgement** | You must confirm you saved the recovery phrase before mainnet use |
| **SilverScript is UNAUDITED** | Mainnet covenants can lose funds — prefer testnet |

## Testnet

1. Create the wallet on a testnet approve link.
2. Copy the `kaspatest:` address (or use the QR).
3. Open [faucet-tn10.kaspanet.io](https://faucet-tn10.kaspanet.io/), paste, request free tKAS.
4. The page polls balance and continues when funds arrive.

There is **no automatable public faucet API** today (Cloudflare Turnstile on the form). We do not fake faucet claims.

## Mainnet

1. Choose mainnet in chat (you will see the UNAUDITED warning).
2. Create Quick-start → **save the backup** → acknowledge.
3. Send a small amount of real KAS to the shown address (stay under 50 KAS).
4. Approve fund / spend / send on the page.

## Send KAS

In chat: *“send 3 KAS to kaspa:…”* → agent calls `l1_prepare_send` → you open `tapToApprove.url`.

On the page: unlock Quick-start → paste address → amount (or **Max**) → Review & send → one passkey/PIN approval → explorer link.

Address prefixes are checked (`kaspa:` vs `kaspatest:`) so you cannot accidentally send across networks.

## Export / import

Use **Backup** on the page. Store the 12-word phrase (or hex key) offline. **Import backup** restores onto another browser/device (you set a new PIN/passkey for that device).

## Security notes

- Strict CSP on `/sign` (no third-party scripts).
- kaspa-wasm is integrity-checked (sha384) before use.
- No key logging; private material stays in memory only while unlocked.
- Prefer a dedicated extension / hardware wallet above the 50 KAS cap.

## Agent guidance

See `src/ux-copy.ts` (`BUILD_TIPJAR_PUBLIC_GUIDE`, `WALLET_TAP_APPROVE`). Prefer Quick-start for users with no wallet; call `l1_prepare_send` for plain sends.
