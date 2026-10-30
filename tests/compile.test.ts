import { describe, it, expect } from "vitest";
import { compileSolidityAsync } from "../src/backends/compile.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("compileSolidityAsync", () => {
  it("compiles Counter.sol", async () => {
    const source = readFileSync(join(root, "examples/Counter.sol"), "utf8");
    const out = await compileSolidityAsync(source, { contractName: "Counter" });
    expect(out.contractName).toBe("Counter");
    expect(out.bytecode.startsWith("0x")).toBe(true);
    expect(out.bytecode.length).toBeGreaterThan(10);
    expect(Array.isArray(out.abi)).toBe(true);
  }, 120_000);
});
