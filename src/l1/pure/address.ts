/** Kaspa bech32 (cashaddr-style checksum, ':' separator). */
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const REV = new Array<number>(128).fill(100);
for (let i = 0; i < CHARSET.length; i++) REV[CHARSET.charCodeAt(i)] = i;

export type AddressPrefix = "kaspa" | "kaspatest" | "kaspasim" | "kaspadev";
export const AddressVersion = { PubKey: 0, PubKeyECDSA: 1, ScriptHash: 8 } as const;

function polymod(values: Iterable<number>): bigint {
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    if (c0 & 0x01n) c ^= 0x98f2bc8e61n;
    if (c0 & 0x02n) c ^= 0x79b76d99e2n;
    if (c0 & 0x04n) c ^= 0xf33e5fb3c4n;
    if (c0 & 0x08n) c ^= 0xae2eabe2a8n;
    if (c0 & 0x10n) c ^= 0x1e4f43e470n;
  }
  return c ^ 1n;
}

function checksum(payload: number[], prefix: string): bigint {
  const pref = [...prefix].map((c) => c.charCodeAt(0) & 0x1f);
  return polymod([...pref, 0, ...payload, 0, 0, 0, 0, 0, 0, 0, 0]);
}

function conv8to5(payload: Uint8Array): number[] {
  const padding = payload.length % 5 === 0 ? 0 : 1;
  const five = new Array<number>(Math.floor((payload.length * 8) / 5) + padding).fill(0);
  let idx = 0;
  let buff = 0;
  let bits = 0;
  for (const c of payload) {
    buff = (buff << 8) | c;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      five[idx++] = (buff >> bits) & 31;
      buff &= (1 << bits) - 1;
    }
  }
  if (bits > 0) five[idx] = (buff << (5 - bits)) & 31;
  return five;
}

function conv5to8(payload: number[]): Uint8Array {
  const eight = new Uint8Array(Math.floor((payload.length * 5) / 8));
  let idx = 0;
  let buff = 0;
  let bits = 0;
  for (const c of payload) {
    buff = (buff << 5) | c;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      eight[idx++] = (buff >> bits) & 255;
      buff &= (1 << bits) - 1;
    }
  }
  return eight;
}

export function encodeAddress(prefix: AddressPrefix, version: number, payload: Uint8Array): string {
  const raw = new Uint8Array(1 + payload.length);
  raw[0] = version;
  raw.set(payload, 1);
  const five = conv8to5(raw);
  const pref = [...prefix].map((c) => c.charCodeAt(0) & 0x1f);
  const cs = checksum(five, prefix);
  const csBytes = new Uint8Array(8);
  new DataView(csBytes.buffer).setBigUint64(0, cs, false); // BE
  const cs5 = conv8to5(csBytes.slice(3)); // last 5 bytes of 8-byte BE → 8 five-bit words
  const body = [...five, ...cs5].map((c) => CHARSET[c]!).join("");
  return `${prefix}:${body}`;
}

export function decodeAddress(address: string): {
  prefix: AddressPrefix;
  version: number;
  payload: Uint8Array;
} {
  const colon = address.indexOf(":");
  if (colon < 0) throw new Error("missing address prefix");
  const prefix = address.slice(0, colon) as AddressPrefix;
  const data = address.slice(colon + 1);
  const u5: number[] = [];
  for (const ch of data) {
    const v = REV[ch.charCodeAt(0)] ?? 100;
    if (v === 100) throw new Error(`invalid address char ${ch}`);
    u5.push(v);
  }
  if (u5.length < 8) throw new Error("bad address payload");
  const split = u5.length - 8;
  const payloadU5 = u5.slice(0, split);
  const checksumU5 = u5.slice(split);
  const csBytes = new Uint8Array(8);
  csBytes.set(conv5to8(checksumU5), 3);
  const csNum = new DataView(csBytes.buffer).getBigUint64(0, false);
  if (checksum(payloadU5, prefix) !== csNum) throw new Error("bad address checksum");
  const payloadU8 = conv5to8(payloadU5);
  if (!payloadU8.length) throw new Error("empty payload");
  return { prefix, version: payloadU8[0]!, payload: payloadU8.slice(1) };
}

export function prefixForNetwork(networkId: "testnet-10" | "mainnet"): AddressPrefix {
  return networkId === "mainnet" ? "kaspa" : "kaspatest";
}

/** P2PK Schnorr scriptPublicKey script hex (no version prefix). */
export function p2pkScriptHex(xonly: Uint8Array): string {
  if (xonly.length !== 32) throw new Error("xonly must be 32 bytes");
  const hex = Array.from(xonly).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `20${hex}ac`;
}

export function addressFromXonly(xonly: Uint8Array, networkId: "testnet-10" | "mainnet"): string {
  return encodeAddress(prefixForNetwork(networkId), AddressVersion.PubKey, xonly);
}

export function scriptPublicKeyFromAddress(address: string): { version: number; script: string } {
  const { version, payload } = decodeAddress(address);
  if (version === AddressVersion.PubKey) {
    return { version: 0, script: p2pkScriptHex(payload) };
  }
  if (version === AddressVersion.ScriptHash) {
    if (payload.length !== 32) throw new Error("script hash payload must be 32 bytes");
    const hex = Array.from(payload).map((b) => b.toString(16).padStart(2, "0")).join("");
    return { version: 0, script: `aa20${hex}87` };
  }
  throw new Error(`unsupported address version ${version}`);
}
