/**
 * Pure-JS Kaspa signer differential vs kaspa-wasm + rusty-kaspa vectors.
 * Note: wasm createInputSignature uses non-deterministic Schnorr aux randomness,
 * so signature *bytes* differ; we require sighash equality (wasm sig verifies our hash)
 * and our signature verifies the same hash. Unsigned SafeJSON fields match.
 */
import { describe, it, expect } from "vitest";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { schnorr } from "@noble/curves/secp256k1";
import kaspa from "kaspa";
import { calcSchnorrSignatureHash, SIG_HASH_ALL, type PureTx } from "../src/l1/pure/sighash.js";
import { signInputSchnorr, privateKeyToXonly, p2shAddress, payToScriptHashScript } from "../src/l1/pure/sign.js";
import { addressFromXonly, scriptPublicKeyFromAddress } from "../src/l1/pure/address.js";
import { getTemplate } from "../src/l1/templates.js";
import { toSafeJson } from "../src/l1/pure/tx.js";

function rndBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

describe("rusty-kaspa sighash vectors", () => {
  it("native-all-0", () => {
    const prevTx = hexToBytes("880eb9819a31821d9d2399e2f35e2433b72637e393d71ecc9b8d0250f49153c3");
    const spk1 = hexToBytes("208325613d2eeaf7176ac6c670b13c0043156c427438ed72d74b7800862ad884e8ac");
    const spk2 = hexToBytes("20fcef4c106cf11135bbd70f02a726a92162d2fb8b22f0469126f800862ad884e8ac");
    const mkIn = (index: number, sequence: bigint, amount: bigint, script: Uint8Array) => ({
      previousOutpoint: { transactionId: prevTx, index },
      sequence,
      sigOpCount: 0,
      utxo: { amount, scriptPublicKey: { version: 0, script } },
    });
    const tx: PureTx = {
      version: 0,
      inputs: [mkIn(0, 0n, 100n, spk1), mkIn(1, 1n, 200n, spk2), mkIn(2, 2n, 300n, spk2)],
      outputs: [
        { value: 300n, scriptPublicKey: { version: 0, script: spk2 }, covenant: null },
        { value: 300n, scriptPublicKey: { version: 0, script: spk1 }, covenant: null },
      ],
      lockTime: 1615462089000n,
      subnetworkId: new Uint8Array(20),
      gas: 0n,
      payload: new Uint8Array(0),
    };
    expect(bytesToHex(calcSchnorrSignatureHash(tx, 0, SIG_HASH_ALL))).toBe(
      "03b7ac6927b2b67100734c3cc313ff8c2e8b3ce3e746d46dd660b706a916b1f5",
    );
  });
});

describe("address + p2sh vs wasm", () => {
  it("P2PK address matches", () => {
    const sk = "01".padStart(64, "0");
    const pure = addressFromXonly(privateKeyToXonly(sk), "testnet-10");
    const wasm = new kaspa.PrivateKey(sk).toKeypair().toAddress("testnet-10").toString();
    expect(pure).toBe(wasm);
  });

  it("P2SH address matches tipjar example", () => {
    const tip = getTemplate("tipjar");
    const pure = p2shAddress(tip.loadedExample.bytecode, "testnet-10");
    const spk = kaspa.payToScriptHashScript(tip.loadedExample.bytecode);
    const wasm = kaspa.addressFromScriptPublicKey(spk, "testnet-10").toString();
    expect(pure).toBe(wasm);
    expect(payToScriptHashScript(tip.loadedExample.bytecode).script).toBe(spk.script);
  });
});

describe("differential: random txs sighash (wasm sig verifies our digest)", () => {
  it("matches for many random txs", () => {
    const trials = 48;
    for (let t = 0; t < trials; t++) {
      let sk = bytesToHex(rndBytes(32));
      try {
        privateKeyToXonly(sk);
      } catch {
        sk = "01".padStart(64, "0");
      }
      const xonly = privateKeyToXonly(sk);
      const addr = addressFromXonly(xonly, "testnet-10");
      const spk = scriptPublicKeyFromAddress(addr);
      const nIn = 1 + (t % 3);
      const nOut = 1 + (t % 2);
      const prevIds = Array.from({ length: nIn }, () => rndBytes(32));
      const amounts = Array.from({ length: nIn }, () => BigInt(10_000_000 + (t + 1) * 1_000_000));
      const outAmts = amounts.map((a) => a / BigInt(nOut + 1));

      const wasmInputs = [];
      for (let i = 0; i < nIn; i++) {
        const utxo = {
          address: addr,
          outpoint: { transactionId: bytesToHex(prevIds[i]!), index: i },
          amount: amounts[i]!,
          scriptPublicKey: { version: 0, script: spk.script },
          blockDaaScore: 0n,
          isCoinbase: false,
        };
        wasmInputs.push(
          new kaspa.TransactionInput({
            previousOutpoint: utxo.outpoint,
            signatureScript: "",
            sequence: BigInt(i),
            sigOpCount: 1,
            utxo: utxo as never,
          }),
        );
      }
      const wasmOutputs = outAmts.map(
        (amt) => new kaspa.TransactionOutput(amt, kaspa.payToAddressScript(addr)),
      );
      const wasmTx = new kaspa.Transaction({
        version: 0,
        inputs: wasmInputs,
        outputs: wasmOutputs,
        lockTime: 0n,
        subnetworkId: "0000000000000000000000000000000000000000",
        gas: 0n,
        payload: "",
      });
      const wasmSigHex = String(
        kaspa.createInputSignature(wasmTx, 0, new kaspa.PrivateKey(sk), kaspa.SighashType.All),
      ).replace(/^0x/, "");
      const wasmSig = hexToBytes(wasmSigHex);
      expect(wasmSig[0]).toBe(0x41);
      expect(wasmSig[65]).toBe(SIG_HASH_ALL);

      const pureTx: PureTx = {
        version: 0,
        inputs: Array.from({ length: nIn }, (_, i) => ({
          previousOutpoint: { transactionId: prevIds[i]!, index: i },
          sequence: BigInt(i),
          sigOpCount: 1,
          utxo: {
            amount: amounts[i]!,
            scriptPublicKey: { version: 0, script: hexToBytes(spk.script) },
          },
        })),
        outputs: outAmts.map((amt) => ({
          value: amt,
          scriptPublicKey: { version: 0, script: hexToBytes(spk.script) },
          covenant: null,
        })),
        lockTime: 0n,
        subnetworkId: new Uint8Array(20),
        gas: 0n,
        payload: new Uint8Array(0),
      };
      const hash = calcSchnorrSignatureHash(pureTx, 0, SIG_HASH_ALL);
      // Byte-for-byte sighash agreement: wasm signature verifies our digest
      expect(schnorr.verify(wasmSig.slice(1, 65), hash, xonly)).toBe(true);
      const pureSig = signInputSchnorr(pureTx, 0, sk);
      expect(pureSig[0]).toBe(0x41);
      expect(pureSig[65]).toBe(SIG_HASH_ALL);
      expect(schnorr.verify(pureSig.slice(1, 65), hash, xonly)).toBe(true);

      // Unsigned SafeJSON structural parity (inputs/outputs/version)
      const wasmSafe = JSON.parse(wasmTx.serializeToSafeJSON());
      const pureSafe = JSON.parse(toSafeJson(pureTx, Array(nIn).fill("")));
      expect(pureSafe.version).toBe(wasmSafe.version);
      expect(pureSafe.inputs.length).toBe(wasmSafe.inputs.length);
      expect(pureSafe.outputs.length).toBe(wasmSafe.outputs.length);
      expect(pureSafe.inputs[0].transactionId).toBe(wasmSafe.inputs[0].transactionId);
      expect(pureSafe.inputs[0].index).toBe(wasmSafe.inputs[0].index);
      expect(pureSafe.outputs[0].value).toBe(wasmSafe.outputs[0].value);
    }
  });
});
