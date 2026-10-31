/** Stored prepare payload for one-tap /sign/<id> (never contains private keys). */
export type SignKind = "l1-fund" | "l1-spend" | "evm-deploy" | "evm-call";

export interface L1BrowserBuild {
  /** Page loads /kaspa-wasm and builds SafeJSON in-browser */
  buildInBrowser: true;
  kaspaNetwork: "testnet-10" | "mainnet";
  utxoApiBase: string;
  bytecodeHex: string;
  /** fund */
  fromAddress?: string;
  amountSompi?: string;
  priorityFeeSompi?: string;
  /** spend */
  entryName?: string;
  dispatchTag?: string;
  entryParams?: Array<{ name: string; type: { kind: string } }>;
  args?: unknown[];
  destinationAddress?: string;
  feeSompi?: string;
  outputAmountSompi?: string;
  p2shUtxo?: {
    outpoint: { transactionId: string; index: number };
    amount: string;
    scriptPublicKey: { version: number; script: string };
  };
  /** CLTV / reclaim path */
  lockTimeMs?: string;
  expectedP2shAddress?: string;
  sigOpCount?: number;
}

export interface SignSession {
  id: string;
  kind: SignKind;
  networkId: string;
  networkLabel: string;
  isMainnet: boolean;
  createdAt: number;
  expiresAt: number;
  /** Prebuilt SafeJSON (Node path) — optional when buildInBrowser */
  safeJson?: string;
  signedSafeJson?: string;
  signInputs?: Array<{ index: number; sighashType: number }>;
  /** Worker path: browser builds tx with kaspa-wasm assets */
  l1Build?: L1BrowserBuild;
  evm?: {
    chainId: number;
    to: string | null;
    data: string;
    value: string;
    gasLimit?: string;
    gasPrice?: string;
    nonce?: number;
  };
  /** Set when /sign page reports a successful broadcast */
  submittedTxid?: string;
  submittedAt?: number;
  meta?: {
    p2shAddress?: string;
    entry?: string;
    contractName?: string;
    templateId?: string;
    expectedP2shAddress?: string;
    sharePageUrl?: string;
    campaignId?: string;
    campaignTagHex?: string;
    goalSompi?: string;
    deadlineMs?: string;
    backerAddress?: string;
    [key: string]: unknown;
  };
}

export interface TapToApprove {
  id: string;
  url: string;
  expiresAt: string;
  note: string;
}

export const SIGN_TTL_SEC = 15 * 60;
