/**
 * Bomb-proof spending wallet CI gates.
 * Fails if shared-demo can use a key, or if chat paths leak/raise/drain.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getNetwork } from "../src/networks.js";
import { SafetyError, redactSecrets } from "../src/safety.js";
import {
  assertNotSharedDemo,
  assertReviewedTemplate,
  assertWithdrawDestination,
  assertCovenantOwned,
  assertDestinationAllowedForSpend,
  createSpendingWallet,
  isSharedPublicDemo,
  loadSpendingPrivateKeyHex,
  maxMainnetKas,
  maxTxKas,
  persistSpendingKey,
  refuseCapChangeViaChat,
  refuseKeyExport,
  spendingWalletStatus,
  writeRegistry,
  readRegistry,
  recordCovenant,
  REVIEWED_TEMPLATE_IDS,
  DEFAULT_MAX_MAINNET_KAS,
  assertCanAutoSign,
  assertBalanceAndTxCaps,
} from "../src/spending-wallet.js";

const TESTNET = getNetwork("kaspa-l1-testnet-10");
const KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const MAIN = "kaspatest:qza6ey35a278ft60rhvjfna96dznge4qrlw9zgr7zedngjzqvd97u9t9lscq6";
const ATTACKER = "kaspatest:qpumuen7l8wthtz45p3ftn58pvrs9xlumvkuu2xet8egzkcklqtes5z8rkmpd";

const ENV_KEYS = [
  "MCP_PUBLIC",
  "KASPA_SPENDING_PRIVATE_KEY",
  "KASPA_SPENDING_WALLET_PATH",
  "KASPA_SPENDING_REGISTRY_PATH",
  "KASPA_SPENDING_MAINNET",
  "KASPA_SPENDING_MAX_KAS",
  "KASPA_SPENDING_MAX_TX_KAS",
] as const;

describe("shared demo never activates a key path", () => {
  const prev: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
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

  it("ignores env key when MCP_PUBLIC=true", () => {
    process.env.MCP_PUBLIC = "true";
    process.env.KASPA_SPENDING_PRIVATE_KEY = KEY;
    expect(isSharedPublicDemo()).toBe(true);
    expect(loadSpendingPrivateKeyHex()).toBeNull();
    expect(() => assertNotSharedDemo("auto-sign")).toThrow(SafetyError);
  });

  it("ignores key file when MCP_PUBLIC=true", () => {
    const dir = mkdtempSync(join(tmpdir(), "kaspa-sec-shared-"));
    const path = join(dir, "w.key");
    process.env.MCP_PUBLIC = "false";
    persistSpendingKey(KEY, path);
    process.env.MCP_PUBLIC = "true";
    process.env.KASPA_SPENDING_WALLET_PATH = path;
    expect(loadSpendingPrivateKeyHex()).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("create refused on shared demo even with mainAddress", async () => {
    process.env.MCP_PUBLIC = "true";
    await expect(
      createSpendingWallet({ network: TESTNET, mainAddress: MAIN }),
    ).rejects.toThrow(/shared public demo/i);
  });

  it("status on shared demo never includes a key-shaped field", async () => {
    process.env.MCP_PUBLIC = "true";
    process.env.KASPA_SPENDING_PRIVATE_KEY = KEY;
    const s = await spendingWalletStatus(TESTNET);
    const json = JSON.stringify(s);
    expect(s.configured).toBe(false);
    expect(json).not.toMatch(/0x[0-9a-fA-F]{64}/);
    expect(json.toLowerCase()).not.toContain("privatekey");
  });
});

describe("hard caps not raisable via chat / env ceiling", () => {
  const prev: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
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

  it("default balance cap is 50; env cannot raise above 50", () => {
    expect(maxMainnetKas()).toBe(DEFAULT_MAX_MAINNET_KAS);
    process.env.KASPA_SPENDING_MAX_KAS = "9999";
    expect(maxMainnetKas()).toBe(DEFAULT_MAX_MAINNET_KAS);
    process.env.KASPA_SPENDING_MAX_KAS = "10";
    expect(maxMainnetKas()).toBe(10);
  });

  it("per-tx cap has hard ceiling", () => {
    process.env.KASPA_SPENDING_MAX_TX_KAS = "9999";
    expect(maxTxKas({ isTestnet: false })).toBe(50);
    expect(maxTxKas({ isTestnet: true })).toBe(500);
  });

  it("spending_wallet_set_limits style call is refused", () => {
    expect(() => refuseCapChangeViaChat()).toThrow(/Refusing to change/);
  });

  it("assertBalanceAndTxCaps refuses oversized tx", async () => {
    process.env.KASPA_SPENDING_PRIVATE_KEY = KEY;
    await expect(
      assertBalanceAndTxCaps(TESTNET, MAIN, 600n * 100_000_000n, async () => 0n),
    ).rejects.toThrow(/Per-tx amount/);
  });
});

describe("prompt-injection style attempts refused", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kaspa-sec-inj-"));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.KASPA_SPENDING_WALLET_PATH = join(dir, "spend.key");
    process.env.KASPA_SPENDING_REGISTRY_PATH = join(dir, "reg.json");
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
  });

  it("export key always refused", () => {
    expect(() => refuseKeyExport()).toThrow(/Refusing to export/);
  });

  it("create response JSON has no 32-byte key material", async () => {
    const created = await createSpendingWallet({ network: TESTNET, mainAddress: MAIN });
    const json = JSON.stringify(created);
    expect(json).not.toMatch(/0x[0-9a-fA-F]{64}/);
    expect(created).not.toHaveProperty("privateKeyHex");
    expect(created.mainAddress).toBe(MAIN);
    // Key exists on disk only
    const disk = readFileSync(created.persistedTo, "utf8");
    expect(disk).toMatch(/0x[0-9a-fA-F]{64}/);
    expect(redactSecrets(disk)).toContain("REDACTED_32BYTE");
  });

  it("send to attacker address refused (withdraw destination)", async () => {
    await createSpendingWallet({ network: TESTNET, mainAddress: MAIN });
    expect(() => assertWithdrawDestination(ATTACKER)).toThrow(/locked mainAddress/);
    expect(() => assertWithdrawDestination(MAIN)).not.toThrow();
  });

  it("covenant spend to attacker refused", async () => {
    await createSpendingWallet({ network: TESTNET, mainAddress: MAIN });
    const spendAddr = (await spendingWalletStatus(TESTNET)).address!;
    expect(() => assertDestinationAllowedForSpend(ATTACKER, spendAddr)).toThrow(/Refusing covenant spend/);
    expect(() => assertDestinationAllowedForSpend(MAIN, spendAddr)).not.toThrow();
    expect(() => assertDestinationAllowedForSpend(spendAddr, spendAddr)).not.toThrow();
  });

  it("unreviewed template refused", () => {
    expect(() => assertReviewedTemplate("evil_drain")).toThrow(/allowlist/);
    expect(() => assertReviewedTemplate("tipjar")).not.toThrow();
    expect(REVIEWED_TEMPLATE_IDS).toContain("escrow");
  });

  it("spend of unregistered P2SH refused", async () => {
    await createSpendingWallet({ network: TESTNET, mainAddress: MAIN });
    expect(() => assertCovenantOwned("kaspatest:prfqwa3gj2y245963eqg28ce34tce9qtxfc43guxvwlz9rd05xflg6ardagg2")).toThrow(
      /not in this spending wallet/,
    );
    recordCovenant({
      p2shAddress: "kaspatest:prfqwa3gj2y245963eqg28ce34tce9qtxfc43guxvwlz9rd05xflg6ardagg2",
      templateId: "tipjar",
    });
    expect(() =>
      assertCovenantOwned("kaspatest:prfqwa3gj2y245963eqg28ce34tce9qtxfc43guxvwlz9rd05xflg6ardagg2"),
    ).not.toThrow();
  });

  it("raise cap via chat tool refused", () => {
    expect(() => refuseCapChangeViaChat()).toThrow(/deploy-time env only/);
  });
});
