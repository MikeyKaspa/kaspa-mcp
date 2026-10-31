import { describe, it, expect } from "vitest";
import { createAoNCampaign, addAoNPledge } from "../src/crowdfund.js";
import { AON_DEMO_DEADLINE } from "../src/l1/artifact.js";

const OWNER = "kaspatest:qq8x4g8see6sxhe46zmuwg28cgjauw9csxkxug2gynpfsuszp7kk78yvl9r00";
const B1 = "kaspatest:qza6ey35a278ft60rhvjfna96dznge4qrlw9zgr7zedngjzqvd97u9t9lscq6";

describe("crowdfund public path (no compile)", () => {
  it("create campaign + pledge with user ownerAddress (rebind only)", () => {
    const c = createAoNCampaign({
      ownerAddress: OWNER,
      goalSompi: 500_000_000, // 5 test KAS
      deadlineMs: Date.now() + 2 * 86_400_000,
      network: "testnet-10",
    });
    expect(c.ownerPkhHex).toHaveLength(64);
    expect(c.goalSompi).toBe("500000000");
    const p = addAoNPledge(c, B1);
    expect(p.p2shAddress).toMatch(/^kaspatest:p/);
  });
});
