import { describe, it, expect, beforeEach } from "vitest";
import { createKaspaMcpServer } from "../src/server.js";
import { clearSessionNetworkPreference, setSessionNetworkChoice, setNetworkClientKey } from "../src/session-network.js";
import {
  clearBoundWalletMemory,
  setBoundWalletClientKey,
  setBoundWalletKv,
  getSessionBoundWallet,
  setSessionBoundWallet,
} from "../src/session-bound-wallet.js";
import { setChooseNetworkContext } from "../src/choose/network-choice.js";
import { createMemorySignStore, setSignContext } from "../src/sign/index.js";
import { handleSignHttp } from "../src/sign/http.js";

type ToolMap = Record<
  string,
  { handler: (args: unknown, extra?: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> }
>;

function toolsOf(server: ReturnType<typeof createKaspaMcpServer>): ToolMap {
  return (server as unknown as { _registeredTools: ToolMap })._registeredTools;
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const server = createKaspaMcpServer();
  const extra = {
    signal: AbortSignal.timeout(20_000),
    requestId: 1,
    sendNotification: async () => {},
    sendRequest: async () => ({}) as never,
  };
  const result = await toolsOf(server)[name]!.handler(args, extra);
  const text = result.content?.[0]?.text ?? "";
  try {
    return { parsed: JSON.parse(text) as Record<string, unknown>, isError: !!result.isError };
  } catch {
    return { parsed: null, isError: !!result.isError, text };
  // keep text
  }
}

describe("quick-start bind (no address)", () => {
  const store = createMemorySignStore();

  beforeEach(async () => {
    clearSessionNetworkPreference();
    clearBoundWalletMemory();
    setNetworkClientKey("bind-test");
    setBoundWalletClientKey("bind-test");
    setBoundWalletKv(null);
    setChooseNetworkContext({ kv: null, publicBaseUrl: "https://example.test" });
    setSignContext({ store, publicBaseUrl: "https://example.test" });
    await setSessionNetworkChoice("testnet", "bind-test");
  });

  it("l1_prepare_fund without from/owner returns quick_start_bind tap", async () => {
    const { parsed, isError } = await callTool("l1_prepare_fund", {
      templateId: "tipjar",
      amountSompi: "100000000",
    });
    expect(isError).toBe(false);
    expect(parsed?.mode).toBe("quick_start_bind");
    expect(parsed?.fromAddress).toBeNull();
    expect(parsed?.ownerAddress).toBeNull();
    expect(String(parsed?.agentRule || "")).toMatch(/NEVER ask/i);
    const tap = parsed?.tapToApprove as { url?: string; id?: string };
    expect(tap?.url).toMatch(/\/sign\/[a-f0-9]{32}/);
    expect(tap?.id).toHaveLength(32);
  });

  it("l1_prepare_send without fromAddress returns bind mode", async () => {
    const { parsed, isError } = await callTool("l1_prepare_send", {
      toAddress: "kaspatest:qza6ey35a278ft60rhvjfna96dznge4qrlw9zgr7zedngjzqvd97u9t9lscq6",
      amountSompi: "100000000",
    });
    expect(isError).toBe(false);
    expect(parsed?.mode).toBe("quick_start_bind");
    expect(parsed?.fromAddress).toBeNull();
    expect(parsed?.toAddress).toMatch(/^kaspatest:/);
  });

  it("POST /api/sign/:id/bind rebinds tipjar and stores bound wallet", async () => {
    const { parsed } = await callTool("l1_prepare_fund", {
      templateId: "tipjar",
      amountSompi: "100000000",
    });
    const id = (parsed?.tapToApprove as { id: string }).id;
    const addr = "kaspatest:qrfkpju2l2m75vdcrynv7dv8nmmycqft39d7570684u5cnmz6at0c6grdnsas";
    const res = await handleSignHttp(
      new Request(`https://example.test/api/sign/${id}/bind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: addr, clientKey: "bind-test" }),
      }),
      store,
    );
    expect(res).toBeTruthy();
    const body = await res!.json();
    expect(body.ok).toBe(true);
    expect(body.boundAddress).toBe(addr);
    expect(body.p2shAddress).toMatch(/^kaspatest:/);
    expect(body.session.l1Build.fromAddress).toBe(addr);
    expect(body.session.l1Build.bytecodeHex.length).toBeGreaterThan(20);
    expect(body.session.l1Build.quickStartBind).toBe(false);

    const bound = await getSessionBoundWallet("testnet-10", "bind-test");
    expect(bound?.address).toBe(addr);

    // Later prepare_fund uses bound address without explicit from
    const again = await callTool("l1_prepare_fund", {
      templateId: "tipjar",
      amountSompi: "100000000",
    });
    expect(again.isError).toBe(false);
    expect(again.parsed?.mode).toBe("browser_build");
    expect(again.parsed?.boundAddress || again.parsed?.fromAddress || again.parsed?.ownerAddress).toBe(addr);
  });

  it("l1_aon_create_campaign without owner returns bind tap", async () => {
    const { parsed, isError } = await callTool("l1_aon_create_campaign", {
      goalSompi: "100000000",
    });
    expect(isError).toBe(false);
    expect(parsed?.mode).toBe("quick_start_bind");
    expect((parsed?.tapToApprove as { url: string }).url).toMatch(/\/sign\//);
  });

  it("l1_derive_p2sh without owner returns bind tap", async () => {
    const { parsed, isError } = await callTool("l1_derive_p2sh", {
      templateId: "tipjar",
      network: "kaspa-l1-testnet-10",
    });
    expect(isError).toBe(false);
    expect(parsed?.mode).toBe("quick_start_bind");
  });
});
