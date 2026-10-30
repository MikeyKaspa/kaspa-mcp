import { describe, it, expect } from "vitest";
import { NETWORKS, getNetwork, listNetworks } from "../src/networks.js";
import { backendFor } from "../src/backends/registry.js";
import { SafetyError } from "../src/safety.js";
import { EvmBackend } from "../src/backends/evm.js";

describe("networks registry", () => {
  it("has kasplex testnet and mainnet", () => {
    expect(NETWORKS["kasplex-testnet"].chainId).toBe(167012);
    expect(NETWORKS["kasplex-mainnet"].chainId).toBe(202555);
    expect(NETWORKS["kasplex-testnet"].isTestnet).toBe(true);
    expect(NETWORKS["kasplex-mainnet"].isTestnet).toBe(false);
  });

  it("lists evm testnets", () => {
    const t = listNetworks({ kind: "evm", testnetOnly: true });
    expect(t.some((n) => n.id === "kasplex-testnet")).toBe(true);
  });

  it("resolves backends", () => {
    expect(backendFor(getNetwork("kasplex-testnet")).kind).toBe("evm");
    expect(backendFor(getNetwork("kaspa-l1-mainnet")).kind).toBe("l1-read");
    // Covenant networks with rpcUrl use L1ReadBackend for balance/tx; MCP tools handle SilverScript.
    expect(backendFor(getNetwork("kaspa-covenants-mainnet")).kind).toBe("l1-read");
    expect(backendFor(getNetwork("kaspa-l1-testnet-10")).kind).toBe("l1-read");
    expect(getNetwork("kaspa-l1-testnet-10").kind).toBe("covenant");
    expect(backendFor(getNetwork("kaspa-vprogs")).kind).toBe("vprogs");
  });
});

describe("safety", () => {
  it("rejects mainnet private keys", async () => {
    const backend = new EvmBackend();
    const net = getNetwork("kasplex-mainnet");
    const compiled = {
      contractName: "X",
      abi: [],
      bytecode: "0x6000" as `0x${string}`,
      compiler: "test",
    };
    await expect(
      backend.deploy(net, compiled, {
        privateKey: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      }),
    ).rejects.toBeInstanceOf(SafetyError);
  });
});
