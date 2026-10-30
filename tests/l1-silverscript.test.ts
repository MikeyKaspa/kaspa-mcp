import { describe, it, expect } from "vitest";
import { listTemplates, getTemplate } from "../src/l1/templates.js";
import { loadSilArtifact } from "../src/l1/artifact.js";
import { buildEntryUnlock, encodePush, bytesToHex } from "../src/l1/script.js";
import { deriveP2shAddress } from "../src/l1/p2sh.js";
import { compileSilverscript, isSilvercAvailable } from "../src/l1/compile.js";

describe("silverscript templates", () => {
  it("ships tipjar, timeout_vault, escrow", () => {
    const ids = listTemplates().map((t) => t.id);
    expect(ids).toEqual(["tipjar", "timeout_vault", "escrow"]);
  });

  it("pinned tipjar artifact loads and has withdraw entry", () => {
    const t = getTemplate("tipjar");
    expect(t.loadedExample.entries.withdraw.dispatch_tag).toMatch(/^[0-9a-f]{8}$/i);
    expect(t.loadedExample.bytecode.length).toBeGreaterThan(20);
    expect(t.exampleMeta.silverc).toBe("v1.0.0");
  });

  it("deriveP2sh matches pinned example address for tipjar", async () => {
    const t = getTemplate("tipjar");
    const d = await deriveP2shAddress(t.loadedExample.bytecode, "testnet-10");
    expect(d.address).toBe(t.exampleMeta.exampleP2shTestnet10);
  });
});

describe("script unlock encoder", () => {
  it("encodes pushes and builds entry unlock length", () => {
    const push = encodePush(Uint8Array.from([1, 2, 3]));
    expect(push[0]).toBe(3);
    const t = getTemplate("tipjar");
    const entry = t.loadedExample.entries.withdraw;
    const pk = new Uint8Array(32);
    const sig = Uint8Array.of(0x41, ...new Uint8Array(64), 1); // fake push-encoded sig
    const unlock = buildEntryUnlock(entry, [pk, sig]);
    expect(unlock.length).toBeGreaterThan(32 + 66 + 5);
  });
});

describe("loadSilArtifact", () => {
  it("rejects garbage", () => {
    expect(() => loadSilArtifact({ foo: 1 })).toThrow(/contracts/);
  });
});

describe("silverscript_compile self-host", () => {
  it("compiles tipjar source when silverc is on PATH/SILVERC_PATH", () => {
    process.env.SILVERC_PATH = process.env.SILVERC_PATH || "/workspace/silverscript-tools/silverc";
    if (!isSilvercAvailable()) return;
    const t = getTemplate("tipjar");
    // Use demo pkh from meta
    const pkhHex = t.exampleMeta.demoPkhHex as string | undefined;
    const pkh = pkhHex
      ? Array.from(Buffer.from(pkhHex, "hex"))
      : Array.from({ length: 32 }, (_, i) => i);
    const loaded = compileSilverscript({
      source: t.source,
      constructorArgs: [{ kind: "bytes", value: pkh }],
    });
    expect(loaded.contractName).toBe("TipJar");
    expect(loaded.bytecodeHex).toBe(t.loadedExample.bytecodeHex);
  });
});
