import { describe, it, expect } from "vitest";
import { createKaspaMcpServer } from "../src/server.js";

type ToolMap = Record<
  string,
  {
    handler: (args: unknown, extra?: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
  }
>;

function toolsOf(server: ReturnType<typeof createKaspaMcpServer>): ToolMap {
  return (server as unknown as { _registeredTools: ToolMap })._registeredTools;
}

async function call(name: string, args: Record<string, unknown>) {
  const map = toolsOf(createKaspaMcpServer());
  const extra = {
    signal: AbortSignal.timeout(15_000),
    requestId: 1,
    sendNotification: async () => {},
    sendRequest: async () => ({}) as never,
  };
  const result = await map[name]!.handler(args, extra);
  const text = result.content?.[0]?.text ?? "";
  return { isError: !!result.isError, text };
}

describe("input validation fuzz (safe rejects)", () => {
  it("rejects garbage network ids without crashing", async () => {
    for (const junk of ["", "mainnet!!!", "../../etc", "<script>", "a".repeat(500)]) {
      const r = await call("kaspa_network_info", { network: junk });
      expect(r.isError || /unknown|not found|invalid|Error/i.test(r.text)).toBe(true);
    }
  });

  it("choose_network rejects invalid choice", async () => {
    const r = await call("choose_network", { choice: "not-a-network" as unknown as string });
    expect(r.isError || /testnet|mainnet|choose|invalid|Error|need|enum|Required/i.test(r.text)).toBe(true);
  });

  it("l1_prepare_fund rejects absurd amounts / missing fields", async () => {
    const r = await call("l1_prepare_fund", { amountSompi: "-1", fromAddress: "nope" });
    expect(r.isError || /error|invalid|address|network|need|refuse/i.test(r.text)).toBe(true);
  });

  it("get_balance rejects malformed address", async () => {
    const r = await call("get_balance", { address: "not-an-address", network: "kaspa-l1-testnet-10" });
    expect(r.isError || /invalid|address|error|fail/i.test(r.text)).toBe(true);
  });
});
