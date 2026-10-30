/**
 * Lazy-load kaspa-wasm (Node). Workers: tools that need wasm tell the user to self-host.
 */
export type KaspaModule = typeof import("kaspa");

let cached: KaspaModule | null = null;

export async function loadKaspa(): Promise<KaspaModule> {
  if (cached) return cached;
  try {
    cached = await import("kaspa");
    return cached;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `kaspa-wasm unavailable in this runtime (${msg}). ` +
        `Self-host with Node 20+ (\`npm start\`) for L1 P2SH / fund / spend helpers. ` +
        `Shared Workers demo still serves templates + load_artifact.`,
    );
  }
}

export function isMainnetL1WritesEnabled(): boolean {
  return process.env.KASPA_L1_MAINNET_WRITES === "1" || process.env.KASPA_L1_MAINNET_WRITES === "true";
}

export function assertL1NetworkWritable(isTestnet: boolean): void {
  if (!isTestnet && !isMainnetL1WritesEnabled()) {
    throw new Error(
      "Mainnet L1 fund/spend helpers are gated off until templates pass kaspa-redteam " +
        "and Michael enables KASPA_L1_MAINNET_WRITES=1. Use kaspa-l1-testnet-10.",
    );
  }
}
