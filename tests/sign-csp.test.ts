import { describe, it, expect } from "vitest";
import { signCsp, signPageHtml } from "../src/sign/page.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("/sign CSP and XSS hardening", () => {
  it("CSP defaults to none and allows self scripts with nonce", () => {
    const csp = signCsp("abc123nonce");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("nonce-abc123nonce");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it("page HTML sanitizes id and does not embed raw angle brackets in SIGN_ID", () => {
    const html = signPageHtml("deadbeef<script>", null, "n1");
    expect(html).toContain('window.__SIGN_ID__="deadbeefscript"');
    expect(html).not.toMatch(/__SIGN_ID__="[^"]*</);
  });

  it("l1-build pins wasm sha384", () => {
    const js = readFileSync(join(process.cwd(), "public/sign/l1-build.js"), "utf8");
    const sri = readFileSync(join(process.cwd(), "public/kaspa-wasm/SRI.txt"), "utf8").trim();
    expect(js).toMatch(/KASPA_WASM_SHA384_HEX = "[a-f0-9]{96}"/);
    expect(sri).toMatch(/^sha384-/);
    expect(js).toContain("integrity check failed");
  });
});
