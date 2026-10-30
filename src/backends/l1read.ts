import type { KaspaBackend } from "./types.js";
import type { BalanceResult, NetworkInfo, TxResult } from "../types.js";

/** Kaspa L1 public REST reads via api.kaspa.org / api-tn10.kaspa.org */
export class L1ReadBackend implements KaspaBackend {
  readonly kind = "l1-read" as const;

  supports(network: NetworkInfo): boolean {
    return (network.kind === "l1-read" || network.kind === "covenant") && Boolean(network.rpcUrl);
  }

  async getBalance(network: NetworkInfo, address: string): Promise<BalanceResult> {
    const base = network.rpcUrl!.replace(/\/$/, "");
    const res = await fetch(`${base}/addresses/${encodeURIComponent(address)}/balance`);
    if (!res.ok) throw new Error(`L1 balance HTTP ${res.status}`);
    const data = (await res.json()) as { balance?: number | string };
    const sompi = BigInt(data.balance ?? 0);
    const kas = Number(sompi) / 1e8;
    return {
      address,
      balanceWei: sompi.toString(),
      balanceFormatted: String(kas),
      symbol: network.nativeCurrency.symbol,
      networkId: network.id,
    };
  }

  async getTx(network: NetworkInfo, hash: string): Promise<TxResult> {
    const base = network.rpcUrl!.replace(/\/$/, "");
    const res = await fetch(`${base}/transactions/${encodeURIComponent(hash)}`);
    if (!res.ok) throw new Error(`L1 tx HTTP ${res.status}`);
    const data = await res.json();
    return {
      hash,
      status: "unknown",
      explorerUrl: network.explorerUrl
        ? `${network.explorerUrl.replace(/\/$/, "")}/${
            network.explorerUrl.includes("kaspa.stream") ? "transactions" : "txs"
          }/${hash}`
        : undefined,
      networkId: network.id,
      raw: data,
    };
  }
}
