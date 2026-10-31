#!/usr/bin/env node
/**
 * AoNPledge TN10 e2e (Stag Hunt style):
 *  A) goal met → owner claim BEFORE deadline
 *  B) attack: foreign P2SH inflate → claim MUST fail
 *  C) goal missed → reclaim rejected before grace; succeeds after short grace
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
const ONLY = process.env.ONLY || "";

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

function compileAoN({ ownerPkh, backerPkh, tag, goal, refundOpensAt }) {
  const argsPath = "/tmp/e2e-aon-ctor.json";
  writeFileSync(
    argsPath,
    JSON.stringify([
      { kind: "bytes", value: Array.from(ownerPkh) },
      { kind: "bytes", value: Array.from(backerPkh) },
      { kind: "bytes", value: Array.from(tag) },
      { kind: "int", value: Number(goal) },
      { kind: "int", value: Number(refundOpensAt) },
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

/** Permissionless reclaim: only backer xonly + dispatch tag (no sig). */
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
  const xonly = xonlyOf(backerKey);
  const tag = Buffer.from(tagHex, "hex");
  const unlock = Buffer.concat([push(xonly), push(tag)]);
  const unlockHex = kaspa.payToScriptHashSignatureScript(bytecode, unlock);
  const res = await rpc.submitTransaction({ transaction: mk(unlockHex), allowOrphan: false });
  return res.transactionId || res;
}

async function main() {
  const { privateKey: ownerKey, address: ownerAddress } = loadEnvKey();
  const ownerPkh = pkhOf(ownerKey);
  const rpc = new kaspa.RpcClient({ url: RPC, encoding: kaspa.Encoding.Borsh, networkId: NETWORK });
  await rpc.connect();
  const results = { network: NETWORK, startedAt: new Date().toISOString(), cases: {}, style: "stag-hunt-grace" };
  const run = (name) => !ONLY || ONLY === name;

  try {
    if (run("A")) {
      console.log("=== A: goal met → owner claim BEFORE deadline ===");
      const tagA = rb(32);
      const deadlineFuture = Date.now() + 7 * 86_400_000;
      const grace = 3 * 86_400_000;
      const refundOpensAt = deadlineFuture + grace;
      const goalA = PLEDGE * 3n;
      const backersA = [0, 1, 2].map(() => new kaspa.PrivateKey(rb(32).toString("hex")));
      const pledgesA = [];
      for (const bk of backersA) {
        const art = compileAoN({
          ownerPkh,
          backerPkh: pkhOf(bk),
          tag: tagA,
          goal: goalA,
          refundOpensAt,
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
      console.log("  CLAIM OK (before deadline)", claimTxid);
      results.cases.goalMetClaimBeforeDeadline = {
        ok: true,
        goalSompi: String(goalA),
        deadlineMs: deadlineFuture,
        refundOpensAtMs: refundOpensAt,
        fundTxids: pledgesA.map((p) => p.fundTxid),
        fundExplorers: pledgesA.map((p) => EX(p.fundTxid)),
        claimTxid,
        claimExplorer: EX(claimTxid),
      };
    }

    if (run("B")) {
      console.log("=== B: adversarial inflator claim (must FAIL) ===");
      const tagB = rb(32);
      const refundOpensAt = Date.now() + 7 * 86_400_000;
      const goalB = PLEDGE * 3n;
      const backerB = new kaspa.PrivateKey(rb(32).toString("hex"));
      const artReal = compileAoN({
        ownerPkh,
        backerPkh: pkhOf(backerB),
        tag: tagB,
        goal: goalB,
        refundOpensAt,
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
        refundOpensAt,
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
      };
    }

    if (run("C")) {
      console.log("=== C: goal missed → reclaim before grace FAILS; after grace OK ===");
      const goalC = PLEDGE * 10n;

      // C1: refundOpensAt still in the future → reclaim must fail (not finalized / time lock)
      const tagEarly = rb(32);
      const refundFuture = Date.now() + 2 * 86_400_000;
      const bkEarly = new kaspa.PrivateKey(rb(32).toString("hex"));
      const artEarly = compileAoN({
        ownerPkh,
        backerPkh: pkhOf(bkEarly),
        tag: tagEarly,
        goal: goalC,
        refundOpensAt: refundFuture,
      });
      const bcEarly = Buffer.from(artEarly.contracts.AoNPledge.compiled.bytecode);
      const p2shEarly = p2shOf(bcEarly);
      const fundEarly = await fund(rpc, ownerKey, ownerAddress, p2shEarly, PLEDGE);
      const utxoEarly = await waitUtxo(rpc, p2shEarly, (e) => e.outpoint.transactionId === fundEarly);
      let earlyError = null;
      let earlyTxid = null;
      try {
        earlyTxid = await reclaimOne({
          rpc,
          backerKey: bkEarly,
          bytecode: bcEarly,
          tagHex: artEarly.contracts.AoNPledge.entries.reclaim.dispatch_tag,
          utxo: utxoEarly,
          lockTimeMs: refundFuture,
        });
      } catch (e) {
        earlyError = String(e?.message || e).slice(0, 500);
      }
      const earlyRejected = !earlyTxid;
      console.log(earlyRejected ? "  EARLY RECLAIM REJECTED (good)" : "  EARLY RECLAIM SUCCEEDED (BAD)", earlyError || earlyTxid);

      // C2: refundOpensAt well in the past → permissionless reclaim succeeds
      const tagLate = rb(32);
      const refundPast = Date.now() - 7 * 86_400_000;
      const bkLate = new kaspa.PrivateKey(rb(32).toString("hex"));
      const artLate = compileAoN({
        ownerPkh,
        backerPkh: pkhOf(bkLate),
        tag: tagLate,
        goal: goalC,
        refundOpensAt: refundPast,
      });
      const bcLate = Buffer.from(artLate.contracts.AoNPledge.compiled.bytecode);
      const p2shLate = p2shOf(bcLate);
      const fundLate = await fund(rpc, ownerKey, ownerAddress, p2shLate, PLEDGE);
      const utxoLate = await waitUtxo(rpc, p2shLate, (e) => e.outpoint.transactionId === fundLate);
      const reclaimTxid = await reclaimOne({
        rpc,
        backerKey: bkLate,
        bytecode: bcLate,
        tagHex: artLate.contracts.AoNPledge.entries.reclaim.dispatch_tag,
        utxo: utxoLate,
        lockTimeMs: refundPast,
      });
      console.log("  RECLAIM OK after grace", reclaimTxid);
      results.cases.goalMissedReclaimGrace = {
        ok: earlyRejected && !!reclaimTxid,
        goalSompi: String(goalC),
        earlyFundTxid: fundEarly,
        earlyFundExplorer: EX(fundEarly),
        earlyRejected,
        earlyError,
        earlyTxid: earlyTxid || null,
        refundOpensAtPastMs: refundPast,
        lateFundTxid: fundLate,
        lateFundExplorer: EX(fundLate),
        reclaimTxid,
        reclaimExplorer: EX(reclaimTxid),
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
