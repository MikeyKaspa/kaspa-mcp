#!/usr/bin/env node
/**
 * TN10 e2e against deployed kaspa-mcp-selfhost Worker (pure-JS signer).
 * Never prints secrets. Writes docs/E2E_WORKER_SELFHOST_RESULTS.json.
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.SELFHOST_BASE || "https://kaspa-mcp-selfhost.kaspa-mcp.workers.dev";
const KEY_FILE = "/home/box/.kaspa-operator/tn10/tn10.key";
const SECRET_FILE = join(ROOT, ".e2e-worker-spending.secret");
const OUT = join(ROOT, "docs/E2E_WORKER_SELFHOST_RESULTS.json");
const WRANGLER_CFG = "wrangler.selfhost.toml";
const ORPHAN_WAIT_MS = Number(process.env.ORPHAN_WAIT_MS || 8000);

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
  const hex = env.KASPA_PRIVATE_KEY.startsWith("0x") ? env.KASPA_PRIVATE_KEY : `0x${env.KASPA_PRIVATE_KEY}`;
  return { privateKeyHex: hex, address: env.KASPA_ADDRESS };
}

function assertNoKeyMaterial(obj) {
  const s = JSON.stringify(obj);
  if (/0x[0-9a-fA-F]{64}/.test(s)) throw new Error("RESULTS_LEAKED_KEY_MATERIAL");
}

async function mcp(method, params, id = 1) {
  const res = await fetch(BASE + "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  const line = text.includes("data:")
    ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5)
    : text;
  return JSON.parse(line || text);
}

async function tool(name, args) {
  const r = await mcp("tools/call", { name, arguments: args }, Math.floor(Math.random() * 1e6));
  const text = r.result?.content?.[0]?.text || "";
  if (r.error) throw new Error(JSON.stringify(r.error));
  if (r.result?.isError) throw new Error(text || JSON.stringify(r));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-json tool result for ${name}: ${text.slice(0, 200)}`);
  }
}

async function waitAddrBalance(address, minSompi, rpc) {
  for (let i = 0; i < 90; i++) {
    const got = await rpc.getUtxosByAddresses({ addresses: [address] });
    const bal = (got.entries || []).reduce((a, u) => a + BigInt(u.amount), 0n);
    if (bal >= minSompi) return bal;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`balance timeout for ${address}`);
}

async function waitP2shUtxo(address, txid) {
  const api = "https://api-tn10.kaspa.org";
  for (let i = 0; i < 60; i++) {
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
      let s = String(script).replace(/^0x/, "");
      if (s.startsWith("0000") && s.length > 4) s = s.slice(4);
      return {
        transactionId: hit.outpoint.transactionId || hit.outpoint.transaction_id,
        index: Number(hit.outpoint.index),
        amountSompi: String(entry.amount),
        scriptPublicKey: { version: entry.scriptPublicKey?.version ?? 0, script: s },
      };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("P2SH UTXO timeout " + txid);
}

async function main() {
  const results = { ok: false, base: BASE, steps: [], at: new Date().toISOString() };
  const op = loadOperator();

  const health = await fetch(BASE + "/health").then((r) => r.json());
  results.steps.push({
    step: "health",
    pureJsSigner: health.pureJsSigner,
    spendingWallet: health.spendingWallet,
    rateLimit: health.rateLimit,
  });

  // Session network choice (ask-first path)
  const netChoice = await tool("choose_network", { choice: "testnet" });
  results.steps.push({
    step: "choose_network",
    choice: (netChoice.result ?? netChoice).choice,
    l1NetworkId: (netChoice.result ?? netChoice).l1NetworkId,
  });

  // self_host verify step (guide only)
  const guide = await tool("self_host", { step: "verify" });
  results.steps.push({
    step: "self_host_verify",
    verified: (guide.result ?? guide).verified,
    sharedDemo: (guide.result ?? guide).sharedDemo,
  });

  // Create — may fail if already configured; then status
  let spendAddr;
  let createdKey;
  try {
    const created = await tool("spending_wallet_create", {
      network: "kaspa-l1-testnet-10",
      mainAddress: op.address,
    });
    if (!created.ok && created.error) throw new Error(created.error || JSON.stringify(created));
    const body = created.result || created;
    // tool() already parses inner JSON — shape is { ok, result } or flat
    const data = body.result ?? body;
    spendAddr = data.address;
    createdKey = data.privateKeyHex;
    if (!createdKey) throw new Error("Worker create did not return one-shot privateKeyHex");
    writeFileSync(SECRET_FILE, createdKey, { mode: 0o600 });
    // strip key from any object we log
    const safe = { ...data };
    delete safe.privateKeyHex;
    assertNoKeyMaterial(safe);
    results.steps.push({
      step: "create",
      address: spendAddr,
      mainAddress: data.mainAddress,
      hasSetupSteps: Array.isArray(data.setupSteps),
      registryPath: data.registryPath,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/already configured/i.test(msg)) throw e;
    const st = await tool("spending_wallet_status", { network: "kaspa-l1-testnet-10" });
    const data = st.result ?? st;
    spendAddr = data.address;
    results.steps.push({ step: "create_skipped_existing", address: spendAddr, status: data.configured });
  }

  if (createdKey) {
    // Set Worker secret without printing
    execFileSync(
      "npx",
      ["wrangler", "secret", "put", "KASPA_SPENDING_PRIVATE_KEY", "-c", WRANGLER_CFG],
      {
        cwd: ROOT,
        input: createdKey,
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf8",
      },
    );
    unlinkSync(SECRET_FILE);
    createdKey = undefined;
    results.steps.push({ step: "secret_put", ok: true });
    // Wait for deploy of secret
    await new Promise((r) => setTimeout(r, 3000));
  }

  const st2 = await tool("spending_wallet_status", { network: "kaspa-l1-testnet-10" });
  const status = st2.result ?? st2;
  assertNoKeyMaterial(status);
  results.steps.push({
    step: "status",
    configured: status.configured ?? Boolean(status.address),
    address: status.address,
    mainAddress: status.mainAddress,
  });
  if (!status.address) throw new Error("spending wallet not configured after secret put");
  spendAddr = status.address;

  // Fund spending wallet from operator via wRPC
  const kaspa = await import("kaspa");
  const fundAmt = 5_0000_0000n; // 5 tKAS for tipjar + 3 templates + fees
  const rpcUrl = process.env.KASPA_RPC_URL || "wss://electron-10.kaspa.blue/kaspa/testnet-10/wrpc/borsh";
  const rpc = new kaspa.RpcClient({ url: rpcUrl, encoding: kaspa.Encoding.Borsh, networkId: "testnet-10" });
  await rpc.connect();
  try {
    const bal0 = await waitAddrBalance(spendAddr, 0n, rpc).catch(() => 0n);
    if (bal0 < 3_0000_0000n) {
      const { entries } = await rpc.getUtxosByAddresses({ addresses: [op.address] });
      const { transactions } = await kaspa.createTransactions({
        entries,
        outputs: [{ address: spendAddr, amount: fundAmt }],
        changeAddress: op.address,
        priorityFee: kaspa.kaspaToSompi("0.0002"),
        networkId: "testnet-10",
      });
      const pending = transactions[0];
      const pk = new kaspa.PrivateKey(op.privateKeyHex.replace(/^0x/, ""));
      pending.sign([pk]);
      const txid = await pending.submit(rpc);
      results.steps.push({
        step: "fund_spending_wallet",
        txid: typeof txid === "string" ? txid : String(txid),
        amountSompi: String(fundAmt),
      });
      await waitAddrBalance(spendAddr, fundAmt, rpc);
    } else {
      results.steps.push({ step: "fund_spending_wallet", skipped: true, balanceSompi: String(bal0) });
    }
  } finally {
    await rpc.disconnect().catch(() => {});
  }

  // Bridge wRPC → REST lag before Worker pure-JS signer spends
  {
    const api = "https://api-tn10.kaspa.org";
    let restBal = 0n;
    for (let i = 0; i < 40; i++) {
      const res = await fetch(api + "/addresses/" + encodeURIComponent(spendAddr) + "/utxos");
      const list = await res.json();
      restBal = (Array.isArray(list) ? list : []).reduce(
        (a, u) => a + BigInt((u.utxoEntry || u).amount || 0),
        0n,
      );
      if (restBal >= 3_0000_0000n) break;
      await new Promise((r) => setTimeout(r, 800));
    }
    results.steps.push({ step: "rest_utxo_ready", balanceSompi: String(restBal) });
    if (restBal < 1_0000_0000n) throw new Error("REST still empty after fund: " + restBal);
  }

  // tipjar chat-deploy on Worker
  const tip = await tool("l1_tipjar_chat_deploy", {
    network: "kaspa-l1-testnet-10",
    amountSompi: "100000000",
  });
  const tipData = tip.result ?? tip;
  assertNoKeyMaterial(tipData);
  results.steps.push({
    step: "tipjar_chat_deploy",
    txid: tipData.txid,
    p2shAddress: tipData.p2shAddress,
    explorer: tipData.explorer,
  });

  const tipUtxo = await waitP2shUtxo(tipData.p2shAddress, tipData.txid);

  // Fund all 3 templates (tipjar already funded; fund vault + escrow)
  for (const templateId of ["timeout_vault", "escrow"]) {
    const funded = await tool("l1_prepare_fund", {
      network: "kaspa-l1-testnet-10",
      templateId,
      amountSompi: "100000000",
      autoSignBroadcast: true,
    });
    const fd = funded.result ?? funded;
    assertNoKeyMaterial(fd);
    results.steps.push({
      step: `fund_${templateId}`,
      txid: fd.txid,
      p2shAddress: fd.p2shAddress,
      explorer: fd.explorer,
    });
  }

  // Withdraw tipjar back to spending address
  const spent = await tool("l1_prepare_spend", {
    network: "kaspa-l1-testnet-10",
    entry: "withdraw",
    args: [null, null],
    destinationAddress: spendAddr,
    autoSignBroadcast: true,
    utxo: tipUtxo,
    // Full rebound TipJar artifact from chat-deploy (not stock templateId)
    artifact: tipData.artifact,
    contractName: tipData.contractName,
  });
  const sp = spent.result ?? spent;
  assertNoKeyMaterial(sp);
  results.steps.push({ step: "tipjar_withdraw", txid: sp.txid, explorer: sp.explorer });

  await new Promise((r) => setTimeout(r, 2500));

  const swept = await tool("spending_wallet_withdraw_all", { network: "kaspa-l1-testnet-10" });
  const sw = swept.result ?? swept;
  assertNoKeyMaterial(sw);
  if (sw.destinationAddress && sw.destinationAddress !== op.address) {
    throw new Error("withdraw_all destination mismatch");
  }
  results.steps.push({
    step: "withdraw_all",
    txid: sw.txid,
    txids: sw.txids,
    amountSompi: sw.amountSompi,
    destination: sw.destinationAddress,
    explorer: sw.explorer,
  });

  assertNoKeyMaterial(results);
  results.ok = true;
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(
    JSON.stringify({
      ok: true,
      out: OUT,
      steps: results.steps.map((s) => s.step),
      explorers: results.steps.filter((s) => s.explorer).map((s) => ({ step: s.step, explorer: s.explorer })),
    }),
  );
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("E2E_WORKER_FAIL", msg.slice(0, 500));
  writeFileSync(OUT, JSON.stringify({ ok: false, error: msg.slice(0, 800) }, null, 2));
  process.exit(1);
});
