import { describe, it, expect } from "vitest";
import { getTemplate } from "../src/l1/templates.js";
import {
  rebindAoNPledge,
  AON_DEMO_OWNER_PKH_HEX,
  AON_DEMO_CAMPAIGN_TAG_HEX,
  AON_DEMO_GOAL_SOMPI,
  AON_DEMO_DEADLINE,
} from "../src/l1/artifact.js";
import {
  buildAoNPledgeAddress,
  createAoNCampaign,
  addAoNPledge,
  AON_POLICY,
} from "../src/crowdfund.js";
import { ownerPkhFromP2pkAddress } from "../src/l1/owner-pkh.js";

const REDEEM_LEN = 1075;
const BACKER_OFF = 910;

const OWNER = "kaspatest:qq8x4g8see6sxhe46zmuwg28cgjauw9csxkxug2gynpfsuszp7kk78yvl9r00";
const B1 = "kaspatest:qza6ey35a278ft60rhvjfna96dznge4qrlw9zgr7zedngjzqvd97u9t9lscq6";
const B2 = "kaspatest:qrs89htrl7hc785tz6r9985xfp7xz3267wn5pr3wd7e863xddqqkcccpth6zv";

function hexToBytes(h: string): Uint8Array {
  const s = h.replace(/^0x/, "");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe("AoNPledge sibling-redeem enforcement", () => {
  it("bytecode layout: only backerPkh window differs across backers (prefix/suffix invariant)", () => {
    const t = getTemplate("aon_pledge");
    expect(t).toBeTruthy();
    const loaded = t!.loadedExample;
    const a = rebindAoNPledge(loaded, {
      ownerPkhHex: AON_DEMO_OWNER_PKH_HEX,
      backerPkhHex: "11".repeat(32),
      campaignTagHex: AON_DEMO_CAMPAIGN_TAG_HEX,
      goalSompi: AON_DEMO_GOAL_SOMPI,
      deadline: AON_DEMO_DEADLINE,
    });
    const b = rebindAoNPledge(loaded, {
      ownerPkhHex: AON_DEMO_OWNER_PKH_HEX,
      backerPkhHex: "22".repeat(32),
      campaignTagHex: AON_DEMO_CAMPAIGN_TAG_HEX,
      goalSompi: AON_DEMO_GOAL_SOMPI,
      deadline: AON_DEMO_DEADLINE,
    });
    const ba = hexToBytes(a.bytecodeHex);
    const bb = hexToBytes(b.bytecodeHex);
    expect(ba.length).toBe(REDEEM_LEN);
    expect(bb.length).toBe(REDEEM_LEN);
    const diffs: number[] = [];
    for (let i = 0; i < ba.length; i++) if (ba[i] !== bb[i]) diffs.push(i);
    expect(diffs.length).toBe(32);
    expect(diffs[0]).toBe(BACKER_OFF);
    expect(diffs[31]).toBe(BACKER_OFF + 31);
    expect(ba.slice(0, BACKER_OFF)).toEqual(bb.slice(0, BACKER_OFF));
    expect(ba.slice(BACKER_OFF + 32)).toEqual(bb.slice(BACKER_OFF + 32));
  });

  it("adversarial: creator-controlled P2SH with different campaignTag does NOT share redeem prefix", () => {
    const ownerPkh = ownerPkhFromP2pkAddress(OWNER);
    const backerPkh = ownerPkhFromP2pkAddress(B1);
    const real = buildAoNPledgeAddress({
      ownerPkhHex: ownerPkh,
      backerPkhHex: backerPkh,
      campaignTagHex: AON_DEMO_CAMPAIGN_TAG_HEX,
      goalSompi: AON_DEMO_GOAL_SOMPI,
      deadlineMs: AON_DEMO_DEADLINE,
    });
    // Inflator: same params except attacker picks a DIFFERENT tag (or own script).
    // Old buggy claim only checked P2SH length + sum — this would have counted.
    const inflator = buildAoNPledgeAddress({
      ownerPkhHex: ownerPkh,
      backerPkhHex: ownerPkh, // creator as "backer"
      campaignTagHex: "aa".repeat(32),
      goalSompi: AON_DEMO_GOAL_SOMPI,
      deadlineMs: AON_DEMO_DEADLINE,
    });
    const br = hexToBytes(real.bytecodeHex);
    const bi = hexToBytes(inflator.bytecodeHex);
    expect(br.length).toBe(bi.length);
    expect(Buffer.from(br.slice(0, BACKER_OFF)).equals(Buffer.from(bi.slice(0, BACKER_OFF)))).toBe(
      false,
    );
    expect(real.p2shAddress).not.toBe(inflator.p2shAddress);
  });

  it("adversarial: tipjar / unrelated template bytecode length differs (claim length gate fails)", () => {
    const tip = getTemplate("tipjar");
    expect(tip).toBeTruthy();
    const aon = getTemplate("aon_pledge")!;
    const pledge = rebindAoNPledge(aon.loadedExample, {
      ownerPkhHex: AON_DEMO_OWNER_PKH_HEX,
      backerPkhHex: "33".repeat(32),
      campaignTagHex: AON_DEMO_CAMPAIGN_TAG_HEX,
      goalSompi: AON_DEMO_GOAL_SOMPI,
      deadline: AON_DEMO_DEADLINE,
    });
    expect(tip!.loadedExample.bytecode.length).not.toBe(hexToBytes(pledge.bytecodeHex).length);
  });

  it("policy documents on-chain sibling check and grace window (race resolved)", () => {
    expect(AON_POLICY.siblingRedeemPrefixSuffixCheck).toBe(true);
    expect(AON_POLICY.siblingRedeemNotFullyProvenOnChain).toBe(false);
    expect(AON_POLICY.claimAfterDeadlineRace).toBe(false);
    expect(AON_POLICY.reclaimRequiresAfterDeadlinePlusGrace).toBe(true);
  });

  it("two backers same campaign share redeem prefix/suffix; attacker tag does not", () => {
    const c = createAoNCampaign({
      ownerAddress: OWNER,
      goalSompi: AON_DEMO_GOAL_SOMPI,
      deadlineMs: AON_DEMO_DEADLINE,
      network: "testnet-10",
    });
    c.campaignTagHex = AON_DEMO_CAMPAIGN_TAG_HEX;
    const p1 = addAoNPledge(c, B1);
    const p2 = addAoNPledge(c, B2);
    const b1 = hexToBytes(
      buildAoNPledgeAddress({
        ownerPkhHex: c.ownerPkhHex,
        backerPkhHex: p1.backerPkhHex,
        campaignTagHex: c.campaignTagHex,
        goalSompi: c.goalSompi,
        deadlineMs: c.deadlineMs,
      }).bytecodeHex,
    );
    const b2 = hexToBytes(
      buildAoNPledgeAddress({
        ownerPkhHex: c.ownerPkhHex,
        backerPkhHex: p2.backerPkhHex,
        campaignTagHex: c.campaignTagHex,
        goalSompi: c.goalSompi,
        deadlineMs: c.deadlineMs,
      }).bytecodeHex,
    );
    const attacker = buildAoNPledgeAddress({
      ownerPkhHex: c.ownerPkhHex,
      backerPkhHex: c.ownerPkhHex,
      campaignTagHex: "ff".repeat(32),
      goalSompi: c.goalSompi,
      deadlineMs: c.deadlineMs,
    });
    const ba = hexToBytes(attacker.bytecodeHex);
    expect(b1.slice(0, BACKER_OFF)).toEqual(b2.slice(0, BACKER_OFF));
    expect(b1.slice(BACKER_OFF + 32)).toEqual(b2.slice(BACKER_OFF + 32));
    expect(p1.p2shAddress).not.toBe(p2.p2shAddress);
    expect(Buffer.from(b1.slice(0, BACKER_OFF)).equals(Buffer.from(ba.slice(0, BACKER_OFF)))).toBe(
      false,
    );
  });
});
