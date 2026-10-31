#!/usr/bin/env node
/**
 * Mainnet Quick-start e2e (Michael-approved, capped ≤5 KAS total from deploy wallet).
 * Persists QW key to 0600 temp file for mid-run recovery only; never prints/commits it.
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync, chmodSync, existsSync, unlinkSync } from "node:fs";
import { blake2b } from "@noble/hashes/blake2.js";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.SIGN_BASE_URL || "http://127.0.0.1:18887";
const DEPLOY_KEY_FILE =
  process.env.KASPA_MAINNET_KEY_FILE || "/home/box/.kaspa-operator/kaspa-l1.privateKey";
const ADDR_FILE = "/home/box/.kaspa-operator/addresses.json";
const OUT = join(ROOT, "docs/E2E_QUICK_WALLET_MAINNET_RESULTS.json");
const KEY_TMP = join(tmpdir(), "kaspa-qw-mainnet-e2e.key");
const MAX_TOTAL_SOMPI = 5n * 100_000_000n;
const FEE = 400_000n;

function loadDeployKey() {
  const raw = readFileSync(DEPLOY_KEY_FILE, "utf8").trim();
  const key = raw.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("deploy key file shape unexpected");
  const addresses = JSON.parse(readFileSync(ADDR_FILE, "utf8"));
  return { privateKeyHex: key, address: addresses.kaspaL1Address };
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

async function balance(address) {
  const res = await fetch("https://api.kaspa.org/addresses/" + encodeURIComponent(address) + "/balance");
  const j = await res.json();
  return BigInt(j.balance ?? 0);
}

async function listUtxos(address) {
  const res = await fetch("https://api.kaspa.org/addresses/" + encodeURIComponent(address) + "/utxos");
  const list = await res.json();
  return (Array.isArray(list) ? list : []).map((u) => {
    const entry = u.utxoEntry || u;
    let script =
      entry.scriptPublicKey?.scriptPublicKey ||
      entry.scriptPublicKey?.script ||
      entry.script_public_key ||
      "";
    if (typeof script === "object") script = script.script || "";
    return {
      transactionId: u.outpoint.transactionId || u.outpoint.transaction_id,
      index: Number(u.outpoint.index),
      amountSompi: String(entry.amount),
      scriptPublicKey: {
        version: entry.scriptPublicKey?.version ?? 0,
        script: String(script).replace(/^0x/, "").replace(/^0000/, ""),
      },
    };
  });
}

async function waitStatus(page, okRe, ms = 180000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const s = await page.locator("#status").innerText();
    if (okRe.test(s) && !/Building|Loading|Rebuilding|Waiting for funds/i.test(s)) return s;
    if (/failed|error|Insufficient/i.test(s) && !/Building|Waiting/i.test(s)) throw new Error("status: " + s);
    if (Date.now() > deadline) throw new Error("timeout: " + s);
    await page.waitForTimeout(500);
  }
}

async function approveQuick(page, tapUrl, qwKeyHex) {
  await page.addInitScript(({ key }) => {
    window.__QUICK_WALLET_TEST_KEY__ = key;
  }, { key: qwKeyHex });
  await page.goto(tapUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
  await waitStatus(
    page,
    /Fund covenant|Spend covenant|Send |Withdraw|Ready|Tip Jar|Quick-start|Connected|Send KAS|Approve/i,
  );
  if (await page.locator("#connect").isEnabled()) {
    await page.click("#connect");
    await page.waitForTimeout(400);
  }
  for (let i = 0; i < 60; i++) {
    if (await page.locator("#approve").isEnabled()) break;
    await page.waitForTimeout(400);
  }
  if (!(await page.locator("#approve").isEnabled())) {
    throw new Error("approve disabled: " + (await page.locator("#status").innerText()));
  }
  await page.click("#approve");
  await waitStatus(page, /Submitted/i, 180000);
  const result = await page.locator("#result").innerText();
  const m = result.match(/txid:\s*([a-f0-9]+)/i);
  if (!m) throw new Error("no txid: " + result);
  return { txid: m[1] };
}

async function main() {
  const deploy = loadDeployKey();
  const kaspa = await import("kaspa");
  process.env.SILVERC_PATH = process.env.SILVERC_PATH || "/workspace/silverscript-tools/silverc";
  const { compileSilverscript } = await import(pathToFileURL(join(ROOT, "dist/l1/compile.js")).href);
  const { buildAndSignPayment } = await import(pathToFileURL(join(ROOT, "dist/l1/pure/tx.js")).href);
  const { deriveP2shAddress } = await import(pathToFileURL(join(ROOT, "dist/l1/p2sh.js")).href);

  const balBefore = await balance(deploy.address);
  console.log("deploy balance before (KAS)", Number(balBefore) / 1e8);
  // Size run to remaining balance (leave dust)
  // Keep amounts round and well under storage-mass traps on fragmented UTXOs
  const qwFund = 30_000_000n; // 0.3 KAS
  const tipjarFund = 12_000_000n; // 0.12 KAS
  const tipAmt = 10_000_000n; // 0.1 KAS
  if (balBefore < qwFund + FEE + 1_000_000n) throw new Error("deploy wallet too low");

  const qwKeyHex = String(kaspa.Keypair.random().privateKey).replace(/^0x/, "");
  writeFileSync(KEY_TMP, qwKeyHex, { mode: 0o600 });
  chmodSync(KEY_TMP, 0o600);
  const qwPriv = new kaspa.PrivateKey(qwKeyHex);
  const qwAddr = qwPriv.toPublicKey().toAddress("mainnet").toString();
  const xonly = Buffer.from(qwPriv.toPublicKey().toXOnlyPublicKey().toString(), "hex");
  const pkh = Buffer.from(blake2b(xonly, { dkLen: 32 }));
  console.log("QW address", qwAddr);
  console.log("qwFundKas", Number(qwFund) / 1e8);

  const fundQw = await buildAndSignPayment({
    networkId: "mainnet",
    privateKeyHex: deploy.privateKeyHex,
    outputs: [{ address: qwAddr, amount: qwFund }],
    priorityFeeSompi: FEE,
  });
  console.log("funded QW", fundQw.txid);
  await new Promise((r) => setTimeout(r, 12000));

  await mcp("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "qw-mainnet-e2e", version: "0" },
  });
  await tool("choose_network", { choice: "mainnet" });

  const src = readFileSync(join(ROOT, "src/resources/silverscript/tipjar.sil"), "utf8");
  const compiled = await compileSilverscript({
    source: src,
    constructorArgs: [{ kind: "bytes", value: Array.from(pkh) }],
  });
  const derived = await deriveP2shAddress(
    Uint8Array.from(Buffer.from(compiled.bytecodeHex, "hex")),
    "mainnet",
  );

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  const steps = [];

  const fund = await tool("l1_prepare_fund", {
    network: "kaspa-l1-mainnet",
    fromAddress: qwAddr,
    ownerAddress: qwAddr,
    amountSompi: String(tipjarFund),
    artifact: compiled.artifact,
    bytecodeHex: compiled.bytecodeHex,
    templateId: "tipjar",
    contractName: "TipJar",
    expectedP2shAddress: derived.address,
  });
  const fundRes = await approveQuick(page, fund.tapToApprove.url, qwKeyHex);
  steps.push({
    step: "deploy_fund",
    txid: fundRes.txid,
    explorer: `https://explorer.kaspa.org/txs/${fundRes.txid}`,
    p2sh: derived.address,
  });
  console.log("deploy", fundRes.txid);
  await new Promise((r) => setTimeout(r, 10000));

  const tip = await tool("l1_prepare_fund", {
    network: "kaspa-l1-mainnet",
    fromAddress: qwAddr,
    ownerAddress: qwAddr,
    amountSompi: String(tipAmt),
    artifact: compiled.artifact,
    bytecodeHex: compiled.bytecodeHex,
    templateId: "tipjar",
    contractName: "TipJar",
    expectedP2shAddress: derived.address,
  });
  const tipRes = await approveQuick(page, tip.tapToApprove.url, qwKeyHex);
  steps.push({
    step: "tip",
    txid: tipRes.txid,
    explorer: `https://explorer.kaspa.org/txs/${tipRes.txid}`,
  });
  console.log("tip", tipRes.txid);
  await new Promise((r) => setTimeout(r, 10000));

  // Withdraw EVERY tipjar UTXO back to QW
  let utxos = await listUtxos(derived.address);
  for (let attempt = 0; attempt < 10 && utxos.length === 0; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    utxos = await listUtxos(derived.address);
  }
  console.log("tipjar utxos", utxos.length);
  for (const utxo of utxos) {
    const amt = BigInt(utxo.amountSompi);
    if (amt <= FEE) continue;
    const spend = await tool("l1_prepare_spend", {
      network: "kaspa-l1-mainnet",
      entry: "withdraw",
      args: ["$pk", "$sig"],
      destinationAddress: qwAddr,
      artifact: compiled.artifact,
      utxo,
      feeSompi: String(FEE),
      outputAmountSompi: String(amt - FEE),
      contractName: "TipJar",
    });
    const spendRes = await approveQuick(page, spend.tapToApprove.url, qwKeyHex);
    steps.push({
      step: "withdraw",
      txid: spendRes.txid,
      explorer: `https://explorer.kaspa.org/txs/${spendRes.txid}`,
      amountSompi: utxo.amountSompi,
    });
    console.log("withdraw", spendRes.txid);
    await new Promise((r) => setTimeout(r, 8000));
  }

  // Return remaining QW funds to deploy
  await new Promise((r) => setTimeout(r, 5000));
  const qwBal = await balance(qwAddr);
  console.log("qw bal before return", Number(qwBal) / 1e8);
  if (qwBal > FEE + 1000n) {
    const send = await tool("l1_prepare_send", {
      network: "kaspa-l1-mainnet",
      fromAddress: qwAddr,
      toAddress: deploy.address,
      amountSompi: "0",
      sendMax: true,
      priorityFeeSompi: String(FEE),
    });
    const sendRes = await approveQuick(page, send.tapToApprove.url, qwKeyHex);
    steps.push({
      step: "return_to_deploy",
      txid: sendRes.txid,
      explorer: `https://explorer.kaspa.org/txs/${sendRes.txid}`,
    });
    console.log("return", sendRes.txid);
  } else {
    console.log("skip return — QW dust only");
  }

  await browser.close();
  await new Promise((r) => setTimeout(r, 8000));
  const balAfter = await balance(deploy.address);
  const qwLeft = await balance(qwAddr);
  const spent = balBefore - balAfter;

  const out = {
    at: new Date().toISOString(),
    base: BASE,
    network: "mainnet",
    ok: true,
    qwAddress: qwAddr,
    deployAddress: deploy.address,
    p2sh: derived.address,
    priorUnreachableNotes: [
      "Earlier failed attempts left funds at unreachable Quick-start addresses when wRPC timed out before REST fallback existed (keys not retained).",
    ],
    balancesKas: {
      deployBefore: Number(balBefore) / 1e8,
      deployAfter: Number(balAfter) / 1e8,
      qwRemaining: Number(qwLeft) / 1e8,
      totalSpentFromDeployThisRun: Number(spent) / 1e8,
    },
    maxCapKas: 5,
    steps,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  try {
    unlinkSync(KEY_TMP);
  } catch {}
  console.log("wrote", OUT);
  console.log("spentThisRunKas", out.balancesKas.totalSpentFromDeployThisRun);
  for (const s of steps) console.log(s.step, s.explorer);
  if (spent > MAX_TOTAL_SOMPI) console.warn("WARNING over 5 KAS this run");
}

main().catch((e) => {
  console.error("FAIL", e?.message || e);
  console.error("QW key temp (if present):", KEY_TMP, existsSync(KEY_TMP) ? "EXISTS — recover funds then delete" : "absent");
  process.exit(1);
});
