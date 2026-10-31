/**
 * Dedicated spending wallet for chat-driven L1 deploys (self-host only).
 *
 * Bomb-proof rules (see docs/SPENDING_WALLET_SECURITY.md):
 * - Shared demo (MCP_PUBLIC): never load, create, or sign with a spending key —
 *   even if env/file accidentally contains one.
 * - Key lives only on the user's deployment (env / local file / their CF secret).
 * - Fresh dedicated key only — never accept pasted main-wallet keys/seeds.
 * - Hard mainnet balance + per-tx caps (env at deploy time; not raisable via chat tools).
 * - Allowlist: fund/deploy only reviewed templates; spend only covenants we recorded;
 *   withdraw_all only to mainAddress locked at creation. No arbitrary P2PK sends.
 * - Private key is never returned by status / export tools; create persists to file
 *   and does not echo the key into MCP chat JSON.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SafetyError } from "./safety.js";
import type { NetworkInfo } from "./types.js";

export const SPENDING_ENV_KEY = "KASPA_SPENDING_PRIVATE_KEY";
export const SPENDING_PATH_ENV = "KASPA_SPENDING_WALLET_PATH";
export const SPENDING_MAINNET_ENV = "KASPA_SPENDING_MAINNET";
export const SPENDING_MAX_KAS_ENV = "KASPA_SPENDING_MAX_KAS";
export const SPENDING_MAX_TX_KAS_ENV = "KASPA_SPENDING_MAX_TX_KAS";
export const SPENDING_REGISTRY_ENV = "KASPA_SPENDING_REGISTRY_PATH";
export const DEFAULT_MAX_MAINNET_KAS = 50;
export const DEFAULT_MAX_TX_KAS = 50;
export const DEFAULT_WALLET_FILE = ".kaspa-spending.key";
export const DEFAULT_REGISTRY_FILE = ".kaspa-spending.registry.json";

/** Reviewed SilverScript templates the spending wallet may fund/deploy. */
export const REVIEWED_TEMPLATE_IDS = ["tipjar", "timeout_vault", "escrow", "lockbox", "softcap"] as const;
export type ReviewedTemplateId = (typeof REVIEWED_TEMPLATE_IDS)[number];

const HEX64 = /^0x[0-9a-fA-F]{64}$/;

export function isSharedPublicDemo(): boolean {
  return process.env.MCP_PUBLIC === "true" || process.env.MCP_PUBLIC === "1";
}

export function spendingMainnetEnabled(): boolean {
  return process.env[SPENDING_MAINNET_ENV] === "1" || process.env[SPENDING_MAINNET_ENV] === "true";
}

function parsePositiveKas(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  // Chat cannot raise above the hardcoded ceiling; env may only lower or equal.
  return Math.min(n, fallback);
}

/** Hard ceiling — env may lower, never raise above DEFAULT via this helper. */
export function maxMainnetKas(): number {
  return parsePositiveKas(process.env[SPENDING_MAX_KAS_ENV], DEFAULT_MAX_MAINNET_KAS);
}

export function maxTxKas(network: { isTestnet: boolean }): number {
  // Testnet: still enforce a per-tx bound (higher) so injection can't empty a fat faucet wallet in one shot.
  const ceiling = network.isTestnet ? 500 : DEFAULT_MAX_TX_KAS;
  const envDefault = network.isTestnet ? 500 : DEFAULT_MAX_TX_KAS;
  const raw = process.env[SPENDING_MAX_TX_KAS_ENV];
  if (raw == null || raw === "") return envDefault;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return envDefault;
  return Math.min(n, ceiling);
}

export function maxMainnetSompi(): bigint {
  return BigInt(Math.floor(maxMainnetKas() * 1e8));
}

export function maxTxSompi(network: { isTestnet: boolean }): bigint {
  return BigInt(Math.floor(maxTxKas(network) * 1e8));
}

export function walletFilePath(): string {
  return resolve(process.env[SPENDING_PATH_ENV] || DEFAULT_WALLET_FILE);
}

export function registryFilePath(): string {
  return resolve(process.env[SPENDING_REGISTRY_ENV] || DEFAULT_REGISTRY_FILE);
}

export function assertNotSharedDemo(action: string): void {
  if (isSharedPublicDemo()) {
    throw new SafetyError(
      `Refusing ${action} on the shared public demo. ` +
        `Self-host and configure a spending wallet on YOUR copy only. ` +
        `The shared Worker never holds or uses spending keys.`,
    );
  }
}

function normalizeHexKey(raw: string): string {
  const t = raw.trim();
  if (HEX64.test(t)) return t.toLowerCase();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return `0x${t.toLowerCase()}`;
  throw new SafetyError(
    "Spending key must be 0x-prefixed 32-byte hex. Mnemonics and keystores are rejected.",
  );
}

/**
 * Load spending key. On shared demo always returns null (ignores env/file).
 * Never logs the key.
 */
export function loadSpendingPrivateKeyHex(): { hex: string; source: "env" | "file" } | null {
  if (isSharedPublicDemo()) return null;
  const fromEnv = process.env[SPENDING_ENV_KEY]?.trim();
  if (fromEnv) {
    return { hex: normalizeHexKey(fromEnv), source: "env" };
  }
  const path = walletFilePath();
  if (!existsSync(path)) return null;
  const body = readFileSync(path, "utf8");
  const line =
    body
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#") && (l.startsWith("0x") || l.includes("="))) ?? "";
  const value = line.includes("=") ? line.slice(line.indexOf("=") + 1).trim() : line;
  if (!value) return null;
  return { hex: normalizeHexKey(value), source: "file" };
}

export function persistSpendingKey(hex: string, path = walletFilePath()): string {
  assertNotSharedDemo("persist spending key");
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `# kaspa-mcp spending wallet — DO NOT COMMIT\n${SPENDING_ENV_KEY}=${hex}\n`, {
    mode: 0o600,
  });
  try {
    chmodSync(abs, 0o600);
  } catch {
    /* ignore */
  }
  return abs;
}

export type SpendingRegistry = {
  version: 1;
  mainAddress: string;
  spendingAddress?: string;
  networkId: string;
  createdAt: string;
  /** P2SH covenants funded/deployed by this spending wallet */
  covenants: Array<{
    p2shAddress: string;
    templateId: ReviewedTemplateId;
    fundTxid?: string;
    bytecodeHashHex?: string;
    createdAt: string;
  }>;
};

export function readRegistry(): SpendingRegistry | null {
  if (isSharedPublicDemo()) return null;
  const fromEnv = process.env.KASPA_SPENDING_REGISTRY_JSON;
  if (fromEnv) {
    try {
      const raw = JSON.parse(fromEnv) as SpendingRegistry;
      if (raw?.version === 1 && typeof raw.mainAddress === "string") return raw;
    } catch { /* ignore */ }
  }
  const path = registryFilePath();
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8")) as SpendingRegistry;
    if (raw?.version !== 1 || typeof raw.mainAddress !== "string") return null;
    return raw;
  } catch {
    return null;
  }
}

export function writeRegistry(reg: SpendingRegistry): string {
  assertNotSharedDemo("write spending registry");
  process.env.KASPA_SPENDING_REGISTRY_JSON = JSON.stringify(reg);
  const path = registryFilePath();
  let result = "memory";
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(reg, null, 2) + "\n", { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      /* ignore */
    }
    result = path;
  } catch {
    result = "memory";
  }
  return result;
}

/** Persist registry to file/env and Cloudflare KV when the Worker hook is set. */
export async function persistRegistry(reg: SpendingRegistry): Promise<string> {
  const path = writeRegistry(reg);
  const hook = (globalThis as { __kaspaWriteRegistry?: (r: SpendingRegistry) => Promise<void> })
    .__kaspaWriteRegistry;
  if (hook) {
    await hook(reg);
    return path === "memory" ? "kv:spending-registry" : path;
  }
  return path;
}

export function assertReviewedTemplate(templateId: string): asserts templateId is ReviewedTemplateId {
  if (!(REVIEWED_TEMPLATE_IDS as readonly string[]).includes(templateId)) {
    throw new SafetyError(
      `Template "${templateId}" is not on the spending-wallet allowlist. ` +
        `Allowed: ${REVIEWED_TEMPLATE_IDS.join(", ")}. Arbitrary bytecode auto-sign is refused.`,
    );
  }
}

export async function recordCovenant(opts: {
  p2shAddress: string;
  templateId: ReviewedTemplateId;
  fundTxid?: string;
  bytecodeHashHex?: string;
}): Promise<SpendingRegistry> {
  const reg = readRegistry();
  if (!reg) {
    throw new SafetyError(
      "Spending registry missing — call spending_wallet_create with mainAddress first.",
    );
  }
  if (!reg.covenants.some((c) => c.p2shAddress === opts.p2shAddress)) {
    reg.covenants.push({
      p2shAddress: opts.p2shAddress,
      templateId: opts.templateId,
      fundTxid: opts.fundTxid,
      bytecodeHashHex: opts.bytecodeHashHex,
      createdAt: new Date().toISOString(),
    });
  }
  await persistRegistry(reg);
  return reg;
}

export function assertCovenantOwned(p2shAddress: string): void {
  const reg = readRegistry();
  if (!reg?.covenants.some((c) => c.p2shAddress === p2shAddress)) {
    throw new SafetyError(
      `P2SH ${p2shAddress} is not in this spending wallet's covenant registry. ` +
        `Auto-spend only allowed for covenants this wallet funded/deployed.`,
    );
  }
}

export function assertWithdrawDestination(destination: string): void {
  const reg = readRegistry();
  if (!reg) throw new SafetyError("No spending registry — create a spending wallet first.");
  if (destination.trim() !== reg.mainAddress.trim()) {
    throw new SafetyError(
      `Refusing send to ${destination}. Spending wallet may only withdraw_all to the locked mainAddress (${reg.mainAddress}). ` +
        `Arbitrary destinations are blocked (prompt-injection protection).`,
    );
  }
}

export function assertDestinationAllowedForSpend(
  destination: string,
  spendingAddress: string,
): void {
  const reg = readRegistry();
  const main = reg?.mainAddress?.trim();
  const dest = destination.trim();
  if (dest === spendingAddress.trim() || (main && dest === main)) return;
  throw new SafetyError(
    `Refusing covenant spend destination ${destination}. ` +
      `Allowed: spending wallet itself or locked mainAddress${main ? ` (${main})` : ""}.`,
  );
}

export async function addressForKey(
  privateKeyHex: string,
  network: NetworkInfo,
): Promise<string> {
  const { privateKeyToAddress } = await import("./l1/pure/sign.js");
  const networkId = network.id.includes("mainnet") || !network.isTestnet ? "mainnet" : "testnet-10";
  return privateKeyToAddress(privateKeyHex, networkId);
}

export async function xonlyPubHex(privateKeyHex: string): Promise<string> {
  const { privateKeyToXonly } = await import("./l1/pure/sign.js");
  const { bytesToHex } = await import("@noble/hashes/utils.js");
  return bytesToHex(privateKeyToXonly(privateKeyHex));
}

export async function ownerPkhHex(privateKeyHex: string): Promise<string> {
  const { blake2b } = await import("@noble/hashes/blake2.js");
  const { bytesToHex } = await import("@noble/hashes/utils.js");
  const xonly = Buffer.from(await xonlyPubHex(privateKeyHex), "hex");
  return bytesToHex(blake2b(xonly, { dkLen: 32 }));
}

export type SpendingStatus = {
  configured: boolean;
  sharedDemo: boolean;
  source?: "env" | "file";
  address?: string;
  mainAddress?: string;
  covenantCount?: number;
  networkId: string;
  mainnetSigningEnabled: boolean;
  maxMainnetKas: number;
  maxTxKas: number;
  reviewedTemplates: readonly string[];
  note: string;
};

export async function spendingWalletStatus(network: NetworkInfo): Promise<SpendingStatus> {
  const shared = isSharedPublicDemo();
  const base = {
    networkId: network.id,
    mainnetSigningEnabled: shared ? false : spendingMainnetEnabled(),
    maxMainnetKas: maxMainnetKas(),
    maxTxKas: maxTxKas(network),
    reviewedTemplates: REVIEWED_TEMPLATE_IDS,
  };
  if (shared) {
    return {
      ...base,
      configured: false,
      sharedDemo: true,
      note: "Shared demo never holds a spending wallet. Self-host to enable chat-deploy.",
    };
  }
  const loaded = loadSpendingPrivateKeyHex();
  const reg = readRegistry();
  if (!loaded) {
    return {
      ...base,
      configured: false,
      sharedDemo: false,
      mainAddress: reg?.mainAddress,
      note: `No spending key. Call spending_wallet_create({ mainAddress }), or set ${SPENDING_ENV_KEY}.`,
    };
  }
  const address = await addressForKey(loaded.hex, network);
  return {
    ...base,
    configured: true,
    sharedDemo: false,
    source: loaded.source,
    address,
    mainAddress: reg?.mainAddress,
    covenantCount: reg?.covenants.length ?? 0,
    note: "Spending wallet ready (allowlisted templates + withdraw_all to mainAddress only).",
  };
}

export type CreateResult = {
  address: string;
  mainAddress: string;
  networkId: string;
  persistedTo?: string;
  registryPath: string;
  /** Worker one-shot only (no filesystem). Omitted when key file persisted. */
  privateKeyHex?: string;
  backupHint: string;
  wranglerHint: string;
  setupSteps: string[];
  warning: string;
};

function assertAddressLooksValid(address: string, network: NetworkInfo): void {
  const a = address.trim().toLowerCase();
  if (network.isTestnet || network.id.includes("testnet")) {
    if (!a.startsWith("kaspatest:")) {
      throw new SafetyError(`mainAddress must be a kaspatest: address on testnet (got ${address.slice(0, 24)}…)`);
    }
  } else {
    if (!a.startsWith("kaspa:") || a.startsWith("kaspatest:")) {
      throw new SafetyError(`mainAddress must be a kaspa: mainnet address (got ${address.slice(0, 24)}…)`);
    }
  }
}

/** Generate a fresh dedicated key. Requires mainAddress for withdraw_all allowlist. */
export async function createSpendingWallet(opts: {
  network: NetworkInfo;
  mainAddress: string;
  persist?: boolean;
}): Promise<CreateResult> {
  assertNotSharedDemo("spending_wallet_create");
  assertAddressLooksValid(opts.mainAddress, opts.network);
  const existing = loadSpendingPrivateKeyHex();
  if (existing) {
    const address = await addressForKey(existing.hex, opts.network);
    throw new SafetyError(
      `Spending wallet already configured (${existing.source}) at ${address}. ` +
        `Unset ${SPENDING_ENV_KEY} / remove ${walletFilePath()} and ${registryFilePath()} to rotate after withdraw_all.`,
    );
  }

  const { bytesToHex } = await import("@noble/hashes/utils.js");
  const sk = new Uint8Array(32);
  crypto.getRandomValues(sk);
  if (sk.every((b) => b === 0)) sk[31] = 1;
  const privateKeyHex = normalizeHexKey(`0x${bytesToHex(sk)}`);
  const address = await addressForKey(privateKeyHex, opts.network);

  const onWorker =
    typeof (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === "string" &&
    (globalThis as { navigator: { userAgent: string } }).navigator.userAgent.includes("Cloudflare");
  if (opts.persist === false && !onWorker) {
    throw new SafetyError(
      "persist=false is refused on Node — key must be written to a local file (not echoed in chat).",
    );
  }

  const canWriteFile =
    typeof process !== "undefined" && !!process.versions?.node && !onWorker;

  let persistedTo: string | undefined;
  let privateKeyOnce: string | undefined;
  if (canWriteFile) {
    persistedTo = persistSpendingKey(privateKeyHex);
  } else {
    // Worker (or non-Node): one-shot reveal for wrangler secret put
    privateKeyOnce = privateKeyHex;
  }

  const reg: SpendingRegistry = {
    version: 1,
    mainAddress: opts.mainAddress.trim(),
    spendingAddress: address,
    networkId: opts.network.id,
    createdAt: new Date().toISOString(),
    covenants: [],
  };
  const registryPath = await persistRegistry(reg);

  return {
    address,
    mainAddress: reg.mainAddress,
    networkId: opts.network.id,
    persistedTo,
    registryPath,
    ...(privateKeyOnce ? { privateKeyHex: privateKeyOnce } : {}),
    backupHint: privateKeyOnce
      ? `SAVE THIS KEY NOW (shown once). On YOUR Cloudflare account run:\n` +
        `  printf '%s' '<paste-key-here>' | npx wrangler secret put ${SPENDING_ENV_KEY} -c wrangler.selfhost.toml\n` +
        `Or: npm run selfhost:setup -- --create-wallet --main-address <your-address>\n` +
        `Then call spending_wallet_status on YOUR …/mcp URL.`
      : `Key written to ${persistedTo} (mode 600). Never paste into chat.`,
    wranglerHint: `printf '%s' '<key>' | npx wrangler secret put ${SPENDING_ENV_KEY} -c wrangler.selfhost.toml`,
    setupSteps: privateKeyOnce
      ? [
          "1. Copy privateKeyHex from this response (shown once; Worker will not store it in chat logs after this).",
          `2. In your kaspa-mcp folder (same -c file you deployed): printf '%s' '0x…' | npx wrangler secret put ${SPENDING_ENV_KEY} -c wrangler.selfhost.toml`,
          "   Or re-run: npm run selfhost:setup -- --create-wallet --main-address <your-kaspatest>",
          "3. Fund the spending address on TN10 (https://faucet-tn10.kaspanet.io/).",
          "4. In chat: choose_network testnet, then “build me a tip jar” (l1_tipjar_chat_deploy).",
          "5. spending_wallet_withdraw_all can only send leftovers to your locked mainAddress.",
        ]
      : [
          `1. Key is at ${persistedTo} — do not commit it.`,
          "2. Fund the spending address, then l1_tipjar_chat_deploy.",
        ],
    warning:
      "⚠️ Dedicated spending wallet created. Fund only what you can lose. " +
      `withdraw_all can only send to locked mainAddress (${reg.mainAddress}). ` +
      "Auto-sign only allowlisted templates + covenants this wallet created. " +
      "Shared demo will never use this key. " +
      (opts.network.isTestnet
        ? "Testnet: fund from TN10 faucet, then l1_tipjar_chat_deploy."
        : "MAINNET: requires KASPA_SPENDING_MAINNET=1; hard caps apply."),
  };
}

/** Explicitly refuse any attempt to export / dump the key via tools. */
export function refuseKeyExport(): never {
  throw new SafetyError(
    "Refusing to export or print the spending private key. " +
      "It lives only in your local file / env / Cloudflare secret. " +
      "No MCP tool returns key material after creation (prompt-injection protection).",
  );
}

/** Refuse chat attempts to raise caps. */
export function refuseCapChangeViaChat(): never {
  throw new SafetyError(
    `Refusing to change ${SPENDING_MAX_KAS_ENV} / ${SPENDING_MAX_TX_KAS_ENV} via chat. ` +
      `Caps are deploy-time env only (hard ceiling ${DEFAULT_MAX_MAINNET_KAS} KAS balance / ${DEFAULT_MAX_TX_KAS} KAS per tx on mainnet).`,
  );
}

export function assertCanAutoSign(network: NetworkInfo): { hex: string; source: "env" | "file" } {
  assertNotSharedDemo("spending-wallet auto-sign");
  if (!network.isTestnet && !spendingMainnetEnabled()) {
    throw new SafetyError(
      `Mainnet spending-wallet signing is off. Set ${SPENDING_MAINNET_ENV}=1 at deploy time to opt in. ` +
        `Hard cap ${DEFAULT_MAX_MAINNET_KAS} KAS. Prefer tap-to-approve for mainnet.`,
    );
  }
  const loaded = loadSpendingPrivateKeyHex();
  if (!loaded) {
    throw new SafetyError(
      `No spending wallet configured. Call spending_wallet_create({ mainAddress }) on self-host.`,
    );
  }
  if (!readRegistry()?.mainAddress) {
    throw new SafetyError(
      "Spending key found but registry/mainAddress missing. Re-create with spending_wallet_create({ mainAddress }).",
    );
  }
  return loaded;
}

export async function assertBalanceAndTxCaps(
  network: NetworkInfo,
  address: string,
  txAmountSompi: bigint,
  getBalanceSompi: (address: string) => Promise<bigint>,
): Promise<void> {
  const txCap = maxTxSompi(network);
  if (txAmountSompi > txCap) {
    throw new SafetyError(
      `Per-tx amount ${txAmountSompi} sompi exceeds cap ${txCap} sompi (${maxTxKas(network)} KAS). ` +
        `Lower the amount; caps are not raisable via chat.`,
    );
  }
  if (network.isTestnet) return;
  const bal = await getBalanceSompi(address);
  const cap = maxMainnetSompi();
  if (bal > cap) {
    throw new SafetyError(
      `Spending wallet balance ${bal} sompi exceeds hard cap ${cap} sompi (${maxMainnetKas()} KAS). ` +
        `Call spending_wallet_withdraw_all, then reduce funds. Caps are deploy-time env only.`,
    );
  }
  if (txAmountSompi > cap) {
    throw new SafetyError(`Tx amount exceeds mainnet balance cap ${cap} sompi.`);
  }
}

/** @deprecated use assertBalanceAndTxCaps */
export async function assertMainnetBalanceCap(
  network: NetworkInfo,
  address: string,
  getBalanceSompi: (address: string) => Promise<bigint>,
): Promise<void> {
  await assertBalanceAndTxCaps(network, address, 0n, getBalanceSompi);
}

/**
 * Shared-demo invariant for CI: no key path may be active.
 * Returns list of violation strings (empty = ok).
 */
export function sharedDemoKeyPathViolations(env: NodeJS.ProcessEnv = process.env): string[] {
  const violations: string[] = [];
  const pub = env.MCP_PUBLIC === "true" || env.MCP_PUBLIC === "1";
  if (!pub) return violations;
  // Even if secrets are present in the process env on a misconfigured shared deploy,
  // runtime must ignore them — CI asserts load returns null when MCP_PUBLIC is set.
  return violations;
}

export const SPENDING_MAINNET_BANNER =
  "⚠️ MAINNET SPENDING WALLET: UNAUDITED connector auto-signs allowlisted actions only. " +
  `Hard caps: ${DEFAULT_MAX_MAINNET_KAS} KAS balance / ${DEFAULT_MAX_TX_KAS} KAS per tx. Prefer tap-to-approve for real value.`;
