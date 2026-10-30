#!/usr/bin/env node
/**
 * Thorough TN10 proof using prepareFund/prepareSpend tool-layer APIs +
 * mimicKaswareSignPskt (same SafeJSON path as KasWare signPskt).
 * Never prints secrets.
 */
import kaspa from "kaspa";
import { blake2b } from "@noble/hashes/blake2.js";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
process.env.SILVERC_PATH = process.env.SILVERC_PATH || "/workspace/silverscript-tools/silverc";

const { prepareFund, prepareSpend, mimicKaswareSignPskt, submitSafeJson, MIN_FUND_SOMPI } =
  await import(pathToFileURL(join(ROOT, "src/l1/prepare.ts")).href);
const { compileSilverscript } = await import(pathToFileURL(join(ROOT, "src/l1/compile.ts")).href);
const { getNetwork } = await import(pathToFileURL(join(ROOT, "src/networks.ts")).href);
const { assertAddressNetwork } = await import(pathToFileURL(join(ROOT, "src/l1/utxo.ts")).href);
const { assertL1NetworkWritable } = await import(pathToFileURL(join(ROOT, "src/l1/kaspa-sdk.ts")).href);

const NETWORK = "testnet-10";
const netInfo = getNetwork("kaspa-l1-testnet-10");
const KEY_FILE = "/home/box/.kaspa-operator/tn10/tn10.key";
const OUT = join(ROOT, "docs/E2E_THOROUGH_RESULTS.json");
const EX = (id) => `https://tn10.kaspa.stream/transactions/${id}`;

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
  const privateKeyHex = env.KASPA_PRIVATE_KEY;
  const pk = new kaspa.PrivateKey(privateKeyHex);
  const address = pk.toKeypair().toAddress(NETWORK).toString();
  if (address !== env.KASPA_ADDRESS) throw new Error("address mismatch");
  return { privateKeyHex, address, pk };
}

function compileFor(name, xonly, pkh) {
  const src = readFileSync(join(ROOT, `src/resources/silverscript/${name}.sil`), "utf8");
  if (name === "tipjar") {
    return compileSilverscript({
      source: src,
      constructorArgs: [{ kind: "bytes", value: Array.from(pkh) }],
    });
  }
  if (name === "timeout_vault") {
    return compileSilverscript({
      source: src,
      constructorArgs: [
        { kind: "bytes", value: Array.from(xonly) },
        { kind: "bytes", value: Array.from(xonly) },
        { kind: "int", value: 4000000000000 }, // far future
      ],
    });
  }
  if (name === "escrow") {
    return compileSilverscript({
      source: src,
      constructorArgs: [
        { kind: "bytes", value: Array.from(pkh) },
        { kind: "bytes", value: Array.from(xonly) },
        { kind: "bytes", value: Array.from(xonly) },
      ],
    });
  }
  throw new Error(name);
}

async function waitUtxo(address, txid) {
  const api = "https://api-tn10.kaspa.org";
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${api}/addresses/${encodeURIComponent(address)}/utxos`);
    const rows = await res.json();
    const hit = (rows || []).find((r) => r.outpoint?.transactionId === txid);
    if (hit) {
      const e = hit.utxoEntry;
      const script = e.scriptPublicKey.scriptPublicKey || e.scriptPublicKey.script;
      return {
        outpoint: hit.outpoint,
        amount: BigInt(e.amount),
        scriptPublicKey: { version: e.scriptPublicKey.version ?? 0, script },
        blockDaaScore: BigInt(e.blockDaaScore),
        isCoinbase: !!e.isCoinbase,
        address,
      };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${txid} at ${address}`);
}

async function fundAndSpend(name, { privateKeyHex, address, xonly, pkh }) {
  const loaded = compileFor(name, xonly, pkh);
  const amount = 100_000_000n; // 1 KAS
  const fundPrep = await prepareFund({
    network: netInfo,
    bytecode: loaded.bytecode,
    fromAddress: address,
    amountSompi: amount,
    priorityFeeSompi: 20_000n,
  });
  // Round-trip KasWare path
  kaspa.Transaction.deserializeFromSafeJSON(fundPrep.safeJson);
  const signedFund = await mimicKaswareSignPskt(
    fundPrep.safeJson,
    privateKeyHex,
    fundPrep.kasware.signInputs,
  );
  const fundTxid = await submitSafeJson(signedFund, netInfo);
  const utxo = await waitUtxo(fundPrep.p2shAddress, fundTxid);

  const entry =
    name === "tipjar" ? "withdraw" : name === "timeout_vault" ? "transfer" : "spend";
  const fee = name === "escrow" ? 300_000n : 300_000n;
  const spendPrep = await prepareSpend({
    network: netInfo,
    loaded,
    entryName: entry,
    args: name === "timeout_vault" ? ["$sig"] : ["$pk", "$sig"],
    destinationAddress: address,
    p2shUtxo: utxo,
    feeSompi: fee,
    outputAmountSompi: utxo.amount - fee,
    privateKeyHex,
  });
  if (!spendPrep.signedSafeJson) throw new Error("expected signedSafeJson");
  const spendTxid = await submitSafeJson(spendPrep.signedSafeJson, netInfo);

  return {
    template: name,
    entry,
    p2shAddress: fundPrep.p2shAddress,
    fundTxid,
    fundExplorer: EX(fundTxid),
    spendTxid,
    spendExplorer: EX(spendTxid),
    fundFeeSompi: fundPrep.feeSompi,
    spendFeeSompi: spendPrep.feeSompi,
    kaswareFundMethod: fundPrep.kasware.method,
    kaswareSpendMethod: spendPrep.kasware.method,
  };
}

async function edgeCases({ privateKeyHex, address, xonly, pkh }) {
  const results = [];
  const loadedTip = compileFor("tipjar", xonly, pkh);

  // 1) insufficient funds
  try {
    await prepareFund({
      network: netInfo,
      bytecode: loadedTip.bytecode,
      fromAddress: address,
      amountSompi: 10n ** 18n, // absurd
    });
    results.push({ case: "insufficient_funds", ok: false, detail: "should have thrown" });
  } catch (e) {
    results.push({
      case: "insufficient_funds",
      ok: /insufficient|lack of funds|exceed/i.test(String(e.message || e)),
      detail: String(e.message || e).slice(0, 160),
    });
  }

  // 2) dust / below MIN_FUND
  try {
    await prepareFund({
      network: netInfo,
      bytecode: loadedTip.bytecode,
      fromAddress: address,
      amountSompi: 1000n,
    });
    results.push({ case: "dust_fund", ok: false, detail: "should have thrown" });
  } catch (e) {
    results.push({
      case: "dust_fund",
      ok: /MIN_FUND_SOMPI|below/i.test(String(e.message || e)),
      detail: String(e.message || e).slice(0, 160),
    });
  }

  // 3) wrong network address
  try {
    assertAddressNetwork("kaspa:qztestwrongprefix00000000000000000000000000000000000000000000", "testnet-10");
    results.push({ case: "wrong_network_address", ok: false, detail: "should have thrown" });
  } catch (e) {
    results.push({
      case: "wrong_network_address",
      ok: /prefix mismatch/i.test(String(e.message || e)),
      detail: String(e.message || e).slice(0, 160),
    });
  }

  // 4) mainnet gate
  try {
    assertL1NetworkWritable(false, "kaspa-l1-mainnet");
    results.push({ case: "mainnet_gate", ok: false, detail: "should have thrown" });
  } catch (e) {
    results.push({
      case: "mainnet_gate",
      ok: /gated off|MAINNET_WRITES/i.test(String(e.message || e)),
      detail: String(e.message || e).slice(0, 160),
    });
  }

  // 5) timelock before expiry — timeout entry must fail on-chain
  const vault = compileFor("timeout_vault", xonly, pkh);
  const fundPrep = await prepareFund({
    network: netInfo,
    bytecode: vault.bytecode,
    fromAddress: address,
    amountSompi: 100_000_000n,
  });
  const signedFund = await mimicKaswareSignPskt(fundPrep.safeJson, privateKeyHex, fundPrep.kasware.signInputs);
  const fundTxid = await submitSafeJson(signedFund, netInfo);
  const utxo = await waitUtxo(fundPrep.p2shAddress, fundTxid);
  const early = await prepareSpend({
    network: netInfo,
    loaded: vault,
    entryName: "timeout",
    args: ["$sig"],
    destinationAddress: address,
    p2shUtxo: utxo,
    feeSompi: 300_000n,
    outputAmountSompi: utxo.amount - 300_000n,
    privateKeyHex,
    // lockTime below constructor timeout — script still checks tx.time >= timeout
  });
  try {
    await submitSafeJson(early.signedSafeJson, netInfo);
    results.push({ case: "timelock_before_expiry", ok: false, detail: "submit unexpectedly succeeded" });
  } catch (e) {
    results.push({
      case: "timelock_before_expiry",
      ok: /verification failed|script|rejected|lock|time/i.test(String(e.message || e)),
      detail: String(e.message || e).slice(0, 200),
      fundTxid,
      fundExplorer: EX(fundTxid),
      note: "timeout entry correctly rejected; UTXO still at vault for cleanup via transfer",
    });
    // cleanup via transfer
    const clean = await prepareSpend({
      network: netInfo,
      loaded: vault,
      entryName: "transfer",
      args: ["$sig"],
      destinationAddress: address,
      p2shUtxo: utxo,
      feeSompi: 300_000n,
      outputAmountSompi: utxo.amount - 300_000n,
      privateKeyHex,
    });
    const cleanId = await submitSafeJson(clean.signedSafeJson, netInfo);
    results[results.length - 1].cleanupSpendTxid = cleanId;
    results[results.length - 1].cleanupExplorer = EX(cleanId);
  }

  // 6) escrow wrong party — fund with operator as arbiter/buyer/seller; sign with demo key 0x01
  const escrow = compileFor("escrow", xonly, pkh);
  const ef = await prepareFund({
    network: netInfo,
    bytecode: escrow.bytecode,
    fromAddress: address,
    amountSompi: 100_000_000n,
  });
  const efs = await mimicKaswareSignPskt(ef.safeJson, privateKeyHex, ef.kasware.signInputs);
  const eFundTx = await submitSafeJson(efs, netInfo);
  const eUtxo = await waitUtxo(ef.p2shAddress, eFundTx);
  const wrongKey = "0".repeat(63) + "1";
  const wrongSpend = await prepareSpend({
    network: netInfo,
    loaded: escrow,
    entryName: "spend",
    args: ["$pk", "$sig"],
    destinationAddress: address,
    p2shUtxo: eUtxo,
    feeSompi: 300_000n,
    outputAmountSompi: eUtxo.amount - 300_000n,
    privateKeyHex: wrongKey,
  });
  try {
    await submitSafeJson(wrongSpend.signedSafeJson, netInfo);
    results.push({ case: "escrow_wrong_party", ok: false, detail: "wrong key accepted" });
  } catch (e) {
    results.push({
      case: "escrow_wrong_party",
      ok: /verification failed|rejected|script/i.test(String(e.message || e)),
      detail: String(e.message || e).slice(0, 200),
      fundTxid: eFundTx,
      fundExplorer: EX(eFundTx),
    });
    // cleanup with correct key
    const okSpend = await prepareSpend({
      network: netInfo,
      loaded: escrow,
      entryName: "spend",
      args: ["$pk", "$sig"],
      destinationAddress: address,
      p2shUtxo: eUtxo,
      feeSompi: 300_000n,
      outputAmountSompi: eUtxo.amount - 300_000n,
      privateKeyHex,
    });
    const okId = await submitSafeJson(okSpend.signedSafeJson, netInfo);
    results[results.length - 1].cleanupSpendTxid = okId;
    results[results.length - 1].cleanupExplorer = EX(okId);
  }

  // 7) many small UTXOs — attempt fund that may need multiple inputs (createTransactions handles)
  try {
    const multi = await prepareFund({
      network: netInfo,
      bytecode: loadedTip.bytecode,
      fromAddress: address,
      amountSompi: 250_000_000n, // 2.5 KAS — may select multiple UTXOs
    });
    results.push({
      case: "many_small_utxos_selection",
      ok: multi.inputCount >= 1,
      detail: `selected ${multi.inputCount} inputs, fee ${multi.feeSompi}`,
      inputCount: multi.inputCount,
      note: "Did not broadcast; selection only. Storage-mass may still reject pathological dust sets.",
    });
  } catch (e) {
    results.push({
      case: "many_small_utxos_selection",
      ok: false,
      detail: String(e.message || e).slice(0, 200),
    });
  }

  return results;
}

async function main() {
  const { privateKeyHex, address, pk } = loadKey();
  const xonly = Buffer.from(pk.toPublicKey().toXOnlyPublicKey().toString(), "hex");
  const pkh = Buffer.from(blake2b(xonly, { dkLen: 32 }));

  const happy = [];
  for (const name of ["tipjar", "timeout_vault", "escrow"]) {
    console.log("=== happy", name, "===");
    const r = await fundAndSpend(name, { privateKeyHex, address, xonly, pkh });
    console.log(JSON.stringify(r, null, 2));
    happy.push(r);
  }

  console.log("=== edge cases ===");
  const edges = await edgeCases({ privateKeyHex, address, xonly, pkh });
  console.log(JSON.stringify(edges, null, 2));

  const doc = {
    at: new Date().toISOString(),
    network: NETWORK,
    kaswareCite:
      "docs.kasware.xyz/…/kaspa-transaction + kasware-wallet/extension wallet.ts signPskt/pushTx (SafeJSON)",
    minFundSompi: String(MIN_FUND_SOMPI),
    happyPath: happy,
    edgeCases: edges,
    allEdgesOk: edges.every((e) => e.ok),
  };
  writeFileSync(OUT, JSON.stringify(doc, null, 2));
  console.log("wrote", OUT, "allEdgesOk=", doc.allEdgesOk);
  if (!doc.allEdgesOk) process.exit(2);
}

main().catch((e) => {
  console.error("FAIL", e?.message || e);
  process.exit(1);
});
