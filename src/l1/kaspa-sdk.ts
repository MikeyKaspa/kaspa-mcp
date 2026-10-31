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
      `kaspa-wasm Node package unavailable in this runtime (${msg}). ` +
        `On the public connector use tap-to-approve (/sign/…) — the page builds + signs in the browser (KasWare/Kastle/Kaspire). ` +
        `Templates, prepare_fund/spend (browser_build), and self-host Cloudflare Workers use the pure-JS signer. ` +
        `Optional: local Node (npm start) if you want the Node wasm package.`,
    );
  }
}

export function isMainnetL1WritesEnabled(): boolean {
  return process.env.KASPA_L1_MAINNET_WRITES === "1" || process.env.KASPA_L1_MAINNET_WRITES === "true";
}

/** Refuse mainnet prepare helpers unless KASPA_L1_MAINNET_WRITES is explicitly enabled. */
export function assertL1NetworkWritable(
  isTestnet: boolean,
  networkId?: string,
): void {
  const id = (networkId ?? "").toLowerCase();
  const isMain = !isTestnet || id.includes("mainnet");
  if (isMain && !isMainnetL1WritesEnabled()) {
    throw new Error(
      "Mainnet L1 fund/spend prepare helpers are gated off. " +
        "Set KASPA_L1_MAINNET_WRITES=1 for prepare-only (unsigned SafeJSON; wallet signs). " +
        "Private keys are always rejected on mainnet. Prefer testnet-10 for experiments.",
    );
  }
}

/** Prominent risk banner for L1 covenant tools (testnet + mainnet). */
export const L1_UNAUDITED_WARNING =
  "⚠️ UNAUDITED / USE AT YOUR OWN RISK: SilverScript templates and L1 prepare helpers are experimental, " +
  "not security-audited, and may lose funds. Mainnet = prepare unsigned SafeJSON only (KasWare/wallet signs). " +
  "This connector never accepts or stores mainnet private keys. Prefer testnet-10. No warranty.";

/**
 * True when Node kaspa-wasm loads.
 * Shared Workers set KASPA_L1_BROWSER_BUILD=1 so prepare always returns
 * browser_build + tap link (web wasm is a static asset, not in the script).
 */
export async function kaspaWasmAvailable(): Promise<boolean> {
  const forceBrowser =
    process.env.KASPA_L1_BROWSER_BUILD === "1" || process.env.KASPA_L1_BROWSER_BUILD === "true";
  if (forceBrowser) return false;
  try {
    await loadKaspa();
    return true;
  } catch {
    return false;
  }
}
