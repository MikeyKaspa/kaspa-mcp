/**
 * Everyday-user copy shared by MCP tools/instructions.
 * Keep free of jargon; never promise auto-drip.
 */

/** Official TN10 faucet (primary: wiki.kaspa.org/en/testnets). */
export const TN10_FAUCET_URL = "https://faucet-tn10.kaspanet.io/";
export const TN10_FAUCET_SOURCE = "https://wiki.kaspa.org/en/testnets";

export const WALLET_TAP_APPROVE = {
  worksNow: [
    "Quick-start wallet — built into the approve page (Face ID / fingerprint / PIN). Works on iPhone Safari. Keys never leave the device.",
    "KasWare — desktop browser extension + Android",
    "Kastle — when injected in the browser",
    "Kaspire — WalletConnect path on the approve page",
  ],
  notYet: ["Kaspium / KaChat as injected dApp wallets (use Quick-start instead)"],
  plain:
    "No wallet yet? Open the approve link and tap Create Quick-start wallet (Face ID or PIN). Or use KasWare / Kastle / Kaspire if you already have one.",
  quickStartCapKas: 50,
  dataLossNotice:
    "Quick-start wallets live only in this browser. Clearing site data loses them unless you saved a backup.",
};

export const NO_POPUP_PATH_PLAIN =
  "Want the bot to deploy with no approval popups? Call self_host and follow it — you get your own free Cloudflare copy with a tiny capped spending wallet on YOUR account only. The public demo never holds keys.";

/** One-line faucet instructions for agents to show users. */
export function faucetPasteSteps(addressPlaceholder = "kaspatest:YOUR_ADDRESS"): Record<string, unknown> {
  return {
    faucetUrl: TN10_FAUCET_URL,
    source: TN10_FAUCET_SOURCE,
    verified: "Listed as the TN-10 faucet on the official Kaspa wiki (wiki.kaspa.org/en/testnets).",
    humanSteps: [
      `1. Copy your address (${addressPlaceholder}).`,
      `2. Open ${TN10_FAUCET_URL}`,
      "3. Paste the address and request free test KAS.",
      "4. Wait a minute, then come back here.",
    ],
    oneLiner: `Paste this address into ${TN10_FAUCET_URL} → request free test KAS → tell me when it arrives.`,
    noAutoDrip: true,
    note: "This connector never sends faucet funds for you (no auto-drip). You paste the address yourself.",
  };
}

export const BUILD_TIPJAR_PUBLIC_GUIDE = `
## When the user says “build me a tip jar” (or similar) on the SHARED public demo
You are on the keyless shared demo — you cannot deploy without their approval (and you must never ask them to paste a private key).

Do this, in order:
1. Ask **Testnet or mainnet?** then call choose_network. Prefer testnet.
2. Offer plain paths:
   A) **Quick-start (best for brand-new users / iPhone):** prepare tap links; they open the page, create a Quick-start wallet (Face ID or PIN), fund via faucet (testnet) or QR (mainnet, 50 KAS cap), then Approve. Keys never leave their device.
   B) **Extension wallet:** KasWare / Kastle / Kaspire if they already have one.
   C) **No approvals (their own copy):** call self_host → free Cloudflare copy + spending wallet → l1_tipjar_chat_deploy with zero popups.
3. If they pick A/B and have no testnet KAS: call faucet_info + show faucet URL. Never claim you can drip funds. The Quick-start page shows address + faucet link and polls balance.
4. For Quick-start: after they create the wallet, use the address shown on the page as fromAddress / ownerAddress.
5. Never say “compile with your key baked in”. Say: “We’ll make a tip jar owned by your wallet.”
6. On the shared demo, l1_tipjar_chat_deploy is refused — that is expected; steer to A/B/C above.
7. “Send 3 KAS to <address>”: call l1_prepare_send → give tapToApprove.url (Quick-start or extension).
`.trim();

export const TAP_APPROVE_NOTE =
  "Open the approve link. New to Kaspa? Create a Quick-start wallet on the page (Face ID / PIN; works on iPhone). " +
  "Or use KasWare / Kastle / Kaspire. Prefer no popups? Use self_host for your own copy.";

/** Steer agents away from “send manually in KasWare”. */
export const NEVER_MANUAL_SEND =
  "Never tell the user to manually send KAS from KasWare/Kastle. Always call l1_prepare_fund and give them tapToApprove.url (one-tap approve link).";

export const WITHDRAW_PUBLIC_GUIDE = `
## Withdraw / spend on the SHARED public demo
Withdraw IS one-tap on the public connector:
1. Call get_balance on the tip-jar (P2SH) address.
2. If balance is 0 / unfunded: do NOT say “send manually”. Call l1_prepare_fund({ templateId, fromAddress, amountSompi }) and give the user tapToApprove.url to fund first.
3. If funded: call l1_prepare_spend({ templateId, entry, utxo, destinationAddress, args }) and give tapToApprove.url — the /sign page wraps the covenant unlock for KasWare/Kastle/Kaspire.
4. Withdraw works with a one-tap approve link on the public connector. Self-host Cloudflare adds optional no-popup auto-sign. Do not claim withdraw requires a local Node server.
`.trim();

export function readyNotOnChain(opts: {
  p2shAddress?: string;
  tapToApproveUrl?: string;
  templateId?: string;
}): Record<string, unknown> {
  return {
    onChain: false,
    status: "ready_not_on_chain",
    tellUser: "Ready — not on chain until funded. Do not say it is live yet.",
    nextStep: opts.tapToApproveUrl
      ? {
          action: "Open tapToApprove.url and approve a small fund amount in KasWare/Kastle/Kaspire.",
          tapToApproveUrl: opts.tapToApproveUrl,
        }
      : {
          action:
            "Call l1_prepare_fund with templateId + fromAddress + amountSompi, then give the user tapToApprove.url. Never ask them to send manually.",
          tool: "l1_prepare_fund",
          templateId: opts.templateId || "tipjar",
        },
    p2shAddress: opts.p2shAddress,
    neverManualSend: NEVER_MANUAL_SEND,
  };
}

export function zeroBalanceFundOffer(address: string): Record<string, unknown> {
  return {
    funded: false,
    tellUser:
      "This address has 0 balance — nothing to withdraw yet. Offer a one-tap fund link next (l1_prepare_fund → tapToApprove.url). Do not tell them to send manually from their wallet app.",
    nextTool: {
      name: "l1_prepare_fund",
      hint: "Pass templateId (e.g. tipjar), fromAddress (their kaspatest:q… wallet), amountSompi (e.g. 100000000 = 1 tKAS). Return tapToApprove.url to the user.",
    },
    address,
    neverManualSend: NEVER_MANUAL_SEND,
    wallets: WALLET_TAP_APPROVE,
  };
}
