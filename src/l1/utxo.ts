/**
 * Fetch L1 UTXOs via public REST (api.kaspa.org / api-tn10.kaspa.org).
 * Prefer REST so Cloudflare Workers (no durable WS) can still build fund txs.
 */

export interface RestUtxo {
  address?: string;
  outpoint: { transactionId: string; index: number };
  amount: bigint;
  scriptPublicKey: { version: number; script: string };
  blockDaaScore: bigint;
  isCoinbase: boolean;
}

export function assertAddressNetwork(address: string, networkId: "testnet-10" | "mainnet"): void {
  const a = address.trim().toLowerCase();
  if (networkId === "testnet-10") {
    if (!a.startsWith("kaspatest:")) {
      throw new Error(
        `Address prefix mismatch: expected kaspatest:… for testnet-10, got "${address.slice(0, 24)}…"`,
      );
    }
  } else if (networkId === "mainnet") {
    if (!a.startsWith("kaspa:") || a.startsWith("kaspatest:") || a.startsWith("kaspasim:")) {
      throw new Error(`Address prefix mismatch: expected kaspa:… for mainnet, got "${address.slice(0, 24)}…"`);
    }
  }
}

export async function fetchUtxosRest(apiBase: string, address: string): Promise<RestUtxo[]> {
  const base = apiBase.replace(/\/$/, "");
  const url = `${base}/addresses/${encodeURIComponent(address)}/utxos`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`UTXO fetch HTTP ${res.status} from ${base}`);
  const data = (await res.json()) as Array<{
    address?: string;
    outpoint: { transactionId: string; index: number };
    utxoEntry?: {
      amount: string | number;
      scriptPublicKey: { scriptPublicKey?: string; version?: number } | string;
      blockDaaScore: string | number;
      isCoinbase?: boolean;
    };
    /** some APIs flatten */
    amount?: string | number;
    scriptPublicKey?: { scriptPublicKey?: string; version?: number } | string;
    blockDaaScore?: string | number;
    isCoinbase?: boolean;
  }>;

  return (data ?? []).map((row) => {
    const entry = row.utxoEntry ?? row;
    const spkRaw = entry.scriptPublicKey ?? { scriptPublicKey: "", version: 0 };
    let script: string;
    let version = 0;
    if (typeof spkRaw === "string") {
      script = spkRaw;
    } else {
      script = spkRaw.scriptPublicKey ?? (spkRaw as { script?: string }).script ?? "";
      version = spkRaw.version ?? 0;
    }
    // REST often returns script without version prefix; kaspa-wasm SafeJSON uses "0000"+script for version 0
    if (script.length >= 4 && script.startsWith("00") && script.length > 66) {
      // already version-prefixed hex (e.g. 000020…ac)
    } else if (script.length === 70 || script.length === 66 || script.length === 68) {
      // bare script; leave as-is — createTransactions accepts ScriptPublicKey objects
    }
    return {
      address: row.address ?? address,
      outpoint: row.outpoint,
      amount: BigInt(entry.amount as string | number),
      scriptPublicKey: { version, script },
      blockDaaScore: BigInt(entry.blockDaaScore as string | number),
      isCoinbase: !!(entry as { isCoinbase?: boolean }).isCoinbase,
    };
  });
}

/** Convert REST UTXOs to the shape kaspa-wasm createTransactions expects. */
export function toKaspaEntries(utxos: RestUtxo[]) {
  return utxos.map((u) => ({
    address: u.address,
    outpoint: u.outpoint,
    amount: u.amount,
    scriptPublicKey: u.scriptPublicKey,
    blockDaaScore: u.blockDaaScore,
    isCoinbase: u.isCoinbase,
  }));
}
