/** Kaspa TransactionSigningHash = Blake2b-256 keyed with "TransactionSigningHash". */
import { blake2b } from "@noble/hashes/blake2.js";

const DOMAIN = new TextEncoder().encode("TransactionSigningHash");
export const ZERO_HASH = new Uint8Array(32);

export class TxSigningHasher {
  private state = blake2b.create({ dkLen: 32, key: DOMAIN });
  update(data: Uint8Array): this {
    this.state.update(data);
    return this;
  }
  writeU8(n: number): this {
    return this.update(Uint8Array.of(n & 0xff));
  }
  writeBool(b: boolean): this {
    return this.writeU8(b ? 1 : 0);
  }
  writeU16(n: number): this {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, n, true);
    return this.update(b);
  }
  writeU32(n: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    return this.update(b);
  }
  writeU64(n: bigint | number): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
    return this.update(b);
  }
  writeVarBytes(bytes: Uint8Array): this {
    this.writeU64(bytes.length);
    return this.update(bytes);
  }
  finalize(): Uint8Array {
    return this.state.digest();
  }
}
