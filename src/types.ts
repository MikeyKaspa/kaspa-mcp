/** Shared types for pluggable Kaspa backends. */

export type BackendKind = "evm" | "covenant" | "vprogs" | "l1-read";

export interface NetworkInfo {
  id: string;
  displayName: string;
  kind: BackendKind;
  /** true = free test tokens; false = real value (writes require unsigned-tx flow) */
  isTestnet: boolean;
  chainId?: number;
  rpcUrl?: string;
  explorerUrl?: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  faucetUrl?: string;
  faucetNotes?: string;
  docsUrl?: string;
  /** maturity for community honesty */
  maturity: "production" | "active" | "pre-audit" | "experimental" | "roadmap";
  notes?: string;
  /** estimated gasPrice override in wei (some Kaspa L2s need hardcoding) */
  minGasPriceWei?: string;
}

export interface CompileResult {
  contractName: string;
  abi: unknown[];
  bytecode: `0x${string}`;
  compiler: string;
}

export interface DeployResult {
  txHash: string;
  contractAddress?: string;
  explorerTxUrl?: string;
  explorerAddressUrl?: string;
  networkId: string;
}

export interface PreparedTx {
  mode: "unsigned" | "signed_ready_to_send";
  networkId: string;
  to?: string | null;
  data: string;
  value: string;
  gasLimit?: string;
  gasPrice?: string;
  nonce?: number;
  chainId?: number;
  /** only present for testnet signed flow — never logged by tools */
  rawTransaction?: string;
  summary: string;
}

export interface CallResult {
  raw: string;
  decoded?: unknown;
  networkId: string;
}

export interface BalanceResult {
  address: string;
  balanceWei: string;
  balanceFormatted: string;
  symbol: string;
  networkId: string;
}

export interface TxResult {
  hash: string;
  status?: "pending" | "success" | "reverted" | "unknown";
  blockNumber?: number;
  from?: string;
  to?: string;
  contractAddress?: string;
  explorerUrl?: string;
  networkId: string;
  raw?: unknown;
}

export type TextJson = {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};
