import { describe, it, expect } from "vitest";

async function ethChainId(url: string): Promise<number> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
  });
  const body = (await res.json()) as { result: string };
  return parseInt(body.result, 16);
}

describe("live RPCs", () => {
  it("Kasplex testnet chainId 167012", async () => {
    expect(await ethChainId("https://rpc.kasplextest.xyz")).toBe(167012);
  }, 20_000);

  it("Kasplex mainnet chainId 202555", async () => {
    expect(await ethChainId("https://evmrpc.kasplex.org")).toBe(202555);
  }, 20_000);

  it("api.kaspa.org blockdag", async () => {
    const res = await fetch("https://api.kaspa.org/info/blockdag");
    expect(res.ok).toBe(true);
    const j = (await res.json()) as { networkName?: string };
    expect(j.networkName).toMatch(/kaspa/i);
  }, 20_000);
});
