/**
 * Reliable L1 transaction confirmation via public REST (kaspa.stream-compatible APIs).
 * Handles submit races where the API returns reject/orphan but the tx still lands.
 */
import { apiBase } from "./pure/tx.js";

export type ConfirmNetworkId = "testnet-10" | "mainnet";

export type TxConfirmStatus = "accepted" | "pending" | "not_found" | "failed";

export type TxConfirmResult = {
  txid: string;
  status: TxConfirmStatus;
  isAccepted: boolean;
  explorer: string;
  acceptingBlockHash?: string;
  acceptingBlockBlueScore?: number;
  attempts: number;
  elapsedMs: number;
  /** True when submit looked like a failure but REST later showed the tx. */
  recoveredFromSubmitRace?: boolean;
  detail?: string;
};

export function explorerTxUrl(networkId: ConfirmNetworkId, txid: string): string {
  return networkId === "mainnet"
    ? `https://explorer.kaspa.org/transactions/${txid}`
    : `https://tn10.kaspa.stream/transactions/${txid}`;
}

export type ConfirmOpts = {
  /** Max wall time to wait (default 12s testnet / 20s mainnet). */
  timeoutMs?: number;
  /** Delay between polls (default 600ms). */
  intervalMs?: number;
  /** Optional fetch impl (tests). */
  fetchImpl?: typeof fetch;
  /** Clock (tests). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_INTERVAL = 600;

function defaultTimeout(networkId: ConfirmNetworkId): number {
  return networkId === "mainnet" ? 20_000 : 12_000;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll GET /transactions/{txid} until is_accepted, missing after timeout, or hard failure.
 * 404 = not indexed yet (or truly missing) — keep polling until timeout.
 */
export async function confirmTransaction(
  networkId: ConfirmNetworkId,
  txid: string,
  opts: ConfirmOpts = {},
): Promise<TxConfirmResult> {
  const id = txid.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) {
    throw new Error(`Invalid txid (want 64 hex): ${txid.slice(0, 20)}…`);
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const timeoutMs = opts.timeoutMs ?? defaultTimeout(networkId);
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL;
  const url = `${apiBase(networkId)}/transactions/${id}`;
  const explorer = explorerTxUrl(networkId, id);
  const started = now();
  let attempts = 0;
  let lastDetail: string | undefined;

  while (now() - started < timeoutMs) {
    attempts += 1;
    try {
      const res = await fetchImpl(url);
      if (res.status === 404) {
        lastDetail = "Transaction not found (indexer lag or missing)";
      } else if (!res.ok) {
        lastDetail = `HTTP ${res.status}`;
      } else {
        const json = (await res.json()) as {
          transaction_id?: string;
          is_accepted?: boolean;
          accepting_block_hash?: string;
          accepting_block_blue_score?: number;
          detail?: string;
        };
        if (json.is_accepted === true) {
          return {
            txid: id,
            status: "accepted",
            isAccepted: true,
            explorer,
            acceptingBlockHash: json.accepting_block_hash,
            acceptingBlockBlueScore: json.accepting_block_blue_score,
            attempts,
            elapsedMs: now() - started,
          };
        }
        // Seen by indexer but not yet accepted into virtual selected parent chain
        lastDetail = "Indexed but not yet accepted";
        if (attempts > 1) {
          // Still pending — continue until timeout, then report pending
        }
      }
    } catch (e) {
      lastDetail = e instanceof Error ? e.message : String(e);
    }
    await sleep(intervalMs);
  }

  // Final probe
  attempts += 1;
  try {
    const res = await fetchImpl(url);
    if (res.ok) {
      const json = (await res.json()) as {
        is_accepted?: boolean;
        accepting_block_hash?: string;
        accepting_block_blue_score?: number;
      };
      if (json.is_accepted === true) {
        return {
          txid: id,
          status: "accepted",
          isAccepted: true,
          explorer,
          acceptingBlockHash: json.accepting_block_hash,
          acceptingBlockBlueScore: json.accepting_block_blue_score,
          attempts,
          elapsedMs: now() - started,
        };
      }
      return {
        txid: id,
        status: "pending",
        isAccepted: false,
        explorer,
        attempts,
        elapsedMs: now() - started,
        detail: lastDetail ?? "Timed out still pending acceptance",
      };
    }
    if (res.status === 404) {
      return {
        txid: id,
        status: "not_found",
        isAccepted: false,
        explorer,
        attempts,
        elapsedMs: now() - started,
        detail: lastDetail ?? "Not found after timeout",
      };
    }
  } catch (e) {
    lastDetail = e instanceof Error ? e.message : String(e);
  }

  return {
    txid: id,
    status: "failed",
    isAccepted: false,
    explorer,
    attempts,
    elapsedMs: now() - started,
    detail: lastDetail ?? "Confirmation failed",
  };
}

/** Extract a 64-hex txid from submit error bodies / messages when present. */
export function extractTxidFromMessage(msg: string): string | undefined {
  const m = msg.match(/\b([0-9a-fA-F]{64})\b/);
  return m?.[1]?.toLowerCase();
}

export function isLikelySubmitRaceError(msg: string): boolean {
  const s = msg.toLowerCase();
  return (
    s.includes("orphan") ||
    s.includes("already") ||
    s.includes("reject") ||
    s.includes("exist") ||
    s.includes("duplicate") ||
    s.includes("mempool") ||
    s.includes("missing utxo") ||
    s.includes("double spend") ||
    s.includes("failed to")
  );
}
