import type { SignStore } from "./store.js";
import { buildSession } from "./store.js";
import type { SignKind, SignSession, TapToApprove } from "./types.js";
import { SIGN_TTL_SEC } from "./types.js";

export interface SignContext {
  store: SignStore;
  /** Public origin for links, e.g. https://kaspa-mcp.…workers.dev */
  publicBaseUrl: string;
}

let ctx: SignContext | null = null;

export function setSignContext(next: SignContext | null): void {
  ctx = next;
}

export function getSignContext(): SignContext | null {
  return ctx;
}

function networkLabel(networkId: string): string {
  if (networkId.includes("testnet-10")) return "Kaspa L1 testnet-10";
  if (networkId.includes("mainnet") && networkId.includes("kaspa-l1")) return "Kaspa L1 mainnet";
  if (networkId.includes("kasplex-testnet")) return "Kasplex testnet";
  if (networkId.includes("kasplex")) return "Kasplex mainnet";
  return networkId;
}

function isMainnet(networkId: string): boolean {
  return /mainnet/i.test(networkId) && !/testnet/i.test(networkId);
}

export async function attachTapToApprove(
  kind: SignKind,
  networkId: string,
  payload: {
    safeJson?: string;
    signedSafeJson?: string;
    signInputs?: Array<{ index: number; sighashType: number }>;
    evm?: SignSession["evm"];
    meta?: SignSession["meta"];
  },
): Promise<TapToApprove | undefined> {
  if (!ctx) return undefined;
  const session = buildSession({
    kind,
    networkId,
    networkLabel: networkLabel(networkId),
    isMainnet: isMainnet(networkId),
    safeJson: payload.safeJson,
    signedSafeJson: payload.signedSafeJson,
    signInputs: payload.signInputs,
    evm: payload.evm,
    meta: payload.meta,
  });
  await ctx.store.put(session);
  const base = ctx.publicBaseUrl.replace(/\/$/, "");
  return {
    id: session.id,
    url: `${base}/sign/${session.id}`,
    expiresAt: new Date(session.expiresAt).toISOString(),
    note: `Tap to approve in KasWare / Kastle (L1) or your EVM wallet. Link expires in ${SIGN_TTL_SEC / 60} minutes. Page never sees keys.`,
  };
}
