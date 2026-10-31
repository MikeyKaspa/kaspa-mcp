import { describe, it, expect } from "vitest";
import {
  timingSafeEqualString,
  extractPresentedToken,
  requireAuthIfConfigured,
  stripTokenPathPrefix,
} from "../src/auth.js";

describe("auth", () => {
  it("timingSafeEqualString", () => {
    expect(timingSafeEqualString("abc", "abc")).toBe(true);
    expect(timingSafeEqualString("abc", "abd")).toBe(false);
    expect(timingSafeEqualString("ab", "abc")).toBe(false);
  });

  it("extract Bearer / X-Api-Key / path", () => {
    const u = new URL("https://x.example/mcp");
    expect(
      extractPresentedToken(
        new Request(u, { headers: { Authorization: "Bearer tok123" } }),
        u,
      ),
    ).toBe("tok123");
    expect(
      extractPresentedToken(new Request(u, { headers: { "X-Api-Key": "k9" } }), u),
    ).toBe("k9");
    const pathU = new URL("https://x.example/t/abcdefghijklmnopqrstuvwxyz012345/mcp");
    expect(extractPresentedToken(new Request(pathU), pathU)).toBe(
      "abcdefghijklmnopqrstuvwxyz012345",
    );
  });

  it("requireAuthIfConfigured disabled when unset", () => {
    const u = new URL("https://x.example/mcp");
    const r = requireAuthIfConfigured(new Request(u), u, undefined);
    expect(r.ok).toBe(true);
  });

  it("requireAuthIfConfigured 401 without token", async () => {
    const u = new URL("https://x.example/mcp");
    const r = requireAuthIfConfigured(new Request(u), u, "secret-token-value-32chars-ok!!");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it("requireAuthIfConfigured accepts Bearer", () => {
    const tok = "secret-token-value-32chars-ok!!";
    const u = new URL("https://x.example/mcp");
    const r = requireAuthIfConfigured(
      new Request(u, { headers: { Authorization: `Bearer ${tok}` } }),
      u,
      tok,
    );
    expect(r.ok && r.authed).toBe(true);
  });

  it("OPTIONS bypasses auth", () => {
    const u = new URL("https://x.example/mcp");
    const r = requireAuthIfConfigured(
      new Request(u, { method: "OPTIONS" }),
      u,
      "secret-token-value-32chars-ok!!",
    );
    expect(r.ok).toBe(true);
  });

  it("stripTokenPathPrefix", () => {
    const u = new URL("https://x.example/t/abcdefghijklmnopqrstuvwxyz012345/mcp");
    const { url, tokenFromPath } = stripTokenPathPrefix(u);
    expect(tokenFromPath).toBe("abcdefghijklmnopqrstuvwxyz012345");
    expect(url.pathname).toBe("/mcp");
  });
});
