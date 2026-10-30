import type { KaspaBackend } from "./types.js";
import type { BalanceResult, NetworkInfo, TxResult } from "../types.js";
import { SafetyError } from "../safety.js";

/**
 * Roadmap stub for Kaspa vProgs (based ZK application runtime).
 * Repo: https://github.com/kaspanet/vprogs — no stable external developer API (2026-10).
 * kasstacker.org lists maturity as "roadmap".
 */
export class VProgsBackend implements KaspaBackend {
  readonly kind = "vprogs" as const;

  supports(network: NetworkInfo): boolean {
    return network.kind === "vprogs";
  }

  async getBalance(_n: NetworkInfo, _a: string): Promise<BalanceResult> {
    throw new SafetyError("vProgs backend is roadmap-only — no public deploy API yet.");
  }

  async getTx(_n: NetworkInfo, _h: string): Promise<TxResult> {
    throw new SafetyError("vProgs backend is roadmap-only.");
  }
}
