#!/usr/bin/env node
/**
 * TN10 end-to-end: for each template, compile with operator key, fund, spend.
 * Secrets never printed. Requires /home/box/.kaspa-operator/tn10/tn10.key
 */
import kaspa from "kaspa";
import { blake2b } from "@noble/hashes/blake2.js";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NETWORK = "testnet-10";
const RPC = process.env.KASPA_RPC_URL || "wss://electron-10.kaspa.blue/kaspa/testnet-10/wrpc/borsh";
const KEY_FILE = "/home/box/.kaspa-operator/tn10/tn10.key";
const SILVERC = process.env.SILVERC_PATH || "/workspace/silverscript-tools/silverc";
const OUT = join(ROOT, "docs/E2E_TN10_RESULTS.json");
const FUND_SOMPI = kaspa.kaspaToSompi("1"); // 1 tKAS — avoid storage-mass traps on tiny outs

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

function compile(silPath, ctorArgs) {
  const argsPath = "/tmp/e2e-ctor.json";
  writeFileSync(argsPath, JSON.stringify(ctorArgs));
  return JSON.parse(
    execFileSync(SILVERC, [silPath, "--constructor-args", argsPath, "-c"], { encoding: "utf8" }),
  );
}

async function fund(rpc, privateKey, address, p2sh, amount) {
  let { entries } = await rpc.getUtxosByAddresses({ addresses: [address] });
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
  for (let i = 0; i < 40; i++) {
    const { entries } = await rpc.getUtxosByAddresses({ addresses: [addr] });
    const hit = entries.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for utxo at ${addr}`);
}

async function spendP2sh({
  rpc,
  privateKey,
  address,
  bytecode,
  tagHex,
  buildUnlock,
  utxo,
  outAmt,
}) {
  const tag = Buffer.from(tagHex, "hex");
  const xonly = Buffer.from(privateKey.toPublicKey().toXOnlyPublicKey().toString(), "hex");
  const outSpk = kaspa.payToAddressScript(address);
  const txUnsigned = new kaspa.Transaction({
    version: 0,
    inputs: [
      new kaspa.TransactionInput({
        previousOutpoint: utxo.outpoint,
        signatureScript: "",
        sequence: 0n,
        sigOpCount: 1,
        utxo,
      }),
    ],
    outputs: [new kaspa.TransactionOutput(outAmt, outSpk)],
    lockTime: 0n,
    subnetworkId: "0000000000000000000000000000000000000000",
    gas: 0n,
    payload: "",
  });
  const sigBytes = Buffer.from(
    String(kaspa.createInputSignature(txUnsigned, 0, privateKey)).replace(/^0x/, ""),
    "hex",
  );
  const unlock = buildUnlock({ xonly, sigBytes, tag, push });
  const unlockHex = kaspa.payToScriptHashSignatureScript(bytecode, unlock);
  const tx = new kaspa.Transaction({
    version: 0,
    inputs: [
      new kaspa.TransactionInput({
        previousOutpoint: utxo.outpoint,
        signatureScript: unlockHex,
        sequence: 0n,
        sigOpCount: 1,
        utxo,
      }),
    ],
    outputs: [new kaspa.TransactionOutput(outAmt, outSpk)],
    lockTime: 0n,
    subnetworkId: "0000000000000000000000000000000000000000",
    gas: 0n,
    payload: "",
  });
  const res = await rpc.submitTransaction({ transaction: tx, allowOrphan: false });
  return res.transactionId || res;
}

async function runOne(name, { privateKey, address, rpc }) {
  const xonly = Buffer.from(privateKey.toPublicKey().toXOnlyPublicKey().toString(), "hex");
  const pkh = Buffer.from(blake2b(xonly, { dkLen: 32 }));
  const sil = join(ROOT, `src/resources/silverscript/${name}.sil`);
  let artifact;
  let entryName;
  let fee;
  let buildUnlock;

  if (name === "tipjar") {
    artifact = compile(sil, [{ kind: "bytes", value: Array.from(pkh) }]);
    entryName = "withdraw";
    fee = 300000n;
    buildUnlock = ({ xonly, sigBytes, tag, push }) =>
      Buffer.concat([push(xonly), sigBytes, push(tag)]);
  } else if (name === "timeout_vault") {
    artifact = compile(sil, [
      { kind: "bytes", value: Array.from(xonly) },
      { kind: "bytes", value: Array.from(xonly) },
      { kind: "int", value: 4000000000000 },
    ]);
    entryName = "transfer";
    fee = 300000n;
    buildUnlock = ({ sigBytes, tag, push }) => Buffer.concat([sigBytes, push(tag)]);
  } else if (name === "escrow") {
    artifact = compile(sil, [
      { kind: "bytes", value: Array.from(pkh) },
      { kind: "bytes", value: Array.from(xonly) },
      { kind: "bytes", value: Array.from(xonly) },
    ]);
    entryName = "spend";
    fee = 300000n; // must match contract minerFee
    buildUnlock = ({ xonly, sigBytes, tag, push }) =>
      Buffer.concat([push(xonly), sigBytes, push(tag)]);
  } else throw new Error(name);

  const contract = Object.values(artifact.contracts)[0];
  const bytecode = Buffer.from(contract.compiled.bytecode);
  const tagHex = contract.entries[entryName].dispatch_tag;
  const p2sh = kaspa.addressFromScriptPublicKey(kaspa.payToScriptHashScript(bytecode), NETWORK).toString();

  const fundTxid = await fund(rpc, privateKey, address, p2sh, FUND_SOMPI);
  const utxo = await waitUtxo(rpc, p2sh, (e) => e.outpoint.transactionId === fundTxid);
  const outAmt = BigInt(utxo.amount) - fee;
  const spendTxid = await spendP2sh({
    rpc,
    privateKey,
    address,
    bytecode,
    tagHex,
    buildUnlock,
    utxo,
    outAmt,
  });

  return {
    template: name,
    entry: entryName,
    p2shAddress: p2sh,
    fundTxid,
    fundExplorer: `https://tn10.kaspa.stream/transactions/${fundTxid}`,
    spendTxid,
    spendExplorer: `https://tn10.kaspa.stream/transactions/${spendTxid}`,
    amountSompi: String(FUND_SOMPI),
    feeSompi: String(fee),
  };
}

async function main() {
  const { privateKey, address } = loadEnvKey();
  const rpc = new kaspa.RpcClient({ url: RPC, encoding: kaspa.Encoding.Borsh, networkId: NETWORK });
  await rpc.connect();
  const results = [];
  try {
    for (const name of ["tipjar", "timeout_vault", "escrow"]) {
      console.log("===", name, "===");
      const r = await runOne(name, { privateKey, address, rpc });
      console.log(JSON.stringify(r, null, 2));
      results.push(r);
    }
  } finally {
    await rpc.disconnect();
  }
  const doc = { at: new Date().toISOString(), network: NETWORK, results };
  writeFileSync(OUT, JSON.stringify(doc, null, 2));
  console.log("wrote", OUT);
}

main().catch((e) => {
  console.error("E2E FAIL:", e?.message || e);
  process.exit(1);
});
