#!/usr/bin/env node
/**
 * Playwright TN10: Quick-start wallet create→fund→tipjar→tip→withdraw + send.
 * Funds the browser wallet from operator TN10 key (faucet has no automatable API).
 * Never prints secrets.
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { blake2b } from "@noble/hashes/blake2.js";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.SIGN_BASE_URL || "http://127.0.0.1:8787";
const KEY_FILE = process.env.KASPA_TN10_KEY_FILE || "/home/box/.kaspa-operator/tn10/tn10.key";
const OUT = join(ROOT, "docs/E2E_QUICK_WALLET_TN10_RESULTS.json");

function loadOperator() {
  const env = Object.fromEntries(
    readFileSync(KEY_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), l.slice(i + 1)];
      }),
  );
  return { privateKeyHex: env.KASPA_PRIVATE_KEY, address: env.KASPA_ADDRESS };
}

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

async function waitUtxo(address, txid) {
  const api = "https://api-tn10.kaspa.org";
  for (let i = 0; i < 80; i++) {
    const res = await fetch(api + "/addresses/" + encodeURIComponent(address) + "/utxos");
    const list = await res.json();
    const hit = (Array.isArray(list) ? list : []).find(
      (u) => (u.outpoint?.transactionId || u.outpoint?.transaction_id) === txid,
    );
    if (hit) {
      const entry = hit.utxoEntry || hit;
      let script =
        entry.scriptPublicKey?.scriptPublicKey ||
        entry.scriptPublicKey?.script ||
        entry.script_public_key ||
        "";
      if (typeof script === "object") script = script.script || "";
      return {
        transactionId: txid,
        index: Number(hit.outpoint.index),
        amountSompi: String(entry.amount),
        scriptPublicKey: {
          version: entry.scriptPublicKey?.version ?? 0,
          script: String(script).replace(/^0x/, "").replace(/^0000/, ""),
        },
      };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("UTXO not found for " + txid);
}

async function waitStatus(page, okRe, failRe, ms = 180000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const s = await page.locator("#status").innerText();
    if (okRe.test(s) && !/Building|Loading|Rebuilding|Waiting for funds/i.test(s)) return s;
    if (failRe && failRe.test(s) && !/Building|Waiting/i.test(s)) throw new Error("status: " + s);
    if (Date.now() > deadline) throw new Error("timeout: " + s);
    await page.waitForTimeout(500);
  }
}

async function approveQuick(page, tapUrl, qwKeyHex) {
  await page.addInitScript(
    ({ key }) => {
      window.__QUICK_WALLET_TEST_KEY__ = key;
    },
    { key: qwKeyHex },
  );
  await page.goto(tapUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
  await waitStatus(
    page,
    /Fund covenant|Spend covenant|Send |Withdraw|Ready|Tip Jar|Quick-start|Connected|Send KAS|Approve/i,
    /failed|error/i,
  );
  // Prefer Quick-start connect
  if (await page.locator("#connect").isEnabled()) {
    await page.click("#connect");
    await page.waitForTimeout(500);
  }
  for (let i = 0; i < 60; i++) {
    if (await page.locator("#approve").isEnabled()) break;
    await page.waitForTimeout(400);
  }
  if (!(await page.locator("#approve").isEnabled())) {
    throw new Error("approve disabled; status=" + (await page.locator("#status").innerText()));
  }
  await page.click("#approve");
  await waitStatus(page, /Submitted/i, /failed|error/i, 180000);
  const result = await page.locator("#result").innerText();
  const m = result.match(/txid:\s*([a-f0-9]+)/i);
  if (!m) throw new Error("no txid: " + result);
  return { txid: m[1] };
}

async function main() {
  const op = loadOperator();
  const kaspa = await import("kaspa");
  process.env.SILVERC_PATH = process.env.SILVERC_PATH || "/workspace/silverscript-tools/silverc";
  const { compileSilverscript } = await import(pathToFileURL(join(ROOT, "dist/l1/compile.js")).href);
  const { buildAndSignPayment } = await import(pathToFileURL(join(ROOT, "dist/l1/pure/tx.js")).href);
  const { deriveP2shAddress } = await import(pathToFileURL(join(ROOT, "dist/l1/p2sh.js")).href);

  // Fresh Quick-start key (browser will unlock via __QUICK_WALLET_TEST_KEY__)
  const qwKeyHex = String(kaspa.Keypair.random().privateKey).replace(/^0x/, "");
  const qwPriv = new kaspa.PrivateKey(qwKeyHex);
  const qwAddr = qwPriv.toPublicKey().toAddress("testnet-10").toString();
  const xonly = Buffer.from(qwPriv.toPublicKey().toXOnlyPublicKey().toString(), "hex");
  const pkh = Buffer.from(blake2b(xonly, { dkLen: 32 }));

  console.log("QW address prefix", qwAddr.slice(0, 24) + "…");

  // Fund quick-start from operator (2 tKAS) — no faucet API
  const fundQw = await buildAndSignPayment({
    networkId: "testnet-10",
    privateKeyHex: op.privateKeyHex,
    outputs: [{ address: qwAddr, amount: 200_000_000n }],
    priorityFeeSompi: 250_000n,
  });
  console.log("funded QW", fundQw.txid);
  await new Promise((r) => setTimeout(r, 6000));

  await mcp("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "qw-e2e", version: "0" },
  });
  await tool("choose_network", { choice: "testnet" });

  const src = readFileSync(join(ROOT, "src/resources/silverscript/tipjar.sil"), "utf8");
  const compiled = await compileSilverscript({
    source: src,
    constructorArgs: [{ kind: "bytes", value: Array.from(pkh) }],
  });
  const derived = await deriveP2shAddress(
    Uint8Array.from(Buffer.from(compiled.bytecodeHex, "hex")),
    "testnet-10",
  );

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  const results = { at: new Date().toISOString(), base: BASE, qwAddress: qwAddr, steps: [] };

  // Deploy tipjar (fund covenant) from QW
  const fund = await tool("l1_prepare_fund", {
    network: "kaspa-l1-testnet-10",
    fromAddress: qwAddr,
    ownerAddress: qwAddr,
    amountSompi: "100000000",
    artifact: compiled.artifact,
    bytecodeHex: compiled.bytecodeHex,
    templateId: "tipjar",
    contractName: "TipJar",
    expectedP2shAddress: derived.address,
  });
  if (!fund.tapToApprove?.url) throw new Error("no fund tap");
  const fundRes = await approveQuick(page, fund.tapToApprove.url, qwKeyHex);
  results.steps.push({
    step: "deploy_fund",
    txid: fundRes.txid,
    explorer: `https://tn10.kaspa.stream/transactions/${fundRes.txid}`,
    p2sh: derived.address,
  });
  console.log("deploy", fundRes.txid);
  await new Promise((r) => setTimeout(r, 8000));

  // Tip 0.5 tKAS into jar from QW
  const tip = await tool("l1_prepare_fund", {
    network: "kaspa-l1-testnet-10",
    fromAddress: qwAddr,
    ownerAddress: qwAddr,
    amountSompi: "50000000",
    artifact: compiled.artifact,
    bytecodeHex: compiled.bytecodeHex,
    templateId: "tipjar",
    contractName: "TipJar",
    expectedP2shAddress: derived.address,
  });
  const tipRes = await approveQuick(page, tip.tapToApprove.url, qwKeyHex);
  results.steps.push({
    step: "tip",
    txid: tipRes.txid,
    explorer: `https://tn10.kaspa.stream/transactions/${tipRes.txid}`,
  });
  console.log("tip", tipRes.txid);
  await new Promise((r) => setTimeout(r, 8000));

  // Withdraw tipjar UTXO (use tip tx) back to QW
  const utxo = await waitUtxo(derived.address, tipRes.txid);
  const spend = await tool("l1_prepare_spend", {
    network: "kaspa-l1-testnet-10",
    entry: "withdraw",
    args: ["$pk", "$sig"],
    destinationAddress: qwAddr,
    artifact: compiled.artifact,
    utxo,
    feeSompi: "300000",
    outputAmountSompi: String(BigInt(utxo.amountSompi) - 300000n),
    contractName: "TipJar",
  });
  const spendRes = await approveQuick(page, spend.tapToApprove.url, qwKeyHex);
  results.steps.push({
    step: "withdraw",
    txid: spendRes.txid,
    explorer: `https://tn10.kaspa.stream/transactions/${spendRes.txid}`,
  });
  console.log("withdraw", spendRes.txid);
  await new Promise((r) => setTimeout(r, 6000));

  // Send KAS via l1_prepare_send back toward operator (0.2 tKAS)
  const send = await tool("l1_prepare_send", {
    network: "kaspa-l1-testnet-10",
    fromAddress: qwAddr,
    toAddress: op.address,
    amountSompi: "20000000",
  });
  if (!send.tapToApprove?.url) throw new Error("no send tap");
  const sendRes = await approveQuick(page, send.tapToApprove.url, qwKeyHex);
  results.steps.push({
    step: "send",
    txid: sendRes.txid,
    explorer: `https://tn10.kaspa.stream/transactions/${sendRes.txid}`,
    to: op.address,
  });
  console.log("send", sendRes.txid);

  await browser.close();
  results.ok = true;
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log("wrote", OUT);
  for (const s of results.steps) console.log(s.step, s.explorer);
}

main().catch((e) => {
  console.error("FAIL", e?.message || e);
  process.exit(1);
});
