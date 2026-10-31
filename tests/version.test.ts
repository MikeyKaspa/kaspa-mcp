import { describe, it, expect } from "vitest";
import { connectorVersion, checkAgainstLatest } from "../src/version.js";
import { runSelfHostGuide } from "../src/self-host.js";

describe("version + self_host update", () => {
  it("connectorVersion returns semver", () => {
    const v = connectorVersion();
    expect(v.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("checkAgainstLatest does not throw without network mock", async () => {
    const r = await checkAgainstLatest({
      fetchImpl: async () =>
        new Response(JSON.stringify({ tag_name: "v9.9.9", html_url: "https://example" }), {
          status: 200,
        }),
    });
    expect(r.behind).toBe(true);
    expect(r.latest).toBe("v9.9.9");
    expect(r.updateHint).toMatch(/self_host/);
  });

  it("not behind when latest equals current", async () => {
    const cur = connectorVersion().version;
    const r = await checkAgainstLatest({
      fetchImpl: async () =>
        new Response(JSON.stringify({ tag_name: `v${cur}` }), { status: 200 }),
    });
    expect(r.behind).toBe(false);
  });

  it("self_host update step gives pull+deploy without touching secrets", async () => {
    process.env.MCP_PUBLIC = "true";
    const r = await runSelfHostGuide({ step: "update" });
    expect(String(r.commands)).toContain("git pull");
    expect(String(r.commands)).toContain("wrangler deploy");
    expect(r.neverAutoUpdate).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });
});
