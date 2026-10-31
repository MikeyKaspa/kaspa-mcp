/**
 * All-or-nothing crowdfund (aon_pledge) helpers.
 * authorized_by: pt266u — backers MUST reclaim if goal missed.
 */
import { randomBytes } from "node:crypto";
import { getTemplate } from "./l1/templates.js";
import { rebindAoNPledge } from "./l1/artifact.js";
import { ownerPkhFromP2pkAddress } from "./l1/owner-pkh.js";
import { p2shAddress } from "./l1/pure/sign.js";

export type AoNCampaign = {
  campaignTagHex: string;
  ownerPkhHex: string;
  ownerAddress: string;
  goalSompi: string;
  deadlineMs: string;
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

export function buildAoNPledgeAddress(opts: {
  ownerPkhHex: string;
  backerPkhHex: string;
  campaignTagHex: string;
  goalSompi: number | bigint | string;
  deadlineMs: number | bigint | string;
  network?: "testnet-10" | "mainnet";
}): { p2shAddress: string; bytecodeHex: string } {
  const tpl = getTemplate("aon_pledge").loadedExample;
  const loaded = rebindAoNPledge(tpl, {
    ownerPkhHex: opts.ownerPkhHex.replace(/^0x/, "").toLowerCase(),
    backerPkhHex: opts.backerPkhHex.replace(/^0x/, "").toLowerCase(),
    campaignTagHex: opts.campaignTagHex.replace(/^0x/, "").toLowerCase(),
    goalSompi: BigInt(opts.goalSompi),
    deadline: BigInt(opts.deadlineMs),
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
  network?: "testnet-10" | "mainnet";
}): AoNCampaign {
  const ownerPkhHex = ownerPkhFromP2pkAddress(opts.ownerAddress);
  const deadlineMs = String(opts.deadlineMs ?? Date.now() + 7 * 86_400_000);
  return {
    campaignTagHex: newCampaignTagHex(),
    ownerPkhHex,
    ownerAddress: opts.ownerAddress.trim(),
    goalSompi: String(opts.goalSompi),
    deadlineMs,
    network: opts.network || "testnet-10",
    pledges: [],
  };
}

export function addAoNPledge(
  campaign: AoNCampaign,
  backerAddress: string,
): AoNCampaign["pledges"][0] & { campaignTagHex: string; goalSompi: string; deadlineMs: string } {
  const backerPkhHex = ownerPkhFromP2pkAddress(backerAddress);
  const built = buildAoNPledgeAddress({
    ownerPkhHex: campaign.ownerPkhHex,
    backerPkhHex,
    campaignTagHex: campaign.campaignTagHex,
    goalSompi: campaign.goalSompi,
    deadlineMs: campaign.deadlineMs,
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
  };
}

/** Adversarial policy notes encoded for tests / clients. */
export const AON_POLICY = {
  claimRequiresSumGteGoal: true,
  reclaimRequiresAfterDeadline: true,
  reclaimRequiresBackerSig: true,
  claimAfterDeadlineRace: true, // SilverScript only supports tx.time >=
  siblingRedeemNotFullyProvenOnChain: false,
  siblingRedeemPrefixSuffixCheck: true,
  message: "Creator claim co-spends pledges; each input redeem must match this campaign template with only backerPkh varying (on-chain scriptSig prefix/suffix). After deadline each backer reclaim. Claim cannot be CLTV-disabled after deadline (language limit).",
};
