import { describe, it, expect, beforeEach } from "vitest";
import {
  clearSessionNetworkPreference,
  setNetworkPreferenceKv,
  setNetworkClientKey,
  setSessionNetworkChoice,
  hydrateSessionNetworkPreference,
  getSessionNetworkPreference,
} from "../src/session-network.js";

describe("network preference KV persistence", () => {
  const map = new Map<string, string>();
  beforeEach(() => {
    map.clear();
    clearSessionNetworkPreference();
    setNetworkPreferenceKv({
      async put(key, value) {
        map.set(key, value);
      },
      async get(key) {
        return map.get(key) ?? null;
      },
    });
    setNetworkClientKey("test-client");
  });

  it("writes preference to KV and rehydrates after clear", async () => {
    await setSessionNetworkChoice("mainnet", "test-client");
    expect(map.get("network-pref:test-client")).toContain("mainnet");
    clearSessionNetworkPreference();
    expect(getSessionNetworkPreference()).toBeNull();
    const pref = await hydrateSessionNetworkPreference("test-client");
    expect(pref?.choice).toBe("mainnet");
    expect(getSessionNetworkPreference()?.l1NetworkId).toBe("kaspa-l1-mainnet");
  });
});
