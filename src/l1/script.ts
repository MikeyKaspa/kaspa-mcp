/** Minimal Kaspa script push encoding (no wasm). */

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.trim().replace(/^0x/i, "");
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) {
    throw new Error("invalid hex");
  }
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array | number[]): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** BIP62-style data push (OpDataN / PUSHDATA1 / PUSHDATA2). */
export function encodePush(data: Uint8Array | number[] | Buffer): Uint8Array {
  const buf = data instanceof Uint8Array ? data : Uint8Array.from(data);
  const n = buf.length;
  if (n === 0) return Uint8Array.of(0x00);
  if (n <= 75) {
    const out = new Uint8Array(1 + n);
    out[0] = n;
    out.set(buf, 1);
    return out;
  }
  if (n <= 255) {
    const out = new Uint8Array(2 + n);
    out[0] = 0x4c; // OP_PUSHDATA1
    out[1] = n;
    out.set(buf, 2);
    return out;
  }
  if (n <= 65535) {
    const out = new Uint8Array(3 + n);
    out[0] = 0x4d; // OP_PUSHDATA2
    out[1] = n & 0xff;
    out[2] = (n >> 8) & 0xff;
    out.set(buf, 3);
    return out;
  }
  throw new Error(`push too large: ${n}`);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Encode a SilverScript portable ABI value onto the unlocking stack (raw bytes, then push).
 * `sig` values that already start with OP_DATA65 (0x41) from createInputSignature are passed through.
 */
export function encodeAbiArg(
  typeKind: string,
  value: unknown,
): Uint8Array {
  if (typeKind === "sig") {
    const raw =
      typeof value === "string"
        ? hexToBytes(value)
        : value instanceof Uint8Array
          ? value
          : Uint8Array.from(value as number[]);
    // createInputSignature returns [OP_DATA65][64 sig][sighash] — already a script fragment
    if (raw.length === 66 && raw[0] === 0x41) return raw;
    if (raw.length === 65 || raw.length === 64) return encodePush(raw);
    throw new Error(`sig must be 64/65 bytes or 66-byte push-encoded, got ${raw.length}`);
  }
  if (typeKind === "pubkey" || typeKind === "bytes" || typeKind === "datasig") {
    const raw =
      typeof value === "string"
        ? hexToBytes(value)
        : value instanceof Uint8Array
          ? value
          : Uint8Array.from(value as number[]);
    if (typeKind === "pubkey" && raw.length !== 32) {
      throw new Error(`pubkey must be 32-byte x-only, got ${raw.length}`);
    }
    return encodePush(raw);
  }
  if (typeKind === "int" || typeKind === "temporal") {
    const n = typeof value === "bigint" ? value : BigInt(value as number | string);
    return encodePush(encodeScriptNum(n));
  }
  if (typeKind === "bool") {
    return encodePush(value ? Uint8Array.of(0x01) : Uint8Array.of());
  }
  if (typeKind === "byte") {
    const b = Number(value);
    if (!Number.isInteger(b) || b < 0 || b > 255) throw new Error("byte out of range");
    return encodePush(Uint8Array.of(b));
  }
  throw new Error(`unsupported ABI arg kind for spend encoding: ${typeKind}`);
}

/** Minimally-encoded script integer (Kaspa/Bitcoin script num). */
export function encodeScriptNum(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array();
  const neg = n < 0n;
  let abs = neg ? -n : n;
  const bytes: number[] = [];
  while (abs > 0n) {
    bytes.push(Number(abs & 0xffn));
    abs >>= 8n;
  }
  if (bytes[bytes.length - 1]! & 0x80) bytes.push(neg ? 0x80 : 0x00);
  else if (neg) bytes[bytes.length - 1]! |= 0x80;
  return Uint8Array.from(bytes);
}

/**
 * Build the pre-redeem unlock fragment for a SilverScript entry:
 * encode(args in ABI order) || push(dispatch_tag).
 * Pass to payToScriptHashSignatureScript(redeem, unlock).
 */
export function buildEntryUnlock(
  entry: { dispatch_tag: string; params: Array<{ name: string; type: { kind: string } }> },
  args: unknown[],
): Uint8Array {
  if (args.length !== entry.params.length) {
    throw new Error(
      `entry expects ${entry.params.length} args (${entry.params.map((p) => p.name).join(", ")}), got ${args.length}`,
    );
  }
  const parts: Uint8Array[] = [];
  for (let i = 0; i < entry.params.length; i++) {
    parts.push(encodeAbiArg(entry.params[i]!.type.kind, args[i]));
  }
  const tag = hexToBytes(entry.dispatch_tag);
  if (tag.length !== 4) throw new Error(`dispatch_tag must be 4 bytes, got ${tag.length}`);
  parts.push(encodePush(tag));
  return concatBytes(...parts);
}
