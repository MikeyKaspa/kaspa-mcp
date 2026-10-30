import { describe, it, expect } from "vitest";
import { getNetwork } from "../src/networks.js";
import { SafetyError, normalizeTestnetPrivateKey, redactSecrets } from "../src/safety.js";
import { assertRawTxShape, assertSourceSize, MAX_SOURCE_CHARS } from "../src/limits.js";
import { EvmBackend } from "../src/backends/evm.js";

const MAINNET = getNetwork("kasplex-mainnet");
const TESTNET = getNetwork("kasplex-testnet");
const KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("normalizeTestnetPrivateKey", () => {
  it("rejects mainnet keys (exact)", () => {
    expect(() => normalizeTestnetPrivateKey(MAINNET, KEY)).toThrow(SafetyError);
  });
  it("rejects mainnet keys with whitespace", () => {
    expect(() => normalizeTestnetPrivateKey(MAINNET, `  ${KEY}  `)).toThrow(/Refusing private key/);
  });
  it("rejects mainnet 0x-less hex", () => {
    expect(() => normalizeTestnetPrivateKey(MAINNET, KEY.slice(2))).toThrow(/Refusing private key/);
  });
  it("rejects mainnet uppercase still as mainnet refusal", () => {
    expect(() => normalizeTestnetPrivateKey(MAINNET, KEY.toUpperCase())).toThrow(/Refusing private key/);
  });
  it("rejects mnemonic on mainnet", () => {
    expect(() =>
      normalizeTestnetPrivateKey(
        MAINNET,
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      ),
    ).toThrow(/Refusing private key/);
  });
  it("rejects JSON keystore on mainnet", () => {
    expect(() => normalizeTestnetPrivateKey(MAINNET, '{"version":3,"crypto":{}}')).toThrow(
      /Refusing private key/,
    );
  });
  it("accepts trimmed testnet hex", () => {
    expect(normalizeTestnetPrivateKey(TESTNET, `  ${KEY}  `)).toBe(KEY);
  });
  it("rejects mnemonic on testnet", () => {
    expect(() =>
      normalizeTestnetPrivateKey(
        TESTNET,
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      ),
    ).toThrow(/0x-prefixed/);
  });
});

describe("limits", () => {
  it("rejects oversized source", () => {
    expect(() => assertSourceSize("x".repeat(MAX_SOURCE_CHARS + 1))).toThrow(/exceeds/);
  });
  it("rejects bad rawTx", () => {
    expect(() => assertRawTxShape("deadbeef")).toThrow(/0x-prefixed/);
    expect(() => assertRawTxShape("0xzz")).toThrow(/0x-prefixed/);
  });
});

describe("redactSecrets", () => {
  it("redacts 32-byte hex and mnemonics", () => {
    expect(redactSecrets(`key=${KEY}`)).toContain("REDACTED_32BYTE");
    expect(
      redactSecrets(
        "seed abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      ),
    ).toContain("REDACTED_MNEMONIC");
  });
});

describe("EvmBackend mainnet deploy", () => {
  it("rejects private keys before broadcast", async () => {
    const backend = new EvmBackend();
    await expect(
      backend.deploy(
        MAINNET,
        { contractName: "X", abi: [], bytecode: "0x6000", compiler: "test" },
        { privateKey: KEY },
      ),
    ).rejects.toBeInstanceOf(SafetyError);
  });
});
