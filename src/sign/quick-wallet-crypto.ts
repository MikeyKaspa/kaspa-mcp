/**
 * Quick-start wallet crypto helpers (Node-testable).
 * Browser mirror lives in public/sign/quick-wallet.js — keep algorithms in sync.
 * Server never sees private keys.
 */

export const QUICK_WALLET_CAP_KAS = 50;
export const QUICK_WALLET_CAP_SOMPI = BigInt(QUICK_WALLET_CAP_KAS) * 100_000_000n;
export const QUICK_WALLET_DB = "kaspa-mcp-quick-wallet";
export const QUICK_WALLET_STORE = "wallets";
export const PBKDF2_ITERS = 210_000;
export const SALT_LEN = 16;
export const IV_LEN = 12;

export type QuickWalletNetwork = "testnet-10" | "mainnet";

export type EncryptedBlob = {
  v: 1;
  alg: "AES-GCM";
  kdf: "PBKDF2-SHA256" | "WebAuthn-PRF";
  saltB64: string;
  ivB64: string;
  ciphertextB64: string;
  /** WebAuthn credential id (base64url) when kdf is PRF */
  credIdB64?: string;
};

export type StoredQuickWallet = {
  id: string;
  network: QuickWalletNetwork;
  address: string;
  xonlyHex: string;
  createdAt: number;
  backupAckAt?: number;
  enc: EncryptedBlob;
  /** How the device unlocks — never the key itself */
  unlock: "passkey-prf" | "pin";
};

export function sompiFromKas(kas: number | string): bigint {
  const n = typeof kas === "string" ? Number(kas) : kas;
  if (!Number.isFinite(n) || n < 0) throw new Error("Invalid KAS amount");
  return BigInt(Math.round(n * 1e8));
}

export function formatKasFromSompi(sompi: bigint | string | number): string {
  const n = typeof sompi === "bigint" ? sompi : BigInt(sompi);
  const whole = n / 100_000_000n;
  const frac = (n % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

export function assertQuickWalletCap(balanceOrDepositSompi: bigint, capSompi = QUICK_WALLET_CAP_SOMPI): void {
  if (balanceOrDepositSompi > capSompi) {
    throw new Error(
      `Quick-start wallet cap exceeded: ${formatKasFromSompi(balanceOrDepositSompi)} KAS > ${formatKasFromSompi(capSompi)} KAS hard cap. Use a dedicated extension wallet for larger amounts.`,
    );
  }
}

/** Validate Kaspa address prefix for the active network. */
export function assertAddressMatchesNetwork(
  address: string,
  network: QuickWalletNetwork,
): void {
  const a = address.trim().toLowerCase();
  if (network === "testnet-10") {
    if (!a.startsWith("kaspatest:")) {
      throw new Error(
        `Wrong network: expected a testnet address (kaspatest:…), got "${address.slice(0, 28)}…"`,
      );
    }
    return;
  }
  if (!a.startsWith("kaspa:") || a.startsWith("kaspatest:") || a.startsWith("kaspasim:")) {
    throw new Error(
      `Wrong network: expected a mainnet address (kaspa:…), got "${address.slice(0, 28)}…"`,
    );
  }
}

export function networkPrefix(network: QuickWalletNetwork): "kaspa" | "kaspatest" {
  return network === "mainnet" ? "kaspa" : "kaspatest";
}

export function b64FromBytes(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function bytesFromB64(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlFromBytes(bytes: Uint8Array): string {
  return b64FromBytes(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function bytesFromB64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return bytesFromB64(b64);
}

/** Derive AES-GCM key from a device PIN (PBKDF2). */
export async function deriveKeyFromPin(
  pin: string,
  salt: Uint8Array,
  iterations = PBKDF2_ITERS,
): Promise<CryptoKey> {
  if (pin.length < 4) throw new Error("PIN must be at least 4 characters");
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Import a raw 32-byte AES key (e.g. from WebAuthn PRF). */
export async function importAesKey(raw32: Uint8Array): Promise<CryptoKey> {
  if (raw32.length < 32) throw new Error("AES key material must be ≥32 bytes");
  return crypto.subtle.importKey("raw", raw32.slice(0, 32) as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptPrivateKeyHex(
  privateKeyHex: string,
  aesKey: CryptoKey,
  meta: { kdf: EncryptedBlob["kdf"]; salt: Uint8Array; credIdB64?: string },
): Promise<EncryptedBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const plain = new TextEncoder().encode(privateKeyHex.replace(/^0x/, "").toLowerCase());
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, aesKey, plain),
  );
  return {
    v: 1,
    alg: "AES-GCM",
    kdf: meta.kdf,
    saltB64: b64FromBytes(meta.salt),
    ivB64: b64FromBytes(iv),
    ciphertextB64: b64FromBytes(ct),
    credIdB64: meta.credIdB64,
  };
}

export async function decryptPrivateKeyHex(
  blob: EncryptedBlob,
  aesKey: CryptoKey,
): Promise<string> {
  if (blob.v !== 1 || blob.alg !== "AES-GCM") throw new Error("Unsupported wallet blob");
  const iv = bytesFromB64(blob.ivB64);
  const ct = bytesFromB64(blob.ciphertextB64);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, aesKey, ct as BufferSource),
  );
  const hex = new TextDecoder().decode(plain).trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("Decrypted key is not 32-byte hex");
  return hex;
}

/** Parse a user-typed KAS amount → sompi; empty/invalid throws. */
export function parseKasAmountToSompi(raw: string): bigint {
  const t = String(raw).trim();
  if (!t) throw new Error("Enter an amount");
  if (!/^\d+(\.\d{1,8})?$/.test(t)) throw new Error("Amount must look like 1.5 (max 8 decimals)");
  const [w, f = ""] = t.split(".");
  const frac = (f + "00000000").slice(0, 8);
  return BigInt(w) * 100_000_000n + BigInt(frac);
}

export function mainnetRequiresBackupAck(stored: Pick<StoredQuickWallet, "backupAckAt" | "network">): boolean {
  return stored.network === "mainnet" && !stored.backupAckAt;
}
