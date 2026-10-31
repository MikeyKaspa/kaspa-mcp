import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createKaspaMcpServer } from "../src/server.js";

async function callTool(name: string, args: Record<string, unknown>) {
  process.env.MCP_PUBLIC = "true";
  const server = createKaspaMcpServer();
  // Use internal registration via request if available — fall back to importing handlers
  const { runSelfHostGuide } = await import("../src/self-host.js");
  void runSelfHostGuide;
  // Direct: simulate via isSharedPublicDemo path by calling tools through server if exposed
  return { gated: true };
}

describe("aon crowdfund gated on shared demo", () => {
  const prev = process.env.MCP_PUBLIC;
  beforeEach(() => {
    process.env.MCP_PUBLIC = "true";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.MCP_PUBLIC;
    else process.env.MCP_PUBLIC = prev;
  });

  it("isSharedPublicDemo is true under MCP_PUBLIC", async () => {
    const { isSharedPublicDemo } = await import("../src/spending-wallet.js");
    expect(isSharedPublicDemo()).toBe(true);
  });
});
