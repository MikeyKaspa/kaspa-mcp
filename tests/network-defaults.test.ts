/**
 * Before/after network defaults + MCP ask-first flow.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createKaspaMcpServer } from "../src/server.js";
import { clearSessionNetworkPreference } from "../src/session-network.js";
import { DEFAULT_L1_TESTNET, DEFAULT_EVM_TESTNET } from "../src/networks.js";

/** Before this change (for the report). */
export const BEFORE_DEFAULTS: Record<string, string | "required" | "none"> = {
  list_networks: "none",
  kaspa_network_info: "required",
  deploy_contract: DEFAULT_EVM_TESTNET,
  prepare_deploy: "required",
  read_contract: "required",
  prepare_call: "required",
  send_raw_transaction: "required",
  get_balance: "required",
  get_tx: "required",
  faucet_info: "required",
  l1_blockdag_info: "kaspa-l1-mainnet",
  verify_rpc: "required",
  l1_derive_p2sh: DEFAULT_L1_TESTNET,
  l1_prepare_fund: DEFAULT_L1_TESTNET,
  l1_prepare_spend: DEFAULT_L1_TESTNET,
  spending_wallet_create: DEFAULT_L1_TESTNET,
  spending_wallet_status: DEFAULT_L1_TESTNET,
  spending_wallet_withdraw_all: DEFAULT_L1_TESTNET,
  l1_tipjar_chat_deploy: DEFAULT_L1_TESTNET,
};

export const AFTER_BEHAVIOR = {
  writeToolsAskIfUnset: [
    "deploy_contract",
    "prepare_deploy",
    "prepare_call",
    "send_raw_transaction",
    "l1_prepare_fund",
    "l1_prepare_spend",
    "spending_wallet_create",
    "spending_wallet_withdraw_all",
    "l1_tipjar_chat_deploy",
  ],
  readSafeFallback: DEFAULT_L1_TESTNET,
  l1BlockdagDefault: DEFAULT_L1_TESTNET,
  evmSafeFallback: DEFAULT_EVM_TESTNET,
};

type ToolMap = Record<
  string,
  {
    handler: (args: unknown, extra?: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
    inputSchema?: unknown;
  }
>;

function toolsOf(server: ReturnType<typeof createKaspaMcpServer>): ToolMap {
  return (server as unknown as { _registeredTools: ToolMap })._registeredTools;
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const server = createKaspaMcpServer();
  const map = toolsOf(server);
  if (!map[name]) throw new Error(`missing tool ${name}: have ${Object.keys(map).join(",")}`);
  const extra = {
    signal: AbortSignal.timeout(20_000),
    requestId: 1,
    sendNotification: async () => {},
    sendRequest: async () => ({}) as never,
  };
  const result = await map[name]!.handler(args, extra);
  const text = result.content?.[0]?.text ?? "";
  try {
    return { parsed: JSON.parse(text) as Record<string, unknown>, isError: !!result.isError, text };
  } catch {
    return { parsed: null, isError: !!result.isError, text };
  }
}

describe("network defaults after change", () => {
  beforeEach(() => {
    clearSessionNetworkPreference();
    delete process.env.MCP_PUBLIC;
  });

  it("documents before defaults including l1_blockdag mainnet bug", () => {
    expect(BEFORE_DEFAULTS.l1_blockdag_info).toBe("kaspa-l1-mainnet");
    expect(AFTER_BEHAVIOR.l1BlockdagDefault).toBe(DEFAULT_L1_TESTNET);
  });

  it("registers choose_network, self_host, l1_confirm_tx, network_preference", () => {
    const map = toolsOf(createKaspaMcpServer());
    for (const n of ["choose_network", "self_host", "l1_confirm_tx", "network_preference"]) {
      expect(map[n], n).toBeTruthy();
    }
  });

  it("l1_prepare_fund without network asks Testnet or mainnet", async () => {
    const { parsed } = await callTool("l1_prepare_fund", {
      amountSompi: "100000000",
      templateId: "tipjar",
    });
    expect(parsed?.needUserChoice).toBe(true);
    expect(String(parsed?.askUser || "")).toMatch(/Testnet.*Mainnet|ONE CLICK/i);
    expect(Array.isArray(parsed?.choices)).toBe(true);
  });

  it("deploy_contract without network asks", async () => {
    const { parsed } = await callTool("deploy_contract", {
      source: "contract C { constructor() {} }",
    });
    expect(parsed?.needUserChoice).toBe(true);
  });

  it("choose_network testnet then prepare_fund no longer asks", async () => {
    const chose = await callTool("choose_network", { choice: "testnet" });
    expect(chose.parsed?.remembered).toBe(true);
    expect(chose.parsed?.l1NetworkId).toBe(DEFAULT_L1_TESTNET);
    const { parsed } = await callTool("l1_prepare_fund", {
      amountSompi: "100000000",
      templateId: "tipjar",
      fromAddress: "kaspatest:qza6ey35a278ft60rhvjfna96dznge4qrlw9zgr7zedngjzqvd97u9t9lscq6",
    });
    expect(parsed?.needUserChoice).not.toBe(true);
  });

  it("choose_network mainnet returns UNAUDITED warning", async () => {
    const { parsed } = await callTool("choose_network", { choice: "mainnet" });
    expect(parsed?.choice).toBe("mainnet");
    expect(String(parsed?.mainnetWarning || "")).toMatch(/UNAUDITED/i);
  });

  it("self_host start works", async () => {
    process.env.MCP_PUBLIC = "true";
    const { parsed, isError } = await callTool("self_host", { step: "start" });
    expect(isError).toBe(false);
    expect(parsed?.step).toBe("start");
    delete process.env.MCP_PUBLIC;
  });

  it("network_preference empty then set via choose_network", async () => {
    const empty = await callTool("network_preference", {});
    expect(empty.parsed?.set).toBe(false);
    await callTool("choose_network", { choice: "testnet" });
    const set = await callTool("network_preference", {});
    expect(set.parsed?.set).toBe(true);
    expect(set.parsed?.choice).toBe("testnet");
  });

  it("l1_confirm_tx schema accepts txid (live optional)", async () => {
    const id = "3699167bfe3987a97b69053387a7a8bb8ac45f49df1fd7e34010130c7e066f69";
    const { parsed, isError } = await callTool("l1_confirm_tx", {
      txid: id,
      network: "kaspa-l1-testnet-10",
      timeoutMs: 8_000,
    });
    expect(isError).toBe(false);
    expect(parsed?.txid).toBe(id);
    expect(parsed?.explorer).toContain("tn10.kaspa.stream");
    // Known landed tx should be accepted (or pending if API flake)
    expect(["accepted", "pending", "not_found"]).toContain(parsed?.status);
  });
});
