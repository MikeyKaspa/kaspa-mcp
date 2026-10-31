import { describe, it, expect } from "vitest";
import { resolveTemplateBytecodeForFund } from "../src/l1/resolve-template-bytecode.js";
import { rebindAoNPledge, AON_DEMO_GOAL_SOMPI, AON_DEMO_DEADLINE } from "../src/l1/artifact.js";
import { getTemplate, listTemplates } from "../src/l1/templates.js";
import { p2shAddress } from "../src/l1/pure/sign.js";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { loadSilArtifact } from "../src/l1/artifact.js";

const OWNER = "kaspatest:qq8x4g8see6sxhe46zmuwg28cgjauw9csxkxug2gynpfsuszp7kk78yvl9r00";
const SILVERC = process.env.SILVERC_PATH || "/workspace/silverscript-tools/silverc";

describe("template fund security (expected address)", () => {
  it("lists aon_pledge and tip-goal softcap", () => {
    const ids = listTemplates().map((t) => t.id);
    expect(ids).toContain("aon_pledge");
    expect(ids).toContain("softcap");
    expect(getTemplate("softcap").title).toMatch(/TipGoal|SoftCap/i);
    expect(getTemplate("softcap").description).toMatch(/NOT a crowdfund/i);
  });

  it("lockbox without unlockAtMs refuses (no silent new time)", () => {
    expect(() =>
      resolveTemplateBytecodeForFund({
        templateId: "lockbox",
        ownerAddress: OWNER,
        networkId: "kaspa-l1-testnet-10",
      }),
    ).toThrow(/unlockAtMs/i);
  });

  it("lockbox with unlockAtMs is stable: same params → same address", () => {
    const unlock = 1_800_000_000_000;
    const a = resolveTemplateBytecodeForFund({
      templateId: "lockbox",
      ownerAddress: OWNER,
      unlockAtMs: unlock,
      networkId: "kaspa-l1-testnet-10",
    });
    const b = resolveTemplateBytecodeForFund({
      templateId: "lockbox",
      ownerAddress: OWNER,
      unlockAtMs: unlock,
      expectedP2shAddress: a.p2shAddress,
      networkId: "kaspa-l1-testnet-10",
    });
    expect(b.p2shAddress).toBe(a.p2shAddress);
  });

  it("lockbox expectedP2sh mismatch refuses when unlock differs", () => {
    const a = resolveTemplateBytecodeForFund({
      templateId: "lockbox",
      ownerAddress: OWNER,
      unlockAtMs: 1_800_000_000_000,
      networkId: "kaspa-l1-testnet-10",
    });
    expect(() =>
      resolveTemplateBytecodeForFund({
        templateId: "lockbox",
        ownerAddress: OWNER,
        unlockAtMs: 1_900_000_000_000,
        expectedP2shAddress: a.p2shAddress,
        networkId: "kaspa-l1-testnet-10",
      }),
    ).toThrow(/mismatch|Refusing|address/i);
  });

  it("aon_pledge rebind matches silverc; different backers → different addresses", () => {
    const owner = "50e4e615fef343ada5b11030ee9e3c27e7e73b3cab590a68e59edff51340a2a6";
    const tag = "07".repeat(32);
    const goal = AON_DEMO_GOAL_SOMPI;
    const deadline = AON_DEMO_DEADLINE;
    const b1 = "02".repeat(32);
    const b2 = "03".repeat(32);
    const tpl = getTemplate("aon_pledge").loadedExample;
    const r1 = rebindAoNPledge(tpl, {
      ownerPkhHex: owner,
      backerPkhHex: b1,
      campaignTagHex: tag,
      goalSompi: goal,
      deadline,
    });
    const r2 = rebindAoNPledge(tpl, {
      ownerPkhHex: owner,
      backerPkhHex: b2,
      campaignTagHex: tag,
      goalSompi: goal,
      deadline,
    });
    const a1 = p2shAddress(r1.bytecode, "testnet-10");
    const a2 = p2shAddress(r2.bytecode, "testnet-10");
    expect(a1).not.toBe(a2);

    const argsPath = `/tmp/aon-sec-${Math.random().toString(16).slice(2)}.json`;
    writeFileSync(
      argsPath,
      JSON.stringify([
        { kind: "bytes", value: Array.from(Buffer.from(owner, "hex")) },
        { kind: "bytes", value: Array.from(Buffer.from(b1, "hex")) },
        { kind: "bytes", value: Array.from(Buffer.from(tag, "hex")) },
        { kind: "int", value: goal },
        { kind: "int", value: deadline },
      ]),
    );
    const out = execFileSync(SILVERC, ["src/resources/silverscript/aon_pledge.sil", "--constructor-args", argsPath, "-c"], {
      encoding: "utf8",
    });
    const fromSilverc = loadSilArtifact(JSON.parse(out));
    expect(Buffer.from(r1.bytecode).equals(Buffer.from(fromSilverc.bytecode))).toBe(true);
  });

  it("aon resolve refuses without backer/campaign/goal/deadline", () => {
    expect(() =>
      resolveTemplateBytecodeForFund({
        templateId: "aon_pledge",
        ownerAddress: OWNER,
        networkId: "kaspa-l1-testnet-10",
      }),
    ).toThrow(/backer|campaign|goal|deadline/i);
  });
});
