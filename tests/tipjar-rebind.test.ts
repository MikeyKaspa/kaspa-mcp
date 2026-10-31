import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { loadSilArtifact, rebindTipjarOwnerPkh, TIPJAR_DEMO_OWNER_PKH_HEX } from "../src/l1/artifact.js";
import { getTemplate } from "../src/l1/templates.js";

const SILVERC = process.env.SILVERC_PATH || "/workspace/silverscript-tools/silverc";

describe("tipjar ownerPkh rebind (Worker path)", () => {
  it("matches silverc byte-for-byte for a new ownerPkh", () => {
    const tipjar = getTemplate("tipjar");
    const newPkh = "11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff";
    const rebound = rebindTipjarOwnerPkh(tipjar.loadedExample, newPkh);
    expect(rebound.bytecode).not.toEqual(tipjar.loadedExample.bytecode);

    const argsPath = "/tmp/tipjar-rebind-ctor.json";
    writeFileSync(
      argsPath,
      JSON.stringify([{ kind: "bytes", value: Array.from(Buffer.from(newPkh, "hex")) }]),
    );
    const out = execFileSync(
      SILVERC,
      ["src/resources/silverscript/tipjar.sil", "--constructor-args", argsPath, "-c"],
      { encoding: "utf8" },
    );
    const fromSilverc = loadSilArtifact(JSON.parse(out));
    expect(Buffer.from(rebound.bytecode).equals(Buffer.from(fromSilverc.bytecode))).toBe(true);
  });

  it("keeps demo pkh when rebound to demo", () => {
    const tipjar = getTemplate("tipjar");
    const same = rebindTipjarOwnerPkh(tipjar.loadedExample, TIPJAR_DEMO_OWNER_PKH_HEX);
    expect(Buffer.from(same.bytecode).equals(Buffer.from(tipjar.loadedExample.bytecode))).toBe(true);
  });
});
