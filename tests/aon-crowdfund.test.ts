import { describe, it, expect } from "vitest";
import {
  createAoNCampaign,
  addAoNPledge,
  buildAoNPledgeAddress,
  AON_POLICY,
} from "../src/crowdfund.js";
import { resolveTemplateBytecodeForFund } from "../src/l1/resolve-template-bytecode.js";

const OWNER = "kaspatest:qq8x4g8see6sxhe46zmuwg28cgjauw9csxkxug2gynpfsuszp7kk78yvl9r00";
const B1 = "kaspatest:qza6ey35a278ft60rhvjfna96dznge4qrlw9zgr7zedngjzqvd97u9t9lscq6";
const B2 = "kaspatest:qrs89htrl7hc785tz6r9985xfp7xz3267wn5pr3wd7e863xddqqkcccpth6zv";

describe("aon crowdfund", () => {
  it("policy documents Michael requirement + CLTV limit", () => {
    expect(AON_POLICY.claimRequiresSumGteGoal).toBe(true);
    expect(AON_POLICY.reclaimRequiresAfterDeadline).toBe(true);
    expect(AON_POLICY.claimAfterDeadlineRace).toBe(true);
  });

  it("create campaign + 3 pledges → distinct P2SH; resolve matches expected", () => {
    const c = createAoNCampaign({ ownerAddress: OWNER, goalSompi: 300_000_000 });
    const p1 = addAoNPledge(c, B1);
    const p2 = addAoNPledge(c, B2);
    const p3 = addAoNPledge(c, OWNER); // third backer = owner addr ok for test
    expect(new Set([p1.p2shAddress, p2.p2shAddress, p3.p2shAddress]).size).toBe(3);

    const r = resolveTemplateBytecodeForFund({
      templateId: "aon_pledge",
      ownerAddress: OWNER,
      backerAddress: B1,
      campaignTagHex: c.campaignTagHex,
      goalSompi: c.goalSompi,
      deadlineMs: c.deadlineMs,
      expectedP2shAddress: p1.p2shAddress,
      networkId: "kaspa-l1-testnet-10",
    });
    expect(r.p2shAddress).toBe(p1.p2shAddress);
    expect(r.rebound).toBe(true);
  });

  it("adversarial: wrong expected address (different goal) refuses", () => {
    const built = buildAoNPledgeAddress({
      ownerPkhHex: "50e4e615fef343ada5b11030ee9e3c27e7e73b3cab590a68e59edff51340a2a6",
      backerPkhHex: "02".repeat(32),
      campaignTagHex: "07".repeat(32),
      goalSompi: 100_000_000,
      deadlineMs: 4_000_000_000_000,
    });
    expect(() =>
      resolveTemplateBytecodeForFund({
        templateId: "aon_pledge",
        ownerPkhHex: "50e4e615fef343ada5b11030ee9e3c27e7e73b3cab590a68e59edff51340a2a6",
        backerPkhHex: "02".repeat(32),
        campaignTagHex: "07".repeat(32),
        goalSompi: 200_000_000, // different goal → different script
        deadlineMs: 4_000_000_000_000,
        expectedP2shAddress: built.p2shAddress,
        networkId: "kaspa-l1-testnet-10",
      }),
    ).toThrow(/mismatch|Refusing|address/i);
  });
});
