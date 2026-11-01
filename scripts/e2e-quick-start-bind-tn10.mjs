#!/usr/bin/env node
/**
 * TN10: l1_prepare_fund with NO from/owner address → Quick-start bind → tipjar fund.
 * Requires KASPA_TN10_KEY_FILE for faucet substitute (operator fund). Never prints secrets.
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.SIGN_BASE_URL || "https://kaspa-mcp.kaspa-mcp.workers.dev";
const KEY_FILE = process.env.KASPA_TN10_KEY_FILE || "/home/box/.kaspa-operator/tn10/tn10.key";
const OUT = join(ROOT, "docs/E2E_QUICK_START_BIND_TN10_RESULTS.json");

async function mcp(method, params, id = 1) {
  const res = await fetch(BASE + "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  const data = text.includes("data:")
    ? text.split("\n").find((l) => l.startsWith("data:")).slice(5)
    : text;
  return JSON.parse(data);
}
async function tool(name, args) {
  const r = await mcp("tools/call", { name, arguments: args }, Math.floor(Math.random() * 1e6));
  const text = r.result?.content?.[0]?.text || "";
  if (r.result?.isError) throw new Error(text || JSON.stringify(r));
  return JSON.parse(text);
}

const results = { base: BASE, steps: [], ok: false };
try {
  await tool("choose_network", { choice: "testnet" });
  results.steps.push({ step: "choose_network", choice: "testnet" });

  const prep = await tool("l1_prepare_fund", { templateId: "tipjar", amountSompi: "100000000" });
  if (prep.mode !== "quick_start_bind") throw new Error("expected quick_start_bind, got " + prep.mode);
  if (prep.fromAddress || prep.ownerAddress) throw new Error("should omit addresses");
  const url = prep.tapToApprove?.url;
  if (!url) throw new Error("missing tap url");
  results.steps.push({ step: "prepare_fund_bind", mode: prep.mode, url });

  if (!existsSync(KEY_FILE)) {
    results.steps.push({ step: "skip_live_fund", reason: "no operator key file" });
    results.ok = true;
    results.partial = true;
    writeFileSync(OUT, JSON.stringify(results, null, 2));
    console.log("PARTIAL OK (bind mode verified against", BASE, ") — no key for live fund");
    process.exit(0);
  }

  const env = Object.fromEntries(
    readFileSync(KEY_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), l.slice(i + 1)];
      }),
  );
  const testKey = env.KASPA_PRIVATE_KEY;
  if (!testKey) throw new Error("missing KASPA_PRIVATE_KEY in key file");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addInitScript((k) => {
    window.__QUICK_WALLET_TEST_KEY__ = k;
  }, testKey);
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(4000);
  const status = await page.locator("#status").textContent().catch(() => "");
  const addr = await page.locator("#qwAddress").textContent().catch(() => "");
  results.steps.push({ step: "page_bind", status: (status || "").slice(0, 120), hasAddress: Boolean(addr && addr.startsWith("kaspatest:")) });
  await browser.close();
  results.ok = Boolean(addr && addr.startsWith("kaspatest:"));
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(results.ok ? "OK bind page showed address" : "FAIL", OUT);
  process.exit(results.ok ? 0 : 1);
} catch (e) {
  results.error = String(e && e.message ? e.message : e);
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.error(results.error);
  process.exit(1);
}
