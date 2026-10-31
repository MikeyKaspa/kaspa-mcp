import { describe, it, expect } from "vitest";
import { getTemplate } from "../src/l1/templates.js";
import { p2shAddress } from "../src/l1/pure/sign.js";
import { resolveTemplateBytecodeForFund } from "../src/l1/resolve-template-bytecode.js";
import { ownerPkhFromP2pkAddress } from "../src/l1/owner-pkh.js";
import { rebindTipjarOwnerPkh } from "../src/l1/artifact.js";

const OWNER = "kaspatest:qq8x4g8see6sxhe46zmuwg28cgjauw9csxkxug2gynpfsuszp7kk78yvl9r00";
const OWNER_BOUND = "kaspatest:ppjqe2ua2gedvgyfgaxrg0zyjj2q08q8sx6lnjmrkew4c08pnxdr7yspdrc8y";
const DEMO_DEFAULT = "kaspatest:prfqwa3gj2y245963eqg28ce34tce9qtxfc43guxvwlz9rd05xflg6ardagg2";

describe("tipjar fund rebind (security)", () => {
  it("demo template P2SH is the unbound default (must never be funded as user jar)", () => {
    const tipjar = getTemplate("tipjar");
    expect(p2shAddress(tipjar.loadedExample.bytecode, "testnet-10")).toBe(DEMO_DEFAULT);
  });

  it("ownerPkhFromP2pkAddress + rebind yields the live owner-bound tipjar", () => {
    const tipjar = getTemplate("tipjar");
    const pkh = ownerPkhFromP2pkAddress(OWNER);
    const rebound = rebindTipjarOwnerPkh(tipjar.loadedExample, pkh);
    expect(p2shAddress(rebound.bytecode, "testnet-10")).toBe(OWNER_BOUND);
  });

  it("resolveTemplateBytecodeForFund(tipjar) rebinds to owner and matches expected", () => {
    const r = resolveTemplateBytecodeForFund({
      templateId: "tipjar",
      ownerAddress: OWNER,
      expectedP2shAddress: OWNER_BOUND,
      networkId: "kaspa-l1-testnet-10",
    });
    expect(r.rebound).toBe(true);
    expect(r.p2shAddress).toBe(OWNER_BOUND);
    expect(r.p2shAddress).not.toBe(DEMO_DEFAULT);
  });

  it("resolveTemplateBytecodeForFund refuses expectedP2sh mismatch (demo vs owner)", () => {
    expect(() =>
      resolveTemplateBytecodeForFund({
        templateId: "tipjar",
        ownerAddress: OWNER,
        expectedP2shAddress: DEMO_DEFAULT,
        networkId: "kaspa-l1-testnet-10",
      }),
    ).toThrow(/mismatch|Refusing/i);
  });

  it("tipjar without ownerAddress/ownerPkhHex throws (never silent demo fund)", () => {
    expect(() =>
      resolveTemplateBytecodeForFund({
        templateId: "tipjar",
        networkId: "kaspa-l1-testnet-10",
      }),
    ).toThrow(/ownerAddress|ownerPkh/i);
  });
});
