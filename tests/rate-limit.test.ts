import { describe, it, expect, beforeEach } from "vitest";
import {
  _resetRateLimitStateForTests,
  checkRateLimit,
  peekMcpRequest,
  rateLimitEnabled,
  rateLimitKey,
  type RateLimitEnv,
} from "../src/rate-limit.js";

describe("rateLimitEnabled", () => {
  it("is off by default", () => {
    expect(rateLimitEnabled({})).toBe(false);
    expect(rateLimitEnabled({ RATE_LIMIT_ENABLED: "false" })).toBe(false);
  });
  it("turns on for true/1/on", () => {
    expect(rateLimitEnabled({ RATE_LIMIT_ENABLED: "true" })).toBe(true);
    expect(rateLimitEnabled({ RATE_LIMIT_ENABLED: "1" })).toBe(true);
  });
});

describe("peekMcpRequest", () => {
  it("detects compile_solidity", () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "compile_solidity", arguments: {} },
    });
    expect(peekMcpRequest(body)).toEqual({ isCompile: true, id: 7 });
  });
  it("ignores other tools", () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_networks", arguments: {} },
    });
    expect(peekMcpRequest(body).isCompile).toBe(false);
  });
});

describe("checkRateLimit isolate windows", () => {
  beforeEach(() => _resetRateLimitStateForTests());

  it("allows traffic when disabled", async () => {
    for (let i = 0; i < 100; i++) {
      const r = await checkRateLimit({}, "1.2.3.4", false);
      expect(r.ok).toBe(true);
    }
  });

  it("enforces request limit per IP", async () => {
    const env: RateLimitEnv = {
      RATE_LIMIT_ENABLED: "true",
      RATE_LIMIT_REQUESTS: "3",
      RATE_LIMIT_REQUESTS_PERIOD_SEC: "60",
    };
    expect((await checkRateLimit(env, "9.9.9.9", false)).ok).toBe(true);
    expect((await checkRateLimit(env, "9.9.9.9", false)).ok).toBe(true);
    expect((await checkRateLimit(env, "9.9.9.9", false)).ok).toBe(true);
    const blocked = await checkRateLimit(env, "9.9.9.9", false);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.kind).toBe("request");
      expect(blocked.message).toMatch(/Self-host/i);
    }
    // Other IP still ok
    expect((await checkRateLimit(env, "8.8.8.8", false)).ok).toBe(true);
  });

  it("enforces tighter compile window", async () => {
    const env: RateLimitEnv = {
      RATE_LIMIT_ENABLED: "true",
      RATE_LIMIT_REQUESTS: "100",
      RATE_LIMIT_REQUESTS_PERIOD_SEC: "60",
      RATE_LIMIT_COMPILE: "2",
      RATE_LIMIT_COMPILE_PERIOD_SEC: "600",
    };
    expect((await checkRateLimit(env, "7.7.7.7", true)).ok).toBe(true);
    expect((await checkRateLimit(env, "7.7.7.7", true)).ok).toBe(true);
    const blocked = await checkRateLimit(env, "7.7.7.7", true);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.kind).toBe("compile");
  });
});

describe("rateLimitKey", () => {
  it("prefers X-Kaspa-Demo-Key", () => {
    const req = new Request("https://example/mcp", {
      headers: { "X-Kaspa-Demo-Key": "abc", "CF-Connecting-IP": "1.1.1.1" },
    });
    expect(rateLimitKey(req)).toBe("demo:abc");
  });
  it("falls back to CF-Connecting-IP", () => {
    const req = new Request("https://example/mcp", {
      headers: { "CF-Connecting-IP": "1.1.1.1" },
    });
    expect(rateLimitKey(req)).toBe("1.1.1.1");
  });
});
