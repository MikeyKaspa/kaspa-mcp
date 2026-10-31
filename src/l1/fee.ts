/**
 * Live fee / mass estimate via public REST fee-estimate (+ optional mass POST).
 */
import { fetchRestJson, type NetworkId } from "../endpoints.js";

export type FeeEstimate = {
  networkId: NetworkId;
  feerateSompiPerGram: number;
  estimatedSeconds: number;
  /** Recommended priority fee for a typical 1-in/2-out P2PK (~mass 2036). */
  recommendedPriorityFeeSompi: string;
  /** Recommended for P2SH fund (similar mass). */
  recommendedFundFeeSompi: string;
  /** Recommended for covenant spend (slightly higher mass). */
  recommendedSpendFeeSompi: string;
  sourceBase: string;
  massHeuristic: { p2pk: number; p2shFund: number; p2shSpend: number };
  note: string;
};

/** Known-good mass heuristics when /transactions/mass is unavailable. */
export const MASS_HEURISTIC = {
  p2pk: 2036,
  p2shFund: 2100,
  p2shSpend: 3200,
};

export async function estimateFees(networkId: NetworkId): Promise<FeeEstimate> {
  const { base, json } = await fetchRestJson<{
    priorityBucket?: { feerate?: number; estimatedSeconds?: number };
    normalBuckets?: Array<{ feerate?: number; estimatedSeconds?: number }>;
  }>(networkId, "/info/fee-estimate");

  const feerate =
    json.priorityBucket?.feerate ??
    json.normalBuckets?.[0]?.feerate ??
    100;
  const estimatedSeconds =
    json.priorityBucket?.estimatedSeconds ??
    json.normalBuckets?.[0]?.estimatedSeconds ??
    1;

  const fee = (mass: number) => BigInt(Math.ceil(feerate * mass));
  // Floor so TN10 compute-mass minimums still clear under tiny feerate.
  const floor = networkId === "mainnet" ? 10_000n : 100_000n;
  const withFloor = (m: number) => {
    const v = fee(m);
    return v > floor ? v : floor;
  };

  return {
    networkId,
    feerateSompiPerGram: feerate,
    estimatedSeconds,
    recommendedPriorityFeeSompi: withFloor(MASS_HEURISTIC.p2pk).toString(),
    recommendedFundFeeSompi: withFloor(MASS_HEURISTIC.p2shFund).toString(),
    recommendedSpendFeeSompi: withFloor(MASS_HEURISTIC.p2shSpend).toString(),
    sourceBase: base,
    massHeuristic: { ...MASS_HEURISTIC },
    note:
      "feerate from /info/fee-estimate × mass heuristic. " +
      "Override with priorityFeeSompi on prepare/fund tools if needed.",
  };
}

/** Pick a fee for payments; falls back to safe constant if estimate fails. */
export async function resolvePriorityFeeSompi(
  networkId: NetworkId,
  explicit?: bigint,
  kind: "p2pk" | "fund" | "spend" = "p2pk",
): Promise<bigint> {
  if (explicit != null) return explicit;
  try {
    const est = await estimateFees(networkId);
    if (kind === "fund") return BigInt(est.recommendedFundFeeSompi);
    if (kind === "spend") return BigInt(est.recommendedSpendFeeSompi);
    return BigInt(est.recommendedPriorityFeeSompi);
  } catch {
    return networkId === "mainnet" ? 200_000n : 500_000n;
  }
}
