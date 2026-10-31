import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { calcSchnorrSignatureHash, SIG_HASH_ALL, type PureTx } from "./sighash.js";
import { encodePush, concatBytes, bytesToHex as toHex } from "../script.js";
import {
  addressFromXonly,
  p2pkScriptHex,
  scriptPublicKeyFromAddress,
  encodeAddress,
  AddressVersion,
  prefixForNetwork,
} from "./address.js";

export function privateKeyToXonly(privateKeyHex: string): Uint8Array {
  const sk = hexToBytes(privateKeyHex.replace(/^0x/, ""));
  return schnorr.getPublicKey(sk);
}

export function privateKeyToAddress(privateKeyHex: string, networkId: "testnet-10" | "mainnet"): string {
  return addressFromXonly(privateKeyToXonly(privateKeyHex), networkId);
}

export function signInputSchnorr(
  tx: PureTx,
  inputIndex: number,
  privateKeyHex: string,
  hashType: number = SIG_HASH_ALL,
): Uint8Array {
  const msg = calcSchnorrSignatureHash(tx, inputIndex, hashType);
  const sk = hexToBytes(privateKeyHex.replace(/^0x/, ""));
  const sig = schnorr.sign(msg, sk);
  const out = new Uint8Array(66);
  out[0] = 0x41;
  out.set(sig, 1);
  out[65] = hashType;
  return out;
}

export function payToScriptHashScript(redeem: Uint8Array): {
  version: number;
  script: string;
  scriptBytes: Uint8Array;
  scriptHash: Uint8Array;
} {
  const scriptHash = blake2b(redeem, { dkLen: 32 });
  const scriptBytes = concatBytes(Uint8Array.of(0xaa, 0x20), scriptHash, Uint8Array.of(0x87));
  return { version: 0, script: toHex(scriptBytes), scriptBytes, scriptHash };
}

export function p2shAddress(redeem: Uint8Array, networkId: "testnet-10" | "mainnet"): string {
  const { scriptHash } = payToScriptHashScript(redeem);
  return encodeAddress(prefixForNetwork(networkId), AddressVersion.ScriptHash, scriptHash);
}

export function payToScriptHashSignatureScript(redeem: Uint8Array, unlock: Uint8Array): Uint8Array {
  return concatBytes(unlock, encodePush(redeem));
}

export function hexIdToBytes(txid: string): Uint8Array {
  return hexToBytes(txid.replace(/^0x/, ""));
}

export {
  bytesToHex,
  hexToBytes,
  scriptPublicKeyFromAddress,
  p2pkScriptHex,
  SIG_HASH_ALL,
  addressFromXonly,
};
