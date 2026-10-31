import { describe, it, expect, beforeEach } from "vitest";
import {
  clearSessionNetworkPreference,
  setSessionNetworkChoice,
  getSessionNetworkPreference,
  resolveNetwork,
  ASK_NETWORK_PROMPT,
} from "../src/session-network.js";
import { DEFAULT_L1_TESTNET, DEFAULT_EVM_TESTNET } from "../src/networks.js";

describe("session network preference", () => {
  beforeEach(() => clearSessionNetworkPreference());

  it("asks before write when unset", () => {
    const r = resolveNetwork({ kind: "l1" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.needUserChoice).toBe(true);
    expect(r.askUser).toContain("Testnet or mainnet");
    expect(r.options.testnet.l1).toBe(DEFAULT_L1_TESTNET);
    expect(r.options.mainnet.l1).toBe("kaspa-l1-mainnet");
  });

  it("safe fallback uses TN10 for reads", () => {
    const r = resolveNetwork({ kind: "l1", allowSafeFallback: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.network.id).toBe(DEFAULT_L1_TESTNET);
    expect(r.source).toBe("safe_fallback");
  });

  it("remembers testnet choice for L1 and EVM", () => {
    const pref = setSessionNetworkChoice("testnet");
    expect(pref.l1NetworkId).toBe(DEFAULT_L1_TESTNET);
    expect(pref.evmNetworkId).toBe(DEFAULT_EVM_TESTNET);
    expect(getSessionNetworkPreference()?.choice).toBe("testnet");
    const r = resolveNetwork({ kind: "l1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe("session");
    expect(r.network.id).toBe(DEFAULT_L1_TESTNET);
    expect(r.mainnetWarning).toBeUndefined();
  });

  it("mainnet choice surfaces unaudited warning", () => {
    setSessionNetworkChoice("mainnet");
    const r = resolveNetwork({ kind: "l1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.network.id).toBe("kaspa-l1-mainnet");
    expect(r.mainnetWarning).toMatch(/UNAUDITED/i);
    const evm = resolveNetwork({ kind: "evm" });
    expect(evm.ok).toBe(true);
    if (!evm.ok) return;
    expect(evm.network.id).toBe("kasplex-mainnet");
  });

  it("explicit network overrides session", () => {
    setSessionNetworkChoice("mainnet");
    const r = resolveNetwork({ explicit: DEFAULT_L1_TESTNET, kind: "l1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe("explicit");
    expect(r.network.isTestnet).toBe(true);
  });

  it("exports ask prompt for agents", () => {
    expect(ASK_NETWORK_PROMPT).toMatch(/Testnet or mainnet/);
  });
});
