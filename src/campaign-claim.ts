/**
 * Build AoN owner-claim L1BrowserBuild (single or multi-input co-spend).
 * Shared by /api/campaign/:id/claim and TN10 e2e so the share-page path is one code path.
 */
import { getTemplate } from "./l1/templates.js";
import { rebindAoNPledge, entryOf } from "./l1/artifact.js";
import { derivePledgeForBacker, type CampaignPageRecord } from "./campaign-page.js";
import { AON_DEFAULT_GRACE_MS, computeRefundOpensAtMs } from "./crowdfund.js";
import type { L1BrowserBuild } from "./sign/types.js";
import { kaspaNetworkFor, utxoApiBaseFor } from "./sign/attach.js";

export type ClaimUtxoRow = {
  outpoint: { transactionId: string; index: number };
  amount: string | number | bigint;
  scriptPublicKey: { version: number; script: string };
};

export type ClaimPledgeLive = {
  backerAddress: string;
  p2shAddress: string;
  utxo: ClaimUtxoRow;
};

function refundOpensAtOf(rec: CampaignPageRecord): string {
  if (rec.refundOpensAtMs) return String(rec.refundOpensAtMs);
  return computeRefundOpensAtMs(rec.deadlineMs, rec.graceMs ?? AON_DEFAULT_GRACE_MS);
}

function netKaspa(networkId: string): "testnet-10" | "mainnet" {
  return networkId.includes("mainnet") && !networkId.includes("test") ? "mainnet" : "testnet-10";
}

/**
 * Pick largest UTXOs until sum >= goal (cap 8). Build multi-input l1Build for /sign.
 */
export function buildAoNClaimL1Build(
  rec: CampaignPageRecord,
  live: ClaimPledgeLive[],
): {
  l1Build: L1BrowserBuild;
  inputCount: number;
  totalSompi: string;
  p2shAddresses: string[];
  mode: "single" | "multi";
} {
  const goal = BigInt(rec.goalSompi);
  const refundOpensAtMs = refundOpensAtOf(rec);
  const enriched: Array<{
    live: ClaimPledgeLive;
    amount: bigint;
    bytecodeHex: string;
    dispatchTag: string;
    entryParams: ReturnType<typeof entryOf>["params"];
  }> = [];

  for (const row of live) {
    const amount = BigInt(row.utxo.amount);
    if (amount <= 0n) continue;
    const derived = derivePledgeForBacker(rec, row.backerAddress);
    const tpl = getTemplate("aon_pledge").loadedExample;
    const loaded = rebindAoNPledge(tpl, {
      ownerPkhHex: rec.ownerPkhHex,
      backerPkhHex: derived.backerPkhHex,
      campaignTagHex: rec.campaignTagHex,
      goalSompi: goal,
      deadline: BigInt(refundOpensAtMs),
    });
    const entry = entryOf(loaded, "claim");
    const bytecodeHex = [...loaded.bytecode].map((b) => b.toString(16).padStart(2, "0")).join("");
    enriched.push({
      live: row,
      amount,
      bytecodeHex,
      dispatchTag: entry.dispatch_tag,
      entryParams: entry.params,
    });
  }

  const totalAll = enriched.reduce((a, x) => a + x.amount, 0n);
  if (totalAll < goal) {
    throw new Error(`Goal not met yet (${totalAll} < ${goal} sompi)`);
  }
  if (!enriched.length) throw new Error("No pledge UTXOs to claim");

  let run = [] as typeof enriched;
  let runSum = 0n;
  const sorted = [...enriched].sort((a, b) => (a.amount < b.amount ? 1 : -1));
  for (const u of sorted) {
    run.push(u);
    runSum += u.amount;
    if (runSum >= goal) break;
    if (run.length >= 8) break;
  }
  if (runSum < goal) {
    throw new Error(`Need more pledges to claim (max 8 inputs; have ${runSum} < ${goal})`);
  }

  const fee = 3500000n * BigInt(Math.max(1, run.length));
  const outAmt = runSum - fee;
  if (outAmt <= 0n) throw new Error("Pledges too small to claim after fee");

  const net = netKaspa(rec.networkId);
  const isTestnet = net === "testnet-10";
  const first = run[0]!;
  const l1Build: L1BrowserBuild = {
    buildInBrowser: true,
    kaspaNetwork: kaspaNetworkFor(rec.networkId, isTestnet),
    utxoApiBase: utxoApiBaseFor(rec.networkId, isTestnet),
    bytecodeHex: first.bytecodeHex,
    entryName: "claim",
    dispatchTag: first.dispatchTag,
    entryParams: first.entryParams,
    args: [null, null],
    destinationAddress: rec.ownerAddress,
    feeSompi: String(fee),
    outputAmountSompi: String(outAmt),
    expectedP2shAddress: first.live.p2shAddress,
    sigOpCount: 10,
    p2shInputs: run.map((u) => ({
      outpoint: u.live.utxo.outpoint,
      amount: String(u.amount),
      scriptPublicKey: u.live.utxo.scriptPublicKey,
      bytecodeHex: u.bytecodeHex,
      dispatchTag: u.dispatchTag,
      expectedP2shAddress: u.live.p2shAddress,
      sigOpCount: 10,
    })),
    p2shUtxo: {
      outpoint: first.live.utxo.outpoint,
      amount: String(first.amount),
      scriptPublicKey: first.live.utxo.scriptPublicKey,
    },
  };

  return {
    l1Build,
    inputCount: run.length,
    totalSompi: String(runSum),
    p2shAddresses: run.map((u) => u.live.p2shAddress),
    mode: run.length === 1 ? "single" : "multi",
  };
}
