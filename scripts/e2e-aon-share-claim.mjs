#!/usr/bin/env node
/**
 * TN10 e2e: share-page multi-input Claim path
 * 3 pledges × 1 KAS, goal 3 KAS → buildAoNClaimL1Build (same as /api/campaign/:id/claim)
 * → owner co-spend all inputs in one tx.
 */
import kaspa from "kaspa";
import { blake2b } from "@noble/hashes/blake2.js";
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes as rb } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NETWORK = "testnet-10";
const RPC = process.env.KASPA_RPC_URL || "wss://electron-10.kaspa.blue/kaspa/testnet-10/wrpc/borsh";
const KEY_FILE = "/home/box/.kaspa-operator/tn10/tn10.key";
const OUT = join(ROOT, "docs/E2E_AON_SHARE_CLAIM_RESULTS.json");
const FEE_PER = 3500000n;
const PLEDGE = kaspa.kaspaToSompi("1");
const EX = (txid) => `https://tn10.kaspa.stream/transactions/${txid}`;

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

function xonlyOf(priv) {
  return Buffer.from(priv.toPublicKey().toXOnlyPublicKey().toString(), "hex");
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

function spkFromUtxo(utxo) {
  const spk = utxo.scriptPublicKey;
  let script = "";
  let version = 0;
  if (typeof spk === "string") script = spk.replace(/^0x/, "");
  else if (spk && typeof spk === "object") {
    script = String(spk.script || spk.scriptPublicKey || "").replace(/^0x/, "");
    version = spk.version ?? 0;
  }
  return { version, script };
}

async function main() {
  const { createAoNCampaign, addAoNPledge } = await import("../dist/crowdfund.js");
  const { createCampaignPage, setCampaignPageContext } = await import("../dist/campaign-page.js");
  const { buildAoNClaimL1Build } = await import("../dist/campaign-claim.js");
  const { ownerPkhFromP2pkAddress } = await import("../dist/l1/owner-pkh.js");

  setCampaignPageContext({ kv: null, publicBaseUrl: "https://kaspa-mcp.kaspa-mcp.workers.dev" });

  const { privateKey: ownerKey, address: ownerAddress } = loadEnvKey();
  const rpc = new kaspa.RpcClient({ url: RPC, encoding: kaspa.Encoding.Borsh, networkId: NETWORK });
  await rpc.connect();
  const results = { network: NETWORK, startedAt: new Date().toISOString(), path: "share-page-multi-claim" };

  try {
    const goalS = PLEDGE * 3n;
    const deadlineFuture = Date.now() + 7 * 86_400_000;
    const grace = 3 * 86_400_000;
    const camp = createAoNCampaign({
      ownerAddress,
      goalSompi: goalS,
      deadlineMs: deadlineFuture,
      graceMs: grace,
      network: NETWORK,
    });

    const backers = [0, 1, 2].map(() => new kaspa.PrivateKey(rb(32).toString("hex")));
    const live = [];
    const fundTxids = [];

    for (const bk of backers) {
      const backerAddr = bk.toKeypair().toAddress(NETWORK).toString();
      const pledge = addAoNPledge(camp, backerAddr);
      const fundTxid = await fund(rpc, ownerKey, ownerAddress, pledge.p2shAddress, PLEDGE);
      console.log("funded", pledge.p2shAddress.slice(0, 28), fundTxid);
      const utxo = await waitUtxo(rpc, pledge.p2shAddress, (e) => e.outpoint.transactionId === fundTxid);
      const spk = spkFromUtxo(utxo);
      live.push({
        backerAddress: backerAddr,
        p2shAddress: pledge.p2shAddress,
        utxo: {
          outpoint: utxo.outpoint,
          amount: utxo.amount,
          scriptPublicKey: spk,
        },
      });
      fundTxids.push(fundTxid);
    }

    const page = await createCampaignPage({
      networkId: "kaspa-l1-testnet-10",
      ownerAddress,
      ownerPkhHex: camp.ownerPkhHex || ownerPkhFromP2pkAddress(ownerAddress),
      campaignTagHex: camp.campaignTagHex,
      goalSompi: camp.goalSompi,
      deadlineMs: camp.deadlineMs,
      graceMs: camp.graceMs,
      refundOpensAtMs: camp.refundOpensAtMs,
      title: "e2e share multi claim",
      pledges: camp.pledges.map((p) => ({
        backerAddress: p.backerAddress,
        backerPkhHex: p.backerPkhHex,
        p2shAddress: p.p2shAddress,
        registeredAt: new Date().toISOString(),
      })),
    });

    const built = buildAoNClaimL1Build(page.record, live);
    if (built.inputCount !== 3 || built.mode !== "multi") {
      throw new Error(`expected multi/3 got mode=${built.mode} n=${built.inputCount}`);
    }
    console.log("l1Build p2shInputs", built.inputCount, "total", built.totalSompi);

    // Sign+submit like /sign finalizeCovenantSpend multi-input
    const inputs = built.l1Build.p2shInputs;
    const fee = BigInt(built.l1Build.feeSompi);
    const outAmt = BigInt(built.l1Build.outputAmountSompi);
    const outSpk = kaspa.payToAddressScript(ownerAddress);
    const xonly = xonlyOf(ownerKey);

    const toKaspaUtxo = (row) => {
      // waitUtxo returns wasm utxo entries; rebuild from live
      return live.find((l) => l.p2shAddress === row.expectedP2shAddress);
    };

    // Re-fetch full utxo objects for TransactionInput
    const kaspaUtxos = [];
    for (const row of inputs) {
      const { entries } = await rpc.getUtxosByAddresses({ addresses: [row.expectedP2shAddress] });
      const hit = entries.find((e) => e.outpoint.transactionId === row.outpoint.transactionId);
      if (!hit) throw new Error("missing utxo " + row.expectedP2shAddress);
      kaspaUtxos.push(hit);
    }

    const mkInputs = (sigScripts) =>
      inputs.map(
        (row, i) =>
          new kaspa.TransactionInput({
            previousOutpoint: row.outpoint,
            signatureScript: sigScripts ? sigScripts[i] : "",
            sequence: 0n,
            sigOpCount: 10,
            utxo: kaspaUtxos[i],
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

    const sigScripts = [];
    for (let i = 0; i < inputs.length; i++) {
      const sigBytes = Buffer.from(
        String(kaspa.createInputSignature(txUnsigned, i, ownerKey)).replace(/^0x/, ""),
        "hex",
      );
      const tag = Buffer.from(inputs[i].dispatchTag || built.l1Build.dispatchTag, "hex");
      const unlock = Buffer.concat([push(xonly), sigBytes, push(tag)]);
      const bytecode = Buffer.from(inputs[i].bytecodeHex, "hex");
      sigScripts.push(kaspa.payToScriptHashSignatureScript(bytecode, unlock));
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
    const claimTxid = res.transactionId || res;
    console.log("SHARE CLAIM OK", claimTxid);

    results.ok = true;
    results.campaignId = page.record.id;
    results.inputCount = built.inputCount;
    results.mode = built.mode;
    results.goalSompi = String(goalS);
    results.fundTxids = fundTxids;
    results.fundExplorers = fundTxids.map(EX);
    results.claimTxid = claimTxid;
    results.claimExplorer = EX(claimTxid);
    results.feeSompi = String(fee);
    results.outputAmountSompi = String(outAmt);
  } finally {
    await rpc.disconnect();
  }

  results.finishedAt = new Date().toISOString();
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (!results.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
