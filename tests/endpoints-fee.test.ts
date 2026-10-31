import { describe, it, expect, beforeEach } from "vitest";
import {
  clearNodeConfig,
  setNodeConfig,
  restBasesFor,
  fetchRestJson,
  getNodeConfig,
} from "../src/endpoints.js";
import { estimateFees, MASS_HEURISTIC } from "../src/l1/fee.js";

describe("endpoints failover + fee estimate", () => {
  beforeEach(() => clearNodeConfig());

  it("defaults to official community REST", () => {
    expect(restBasesFor("testnet-10")[0]).toBe("https://api-tn10.kaspa.org");
    expect(restBasesFor("mainnet")[0]).toBe("https://api.kaspa.org");
  });

  it("puts user REST first while keeping public failover", () => {
    setNodeConfig({ restBases: ["https://rest.example.test"] });
    const bases = restBasesFor("mainnet");
    expect(bases[0]).toBe("https://rest.example.test");
    expect(bases).toContain("https://api.kaspa.org");
  });

  it("live fee estimate from TN10", async () => {
    const est = await estimateFees("testnet-10");
    expect(est.feerateSompiPerGram).toBeGreaterThan(0);
    expect(Number(est.recommendedPriorityFeeSompi)).toBeGreaterThan(0);
    expect(est.massHeuristic.p2pk).toBe(MASS_HEURISTIC.p2pk);
    expect(est.sourceBase).toContain("http");
  });

  it("fetchRestJson fee-estimate works", async () => {
    const { status, json } = await fetchRestJson<{ priorityBucket?: { feerate?: number } }>(
      "testnet-10",
      "/info/fee-estimate",
    );
    expect(status).toBe(200);
    expect(json.priorityBucket?.feerate).toBeTruthy();
  });

  it("getNodeConfig returns copy", () => {
    setNodeConfig({ wrpcUrl: "wss://example/wrpc" });
    expect(getNodeConfig().wrpcUrl).toBe("wss://example/wrpc");
  });
});
