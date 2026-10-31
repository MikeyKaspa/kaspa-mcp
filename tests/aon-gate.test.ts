import { describe, it, expect } from "vitest";
import { AON_POLICY } from "../src/crowdfund.js";

describe("aon crowdfund security posture", () => {
  it("sibling redeem on-chain; grace window resolves claim/reclaim race", () => {
    expect(AON_POLICY.siblingRedeemPrefixSuffixCheck).toBe(true);
    expect(AON_POLICY.siblingRedeemNotFullyProvenOnChain).toBe(false);
    expect(AON_POLICY.claimAfterDeadlineRace).toBe(false);
    expect(AON_POLICY.reclaimRequiresAfterDeadlinePlusGrace).toBe(true);
    expect(AON_POLICY.claimAnytimeOnceGoalMet).toBe(true);
  });
});
