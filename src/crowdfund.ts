/**
 * All-or-nothing crowdfund (aon_pledge) helpers — Stag Hunt style.
 * authorized_by: pt277u — backer reclaim only after deadline+grace; owner claim anytime goal met.
 */
import { randomBytes } from "node:crypto";
import { getTemplate } from "./l1/templates.js";
import { rebindAoNPledge } from "./l1/artifact.js";
import { ownerPkhFromP2pkAddress } from "./l1/owner-pkh.js";
import { p2shAddress } from "./l1/pure/sign.js";

/** Default grace after campaign deadline before permissionless refunds open (3 days). */
export const AON_DEFAULT_GRACE_MS = 3 * 86_400_000;

export type AoNCampaign = {
  campaignTagHex: string;
  ownerPkhHex: string;
  ownerAddress: string;
  goalSompi: string;
  /** Campaign end — pledging stops; owner should claim by then if goal met. */
  deadlineMs: string;
  /** Extra wait after deadline before reclaim opens (Stag Hunt grace). */
  graceMs: string;
  /** On-chain temporal: deadlineMs + graceMs. Reclaim requires tx.time >= this. */
  refundOpensAtMs: string;
  network: "testnet-10" | "mainnet";
  pledges: Array<{
    backerAddress: string;
    backerPkhHex: string;
    p2shAddress: string;
    amountSompi?: string;
  }>;
};

export function newCampaignTagHex(): string {
  return Buffer.from(randomBytes(32)).toString("hex");
}

export function computeRefundOpensAtMs(
  deadlineMs: number | bigint | string,
  graceMs: number | bigint | string = AON_DEFAULT_GRACE_MS,
): string {
  return String(BigInt(deadlineMs) + BigInt(graceMs));
}

/**
 * Build P2SH. `refundOpensAtMs` is the on-chain temporal (deadline+grace).
 * Pass deadlineMs alone only when it already equals refundOpensAt (legacy).
 */
export function buildAoNPledgeAddress(opts: {
  ownerPkhHex: string;
  backerPkhHex: string;
  campaignTagHex: string;
  goalSompi: number | bigint | string;
  /** On-chain temporal — prefer refundOpensAtMs. */
  deadlineMs?: number | bigint | string;
  refundOpensAtMs?: number | bigint | string;
  network?: "testnet-10" | "mainnet";
}): { p2shAddress: string; bytecodeHex: string } {
  const refundOpensAt = BigInt(opts.refundOpensAtMs ?? opts.deadlineMs ?? 0);
  if (refundOpensAt <= 0n) throw new Error("refundOpensAtMs (or deadlineMs) required");
  const tpl = getTemplate("aon_pledge").loadedExample;
  const loaded = rebindAoNPledge(tpl, {
    ownerPkhHex: opts.ownerPkhHex.replace(/^0x/, "").toLowerCase(),
    backerPkhHex: opts.backerPkhHex.replace(/^0x/, "").toLowerCase(),
    campaignTagHex: opts.campaignTagHex.replace(/^0x/, "").toLowerCase(),
    goalSompi: BigInt(opts.goalSompi),
    deadline: refundOpensAt,
  });
  const net = opts.network || "testnet-10";
  const addr = p2shAddress(loaded.bytecode, net);
  const bytecodeHex = [...loaded.bytecode].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { p2shAddress: addr, bytecodeHex };
}

export function createAoNCampaign(opts: {
  ownerAddress: string;
  goalSompi: number | bigint | string;
  deadlineMs?: number | bigint | string;
  graceMs?: number | bigint | string;
  network?: "testnet-10" | "mainnet";
}): AoNCampaign {
  const ownerPkhHex = ownerPkhFromP2pkAddress(opts.ownerAddress);
  const deadlineMs = String(opts.deadlineMs ?? Date.now() + 7 * 86_400_000);
  const graceMs = String(opts.graceMs ?? AON_DEFAULT_GRACE_MS);
  const refundOpensAtMs = computeRefundOpensAtMs(deadlineMs, graceMs);
  return {
    campaignTagHex: newCampaignTagHex(),
    ownerPkhHex,
    ownerAddress: opts.ownerAddress.trim(),
    goalSompi: String(opts.goalSompi),
    deadlineMs,
    graceMs,
    refundOpensAtMs,
    network: opts.network || "testnet-10",
    pledges: [],
  };
}

export function addAoNPledge(
  campaign: AoNCampaign,
  backerAddress: string,
): AoNCampaign["pledges"][0] & {
  campaignTagHex: string;
  goalSompi: string;
  deadlineMs: string;
  graceMs: string;
  refundOpensAtMs: string;
} {
  const backerPkhHex = ownerPkhFromP2pkAddress(backerAddress);
  const built = buildAoNPledgeAddress({
    ownerPkhHex: campaign.ownerPkhHex,
    backerPkhHex,
    campaignTagHex: campaign.campaignTagHex,
    goalSompi: campaign.goalSompi,
    refundOpensAtMs: campaign.refundOpensAtMs,
    network: campaign.network,
  });
  const pledge = {
    backerAddress: backerAddress.trim(),
    backerPkhHex,
    p2shAddress: built.p2shAddress,
  };
  campaign.pledges.push(pledge);
  return {
    ...pledge,
    campaignTagHex: campaign.campaignTagHex,
    goalSompi: campaign.goalSompi,
    deadlineMs: campaign.deadlineMs,
    graceMs: campaign.graceMs,
    refundOpensAtMs: campaign.refundOpensAtMs,
  };
}

/** Adversarial / product policy (Stag Hunt style). */
export const AON_POLICY = {
  claimRequiresSumGteGoal: true,
  claimAnytimeOnceGoalMet: true,
  reclaimRequiresAfterDeadlinePlusGrace: true,
  reclaimPermissionlessPinnedToBacker: true,
  reclaimRequiresBackerSig: false,
  claimAfterDeadlineRace: false, // resolved by grace window
  siblingRedeemNotFullyProvenOnChain: false,
  siblingRedeemPrefixSuffixCheck: true,
  defaultGraceMs: AON_DEFAULT_GRACE_MS,
  redeemLen: 1075,
  backerOff: 910,
  message:
    "Creator claim co-spends pledges; each input redeem must match this campaign template with only backerPkh varying (on-chain scriptSig prefix/suffix). " +
    "Owner may claim anytime sum >= goal (no deadline wait). " +
    "Backer reclaim is permissionless only after deadline+grace (default 3d); output pinned to backer SPK. " +
    "Owner must claim within the grace window once the goal is met, or backers can reclaim after refunds open.",
};
