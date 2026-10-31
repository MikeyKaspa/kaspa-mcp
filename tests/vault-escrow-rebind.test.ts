import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  loadSilArtifact,
  rebindTimeoutVaultKeys,
  rebindEscrowParties,
  DEMO_XONLY_PUB_HEX,
  TIPJAR_DEMO_OWNER_PKH_HEX,
} from "../src/l1/artifact.js";
import { getTemplate } from "../src/l1/templates.js";

const SILVERC = process.env.SILVERC_PATH || "/workspace/silverscript-tools/silverc";

function silverc(sil: string, args: unknown[]) {
  const argsPath = `/tmp/rebind-ctor-${Math.random().toString(16).slice(2)}.json`;
  writeFileSync(argsPath, JSON.stringify(args));
  const out = execFileSync(SILVERC, [sil, "--constructor-args", argsPath, "-c"], {
    encoding: "utf8",
  });
  return loadSilArtifact(JSON.parse(out));
}

describe("timeout_vault / escrow rebind (Worker path)", () => {
  it("vault matches silverc for new sender/recipient", () => {
    const sender = "11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff";
    const recipient = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
    const vault = getTemplate("timeout_vault");
    const rebound = rebindTimeoutVaultKeys(vault.loadedExample, {
      senderXonlyHex: sender,
      recipientXonlyHex: recipient,
    });
    const fromSilverc = silverc("src/resources/silverscript/timeout_vault.sil", [
      { kind: "bytes", value: Array.from(Buffer.from(sender, "hex")) },
      { kind: "bytes", value: Array.from(Buffer.from(recipient, "hex")) },
      { kind: "int", value: 4_000_000_000_000 },
    ]);
    expect(Buffer.from(rebound.bytecode).equals(Buffer.from(fromSilverc.bytecode))).toBe(true);
  });

  it("vault demo keys round-trip", () => {
    const vault = getTemplate("timeout_vault");
    const same = rebindTimeoutVaultKeys(vault.loadedExample, {
      senderXonlyHex: DEMO_XONLY_PUB_HEX,
      recipientXonlyHex: DEMO_XONLY_PUB_HEX,
    });
    expect(Buffer.from(same.bytecode).equals(Buffer.from(vault.loadedExample.bytecode))).toBe(true);
  });

  it("escrow matches silverc for new arbiter/buyer/seller", () => {
    const arbiter = "11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff";
    const buyer = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
    const seller = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const esc = getTemplate("escrow");
    const rebound = rebindEscrowParties(esc.loadedExample, {
      arbiterPkhHex: arbiter,
      buyerXonlyHex: buyer,
      sellerXonlyHex: seller,
    });
    const fromSilverc = silverc("src/resources/silverscript/escrow.sil", [
      { kind: "bytes", value: Array.from(Buffer.from(arbiter, "hex")) },
      { kind: "bytes", value: Array.from(Buffer.from(buyer, "hex")) },
      { kind: "bytes", value: Array.from(Buffer.from(seller, "hex")) },
    ]);
    expect(Buffer.from(rebound.bytecode).equals(Buffer.from(fromSilverc.bytecode))).toBe(true);
  });

  it("escrow demo parties round-trip", () => {
    const esc = getTemplate("escrow");
    const same = rebindEscrowParties(esc.loadedExample, {
      arbiterPkhHex: TIPJAR_DEMO_OWNER_PKH_HEX,
      buyerXonlyHex: DEMO_XONLY_PUB_HEX,
      sellerXonlyHex: DEMO_XONLY_PUB_HEX,
    });
    expect(Buffer.from(same.bytecode).equals(Buffer.from(esc.loadedExample.bytecode))).toBe(true);
  });
});
