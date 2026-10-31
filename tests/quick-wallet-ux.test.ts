import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { signPageHtml, SIGN_CSS } from "../src/sign/page.js";
import { WALLET_TAP_APPROVE, BUILD_TIPJAR_PUBLIC_GUIDE } from "../src/ux-copy.js";
import { TOOL_ANNOTATIONS, EXPECTED_TOOL_NAMES } from "../src/tool-annotations.js";

describe("quick-start wallet UX surface", () => {
  it("sign page HTML includes quick-start + send panels", () => {
    const html = signPageHtml("a".repeat(32), null, "n");
    expect(html).toMatch(/id="quickWallet"/);
    expect(html).toMatch(/id="sendPanel"/);
    expect(html).toMatch(/Create Quick-start wallet/);
    expect(html).toMatch(/qwDataLoss/);
  });

  it("CSS styles quick-start", () => {
    expect(SIGN_CSS).toMatch(/\.quick-wallet/);
    expect(SIGN_CSS).toMatch(/\.send-panel/);
  });

  it("public assets ship quick-wallet.js and hooks", () => {
    const qw = readFileSync(join(process.cwd(), "public/sign/quick-wallet.js"), "utf8");
    expect(qw).toMatch(/createWallet/);
    expect(qw).toMatch(/WebAuthn-PRF|prf/);
    expect(qw).toMatch(/sendPayment/);
    expect(qw).toMatch(/DATA_LOSS_NOTICE|Clearing browser data/);
    const app = readFileSync(join(process.cwd(), "public/sign/app.js"), "utf8");
    expect(app).toMatch(/initQuickWalletUi/);
    expect(app).toMatch(/api: "quick"/);
    expect(app).toMatch(/buildPaymentTx/);
    const l1 = readFileSync(join(process.cwd(), "public/sign/l1-build.js"), "utf8");
    expect(l1).toMatch(/buildPaymentTx/);
  });

  it("agent copy steers newbies to Quick-start", () => {
    expect(WALLET_TAP_APPROVE.worksNow.join(" ")).toMatch(/Quick-start/i);
    expect(BUILD_TIPJAR_PUBLIC_GUIDE).toMatch(/Quick-start/i);
    expect(BUILD_TIPJAR_PUBLIC_GUIDE).toMatch(/l1_prepare_send/);
  });

  it("registers l1_prepare_send annotation", () => {
    expect(TOOL_ANNOTATIONS.l1_prepare_send).toBeTruthy();
    expect(EXPECTED_TOOL_NAMES).toContain("l1_prepare_send");
  });
});
