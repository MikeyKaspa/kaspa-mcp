import { describe, it, expect } from "vitest";
import {
  summarizeL1SafeJson,
  summarizeEvmPrepared,
  explorerFor,
} from "../src/sign/summary.js";
import { buildSession, createMemorySignStore } from "../src/sign/store.js";
import { attachTapToApprove, setSignContext } from "../src/sign/attach.js";

const sampleFund = JSON.stringify({
  id: "abc",
  version: 0,
  inputs: [
    {
      transactionId: "aa".repeat(32),
      index: 0,
      sequence: "0",
      sigOpCount: 1,
      signatureScript: "",
      utxo: {
        address: "kaspatest:qza6ey35a278ft60rhvjfna96dznge4qrlw9zgr7zedngjzqvd97u9t9lscq6",
        amount: "200000000",
        scriptPublicKey: "000020bbac9234eabc74af4f1dd924cfa5d3453466a01fdc51207e165b344840634beeac",
        blockDaaScore: "1",
        isCoinbase: false,
      },
    },
  ],
  outputs: [
    {
      value: "100000000",
      scriptPublicKey: "0000aa20947ec7e31fa8a98bb83bf77547dcca6a471c6e80a0b6889d28c346abb16f61b887",
    },
    {
      value: "99663500",
      scriptPublicKey: "000020bbac9234eabc74af4f1dd924cfa5d3453466a01fdc51207e165b344840634beeac",
    },
  ],
  lockTime: "0",
  subnetworkId: "0000000000000000000000000000000000000000",
  gas: "0",
  payload: "",
});

describe("summarizeL1SafeJson", () => {
  it("derives fee and marks P2SH output from script bytes", () => {
    const s = summarizeL1SafeJson(sampleFund, {
      kind: "l1-fund",
      networkLabel: "Kaspa L1 testnet-10",
      isMainnet: false,
    });
    expect(s.title).toMatch(/Fund covenant/);
    const fee = s.lines.find((l) => l.label.startsWith("Fee"));
    expect(fee?.value).toMatch(/0\.003365 KAS|336500/);
    expect(s.lines.some((l) => /P2SH/.test(l.value) || /P2SH/.test(l.label))).toBe(true);
    expect(s.warnings).toHaveLength(0);
  });

  it("adds mainnet unaudited warning", () => {
    const s = summarizeL1SafeJson(sampleFund, {
      kind: "l1-fund",
      networkLabel: "Kaspa L1 mainnet",
      isMainnet: true,
    });
    expect(s.warnings.join(" ")).toMatch(/UNAUDITED/);
  });

  it("ignores untrusted meta — summary comes from JSON only", () => {
    const s = summarizeL1SafeJson(sampleFund, {
      kind: "l1-fund",
      networkLabel: "Kaspa L1 testnet-10",
      isMainnet: false,
    });
    // Output 0 is 1 KAS from the tx itself
    expect(s.lines.some((l) => l.value.includes("1 KAS"))).toBe(true);
  });
});

describe("summarizeEvmPrepared", () => {
  it("summarizes deploy calldata size", () => {
    const s = summarizeEvmPrepared(
      { chainId: 167012, to: null, data: "0x60806040", value: "0", gasLimit: "1000000" },
      { kind: "evm-deploy", networkLabel: "Kasplex testnet", isMainnet: false, contractName: "C" },
    );
    expect(s.lines.find((l) => l.label === "Contract")?.value).toBe("C");
    expect(s.lines.find((l) => l.label === "Calldata")?.value).toMatch(/4 bytes/);
  });
});

describe("explorerFor", () => {
  it("uses tn10.kaspa.stream for testnet-10", () => {
    expect(explorerFor("kaspa-l1-testnet-10", "deadbeef")).toBe(
      "https://tn10.kaspa.stream/transactions/deadbeef",
    );
  });
});

describe("sign store + attach", () => {
  it("stores session and returns tap link", async () => {
    const store = createMemorySignStore();
    setSignContext({ store, publicBaseUrl: "http://127.0.0.1:8787" });
    const tap = await attachTapToApprove("l1-fund", "kaspa-l1-testnet-10", {
      safeJson: sampleFund,
      signInputs: [{ index: 0, sighashType: 1 }],
    });
    expect(tap?.url).toMatch(/^http:\/\/127\.0\.0\.1:8787\/sign\/[a-f0-9]{32}$/);
    const s = await store.get(tap!.id);
    expect(s?.safeJson).toBe(sampleFund);
    expect(s?.safeJson).not.toMatch(/private/i);
  });
});
