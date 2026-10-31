import { describe, it, expect } from "vitest";
import { createKaspaMcpServer } from "../src/server.js";
import { EXPECTED_TOOL_NAMES, TOOL_ANNOTATIONS } from "../src/tool-annotations.js";

type Registered = {
  description?: string;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
  enabled?: boolean;
};

function toolsOf(server: ReturnType<typeof createKaspaMcpServer>): Record<string, Registered> {
  return (server as unknown as { _registeredTools: Record<string, Registered> })._registeredTools;
}

describe("MCP tool annotations", () => {
  it("registers exactly the expected tool set", () => {
    const map = toolsOf(createKaspaMcpServer());
    const names = Object.keys(map).sort();
    expect(names).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it("every tool has title + readOnlyHint + destructiveHint", () => {
    const map = toolsOf(createKaspaMcpServer());
    for (const name of EXPECTED_TOOL_NAMES) {
      const ann = map[name]?.annotations;
      expect(ann, name).toBeTruthy();
      expect(ann!.title, `${name}.title`).toBeTruthy();
      expect(typeof ann!.readOnlyHint, `${name}.readOnlyHint`).toBe("boolean");
      expect(typeof ann!.destructiveHint, `${name}.destructiveHint`).toBe("boolean");
      expect(ann).toMatchObject(TOOL_ANNOTATIONS[name]!);
    }
  });

  it("read-only tools are not marked destructive", () => {
    for (const [name, ann] of Object.entries(TOOL_ANNOTATIONS)) {
      if (ann.readOnlyHint) {
        expect(ann.destructiveHint, name).toBe(false);
      }
    }
  });

  it("spend/deploy tools are destructive writes", () => {
    for (const name of [
      "deploy_contract",
      "send_raw_transaction",
      "l1_tipjar_chat_deploy",
      "l1_aon_create_campaign",
      "spending_wallet_withdraw_all",
    ]) {
      const a = TOOL_ANNOTATIONS[name]!;
      expect(a.readOnlyHint).toBe(false);
      expect(a.destructiveHint).toBe(true);
    }
  });
});
