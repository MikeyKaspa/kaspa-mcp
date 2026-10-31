import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getNetwork } from "../src/networks.js";
import { SafetyError } from "../src/safety.js";
import {
  assertNotSharedDemo,
  createSpendingWallet,
  isSharedPublicDemo,
  loadSpendingPrivateKeyHex,
  maxMainnetKas,
  persistSpendingKey,
  spendingWalletStatus,
  assertCanAutoSign,
} from "../src/spending-wallet.js";

const TESTNET = getNetwork("kaspa-l1-testnet-10");
const KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const MAIN = "kaspatest:qza6ey35a278ft60rhvjfna96dznge4qrlw9zgr7zedngjzqvd97u9t9lscq6";

describe("spending wallet gates", () => {
  const prev: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of [
      "MCP_PUBLIC",
      "KASPA_SPENDING_PRIVATE_KEY",
      "KASPA_SPENDING_WALLET_PATH",
      "KASPA_SPENDING_REGISTRY_PATH",
      "KASPA_SPENDING_MAINNET",
      "KASPA_SPENDING_MAX_KAS",
    ]) {
      prev[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("shared demo refuses create/auto-sign", () => {
    process.env.MCP_PUBLIC = "true";
    expect(isSharedPublicDemo()).toBe(true);
    expect(() => assertNotSharedDemo("test")).toThrow(SafetyError);
  });

  it("loads key from env when not shared", () => {
    process.env.KASPA_SPENDING_PRIVATE_KEY = KEY;
    const loaded = loadSpendingPrivateKeyHex();
    expect(loaded?.source).toBe("env");
    expect(loaded?.hex).toBe(KEY);
  });

  it("loads key from file", () => {
    const dir = mkdtempSync(join(tmpdir(), "kaspa-spend-"));
    const path = join(dir, "w.key");
    persistSpendingKey(KEY, path);
    process.env.KASPA_SPENDING_WALLET_PATH = path;
    const loaded = loadSpendingPrivateKeyHex();
    expect(loaded?.source).toBe("file");
    expect(loaded?.hex).toBe(KEY);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects mnemonic-like spending key material", () => {
    process.env.KASPA_SPENDING_PRIVATE_KEY =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    expect(() => loadSpendingPrivateKeyHex()).toThrow(/0x-prefixed|hex/);
  });

  it("mainnet auto-sign requires opt-in + registry", () => {
    process.env.KASPA_SPENDING_PRIVATE_KEY = KEY;
    const main = getNetwork("kaspa-l1-mainnet");
    expect(() => assertCanAutoSign(main)).toThrow(/KASPA_SPENDING_MAINNET/);
  });

  it("default max mainnet kas is 50; can lower", () => {
    expect(maxMainnetKas()).toBe(50);
    process.env.KASPA_SPENDING_MAX_KAS = "10";
    expect(maxMainnetKas()).toBe(10);
  });

  it("status on shared demo is not configured", async () => {
    process.env.MCP_PUBLIC = "true";
    const s = await spendingWalletStatus(TESTNET);
    expect(s.configured).toBe(false);
    expect(s.sharedDemo).toBe(true);
  });
});

describe("spending_wallet_create", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kaspa-spend-create-"));
    delete process.env.MCP_PUBLIC;
    delete process.env.KASPA_SPENDING_PRIVATE_KEY;
    process.env.KASPA_SPENDING_WALLET_PATH = join(dir, "spend.key");
    process.env.KASPA_SPENDING_REGISTRY_PATH = join(dir, "reg.json");
  });
  afterEach(() => {
    delete process.env.KASPA_SPENDING_WALLET_PATH;
    delete process.env.KASPA_SPENDING_REGISTRY_PATH;
    delete process.env.KASPA_SPENDING_PRIVATE_KEY;
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates with mainAddress, persists, no key in result object", async () => {
    const created = await createSpendingWallet({ network: TESTNET, mainAddress: MAIN });
    expect(created.address.startsWith("kaspatest:")).toBe(true);
    expect(created.mainAddress).toBe(MAIN);
    expect(created).not.toHaveProperty("privateKeyHex");
    expect(created.persistedTo).toBeTruthy();
    await expect(createSpendingWallet({ network: TESTNET, mainAddress: MAIN })).rejects.toThrow(
      /already configured/,
    );
  });

  it("refuses on shared demo", async () => {
    process.env.MCP_PUBLIC = "true";
    await expect(createSpendingWallet({ network: TESTNET, mainAddress: MAIN })).rejects.toThrow(
      SafetyError,
    );
  });

  it("refuses persist=false", async () => {
    await expect(
      createSpendingWallet({ network: TESTNET, mainAddress: MAIN, persist: false }),
    ).rejects.toThrow(/persist=false/);
  });
});
