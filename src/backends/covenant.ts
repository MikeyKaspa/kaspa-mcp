import type { KaspaBackend } from "./types.js";
import type { BalanceResult, NetworkInfo, TxResult } from "../types.js";
import { SafetyError } from "../safety.js";

/**
 * Stub for native Kaspa L1 covenants (Toccata + Silverscript).
 *
 * Status (sources, 2026-10):
 * - Toccata consensus live on mainnet since 2026-06-30 (DAA 474_165_565)
 *   https://docs.kaspa.org/toccata · rusty-kaspa v2.0.0 release
 * - Silverscript v1.0.0 tagged 2026-09-09 — pre-audit (kasstacker.org/status)
 * - Argent — experimental, no release
 * - vProgs — separate roadmap backend
 *
 * When silverc + a non-custodial tx builder are stable, implement compile/prepareDeploy here.
 */
export class CovenantBackend implements KaspaBackend {
  readonly kind = "covenant" as const;

  supports(network: NetworkInfo): boolean {
    return network.kind === "covenant";
  }

  async getBalance(_network: NetworkInfo, _address: string): Promise<BalanceResult> {
    throw new SafetyError(
      "Covenant backend is a stub. Use kaspa-l1-* networks with l1_get_* tools for reads, " +
        "or wait for Silverscript integration (pre-audit as of 2026-10).",
    );
  }

  async getTx(_network: NetworkInfo, _hash: string): Promise<TxResult> {
    throw new SafetyError("Covenant backend stub — getTx not implemented yet.");
  }

  async compile(): Promise<never> {
    throw new SafetyError(
      "Silverscript compile not wired yet (v1.0.0 is pre-audit). " +
        "Track https://github.com/kaspanet/silverscript — this backend will gain compile/deploy when ready.",
    );
  }
}
