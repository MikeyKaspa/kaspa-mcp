import type { KaspaBackend } from "./types.js";
import type { BalanceResult, NetworkInfo, TxResult } from "../types.js";
import { SafetyError } from "../safety.js";

/**
 * Native Kaspa L1 covenants (Toccata + SilverScript).
 * Compile/fund/spend are exposed as dedicated MCP tools (silverscript_*, l1_*),
 * not via the EVM-shaped KaspaBackend deploy path.
 */
export class CovenantBackend implements KaspaBackend {
  readonly kind = "covenant" as const;

  supports(network: NetworkInfo): boolean {
    return network.kind === "covenant";
  }

  async getBalance(_network: NetworkInfo, _address: string): Promise<BalanceResult> {
    throw new SafetyError("Use get_balance on kaspa-l1-* (L1ReadBackend) or REST api.");
  }

  async getTx(_network: NetworkInfo, _hash: string): Promise<TxResult> {
    throw new SafetyError("Use get_tx on kaspa-l1-* networks.");
  }

  async compile(): Promise<never> {
    throw new SafetyError(
      "Use silverscript_compile (Node self-host + silverc) or silverscript_templates / silverscript_load_artifact.",
    );
  }
}
