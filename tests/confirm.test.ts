import { describe, it, expect, vi } from "vitest";
import {
  confirmTransaction,
  extractTxidFromMessage,
  isLikelySubmitRaceError,
  explorerTxUrl,
} from "../src/l1/confirm.js";

describe("confirm helpers", () => {
  it("builds tn10 explorer links", () => {
    const id = "a".repeat(64);
    expect(explorerTxUrl("testnet-10", id)).toContain("tn10.kaspa.stream/transactions/");
    expect(explorerTxUrl("mainnet", id)).toContain("explorer.kaspa.org/transactions/");
  });

  it("extracts txid from error text", () => {
    const id = "3699167bfe3987a97b69053387a7a8bb8ac45f49df1fd7e34010130c7e066f69";
    expect(extractTxidFromMessage(`reject orphan ${id} failed`)).toBe(id);
    expect(extractTxidFromMessage("no id here")).toBeUndefined();
  });

  it("detects race-like submit errors", () => {
    expect(isLikelySubmitRaceError("Transaction is an orphan")).toBe(true);
    expect(isLikelySubmitRaceError("already exists in mempool")).toBe(true);
    expect(isLikelySubmitRaceError("completely unrelated")).toBe(false);
  });

  it("polls until accepted", async () => {
    const id = "b".repeat(64);
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n < 3) return new Response(JSON.stringify({ detail: "Transaction not found" }), { status: 404 });
      return new Response(
        JSON.stringify({
          transaction_id: id,
          is_accepted: true,
          accepting_block_hash: "c".repeat(64),
          accepting_block_blue_score: 42,
        }),
        { status: 200 },
      );
    });
    const conf = await confirmTransaction("testnet-10", id, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5_000,
      intervalMs: 1,
      sleep: async () => {},
    });
    expect(conf.status).toBe("accepted");
    expect(conf.isAccepted).toBe(true);
    expect(conf.attempts).toBeGreaterThanOrEqual(3);
    expect(conf.explorer).toContain(id);
  });

  it("returns not_found after timeout when never indexed", async () => {
    const id = "d".repeat(64);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ detail: "Transaction not found" }), { status: 404 }));
    const conf = await confirmTransaction("testnet-10", id, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5,
      intervalMs: 1,
      sleep: async () => {},
      now: (() => {
        let t = 0;
        return () => {
          t += 3;
          return t;
        };
      })(),
    });
    expect(conf.status).toBe("not_found");
    expect(conf.isAccepted).toBe(false);
  });
});
