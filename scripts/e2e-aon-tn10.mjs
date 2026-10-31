#!/usr/bin/env node
/**
 * AoNPledge TN10 e2e:
 *  A) 3 backers, goal met → creator claim
 *  B) attack: real pledges below goal + creator foreign P2SH → claim MUST fail
 *  C) goal missed, deadline past → each backer reclaim
 */
import kaspa from "kaspa";
import { blake2b } from "@noble/hashes/blake2.js";
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes as rb } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NETWORK = "testnet-10";
const RPC = process.env.KASPA_RPC_URL || "wss://electron-10.kaspa.blue/kaspa/testnet-10/wrpc/borsh";
const KEY_FILE = "/home/box/.kaspa-operator/tn10/tn10.key";
const SILVERC = process.env.SILVERC_PATH || "/workspace/silverscript-tools/silverc";
const OUT = join(ROOT, "docs/E2E_AON_TN10_RESULTS.json");
const FEE = 3500000n;
const PLEDGE = kaspa.kaspaToSompi("1");
const EX = (txid) => `https://tn10.kaspa.stream/transactions/${txid}`;
const ONLY = process.env.ONLY || ""; // A | B | C | ""

function loadEnvKey() {
  const env = Object.fromEntries(
    readFileSync(KEY_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), l.slice(i + 1)];
      }),
  );
  const privateKey = new kaspa.PrivateKey(env.KASPA_PRIVATE_KEY);
  const address = privateKey.toKeypair().toAddress(NETWORK).toString();
  if (address !== env.KASPA_ADDRESS) throw new Error("address mismatch");
  return { privateKey, address };
}

function push(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const n = buf.length;
  if (n === 0) return Buffer.from([0x00]);
  if (n <= 75) return Buffer.concat([Buffer.from([n]), buf]);
  if (n <= 255) return Buffer.concat([Buffer.from([0x4c, n]), buf]);
  const le = Buffer.alloc(2);
  le.writeUInt16LE(n);
  return Buffer.concat([Buffer.from([0x4d]), le, buf]);
}

function pkhOf(priv) {
  const xonly = Buffer.from(priv.toPublicKey().toXOnlyPublicKey().toString(), "hex");
  return Buffer.from(blake2b(xonly, { dkLen: 32 }));
}

function xonlyOf(priv) {
  return Buffer.from(priv.toPublicKey().toXOnlyPublicKey().toString(), "hex");
}

function compileAoN({ ownerPkh, backerPkh, tag, goal, deadline }) {
  const argsPath = "/tmp/e2e-aon-ctor.json";
  writeFileSync(
    argsPath,
    JSON.stringify([
      { kind: "bytes", value: Array.from(ownerPkh) },
      { kind: "bytes", value: Array.from(backerPkh) },
      { kind: "bytes", value: Array.from(tag) },
      { kind: "int", value: Number(goal) },
      { kind: "int", value: Number(deadline) },
    ]),
  );
  const sil = join(ROOT, "src/resources/silverscript/aon_pledge.sil");
  return JSON.parse(execFileSync(SILVERC, [sil, "--constructor-args", argsPath, "-c"], { encoding: "utf8" }));
}

function p2shOf(bytecode) {
  return kaspa.addressFromScriptPublicKey(kaspa.payToScriptHashScript(bytecode), NETWORK).toString();
}

async function fund(rpc, privateKey, address, p2sh, amount) {
  const { entries } = await rpc.getUtxosByAddresses({ addresses: [address] });
  const { transactions } = await kaspa.createTransactions({
    entries,
    outputs: [{ address: p2sh, amount }],
    changeAddress: address,
    priorityFee: kaspa.kaspaToSompi("0.0002"),
    networkId: NETWORK,
  });
  const pending = transactions[0];
  pending.sign([privateKey]);
  return pending.submit(rpc);
}

async function waitUtxo(rpc, addr, pred) {
  for (let i = 0; i < 60; i++) {
    const { entries } = await rpc.getUtxosByAddresses({ addresses: [addr] });
    const hit = entries.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for utxo at ${addr}`);
}

async function claimMulti({ rpc, ownerKey, ownerAddress, pledges }) {
  const total = pledges.reduce((a, p) => a + BigInt(p.utxo.amount), 0n);
  const outAmt = total - FEE;
  const outSpk = kaspa.payToAddressScript(ownerAddress);
  const mkInputs = (sigScripts) =>
    pledges.map(
      (p, i) =>
        new kaspa.TransactionInput({
          previousOutpoint: p.utxo.outpoint,
          signatureScript: sigScripts ? sigScripts[i] : "",
          sequence: 0n,
          sigOpCount: 10,
          utxo: p.utxo,
        }),
    );
  const txUnsigned = new kaspa.Transaction({
    version: 0,
    inputs: mkInputs(null),
    outputs: [new kaspa.TransactionOutput(outAmt, outSpk)],
    lockTime: 0n,
    subnetworkId: "0000000000000000000000000000000000000000",
    gas: 0n,
    payload: "",
  });
  const xonly = xonlyOf(ownerKey);
  const sigScripts = [];
  for (let i = 0; i < pledges.length; i++) {
    const sigBytes = Buffer.from(
      String(kaspa.createInputSignature(txUnsigned, i, ownerKey)).replace(/^0x/, ""),
      "hex",
    );
    const tag = Buffer.from(pledges[i].tagHex, "hex");
    const unlock = Buffer.concat([push(xonly), sigBytes, push(tag)]);
    sigScripts.push(kaspa.payToScriptHashSignatureScript(pledges[i].bytecode, unlock));
  }
  const tx = new kaspa.Transaction({
    version: 0,
    inputs: mkInputs(sigScripts),
    outputs: [new kaspa.TransactionOutput(outAmt, outSpk)],
    lockTime: 0n,
    subnetworkId: "0000000000000000000000000000000000000000",
    gas: 0n,
    payload: "",
  });
  const res = await rpc.submitTransaction({ transaction: tx, allowOrphan: false });
  return res.transactionId || res;
}

async function reclaimOne({ rpc, backerKey, bytecode, tagHex, utxo, lockTimeMs }) {
  const addr = backerKey.toKeypair().toAddress(NETWORK).toString();
  const outAmt = BigInt(utxo.amount) - FEE;
  const outSpk = kaspa.payToAddressScript(addr);
  const lockTime = BigInt(lockTimeMs);
  const mk = (sigScript) =>
    new kaspa.Transaction({
      version: 0,
      inputs: [
        new kaspa.TransactionInput({
          previousOutpoint: utxo.outpoint,
          signatureScript: sigScript,
          sequence: 0n,
          sigOpCount: 10,
          utxo,
        }),
      ],
      outputs: [new kaspa.TransactionOutput(outAmt, outSpk)],
      lockTime,
      subnetworkId: "0000000000000000000000000000000000000000",
      gas: 0n,
      payload: "",
    });
  const txUnsigned = mk("");
  const xonly = xonlyOf(backerKey);
  const sigBytes = Buffer.from(
    String(kaspa.createInputSignature(txUnsigned, 0, backerKey)).replace(/^0x/, ""),
    "hex",
  );
  const tag = Buffer.from(tagHex, "hex");
  const unlock = Buffer.concat([push(xonly), sigBytes, push(tag)]);
  const unlockHex = kaspa.payToScriptHashSignatureScript(bytecode, unlock);
  const res = await rpc.submitTransaction({ transaction: mk(unlockHex), allowOrphan: false });
  return res.transactionId || res;
}

async function main() {
  const { privateKey: ownerKey, address: ownerAddress } = loadEnvKey();
  const ownerPkh = pkhOf(ownerKey);
  const rpc = new kaspa.RpcClient({ url: RPC, encoding: kaspa.Encoding.Borsh, networkId: NETWORK });
  await rpc.connect();
  const results = { network: NETWORK, startedAt: new Date().toISOString(), cases: {} };
  const run = (name) => !ONLY || ONLY === name;

  try {
    if (run("A")) {
      console.log("=== A: 3 backers goal met → claim ===");
      const tagA = rb(32);
      const deadlineFuture = 4_000_000_000_000;
      const goalA = PLEDGE * 3n;
      const backersA = [0, 1, 2].map(() => new kaspa.PrivateKey(rb(32).toString("hex")));
      const pledgesA = [];
      for (const bk of backersA) {
        const art = compileAoN({
          ownerPkh,
          backerPkh: pkhOf(bk),
          tag: tagA,
          goal: goalA,
          deadline: deadlineFuture,
        });
        const contract = art.contracts.AoNPledge;
        const bytecode = Buffer.from(contract.compiled.bytecode);
        const tagHex = contract.entries.claim.dispatch_tag;
        const p2sh = p2shOf(bytecode);
        const fundTxid = await fund(rpc, ownerKey, ownerAddress, p2sh, PLEDGE);
        console.log("  funded", p2sh.slice(0, 24), fundTxid);
        const utxo = await waitUtxo(rpc, p2sh, (e) => e.outpoint.transactionId === fundTxid);
        pledgesA.push({ bytecode, utxo, tagHex, fundTxid, p2sh });
      }
      const claimTxid = await claimMulti({ rpc, ownerKey, ownerAddress, pledges: pledgesA });
      console.log("  CLAIM OK", claimTxid);
      results.cases.goalMetClaim = {
        ok: true,
        goalSompi: String(goalA),
        fundTxids: pledgesA.map((p) => p.fundTxid),
        fundExplorers: pledgesA.map((p) => EX(p.fundTxid)),
        claimTxid,
        claimExplorer: EX(claimTxid),
      };
    }

    if (run("B")) {
      console.log("=== B: adversarial inflator claim (must FAIL) ===");
      const tagB = rb(32);
      const deadlineFuture = 4_000_000_000_000;
      const goalB = PLEDGE * 3n;
      const backerB = new kaspa.PrivateKey(rb(32).toString("hex"));
      const artReal = compileAoN({
        ownerPkh,
        backerPkh: pkhOf(backerB),
        tag: tagB,
        goal: goalB,
        deadline: deadlineFuture,
      });
      const realBc = Buffer.from(artReal.contracts.AoNPledge.compiled.bytecode);
      const realP2sh = p2shOf(realBc);
      const realFund = await fund(rpc, ownerKey, ownerAddress, realP2sh, PLEDGE);
      const realUtxo = await waitUtxo(rpc, realP2sh, (e) => e.outpoint.transactionId === realFund);

      const artFake = compileAoN({
        ownerPkh,
        backerPkh: ownerPkh,
        tag: rb(32),
        goal: goalB,
        deadline: deadlineFuture,
      });
      const fakeBc = Buffer.from(artFake.contracts.AoNPledge.compiled.bytecode);
      const fakeP2sh = p2shOf(fakeBc);
      const fakeFund = await fund(rpc, ownerKey, ownerAddress, fakeP2sh, PLEDGE * 3n);
      const fakeUtxo = await waitUtxo(rpc, fakeP2sh, (e) => e.outpoint.transactionId === fakeFund);

      let attackError = null;
      let attackTxid = null;
      try {
        attackTxid = await claimMulti({
          rpc,
          ownerKey,
          ownerAddress,
          pledges: [
            {
              bytecode: realBc,
              utxo: realUtxo,
              tagHex: artReal.contracts.AoNPledge.entries.claim.dispatch_tag,
            },
            {
              bytecode: fakeBc,
              utxo: fakeUtxo,
              tagHex: artFake.contracts.AoNPledge.entries.claim.dispatch_tag,
            },
          ],
        });
      } catch (e) {
        attackError = String(e?.message || e).slice(0, 500);
      }
      const attackFailed = !attackTxid;
      console.log(attackFailed ? "  ATTACK REJECTED (good)" : "  ATTACK SUCCEEDED (BAD)", attackError || attackTxid);
      results.cases.adversarialInflator = {
        ok: attackFailed,
        realFundTxid: realFund,
        fakeFundTxid: fakeFund,
        realExplorer: EX(realFund),
        fakeExplorer: EX(fakeFund),
        attackTxid: attackTxid || null,
        attackError,
        note: "Creator co-spends foreign P2SH to inflate sum; sibling redeem prefix/suffix must reject",
      };
    }

    if (run("C")) {
      console.log("=== C: goal missed → backer reclaim ===");
      const tagC = rb(32);
      // Well in the past vs network median time (avoid "not finalized")
      const deadlinePast = Date.now() - 7 * 86_400_000;
      const goalC = PLEDGE * 10n;
      const backersC = [0, 1, 2].map(() => new kaspa.PrivateKey(rb(32).toString("hex")));
      const reclaimTxids = [];
      for (const bk of backersC) {
        const art = compileAoN({
          ownerPkh,
          backerPkh: pkhOf(bk),
          tag: tagC,
          goal: goalC,
          deadline: deadlinePast,
        });
        const contract = art.contracts.AoNPledge;
        const bytecode = Buffer.from(contract.compiled.bytecode);
        const p2sh = p2shOf(bytecode);
        const fundTxid = await fund(rpc, ownerKey, ownerAddress, p2sh, PLEDGE);
        const utxo = await waitUtxo(rpc, p2sh, (e) => e.outpoint.transactionId === fundTxid);
        const txid = await reclaimOne({
          rpc,
          backerKey: bk,
          bytecode,
          tagHex: contract.entries.reclaim.dispatch_tag,
          utxo,
          lockTimeMs: deadlinePast,
        });
        console.log("  reclaim OK", txid);
        reclaimTxids.push({
          fundTxid,
          reclaimTxid: txid,
          fundExplorer: EX(fundTxid),
          reclaimExplorer: EX(txid),
        });
      }
      results.cases.goalMissedReclaim = {
        ok: true,
        goalSompi: String(goalC),
        deadlineMs: deadlinePast,
        backers: reclaimTxids,
      };
    }
  } finally {
    await rpc.disconnect();
  }

  results.finishedAt = new Date().toISOString();
  results.allGreen = Object.values(results.cases).every((c) => c.ok);
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (!results.allGreen) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
