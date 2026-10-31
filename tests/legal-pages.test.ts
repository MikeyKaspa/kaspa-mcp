import { describe, it, expect } from "vitest";
import { handleLegalHttp, privacyHtml, termsHtml, supportHtml } from "../src/legal-pages.js";

describe("legal pages", () => {
  it("renders privacy, terms, support HTML with required sections", () => {
    for (const [name, html] of [
      ["privacy", privacyHtml()],
      ["terms", termsHtml()],
      ["support", supportHtml()],
    ] as const) {
      expect(html).toMatch(/<!DOCTYPE html>/i);
      expect(html.toLowerCase()).toContain(name === "privacy" ? "privacy policy" : name === "terms" ? "terms of use" : "support");
      expect(html).not.toMatch(/DFFM/i);
      expect(html).toContain("/privacy");
      expect(html).toContain("kaspa-mcp");
    }
  });

  it("handleLegalHttp serves GET routes and ignores others", () => {
    for (const path of ["/privacy", "/terms", "/support"]) {
      const res = handleLegalHttp(new Request(`https://example.test${path}`));
      expect(res?.status).toBe(200);
      expect(res?.headers.get("content-type")).toMatch(/text\/html/);
    }
    expect(handleLegalHttp(new Request("https://example.test/mcp"))).toBeNull();
    expect(handleLegalHttp(new Request("https://example.test/privacy", { method: "POST" }))).toBeNull();
  });
});
