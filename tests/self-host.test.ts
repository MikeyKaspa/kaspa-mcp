import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runSelfHostGuide } from "../src/self-host.js";

describe("self_host guide", () => {
  const prev = process.env.MCP_PUBLIC;
  beforeEach(() => {
    process.env.MCP_PUBLIC = "true";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.MCP_PUBLIC;
    else process.env.MCP_PUBLIC = prev;
  });

  it("start leads with zero-install Cloudflare + faucet, Node only as advanced", async () => {
    const r = await runSelfHostGuide({ step: "start" });
    expect(r.sharedDemo).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/0x[0-9a-fA-F]{64}/);
    expect(r.youDo).toBeTruthy();
    expect(r.iDo).toBeTruthy();
    expect(String(r.deployToCloudflareUrl || r.oneClickPrimary || "")).toContain("deploy.workers.cloudflare.com");
    expect(String(r.faucetUrl || r.faucetNote || "")).toMatch(/faucet-tn10/);
    expect(String(r.tipAlwaysAllow || "")).toMatch(/Always allow/i);
    expect(String(r.primaryPath || "")).toMatch(/zero_install/i);
    // Node must not be required in primary path text
    expect(JSON.stringify(r.youDo)).not.toMatch(/\bNode\.js\b|\bnpm install\b|\bgit clone\b/);
    expect(String(r.advancedNodeOnly || r.oneCommandDeployAdvanced || "")).toMatch(/Advanced|Node/i);
  });

  it("deploy cloudflare leads with Deploy button + faucet", async () => {
    const r = await runSelfHostGuide({ step: "deploy", platform: "cloudflare" });
    expect(String(r.oneClickPrimary || r.oneClickKeylessOnly || "")).toContain("deploy.workers.cloudflare.com");
    expect(String(r.faucetUrl || JSON.stringify(r.humanSteps))).toMatch(/faucet-tn10/);
    expect(String(r.humanSteps || "")).toMatch(/zero install|Deploy to Cloudflare|MCP_PUBLIC/i);
  });

  it("create_wallet on shared demo refuses key creation path", async () => {
    const r = await runSelfHostGuide({
      step: "create_wallet",
      mainAddress: "kaspatest:qza6ey35a278ft60rhvjfna96dznge4qrlw9zgr7zedngjzqvd97u9t9lscq6",
    });
    expect(String(r.error || r.note || "") + JSON.stringify(r)).toMatch(/self-host|YOUR|refuses/i);
  });

  it("set_secret shows stdin wrangler secret put", async () => {
    const r = await runSelfHostGuide({ step: "set_secret" });
    expect(String(r.commands)).toContain("wrangler secret put KASPA_SPENDING_PRIVATE_KEY");
    expect(JSON.stringify(r)).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });

  it("own_node explains optional independence", async () => {
    const r = await runSelfHostGuide({ step: "own_node" });
    expect(String(r.title || "") + JSON.stringify(r)).toMatch(/node|KASPA_REST/i);
  });
});
