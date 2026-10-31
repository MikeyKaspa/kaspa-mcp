#!/usr/bin/env node
/**
 * AUTHORIZED L1 mainnet smoke (Michael 2026-10-30).
 * - Uses dedicated L1 wallet only (never Kasplex L2).
 * - Cap: tipjar fund 1 KAS + fees; stop if preflight balance < 2.5 KAS.
 * - Never prints keys. Writes docs/E2E_MAINNET_L1_SMOKE.json
 */
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs/E2E_MAINNET_L1_SMOKE.json");
const ADDR_META = "/home/box/.kaspa-operator/addresses.json";
const KEY_FILE = "/home/box/.kaspa-operator/kaspa-l1.privateKey";
const TIPJAR_FUND_SOMPI = 100_000_000n; // 1 KAS
const MIN_BALANCE_SOMPI = 250_000_000n; // 2.5 KAS preflight
const REG_PATH = join(ROOT, `.e2e-mainnet-smoke-${randomBytes(4).toString("hex")}.registry.json`);
const RESULTS = { ok: false, network: "kaspa-l1-mainnet", steps: [], at: new Date().toISOString(), warnings: [] };

function assertNoKeyMaterial(obj) {
  const s = JSON.stringify(obj);
  if (/0x[0-9a-fA-F]{64}/.test(s)) throw new Error("RESULTS_LEAKED_KEY_MATERIAL");
  if (/[0-9a-fA-F]{64}/.test(s) && /private|mnemonic|seed/i.test(s)) throw new Error("RESULTS_LEAKED_KEY_FIELD");
}

function loadL1KeyHex() {
  const raw = readFileSync(KEY_FILE, "utf8").trim();
  const hex = raw.startsWith("0x") ? raw.toLowerCase() : `0x${raw.toLowerCase()}`;
  if (!/^0x[0-9a-f]{64}$/.test(hex)) throw new Error("L1 key file shape invalid");
  return hex;
}

async function restBalance(address) {
  const url = `https://api.kaspa.org/addresses/${encodeURIComponent(address)}/balance`;
  const res = await fetch(url, { headers: { "user-agent": "kaspa-mcp-mainnet-smoke" } });
  if (!res.ok) throw new Error(`balance HTTP ${res.status}`);
  const j = await res.json();
  return BigInt(j.balance);
}

async function waitP2shUtxo(address, txid) {
  for (let i = 0; i < 90; i++) {
    const res = await fetch(
      `https://api.kaspa.org/addresses/${encodeURIComponent(address)}/utxos`,
      { headers: { "user-agent": "kaspa-mcp-mainnet-smoke" } },
    );
    const list = await res.json();
    const hit = (Array.isArray(list) ? list : []).find(
      (u) => (u.outpoint?.transactionId || u.outpoint?.transaction_id) === txid,
    );
    if (hit) {
      const entry = hit.utxoEntry || hit;
      let script =
        entry.scriptPublicKey?.scriptPublicKey ||
        entry.scriptPublicKey?.script ||
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
  const meta = JSON.parse(readFileSync(ADDR_META, "utf8"));
  const mainAddress = meta.kaspaL1Address;
  if (!mainAddress?.startsWith("kaspa:")) throw new Error("bad mainAddress in addresses.json");

  // Isolate env — never touch Kasplex keys
  delete process.env.KASPA_SPENDING_PRIVATE_KEY;
  process.env.MCP_PUBLIC = "false";
  process.env.KASPA_SPENDING_MAINNET = "1";
  process.env.KASPA_L1_MAINNET_WRITES = "1";
  process.env.KASPA_SPENDING_REGISTRY_PATH = REG_PATH;
  process.env.KASPA_L1_BROWSER_BUILD = "0";

  const keyHex = loadL1KeyHex();
  process.env.KASPA_SPENDING_PRIVATE_KEY = keyHex;

  const { privateKeyToAddress, privateKeyToXonly } = await import("../dist/l1/pure/sign.js");
  const { bytesToHex } = await import("../dist/l1/script.js");
  const fromAddress = privateKeyToAddress(keyHex, "mainnet");
  if (fromAddress !== mainAddress) {
    throw new Error(`L1 key address mismatch: expected addresses.json L1, got different address`);
  }

  const bal0 = await restBalance(mainAddress);
  RESULTS.steps.push({
    step: "preflight_balance",
    address: mainAddress,
    balanceSompi: bal0.toString(),
    balanceKas: Number(bal0) / 1e8,
  });
  if (bal0 < MIN_BALANCE_SOMPI) {
    throw new Error(`Balance ${bal0} below min ${MIN_BALANCE_SOMPI} — abort, spend nothing`);
  }

  // Registry: spending = main (TipJar owner = dedicated L1 wallet)
  const reg = {
    version: 1,
    mainAddress,
    spendingAddress: mainAddress,
    networkId: "kaspa-l1-mainnet",
    createdAt: new Date().toISOString(),
    covenants: [],
  };
  writeFileSync(REG_PATH, JSON.stringify(reg), { mode: 0o600 });

  const { getNetwork } = await import("../dist/networks.js");
  const { setSessionNetworkChoice } = await import("../dist/session-network.js");
  const { getTemplate } = await import("../dist/l1/templates.js");
  const { rebindTipjarOwnerPkh } = await import("../dist/l1/artifact.js");
  const { ownerPkhHex } = await import("../dist/spending-wallet.js");
  const { autoFundCovenant, autoSpendCovenant, spendingWalletWithdrawAll, balanceSompi } =
    await import("../dist/l1/auto-sign.js");
  const { confirmTransaction } = await import("../dist/l1/confirm.js");
  const { blake2b } = await import("@noble/hashes/blake2.js");

  await setSessionNetworkChoice("mainnet");
  const network = getNetwork("kaspa-l1-mainnet");
  RESULTS.steps.push({ step: "choose_network", choice: "mainnet" });
  RESULTS.warnings.push(
    "UNAUDITED / USE AT YOUR OWN RISK — SilverScript mainnet smoke authorized by Michael",
  );

  const pkhHex = await ownerPkhHex(keyHex);
  const tipjar = getTemplate("tipjar");
  const loaded = rebindTipjarOwnerPkh(tipjar.loadedExample, pkhHex);

  // Deploy (fund) TipJar — 1 KAS
  const funded = await autoFundCovenant({
    network,
    bytecode: loaded.bytecode,
    amountSompi: TIPJAR_FUND_SOMPI,
    templateId: "tipjar",
  });
  assertNoKeyMaterial(funded);
  const fundConf = await confirmTransaction("mainnet", funded.txid, { timeoutMs: 60_000 });
  RESULTS.steps.push({
    step: "tipjar_fund",
    txid: funded.txid,
    p2shAddress: funded.p2shAddress,
    amountSompi: funded.amountSompi,
    explorer: funded.explorer || `https://explorer.kaspa.org/transactions/${funded.txid}`,
    confirmation: {
      status: fundConf.status,
      isAccepted: fundConf.isAccepted,
      recoveredFromSubmitRace: funded.confirmation?.recoveredFromSubmitRace,
    },
  });
  if (!fundConf.isAccepted) {
    throw new Error(`Fund not accepted: ${fundConf.status} ${fundConf.detail || ""}`);
  }

  const utxo = await waitP2shUtxo(funded.p2shAddress, funded.txid);
  RESULTS.steps.push({ step: "tipjar_utxo", amountSompi: utxo.amountSompi, index: utxo.index });

  // Withdraw TipJar → same L1 wallet (spending = main)
  const spent = await autoSpendCovenant({
    network,
    loaded,
    entryName: "withdraw",
    args: [null, null],
    destinationAddress: mainAddress,
    p2shUtxo: {
      outpoint: { transactionId: utxo.transactionId, index: utxo.index },
      amount: BigInt(utxo.amountSompi),
      scriptPublicKey: utxo.scriptPublicKey,
    },
    p2shAddress: funded.p2shAddress,
  });
  assertNoKeyMaterial(spent);
  const spendConf = await confirmTransaction("mainnet", spent.txid, { timeoutMs: 60_000 });
  RESULTS.steps.push({
    step: "tipjar_withdraw",
    txid: spent.txid,
    destinationAddress: mainAddress,
    explorer: spent.explorer || `https://explorer.kaspa.org/transactions/${spent.txid}`,
    confirmation: { status: spendConf.status, isAccepted: spendConf.isAccepted },
  });
  if (!spendConf.isAccepted) {
    throw new Error(`Withdraw not accepted: ${spendConf.status}`);
  }

  // Sweep residue if any (should be no-op or dust/change only; spending == mainAddress)
  await new Promise((r) => setTimeout(r, 3000));
  let sweep = null;
  try {
    const left = await balanceSompi(network, mainAddress);
    // withdraw_all only meaningful if there were separate spending coins; same address — skip if we'd just churn
    RESULTS.steps.push({
      step: "post_withdraw_balance",
      balanceSompi: left.toString(),
      balanceKas: Number(left) / 1e8,
      note: "Spending key == dedicated L1 wallet; withdraw_all would send to same address",
    });
    sweep = { skipped: true, reason: "spendingAddress === mainAddress (TipJar owner is dedicated L1 wallet)" };
  } catch (e) {
    sweep = { error: e instanceof Error ? e.message : String(e) };
  }
  RESULTS.steps.push({ step: "withdraw_all", ...sweep });

  const bal1 = await restBalance(mainAddress);
  const feesPaidApprox = bal0 - bal1; // net change (fund+fees - withdraw return ≈ fees)
  RESULTS.steps.push({
    step: "final_balance",
    address: mainAddress,
    balanceSompi: bal1.toString(),
    balanceKas: Number(bal1) / 1e8,
    deltaSompi: (bal1 - bal0).toString(),
    approxFeesAndDustSompi: feesPaidApprox > 0n ? feesPaidApprox.toString() : "0",
  });

  RESULTS.kasplexL2Untouched = true;
  RESULTS.workerSecretSet = false;
  RESULTS.tipjarOwner = "dedicated L1 wallet (same key as spending)";
  RESULTS.ok = true;
  assertNoKeyMaterial(RESULTS);

  // scrub env
  delete process.env.KASPA_SPENDING_PRIVATE_KEY;
  try {
    unlinkSync(REG_PATH);
  } catch {
    /* ignore */
  }

  writeFileSync(OUT, JSON.stringify(RESULTS, null, 2));
  console.log(
    JSON.stringify(
      {
        ok: true,
        out: OUT,
        explorers: RESULTS.steps.filter((s) => s.explorer).map((s) => ({ step: s.step, explorer: s.explorer })),
        finalKas: Number(bal1) / 1e8,
        deltaSompi: (bal1 - bal0).toString(),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  delete process.env.KASPA_SPENDING_PRIVATE_KEY;
  try {
    if (existsSync(REG_PATH)) unlinkSync(REG_PATH);
  } catch {
    /* ignore */
  }
  const msg = e instanceof Error ? e.message : String(e);
  // never include key hex in error dump
  const safe = msg.replace(/0x[0-9a-fA-F]{64}/g, "0x[REDACTED]");
  RESULTS.ok = false;
  RESULTS.error = safe.slice(0, 800);
  assertNoKeyMaterial(RESULTS);
  writeFileSync(OUT, JSON.stringify(RESULTS, null, 2));
  console.error("MAINNET_SMOKE_FAIL", safe.slice(0, 500));
  process.exit(1);
});
