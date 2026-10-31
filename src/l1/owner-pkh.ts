/**
 * TipJar ownerPkh = blake2b(x-only pubkey). Kaspa P2PK address payload is that x-only pubkey.
 */
import { blake2b } from "@noble/hashes/blake2b.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decodeAddress } from "./pure/address.js";
import { SafetyError } from "../safety.js";

export function ownerPkhFromP2pkAddress(address: string): string {
  const a = address.trim();
  let decoded;
  try {
    decoded = decodeAddress(a);
  } catch (e) {
    throw new SafetyError(
      `Cannot derive TipJar owner from address (need a kaspatest:/kaspa: P2PK receive address): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  if (decoded.version !== 0 /* PubKey */) {
    throw new SafetyError(
      `TipJar ownership needs your normal receive address (kaspatest:q… / kaspa:q…), not a P2SH or other type (version=${decoded.version}).`,
    );
  }
  if (decoded.payload.length !== 32) {
    throw new SafetyError(
      `Address is not a 32-byte P2PK pubkey payload (got ${decoded.payload.length} bytes).`,
    );
  }
  return bytesToHex(blake2b(decoded.payload, { dkLen: 32 }));
}

export function assertP2shMatches(
  computed: string,
  expected: string | undefined,
  label = "P2SH",
): void {
  if (!expected?.trim()) return;
  if (computed.trim().toLowerCase() !== expected.trim().toLowerCase()) {
    throw new SafetyError(
      `${label} mismatch: computed ${computed} !== expected ${expected}. ` +
        `Refusing to fund the wrong contract. Re-prepare with the same owner address / rebound bytecode.`,
    );
  }
}
