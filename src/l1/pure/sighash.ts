/**
 * calc_schnorr_signature_hash — rusty-kaspa consensus/core hashing/sighash.rs
 * SIG_HASH_ALL = 0x01 (wire), not the wasm enum index.
 */
import { TxSigningHasher, ZERO_HASH } from "./hash.js";

export const SIG_HASH_ALL = 0x01;
export const SIG_HASH_NONE = 0x02;
export const SIG_HASH_SINGLE = 0x04;
export const SIG_HASH_ANYONE_CAN_PAY = 0x80;
export const SIG_HASH_MASK = 0x07;

export type PureInput = {
  previousOutpoint: { transactionId: Uint8Array; index: number };
  sequence: bigint;
  sigOpCount: number;
  /** UTXO being spent */
  utxo: { amount: bigint; scriptPublicKey: { version: number; script: Uint8Array } };
};

export type PureOutput = {
  value: bigint;
  scriptPublicKey: { version: number; script: Uint8Array };
  covenant?: { authorizingInput: number; covenantId: Uint8Array } | null;
};

export type PureTx = {
  version: number;
  inputs: PureInput[];
  outputs: PureOutput[];
  lockTime: bigint;
  subnetworkId: Uint8Array; // 20 bytes
  gas: bigint;
  payload: Uint8Array;
};

function isAnyoneCanPay(t: number) {
  return (t & SIG_HASH_ANYONE_CAN_PAY) === SIG_HASH_ANYONE_CAN_PAY;
}
function isNone(t: number) {
  return (t & SIG_HASH_MASK) === SIG_HASH_NONE;
}
function isSingle(t: number) {
  return (t & SIG_HASH_MASK) === SIG_HASH_SINGLE;
}

function hashScriptPublicKey(h: TxSigningHasher, spk: { version: number; script: Uint8Array }) {
  h.writeU16(spk.version);
  h.writeVarBytes(spk.script);
}

function hashOutput(h: TxSigningHasher, output: PureOutput, version: number) {
  h.writeU64(output.value);
  hashScriptPublicKey(h, output.scriptPublicKey);
  if (version >= 1) {
    const c = output.covenant;
    h.writeBool(!!c);
    if (c) {
      h.writeU16(c.authorizingInput);
      h.update(c.covenantId);
    }
  }
}

function previousOutputsHash(tx: PureTx, hashType: number): Uint8Array {
  if (isAnyoneCanPay(hashType)) return ZERO_HASH.slice();
  const h = new TxSigningHasher();
  for (const input of tx.inputs) {
    h.update(input.previousOutpoint.transactionId);
    h.writeU32(input.previousOutpoint.index);
  }
  return h.finalize();
}

function sequencesHash(tx: PureTx, hashType: number): Uint8Array {
  if (isSingle(hashType) || isAnyoneCanPay(hashType) || isNone(hashType)) return ZERO_HASH.slice();
  const h = new TxSigningHasher();
  for (const input of tx.inputs) h.writeU64(input.sequence);
  return h.finalize();
}

function sigOpCountsHash(tx: PureTx, hashType: number): Uint8Array {
  if (isAnyoneCanPay(hashType)) return ZERO_HASH.slice();
  const h = new TxSigningHasher();
  for (const input of tx.inputs) h.writeU8(input.sigOpCount);
  return h.finalize();
}

function payloadHash(tx: PureTx): Uint8Array {
  const native = tx.subnetworkId.every((b) => b === 0);
  if (native && tx.payload.length === 0) return ZERO_HASH.slice();
  const h = new TxSigningHasher();
  h.writeVarBytes(tx.payload);
  return h.finalize();
}

function outputsHash(tx: PureTx, hashType: number, inputIndex: number): Uint8Array {
  if (isNone(hashType)) return ZERO_HASH.slice();
  if (isSingle(hashType)) {
    if (inputIndex >= tx.outputs.length) return ZERO_HASH.slice();
    const h = new TxSigningHasher();
    hashOutput(h, tx.outputs[inputIndex]!, tx.version);
    return h.finalize();
  }
  const h = new TxSigningHasher();
  for (const out of tx.outputs) hashOutput(h, out, tx.version);
  return h.finalize();
}

export function calcSchnorrSignatureHash(
  tx: PureTx,
  inputIndex: number,
  hashType: number = SIG_HASH_ALL,
): Uint8Array {
  const input = tx.inputs[inputIndex];
  if (!input) throw new Error(`input ${inputIndex} missing`);
  const h = new TxSigningHasher();
  h.writeU16(tx.version);
  h.update(previousOutputsHash(tx, hashType));
  h.update(sequencesHash(tx, hashType));
  if (tx.version < 1) h.update(sigOpCountsHash(tx, hashType));

  h.update(input.previousOutpoint.transactionId);
  h.writeU32(input.previousOutpoint.index);
  hashScriptPublicKey(h, input.utxo.scriptPublicKey);
  h.writeU64(input.utxo.amount);
  h.writeU64(input.sequence);
  if (tx.version < 1) h.writeU8(input.sigOpCount);

  h.update(outputsHash(tx, hashType, inputIndex));
  h.writeU64(tx.lockTime);
  h.update(tx.subnetworkId);
  h.writeU64(tx.gas);
  h.update(payloadHash(tx));
  h.writeU8(hashType);
  return h.finalize();
}
