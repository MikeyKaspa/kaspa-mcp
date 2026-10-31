import { describe, it, expect, beforeEach } from "vitest";
import {
  setCampaignPageContext,
  createCampaignPage,
  derivePledgeForBacker,
} from "../src/campaign-page.js";
import { buildAoNClaimL1Build } from "../src/campaign-claim.js";
import { ownerPkhFromP2pkAddress } from "../src/l1/owner-pkh.js";
import { AON_DEFAULT_GRACE_MS } from "../src/crowdfund.js";

const OWNER = "kaspatest:qq8x4g8see6sxhe46zmuwg28cgjauw9csxkxug2gynpfsuszp7kk78yvl9r00";
const B1 = "kaspatest:qza6ey35a278ft60rhvjfna96dznge4qrlw9zgr7zedngjzqvd97u9t9lscq6";
const B2 = "kaspatest:qrs89htrl7hc785tz6r9985xfp7xz3267wn5pr3wd7e863xddqqkcccpth6zv";
const B3 = "kaspatest:qpr5w4qzmzn52785wafeceaqlxfssl5yr9h344j5qkfdtkt64qsa5r2hku3pg";

describe("AoN multi-input claim build (share-page path)", () => {
  beforeEach(() => {
    setCampaignPageContext({ kv: null, publicBaseUrl: "https://example.test" });
  });

  it("3 pledges of 1 KAS toward 3 KAS goal → p2shInputs length 3, distinct bytecodes", async () => {
    const deadline = Date.now() + 7 * 86_400_000;
    const { record } = await createCampaignPage({
      networkId: "kaspa-l1-testnet-10",
      ownerAddress: OWNER,
      ownerPkhHex: ownerPkhFromP2pkAddress(OWNER),
      campaignTagHex: "ab".repeat(32),
      goalSompi: 300_000_000,
      deadlineMs: deadline,
      graceMs: AON_DEFAULT_GRACE_MS,
    });
    const d1 = derivePledgeForBacker(record, B1);
    const d2 = derivePledgeForBacker(record, B2);
    const d3 = derivePledgeForBacker(record, B3);
    record.pledges = [
      { backerAddress: B1, backerPkhHex: d1.backerPkhHex, p2shAddress: d1.p2shAddress, registeredAt: new Date().toISOString() },
      { backerAddress: B2, backerPkhHex: d2.backerPkhHex, p2shAddress: d2.p2shAddress, registeredAt: new Date().toISOString() },
      { backerAddress: B3, backerPkhHex: d3.backerPkhHex, p2shAddress: d3.p2shAddress, registeredAt: new Date().toISOString() },
    ];

    const fake = (p2sh: string, n: number) => ({
      outpoint: { transactionId: "aa".repeat(32).slice(0, 64), index: n },
      amount: 100_000_000n,
      scriptPublicKey: { version: 0, script: "00" + "11".repeat(34) },
    });

    const built = buildAoNClaimL1Build(record, [
      { backerAddress: B1, p2shAddress: d1.p2shAddress, utxo: fake(d1.p2shAddress, 0) },
      { backerAddress: B2, p2shAddress: d2.p2shAddress, utxo: fake(d2.p2shAddress, 1) },
      { backerAddress: B3, p2shAddress: d3.p2shAddress, utxo: fake(d3.p2shAddress, 2) },
    ]);

    expect(built.mode).toBe("multi");
    expect(built.inputCount).toBe(3);
    expect(built.l1Build.p2shInputs).toHaveLength(3);
    expect(built.totalSompi).toBe("300000000");
    const bcs = built.l1Build.p2shInputs!.map((i) => i.bytecodeHex);
    expect(new Set(bcs).size).toBe(3); // each backer → distinct redeem
    expect(built.l1Build.entryName).toBe("claim");
    expect(built.l1Build.args).toEqual([null, null]);
    expect(BigInt(built.l1Build.outputAmountSompi!)).toBe(300_000_000n - 3500000n * 3n);
  });

  it("refuses when sum < goal", async () => {
    const { record } = await createCampaignPage({
      networkId: "kaspa-l1-testnet-10",
      ownerAddress: OWNER,
      campaignTagHex: "cd".repeat(32),
      goalSompi: 500_000_000,
      deadlineMs: Date.now() + 86_400_000,
    });
    const d1 = derivePledgeForBacker(record, B1);
    expect(() =>
      buildAoNClaimL1Build(record, [
        {
          backerAddress: B1,
          p2shAddress: d1.p2shAddress,
          utxo: {
            outpoint: { transactionId: "bb".repeat(32), index: 0 },
            amount: 100_000_000n,
            scriptPublicKey: { version: 0, script: "0011" },
          },
        },
      ]),
    ).toThrow(/Goal not met/);
  });
});
