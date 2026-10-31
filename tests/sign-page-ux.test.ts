import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { signPageHtml, SIGN_CSS, SIGN_APP_JS } from "../src/sign/page.js";
import { summarizeL1SafeJson } from "../src/sign/summary.js";

const sampleFund = JSON.stringify({
  id: "abc",
  version: 0,
  inputs: [
    {
      transactionId: "aa".repeat(32),
      index: 0,
      sequence: "0",
      sigOpCount: 1,
      signatureScript: "",
      utxo: {
        address: "kaspatest:qza6ey35a278ft60rhvjfna96dznge4qrlw9zgr7zedngjzqvd97u9t9lscq6",
        amount: "200000000",
        scriptPublicKey: "000020bbac9234eabc74af4f1dd924cfa5d3453466a01fdc51207e165b344840634beeac",
        blockDaaScore: "1",
        isCoinbase: false,
      },
    },
  ],
  outputs: [
    {
      value: "100000000",
      scriptPublicKey: "0000aa20947ec7e31fa8a98bb83bf77547dcca6a471c6e80a0b6889d28c346abb16f61b887",
    },
    {
      value: "99663500",
      scriptPublicKey: "000020bbac9234eabc74af4f1dd924cfa5d3453466a01fdc51207e165b344840634beeac",
    },
  ],
  lockTime: "0",
  subnetworkId: "0000000000000000000000000000000000000000",
  gas: "0",
  payload: "",
});

describe("sign page UX", () => {
  it("HTML has sticky status, wallet cue, success banner, skeleton plain", () => {
    const html = signPageHtml("a".repeat(32), null, "nonce");
    expect(html).toMatch(/sticky-bar/);
    expect(html).toMatch(/id="walletCue"/);
    expect(html).toMatch(/Check your wallet popup/);
    expect(html).toMatch(/id="successBanner"/);
    expect(html).toMatch(/class="plain skeleton"/);
    expect(html).toMatch(/id="walletHelp"/);
    expect(html).toMatch(/<details id="walletHelp"/);
  });

  it("CSS sticky + success + cue styles present", () => {
    expect(SIGN_CSS).toMatch(/\.sticky-bar/);
    expect(SIGN_CSS).toMatch(/\.success-banner/);
    expect(SIGN_CSS).toMatch(/\.wallet-cue/);
    expect(SIGN_CSS).toMatch(/position:\s*sticky/);
  });

  it("app.js shows wallet cue on signing and success banner helpers", () => {
    expect(SIGN_APP_JS).toMatch(/Check your wallet popup/);
    expect(SIGN_APP_JS).toMatch(/showSuccess/);
    expect(SIGN_APP_JS).toMatch(/showProvisionalPlain/);
    expect(SIGN_APP_JS).toMatch(/walletHelpEl\.open = false/);
    const pub = readFileSync(join(process.cwd(), "public/sign/app.js"), "utf8");
    expect(pub).toContain("showSuccess");
    expect(pub).toContain("Check your wallet popup");
  });

  it("summarizeL1SafeJson exposes plainLines without Details", () => {
    const s = summarizeL1SafeJson(sampleFund, {
      kind: "l1-fund",
      networkLabel: "Kaspa L1 testnet-10",
      isMainnet: false,
    });
    expect(s.plainLines?.length).toBeGreaterThan(0);
    expect(s.plainLines?.some((l) => /Amount|Fee|Network/i.test(l.label))).toBe(true);
  });
});
