import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Cursor plugin packaging", () => {
  it("plugin.json + mcp.json are valid and point at Worker /mcp", () => {
    const plugin = JSON.parse(readFileSync(join(process.cwd(), ".cursor-plugin/plugin.json"), "utf8"));
    const mcp = JSON.parse(readFileSync(join(process.cwd(), "mcp.json"), "utf8"));
    expect(plugin.name).toBe("kaspa-mcp");
    expect(plugin.license).toBe("MIT");
    expect(plugin.logo).toMatch(/logo\.svg$/);
    expect(plugin.mcpServers).toBe("mcp.json");
    expect(mcp.mcpServers.kaspa.url).toBe("https://kaspa-mcp.kaspa-mcp.workers.dev/mcp");
    expect(plugin.description.toLowerCase()).not.toContain("dffm");
  });

  it("logo assets exist 1:1", () => {
    const svg = readFileSync(join(process.cwd(), "assets/logo.svg"), "utf8");
    expect(svg).toContain('viewBox="0 0 512 512"');
    const png = readFileSync(join(process.cwd(), "assets/logo.png"));
    expect(png.length).toBeGreaterThan(500);
    expect(png[0]).toBe(0x89);
  });
});
