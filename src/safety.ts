import type { NetworkInfo } from "./types.js";

/**
 * Non-custodial safety model (documented for every write tool):
 *
 * 1. Shared public demo NEVER persists private keys, mnemonics, or seed phrases.
 * 2. Self-host spending wallet (optional): a dedicated key may live in the user's
 *    own env/file/Worker secret — never on the shared demo, never a main-wallet seed.
 * 3. Mainnet / real-value: chat `privateKey` is REJECTED. Spending-wallet mainnet
 *    auto-sign requires explicit KASPA_SPENDING_MAINNET=1 + balance cap.
 * 4. Testnet: optional per-call `privateKey` OR spending wallet auto-sign.
 * 5. Prefer tap-to-approve for anything of value. No paid APIs / custodians.
 */

export class SafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyError";
  }
}

/** Normalize and validate a testnet-only private key. Returns trimmed 0x-hex. */
export function normalizeTestnetPrivateKey(network: NetworkInfo, privateKey?: string): string | undefined {
  if (privateKey == null || privateKey === "") return undefined;
  const key = privateKey.trim();
  if (!network.isTestnet) {
    throw new SafetyError(
      `Refusing private key on "${network.id}" (real value). ` +
        `Use prepare_deploy / prepare_call to get an unsigned tx, sign it in your wallet, ` +
        `then send_raw_transaction.`,
    );
  }
  // Reject mnemonics, keystores, 0x-less hex, whitespace-only tricks.
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new SafetyError(
      "privateKey must be 0x-prefixed 32-byte hex (testnet only). Mnemonics and keystores are rejected.",
    );
  }
  return key;
}

/** @deprecated Prefer normalizeTestnetPrivateKey — kept for call sites that only assert. */
export function assertCanSignWithKey(network: NetworkInfo, privateKey?: string): void {
  normalizeTestnetPrivateKey(network, privateKey);
}

export function redactSecrets(text: string): string {
  return text
    .replace(/0x[0-9a-fA-F]{64}/g, "0x[REDACTED_32BYTE]")
    .replace(/\b([a-z]+ ){11}[a-z]+\b/gi, "[REDACTED_MNEMONIC]");
}

export const SAFETY_BANNER = `Safety: non-custodial. Shared demo stores no keys. Self-host optional spending wallet (dedicated key on YOUR deploy only). Mainnet chat keys rejected; tap-to-approve default. $0 public RPCs + free faucets.`;
