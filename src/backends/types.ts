import type {
  BalanceResult,
  CallResult,
  CompileResult,
  DeployResult,
  NetworkInfo,
  PreparedTx,
  TxResult,
} from "../types.js";

/**
 * Pluggable backend for a Kaspa-ecosystem execution environment.
 * - EvmBackend: Kasplex / Igra (Solidity) — implemented in v0.1
 * - CovenantBackend: Silverscript / Toccata L1 — stub until tooling maturity
 * - VProgsBackend: based ZK apps — roadmap stub
 */
export interface KaspaBackend {
  readonly kind: NetworkInfo["kind"];
  supports(network: NetworkInfo): boolean;

  getBalance(network: NetworkInfo, address: string): Promise<BalanceResult>;
  getTx(network: NetworkInfo, hash: string): Promise<TxResult>;

  /** Optional: compile source for this backend's language */
  compile?(
    network: NetworkInfo,
    source: string,
    options?: { contractName?: string; solcVersion?: string },
  ): Promise<CompileResult>;

  /** Prepare deploy without broadcasting (always safe) */
  prepareDeploy?(
    network: NetworkInfo,
    compiled: CompileResult,
    ctorArgs?: unknown[],
    fromAddress?: string,
  ): Promise<PreparedTx>;

  /**
   * Broadcast a deploy. Implementations MUST refuse mainnet private keys.
   * Testnet may accept a per-call privateKey that is never stored.
   */
  deploy?(
    network: NetworkInfo,
    compiled: CompileResult,
    options: {
      ctorArgs?: unknown[];
      privateKey?: string;
      signedRawTx?: string;
    },
  ): Promise<DeployResult>;

  readContract?(
    network: NetworkInfo,
    address: string,
    abi: unknown[],
    functionName: string,
    args?: unknown[],
  ): Promise<CallResult>;

  prepareCall?(
    network: NetworkInfo,
    address: string,
    abi: unknown[],
    functionName: string,
    args?: unknown[],
    valueWei?: string,
    fromAddress?: string,
  ): Promise<PreparedTx>;

  sendRawTransaction?(network: NetworkInfo, rawTx: string): Promise<TxResult>;
}
