import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  loadSilArtifact,
  rebindLockbox,
  rebindSoftCapJar,
  TIPJAR_DEMO_OWNER_PKH_HEX,
  LOCKBOX_DEMO_UNLOCK_AT,
  SOFTCAP_DEMO_GOAL_SOMPI,
} from "../src/l1/artifact.js";
import { getTemplate, listTemplates } from "../src/l1/templates.js";

const SILVERC = process.env.SILVERC_PATH || "/workspace/silverscript-tools/silverc";

function silverc(sil: string, args: unknown[]) {
  const argsPath = `/tmp/lb-ctor-${Math.random().toString(16).slice(2)}.json`;
  writeFileSync(argsPath, JSON.stringify(args));
  const out = execFileSync(SILVERC, [sil, "--constructor-args", argsPath, "-c"], {
    encoding: "utf8",
  });
  return loadSilArtifact(JSON.parse(out));
}

describe("lockbox / softcap", () => {
  it("lists new templates", () => {
    const ids = listTemplates().map((t) => t.id);
    expect(ids).toContain("lockbox");
    expect(ids).toContain("softcap");
  });

  it("lockbox rebind matches silverc", () => {
    const pkh = "11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff";
    const unlock = Date.now() + 3_600_000;
    const rebound = rebindLockbox(getTemplate("lockbox").loadedExample, {
      ownerPkhHex: pkh,
      unlockAt: unlock,
    });
    const fromSilverc = silverc("src/resources/silverscript/lockbox.sil", [
      { kind: "bytes", value: Array.from(Buffer.from(pkh, "hex")) },
      { kind: "int", value: unlock },
    ]);
    expect(Buffer.from(rebound.bytecode).equals(Buffer.from(fromSilverc.bytecode))).toBe(true);
  });

  it("softcap rebind matches silverc", () => {
    const pkh = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
    const goal = 250_000_000;
    const deadline = Date.now() + 86_400_000;
    const rebound = rebindSoftCapJar(getTemplate("softcap").loadedExample, {
      ownerPkhHex: pkh,
      goalSompi: goal,
      deadline,
    });
    const fromSilverc = silverc("src/resources/silverscript/softcap.sil", [
      { kind: "bytes", value: Array.from(Buffer.from(pkh, "hex")) },
      { kind: "int", value: goal },
      { kind: "int", value: deadline },
    ]);
    expect(Buffer.from(rebound.bytecode).equals(Buffer.from(fromSilverc.bytecode))).toBe(true);
  });

  it("demo round-trip lockbox", () => {
    const lock = getTemplate("lockbox");
    const same = rebindLockbox(lock.loadedExample, {
      ownerPkhHex: TIPJAR_DEMO_OWNER_PKH_HEX,
      unlockAt: LOCKBOX_DEMO_UNLOCK_AT,
    });
    expect(Buffer.from(same.bytecode).equals(Buffer.from(lock.loadedExample.bytecode))).toBe(true);
  });
});
