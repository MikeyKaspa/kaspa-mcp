import type { NetworkInfo } from "./types.js";

/**
 * Non-custodial safety model (documented for every write tool):
 *
 * 1. This server NEVER persists private keys, mnemonics, or seed phrases.
 * 2. Mainnet / real-value networks: private keys are REJECTED. Tools return
 *    unsigned transaction payloads for the user to sign in their own wallet.
 * 3. Testnet only: an optional per-call `privateKey` may be passed so an agent
 *    can complete a faucet→deploy demo. It lives only in that request's memory
 *    and must never be logged or written to disk by this server.
 * 4. Prefer generating a throwaway testnet key locally for demos.
 * 5. No paid APIs, no custodian, no hosted wallet. Public RPCs + free faucets only.
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

export const SAFETY_BANNER = `Safety: non-custodial. No keys stored. Mainnet = unsigned tx only. Testnet privateKey is per-call ephemeral. $0 public RPCs + free faucets only.`;
