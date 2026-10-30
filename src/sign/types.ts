/** Stored prepare payload for one-tap /sign/<id> (never contains private keys). */
export type SignKind = "l1-fund" | "l1-spend" | "evm-deploy" | "evm-call";

export interface SignSession {
  id: string;
  kind: SignKind;
  networkId: string;
  /** Human network label derived server-side */
  networkLabel: string;
  isMainnet: boolean;
  createdAt: number;
  expiresAt: number;
  /** KasWare SafeJSON (fund unsigned, or spend unsigned/signed) */
  safeJson?: string;
  signedSafeJson?: string;
  signInputs?: Array<{ index: number; sighashType: number }>;
  /** EVM unsigned fields */
  evm?: {
    chainId: number;
    to: string | null;
    data: string;
    value: string;
    gasLimit?: string;
    gasPrice?: string;
    nonce?: number;
  };
  /** Optional labels that MUST be re-derived/verified client-side from tx bytes */
  meta?: {
    p2shAddress?: string;
    entry?: string;
    contractName?: string;
    templateId?: string;
  };
}

export interface TapToApprove {
  id: string;
  url: string;
  expiresAt: string;
  note: string;
}

export const SIGN_TTL_SEC = 15 * 60;
