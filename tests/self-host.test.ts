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

  it("start explains cloudflare vs local without leaking keys", async () => {
    const r = await runSelfHostGuide({ step: "start" });
    expect(r.sharedDemo).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/0x[0-9a-fA-F]{64}/);
    expect(r.overviewSteps).toBeTruthy();
    expect(String(r.trapToAvoid || "")).toMatch(/keyless|no-popup|selfhost/i);
    expect(r.beforeYouStart).toBeTruthy();
  });

  it("deploy cloudflare gives copy-paste wrangler.selfhost / selfhost:setup commands", async () => {
    const r = await runSelfHostGuide({ step: "deploy", platform: "cloudflare" });
    expect(String(r.commands)).toContain("wrangler.selfhost.toml");
    expect(String(r.commands)).toContain("selfhost:setup");
    expect(String(r.oneClickKeylessOnly || r.oneClick || "")).toContain("deploy.workers.cloudflare.com");
    expect(String(r.oneClickNote || r.trapToAvoid || r.humanSteps || "")).toMatch(/keyless|no-popup/i);
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
