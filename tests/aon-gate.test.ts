import { describe, it, expect } from "vitest";
import { AON_POLICY } from "../src/crowdfund.js";

describe("aon crowdfund security posture", () => {
  it("sibling redeem is enforced on-chain; deadline race still documented", () => {
    expect(AON_POLICY.siblingRedeemPrefixSuffixCheck).toBe(true);
    expect(AON_POLICY.siblingRedeemNotFullyProvenOnChain).toBe(false);
    expect(AON_POLICY.claimAfterDeadlineRace).toBe(true);
  });
});
