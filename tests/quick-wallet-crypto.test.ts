import { describe, it, expect } from "vitest";
import {
  assertAddressMatchesNetwork,
  assertQuickWalletCap,
  decryptPrivateKeyHex,
  deriveKeyFromPin,
  encryptPrivateKeyHex,
  formatKasFromSompi,
  mainnetRequiresBackupAck,
  parseKasAmountToSompi,
  QUICK_WALLET_CAP_SOMPI,
  sompiFromKas,
} from "../src/sign/quick-wallet-crypto.js";

describe("quick-wallet-crypto", () => {
  it("formats and parses KAS amounts", () => {
    expect(formatKasFromSompi(150_000_000n)).toBe("1.5");
    expect(parseKasAmountToSompi("1.5")).toBe(150_000_000n);
    expect(sompiFromKas(50)).toBe(QUICK_WALLET_CAP_SOMPI);
  });

  it("enforces address network prefixes", () => {
    expect(() =>
      assertAddressMatchesNetwork("kaspatest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", "testnet-10"),
    ).not.toThrow();
    expect(() => assertAddressMatchesNetwork("kaspa:qz", "testnet-10")).toThrow(/kaspatest/);
    expect(() => assertAddressMatchesNetwork("kaspatest:q", "mainnet")).toThrow(/kaspa:/);
  });

  it("enforces 50 KAS hard cap", () => {
    expect(() => assertQuickWalletCap(QUICK_WALLET_CAP_SOMPI)).not.toThrow();
    expect(() => assertQuickWalletCap(QUICK_WALLET_CAP_SOMPI + 1n)).toThrow(/cap/i);
  });

  it("requires backup ack on mainnet", () => {
    expect(mainnetRequiresBackupAck({ network: "mainnet" })).toBe(true);
    expect(mainnetRequiresBackupAck({ network: "mainnet", backupAckAt: Date.now() })).toBe(false);
    expect(mainnetRequiresBackupAck({ network: "testnet-10" })).toBe(false);
  });

  it("encrypts and decrypts a private key with PIN-derived AES", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKeyFromPin("test-pin-ok", salt);
    const hex = "a".repeat(64);
    const blob = await encryptPrivateKeyHex(hex, key, { kdf: "PBKDF2-SHA256", salt });
    expect(blob.ciphertextB64).toBeTruthy();
    expect(blob.ciphertextB64).not.toContain(hex);
    const key2 = await deriveKeyFromPin("test-pin-ok", salt);
    await expect(decryptPrivateKeyHex(blob, key2)).resolves.toBe(hex);
    const bad = await deriveKeyFromPin("wrong-pin!!", salt);
    await expect(decryptPrivateKeyHex(blob, bad)).rejects.toThrow();
  });
});
