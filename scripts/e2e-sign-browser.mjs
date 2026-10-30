#!/usr/bin/env node
/**
 * Playwright: open /sign/<id> on local Worker/Node, mock window.kasware with
 * operator TN10 key (never printed), fund+spend all 3 templates.
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { blake2b } from "@noble/hashes/blake2.js";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.SIGN_BASE_URL || "http://127.0.0.1:8787";
const KEY_FILE = "/home/box/.kaspa-operator/tn10/tn10.key";
const OUT = join(ROOT, "docs/E2E_SIGN_BROWSER_RESULTS.json");

function loadKey() {
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
  for (let i = 0; i < 40; i++) {
    const res = await fetch(api + "/addresses/" + encodeURIComponent(address) + "/utxos");
    const list = await res.json();
    const hit = (Array.isArray(list) ? list : []).find(
      (u) => (u.outpoint?.transactionId || u.outpoint?.transaction_id) === txid,
    );
    if (hit) {
      const entry = hit.utxoEntry || hit;
      let script = entry.scriptPublicKey?.scriptPublicKey || entry.scriptPublicKey?.script || entry.script_public_key || "";
      if (typeof script === "object") script = script.script || "";
      return {
        transactionId: txid,
        index: Number(hit.outpoint.index),
        amountSompi: String(entry.amount),
        scriptPublicKey: {
          version: entry.scriptPublicKey?.version ?? 0,
          script: String(script).replace(/^0x/, "").replace(/^0000/, "") ,
        },
      };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("UTXO not found for " + txid);
}

async function approveInBrowser(page, tapUrl, privateKeyHex) {
  await page.addInitScript(
    ({ key }) => {
      window.__SIGN_TEST_KEY__ = key;
    },
    { key: privateKeyHex },
  );

  // Mock KasWare using page's kaspa-wasm after load — inject before navigation
  await page.addInitScript(() => {
    window.__kaswareQueue = [];
    window.kasware = {
      requestAccounts: async () => ["kaspatest:mock"],
      getNetwork: async () => "kaspa_testnet_10",
      signPskt: async ({ txJsonString }) => {
        const mod = await import("/kaspa-wasm/kaspa.js");
        await mod.default({ module_or_path: "/kaspa-wasm/kaspa_bg.wasm" });
        const key = new mod.PrivateKey(String(window.__SIGN_TEST_KEY__).replace(/^0x/, ""));
        const tx = mod.Transaction.deserializeFromSafeJSON(txJsonString);
        for (let i = 0; i < tx.inputs.length; i++) {
          const sig = mod.createInputSignature(tx, i, key, mod.SighashType.All);
          tx.inputs[i].signatureScript = sig;
        }
        return tx.serializeToSafeJSON();
      },
      pushTx: async (txJsonString) => {
        const mod = await import("/kaspa-wasm/kaspa.js");
        await mod.default({ module_or_path: "/kaspa-wasm/kaspa_bg.wasm" });
        const tx = mod.Transaction.deserializeFromSafeJSON(txJsonString);
        const rpc = new mod.RpcClient({
          url: "wss://electron-10.kaspa.blue/kaspa/testnet-10/wrpc/borsh",
          encoding: mod.Encoding.Borsh,
          networkId: "testnet-10",
        });
        await rpc.connect();
        try {
          const res = await rpc.submitTransaction({ transaction: tx, allowOrphan: false });
          return res.transactionId || String(res);
        } finally {
          try {
            await rpc.disconnect();
          } catch {}
        }
      },
    };
  });

  await page.goto(tapUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
  // Wait for browser build without page.waitForFunction (CSP blocks unsafe-eval)
  const deadline = Date.now() + 120000;
  for (;;) {
    const s = await page.locator("#status").innerText();
    if (/Fund covenant|Spend covenant|Ready|Connected/i.test(s) && !/Building|Loading/i.test(s)) break;
    if (/failed|error/i.test(s) && !/Building/i.test(s)) throw new Error("status: " + s);
    if (Date.now() > deadline) throw new Error("timeout waiting build: " + s);
    await page.waitForTimeout(500);
  }
  await page.click("#connect");
  for (let i = 0; i < 60; i++) {
    if (await page.locator("#approve").isEnabled()) break;
    await page.waitForTimeout(500);
  }
  if (!(await page.locator("#approve").isEnabled())) throw new Error("approve still disabled");
  await page.click("#approve");
  const deadline2 = Date.now() + 120000;
  for (;;) {
    const s = await page.locator("#status").innerText();
    if (/Submitted/i.test(s)) break;
    if (/failed|error/i.test(s) && !/Approve in your wallet/i.test(s)) throw new Error("approve status: " + s);
    if (Date.now() > deadline2) throw new Error("timeout waiting submit: " + s);
    await page.waitForTimeout(500);
  }
  const result = await page.locator("#result").innerText();
  const m = result.match(/txid:\s*([a-f0-9]+)/i);
  if (!m) throw new Error("no txid in result: " + result);
  return { txid: m[1], result };
}

async function main() {
  const { privateKeyHex, address } = loadKey();
  // Use Node wasm only to get xonly/pkh for compile — via MCP silverscript on server with SILVERC
  await mcp("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "pw", version: "0" },
  });

  // Derive keys via a tiny dynamic import of kaspa (Node vendor)
  const kaspa = await import("kaspa");
  process.env.SILVERC_PATH = process.env.SILVERC_PATH || "/workspace/silverscript-tools/silverc";
  const { compileSilverscript } = await import(pathToFileURL(join(ROOT, "src/l1/compile.ts")).href);
  const pk = new kaspa.PrivateKey(privateKeyHex);
  const xonly = Buffer.from(pk.toPublicKey().toXOnlyPublicKey().toString(), "hex");
  const pkh = Buffer.from(blake2b(xonly, { dkLen: 32 }));

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  const results = [];

  const templates = [
    {
      id: "tipjar",
      entry: "withdraw",
      args: ["$pk", "$sig"],
      compile: async () => {
        // use pinned templateId — demo key differs from operator!
        // Must compile with operator pkh for spend to work
        const src = readFileSync(join(ROOT, "src/resources/silverscript/tipjar.sil"), "utf8");
        return compileSilverscript({ source: src, constructorArgs: [{ kind: "bytes", value: Array.from(pkh) }] });
      },
    },
    {
      id: "timeout_vault",
      entry: "transfer",
      args: ["$sig"],
      compile: async () => {
        const src = readFileSync(join(ROOT, "src/resources/silverscript/timeout_vault.sil"), "utf8");
        return compileSilverscript({
          source: src,
          constructorArgs: [
            { kind: "bytes", value: Array.from(xonly) },
            { kind: "bytes", value: Array.from(xonly) },
            { kind: "int", value: 4000000000000 },
          ],
        });
      },
    },
    {
      id: "escrow",
      entry: "spend",
      args: ["$pk", "$sig"],
      compile: async () => {
        const src = readFileSync(join(ROOT, "src/resources/silverscript/escrow.sil"), "utf8");
        return compileSilverscript({
          source: src,
          constructorArgs: [
            { kind: "bytes", value: Array.from(pkh) },
            { kind: "bytes", value: Array.from(xonly) },
            { kind: "bytes", value: Array.from(xonly) },
          ],
        });
      },
    },
  ];

  for (const tmpl of templates) {
    console.log("===", tmpl.id, "===");
    const compiled = await tmpl.compile();
    const fund = await tool("l1_prepare_fund", {
      network: "kaspa-l1-testnet-10",
      fromAddress: address,
      amountSompi: "100000000",
      artifact: compiled.artifact,
      bytecodeHex: compiled.bytecodeHex,
    });
    if (!fund.tapToApprove?.url) throw new Error("no tap link fund");
    console.log("fund tap", fund.tapToApprove.url);
    const fundRes = await approveInBrowser(page, fund.tapToApprove.url, privateKeyHex);
    console.log("fund tx", fundRes.txid);
    // Need P2SH address — from page summary or rebuild
    const api = await (await fetch(BASE + "/api/sign/" + fund.tapToApprove.id)).json();
    // Re-open built p2sh from fund result text or query page
    await page.goto(fund.tapToApprove.url, { waitUntil: "domcontentloaded" });
    // get p2sh from summary after rebuild
    await page.addInitScript(({ key }) => { window.__SIGN_TEST_KEY__ = key; }, { key: privateKeyHex });
    // Fresh page for spend — extract p2sh from fund build via API isn't stored; parse from previous page
    // Instead: call l1_derive via compile artifact on Node... use addressFrom in a small node helper
    const { deriveP2shAddress } = await import(pathToFileURL(join(ROOT, "src/l1/p2sh.ts")).href);
    const derived = await deriveP2shAddress(
      Uint8Array.from(Buffer.from(compiled.bytecodeHex, "hex")),
      "testnet-10",
    );
    const utxo = await waitUtxo(derived.address, fundRes.txid);
    // Fix script: waitUtxo stripped 0000 — restore for spend
    if (!utxo.scriptPublicKey.script.startsWith("aa20")) {
      // keep as-is
    }
    const spend = await tool("l1_prepare_spend", {
      network: "kaspa-l1-testnet-10",
      entry: tmpl.entry,
      args: tmpl.args,
      destinationAddress: address,
      artifact: compiled.artifact,
      utxo,
      feeSompi: "300000",
      outputAmountSompi: String(BigInt(utxo.amountSompi) - 300000n),
    });
    console.log("spend tap", spend.tapToApprove.url);
    const spendRes = await approveInBrowser(page, spend.tapToApprove.url, privateKeyHex);
    console.log("spend tx", spendRes.txid);
    results.push({
      template: tmpl.id,
      fundTxid: fundRes.txid,
      fundExplorer: `https://tn10.kaspa.stream/transactions/${fundRes.txid}`,
      spendTxid: spendRes.txid,
      spendExplorer: `https://tn10.kaspa.stream/transactions/${spendRes.txid}`,
      fundTap: fund.tapToApprove.url,
      spendTap: spend.tapToApprove.url,
      p2sh: derived.address,
    });
  }

  await browser.close();
  const tipFundTap = results.find((r) => r.template === "tipjar");
  writeFileSync(
    OUT,
    JSON.stringify(
      { at: new Date().toISOString(), base: BASE, results, tipjarFundTapForMichael: tipFundTap?.fundTap },
      null,
      2,
    ),
  );
  console.log("wrote", OUT);
  console.log("TIPJAR_FUND_TAP", tipFundTap?.fundTap);
}

main().catch((e) => {
  console.error("FAIL", e?.message || e);
  process.exit(1);
});
