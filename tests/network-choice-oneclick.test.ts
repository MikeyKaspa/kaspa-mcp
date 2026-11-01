/**
 * One-click network selection: choices payload, /choose page, elicitation gate.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createKaspaMcpServer } from "../src/server.js";
import { clearSessionNetworkPreference, setNetworkClientKey, getSessionNetworkPreference } from "../src/session-network.js";
import {
  clearChooseNetworkMemory,
  setChooseNetworkContext,
  createChooseNetworkSession,
  applyChooseNetworkSelection,
  handleChooseNetworkHttp,
  NETWORK_CHOICES,
  enrichAskPayload,
  clientSupportsElicitation,
  gateNetworkChoice,
} from "../src/choose/network-choice.js";
import { resolveNetwork } from "../src/session-network.js";

type ToolMap = Record<
  string,
  {
    handler: (args: unknown, extra?: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
  }
>;

function toolsOf(server: ReturnType<typeof createKaspaMcpServer>): ToolMap {
  return (server as unknown as { _registeredTools: ToolMap })._registeredTools;
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const server = createKaspaMcpServer();
  const map = toolsOf(server);
  const extra = {
    signal: AbortSignal.timeout(20_000),
    requestId: 1,
    sendNotification: async () => {},
    sendRequest: async () => ({}) as never,
  };
  const result = await map[name]!.handler(args, extra);
  const text = result.content?.[0]?.text ?? "";
  try {
    return { parsed: JSON.parse(text) as Record<string, unknown>, isError: !!result.isError, text, server };
  } catch {
    return { parsed: null, isError: !!result.isError, text, server };
  }
}

describe("one-click network choice", () => {
  beforeEach(() => {
    clearSessionNetworkPreference();
    clearChooseNetworkMemory();
    setNetworkClientKey("test-client");
    setChooseNetworkContext({ kv: null, publicBaseUrl: "https://example.test" });
  });

  it("NETWORK_CHOICES exposes both descriptions", () => {
    expect(NETWORK_CHOICES).toHaveLength(2);
    expect(NETWORK_CHOICES[0]!.id).toBe("testnet");
    expect(NETWORK_CHOICES[0]!.description).toMatch(/free test KAS/i);
    expect(NETWORK_CHOICES[1]!.id).toBe("mainnet");
    expect(NETWORK_CHOICES[1]!.description).toMatch(/UNAUDITED/i);
    expect(NETWORK_CHOICES[1]!.description).toMatch(/50 KAS/i);
  });

  it("l1_prepare_fund ask includes choices + chooseUrl + never-type instructions", async () => {
    const { parsed } = await callTool("l1_prepare_fund", {
      amountSompi: "100000000",
      templateId: "tipjar",
    });
    expect(parsed?.needUserChoice).toBe(true);
    expect(Array.isArray(parsed?.choices)).toBe(true);
    const choices = parsed!.choices as Array<{ id: string; label: string; description: string }>;
    expect(choices.map((c) => c.id)).toEqual(["testnet", "mainnet"]);
    expect(choices[0]!.description).toMatch(/free test KAS/i);
    expect(choices[1]!.description).toMatch(/50 KAS/i);
    expect(parsed?.presentation).toBe("clickable_buttons");
    expect(String(parsed?.hostInstructions || "")).toMatch(/NEVER ask the user to type/i);
    expect(String(parsed?.chooseUrl || "")).toMatch(/^https:\/\/example\.test\/choose\/[a-f0-9]{32}$/);
  });

  it("/choose/<id>?choice=testnet records preference for clientKey", async () => {
    const created = await createChooseNetworkSession("test-client");
    expect(created.id).toHaveLength(32);
    const req = new Request(`https://example.test/choose/${created.id}?choice=testnet`, { method: "GET", redirect: "manual" });
    const res = await handleChooseNetworkHttp(req);
    expect(res).toBeTruthy();
    expect(res!.status).toBe(303);
    expect(getSessionNetworkPreference()?.choice).toBe("testnet");
    expect(getSessionNetworkPreference()?.clientKey).toBe("test-client");

    // Confirmation page
    const conf = await handleChooseNetworkHttp(new Request(`https://example.test/choose/${created.id}`));
    expect(conf!.status).toBe(200);
    const html = await conf!.text();
    expect(html).toMatch(/Saved: Testnet/);
    expect(conf!.headers.get("content-security-policy") || "").toMatch(/default-src 'none'/);
  });

  it("/choose page HTML shows both descriptions before selection", async () => {
    const created = await createChooseNetworkSession("test-client");
    const res = await handleChooseNetworkHttp(new Request(`https://example.test/choose/${created.id}`));
    const html = await res!.text();
    expect(html).toMatch(/Choose a network/);
    expect(html).toMatch(/free test KAS/i);
    expect(html).toMatch(/UNAUDITED/i);
    expect(html).toMatch(/50 KAS/);
    expect(html).toContain(`href="https://example.test/choose/${created.id}?choice=testnet"`);
    expect(html).toContain(`href="https://example.test/choose/${created.id}?choice=mainnet"`);
  });

  it("applyChooseNetworkSelection mainnet then resolveNetwork uses session", async () => {
    const created = await createChooseNetworkSession("test-client");
    const applied = await applyChooseNetworkSelection(created.id, "mainnet");
    expect(applied.ok).toBe(true);
    const r = resolveNetwork({ kind: "l1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.choice).toBe("mainnet");
    expect(r.mainnetWarning).toMatch(/UNAUDITED/i);
  });

  it("enrichAskPayload attaches chooseUrl", async () => {
    const ask = resolveNetwork({ kind: "l1" });
    expect(ask.ok).toBe(false);
    if (ask.ok) return;
    const enriched = await enrichAskPayload(ask, "test-client");
    expect(enriched.choices[0]!.label).toBe("Testnet");
    expect(enriched.chooseUrl).toContain("/choose/");
  });

  it("clientSupportsElicitation false without connected client", () => {
    const server = createKaspaMcpServer();
    expect(clientSupportsElicitation(server)).toBe(false);
  });

  it("gateNetworkChoice without elicitation returns choices response", async () => {
    const server = createKaspaMcpServer();
    const gated = await gateNetworkChoice(server, { kind: "l1" }, "test-client", (data) => ({
      content: [{ type: "text", text: JSON.stringify(data) }],
    }));
    expect(gated.ok).toBe(false);
    if (gated.ok) return;
    const parsed = JSON.parse(gated.response.content[0]!.text);
    expect(parsed.needUserChoice).toBe(true);
    expect(parsed.choices).toHaveLength(2);
  });

  it("ASK prompt forbids typing", async () => {
    const { parsed } = await callTool("network_preference", {});
    expect(parsed?.set).toBe(false);
    expect(String(parsed?.askUser || "")).toMatch(/ONE CLICK|never ask the user to type/i);
    expect(Array.isArray(parsed?.choices)).toBe(true);
  });
});
