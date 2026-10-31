import { bytesToHex, hexToBytes } from "./script.js";

export interface SilEntryParam {
  name: string;
  type: { kind: string; [k: string]: unknown };
}

export interface SilEntry {
  dispatch_tag: string;
  params: SilEntryParam[];
}

export interface SilCompiled {
  bytecode: number[];
  template_hash: number[];
  state_span: { offset: number; len: number };
}

export interface SilContract {
  source_path?: string;
  runtime_state?: unknown;
  entries: Record<string, SilEntry>;
  compiled: SilCompiled;
}

export interface SilAbiArtifact {
  schema_version: number;
  compiler_version?: string;
  structs?: Record<string, unknown>;
  contracts: Record<string, SilContract>;
}

export interface LoadedArtifact {
  artifact: SilAbiArtifact;
  contractName: string;
  contract: SilContract;
  bytecode: Uint8Array;
  bytecodeHex: string;
  templateHashHex: string;
  entries: Record<string, SilEntry>;
}

export function loadSilArtifact(
  input: unknown,
  contractName?: string,
): LoadedArtifact {
  if (input == null || typeof input !== "object") {
    throw new Error("Not a SilAbiArtifact: pass artifact JSON (or use templateId on tools that support it)");
  }
  const root = input as { artifact?: SilAbiArtifact } & SilAbiArtifact;
  const artifact: SilAbiArtifact = root.artifact?.contracts ? root.artifact : (root as SilAbiArtifact);
  if (!artifact || typeof artifact !== "object" || !artifact.contracts) {
    throw new Error("Not a SilAbiArtifact: missing contracts");
  }
  const names = Object.keys(artifact.contracts);
  if (!names.length) throw new Error("artifact has no contracts");
  const name = contractName ?? names[0]!;
  const contract = artifact.contracts[name];
  if (!contract) throw new Error(`contract "${name}" not in artifact (have: ${names.join(", ")})`);
  if (!contract.compiled?.bytecode?.length) throw new Error("contract missing compiled.bytecode");
  if (!contract.entries || !Object.keys(contract.entries).length) {
    throw new Error("contract has no entries");
  }
  for (const [en, entry] of Object.entries(contract.entries)) {
    if (!/^[0-9a-fA-F]{8}$/.test(entry.dispatch_tag)) {
      throw new Error(`entry ${en}: invalid dispatch_tag`);
    }
  }
  const bytecode = Uint8Array.from(contract.compiled.bytecode);
  return {
    artifact,
    contractName: name,
    contract,
    bytecode,
    bytecodeHex: bytesToHex(bytecode),
    templateHashHex: bytesToHex(Uint8Array.from(contract.compiled.template_hash ?? [])),
    entries: contract.entries,
  };
}

export function entryOf(loaded: LoadedArtifact, entryName: string): SilEntry {
  const e = loaded.entries[entryName];
  if (!e) {
    throw new Error(
      `unknown entry "${entryName}". available: ${Object.keys(loaded.entries).join(", ")}`,
    );
  }
  return e;
}

/** Accept bytecode as number[] / hex / Uint8Array */
export function coerceBytecode(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (typeof raw === "string") return hexToBytes(raw);
  if (Array.isArray(raw)) return Uint8Array.from(raw as number[]);
  throw new Error("bytecode must be hex string or byte array");
}

/** TipJar demo artifact embeds this ownerPkh (blake2b of x-only 0x01 pubkey). */
export const TIPJAR_DEMO_OWNER_PKH_HEX =
  "9407263be9dc3c4b5b9afbd02ebb5d5cbda687dfb57c65c1816c8cdca9b677a0";

/**
 * Rebind TipJar example bytecode to a new ownerPkh without silverc.
 * Byte-identical to `silverc … --constructor-args` for the TipJar template
 * (single contiguous 32-byte push of ownerPkh).
 */
export function rebindTipjarOwnerPkh(
  loaded: LoadedArtifact,
  ownerPkhHex: string,
): LoadedArtifact {
  const hex = ownerPkhHex.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error("ownerPkhHex must be 32-byte hex");
  }
  const demo = hexToBytes(TIPJAR_DEMO_OWNER_PKH_HEX);
  const next = hexToBytes(hex);
  const src = loaded.bytecode;
  let idx = -1;
  for (let i = 0; i <= src.length - 32; i++) {
    let ok = true;
    for (let j = 0; j < 32; j++) {
      if (src[i + j] !== demo[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      idx = i;
      break;
    }
  }
  if (idx < 0) {
    throw new Error("TipJar demo ownerPkh not found in bytecode — recompile with silverc");
  }
  const bytecode = new Uint8Array(src);
  bytecode.set(next, idx);
  const artifact: SilAbiArtifact = structuredClone(loaded.artifact);
  const contract = artifact.contracts[loaded.contractName]!;
  contract.compiled = {
    ...contract.compiled,
    bytecode: Array.from(bytecode),
  };
  return {
    artifact,
    contractName: loaded.contractName,
    contract,
    bytecode,
    bytecodeHex: bytesToHex(bytecode),
    templateHashHex: loaded.templateHashHex,
    entries: contract.entries,
  };
}

/** Demo x-only pubkey = secp256k1 G (privkey 0x01). Used by vault/escrow bundled artifacts. */
export const DEMO_XONLY_PUB_HEX =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

/** Demo timeout temporal embedded in TimeoutVault example (ms-ish units silverc uses). */
export const VAULT_DEMO_TIMEOUT = 4_000_000_000_000;

function replaceAllOccurrences(src: Uint8Array, from: Uint8Array, to: Uint8Array): Uint8Array {
  if (from.length !== to.length) throw new Error("replace length mismatch");
  const out = new Uint8Array(src);
  for (let i = 0; i <= out.length - from.length; i++) {
    let ok = true;
    for (let j = 0; j < from.length; j++) {
      if (out[i + j] !== from[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.set(to, i);
  }
  return out;
}

function replaceNthOccurrence(
  src: Uint8Array,
  from: Uint8Array,
  to: Uint8Array,
  nth: number,
): Uint8Array {
  if (from.length !== to.length) throw new Error("replace length mismatch");
  const out = new Uint8Array(src);
  let seen = 0;
  for (let i = 0; i <= out.length - from.length; i++) {
    let ok = true;
    for (let j = 0; j < from.length; j++) {
      if (out[i + j] !== from[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      if (seen === nth) {
        out.set(to, i);
        return out;
      }
      seen += 1;
    }
  }
  throw new Error(`occurrence ${nth} of demo bytes not found`);
}

function cloneWithBytecode(loaded: LoadedArtifact, bytecode: Uint8Array): LoadedArtifact {
  const artifact: SilAbiArtifact = structuredClone(loaded.artifact);
  const contract = artifact.contracts[loaded.contractName]!;
  contract.compiled = { ...contract.compiled, bytecode: Array.from(bytecode) };
  return {
    artifact,
    contractName: loaded.contractName,
    contract,
    bytecode,
    bytecodeHex: bytesToHex(bytecode),
    templateHashHex: loaded.templateHashHex,
    entries: contract.entries,
  };
}

function assertHex32(hex: string, label: string): string {
  const h = hex.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`${label} must be 32-byte hex`);
  return h;
}

/**
 * Rebind TimeoutVault demo bytecode: recipient (1st x-only), sender (2nd x-only).
 * Byte-identical to silverc --constructor-args for same pubkeys + demo timeout.
 * Order verified against silverc v1.0.0 (recipient @ first demo x-only, sender @ second).
 */
export function rebindTimeoutVaultKeys(
  loaded: LoadedArtifact,
  opts: { senderXonlyHex: string; recipientXonlyHex: string },
): LoadedArtifact {
  const sender = hexToBytes(assertHex32(opts.senderXonlyHex, "senderXonlyHex"));
  const recipient = hexToBytes(assertHex32(opts.recipientXonlyHex, "recipientXonlyHex"));
  const demo = hexToBytes(DEMO_XONLY_PUB_HEX);
  // First occurrence = recipient, second = sender (silverc layout).
  let bc = replaceNthOccurrence(loaded.bytecode, demo, recipient, 0);
  bc = replaceNthOccurrence(bc, demo, sender, 0); // after first replace, remaining demo is sender slot
  return cloneWithBytecode(loaded, bc);
}

/**
 * Rebind Escrow demo: arbiter (pkh), buyer (x-only), seller (x-only).
 * Byte-identical to silverc for the same constructor args.
 */
export function rebindEscrowParties(
  loaded: LoadedArtifact,
  opts: { arbiterPkhHex: string; buyerXonlyHex: string; sellerXonlyHex: string },
): LoadedArtifact {
  const arbiter = hexToBytes(assertHex32(opts.arbiterPkhHex, "arbiterPkhHex"));
  const buyer = hexToBytes(assertHex32(opts.buyerXonlyHex, "buyerXonlyHex"));
  const seller = hexToBytes(assertHex32(opts.sellerXonlyHex, "sellerXonlyHex"));
  const demoPkh = hexToBytes(TIPJAR_DEMO_OWNER_PKH_HEX);
  const demoX = hexToBytes(DEMO_XONLY_PUB_HEX);
  let bc = replaceAllOccurrences(loaded.bytecode, demoPkh, arbiter);
  bc = replaceNthOccurrence(bc, demoX, buyer, 0);
  bc = replaceNthOccurrence(bc, demoX, seller, 0);
  return cloneWithBytecode(loaded, bc);
}

/** Demo unlockAt / deadline temporal embedded in Lockbox + SoftCapJar examples. */
export const LOCKBOX_DEMO_UNLOCK_AT = 4_000_000_000_000;
export const SOFTCAP_DEMO_GOAL_SOMPI = 100_000_000;

/** Encode temporal/int as silverc minimal little-endian push (must be 6 bytes for ms timestamps ≥ 2^40). */
export function encodeSilvercInt6(value: number | bigint): Uint8Array {
  const v = BigInt(value);
  if (v < 0n) throw new Error("negative int");
  // Prefer 6-byte LE for Worker rebind stability when value fits and is ≥ 2^40
  const buf = new Uint8Array(8);
  let x = v;
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  // trim high zeros but keep at least 1
  let len = 8;
  while (len > 1 && buf[len - 1] === 0) len--;
  return buf.slice(0, len);
}

/**
 * Rebind Lockbox: ownerPkh + unlockAt (6-byte temporal push in demo artifact).
 * unlockAt must encode to the same push width as the demo (6 bytes) — use ms ≥ 2^40.
 */
export function rebindLockbox(
  loaded: LoadedArtifact,
  opts: { ownerPkhHex: string; unlockAt: number | bigint },
): LoadedArtifact {
  const owner = hexToBytes(assertHex32(opts.ownerPkhHex, "ownerPkhHex"));
  const demoPkh = hexToBytes(TIPJAR_DEMO_OWNER_PKH_HEX);
  const unlock = BigInt(opts.unlockAt);
  if (unlock < 500_000_000_000n) {
    throw new Error("unlockAt must be ≥ LOCK_TIME_THRESHOLD (500000000000) — use unix ms");
  }
  const newEnc = encodeSilvercInt6(unlock);
  const demoEnc = encodeSilvercInt6(LOCKBOX_DEMO_UNLOCK_AT);
  if (newEnc.length !== demoEnc.length) {
    throw new Error(
      `unlockAt encoding width ${newEnc.length} ≠ demo ${demoEnc.length}; pick a ms timestamp in the same magnitude`,
    );
  }
  let bc = replaceAllOccurrences(loaded.bytecode, demoPkh, owner);
  bc = replaceAllOccurrences(bc, demoEnc, newEnc);
  return cloneWithBytecode(loaded, bc);
}

/**
 * Rebind SoftCapJar: ownerPkh + goalSompi + deadline.
 * Demo goal is 1e8 (4-byte LE); deadline matches Lockbox 6-byte temporal.
 */
export function rebindSoftCapJar(
  loaded: LoadedArtifact,
  opts: { ownerPkhHex: string; goalSompi: number | bigint; deadline: number | bigint },
): LoadedArtifact {
  const owner = hexToBytes(assertHex32(opts.ownerPkhHex, "ownerPkhHex"));
  const demoPkh = hexToBytes(TIPJAR_DEMO_OWNER_PKH_HEX);
  const goal = BigInt(opts.goalSompi);
  const deadline = BigInt(opts.deadline);
  if (deadline < 500_000_000_000n) {
    throw new Error("deadline must be ≥ LOCK_TIME_THRESHOLD (500000000000) — use unix ms");
  }
  const demoGoal = encodeSilvercInt6(SOFTCAP_DEMO_GOAL_SOMPI);
  const newGoal = encodeSilvercInt6(goal);
  const demoDead = encodeSilvercInt6(LOCKBOX_DEMO_UNLOCK_AT);
  const newDead = encodeSilvercInt6(deadline);
  if (newGoal.length !== demoGoal.length) {
    throw new Error(`goalSompi width ${newGoal.length} ≠ demo ${demoGoal.length}`);
  }
  if (newDead.length !== demoDead.length) {
    throw new Error(`deadline width ${newDead.length} ≠ demo ${demoDead.length}`);
  }
  let bc = replaceAllOccurrences(loaded.bytecode, demoPkh, owner);
  bc = replaceAllOccurrences(bc, demoGoal, newGoal);
  bc = replaceAllOccurrences(bc, demoDead, newDead);
  return cloneWithBytecode(loaded, bc);
}

/** Demo constants baked into aon_pledge.artifact.json (must match silverc ctor). */
export const AON_DEMO_OWNER_PKH_HEX =
  "50e4e615fef343ada5b11030ee9e3c27e7e73b3cab590a68e59edff51340a2a6";
export const AON_DEMO_BACKER_PKH_HEX = "01".repeat(32);
export const AON_DEMO_CAMPAIGN_TAG_HEX = "07".repeat(32);
export const AON_DEMO_GOAL_SOMPI = 100_000_000;
export const AON_DEMO_DEADLINE = 4_000_000_000_000;

/**
 * Rebind AoNPledge: ownerPkh + backerPkh + campaignTag + goalSompi + deadline.
 * Byte-identical to silverc for same constructor args (push widths must match demo).
 */
export function rebindAoNPledge(
  loaded: LoadedArtifact,
  opts: {
    ownerPkhHex: string;
    backerPkhHex: string;
    campaignTagHex: string;
    goalSompi: number | bigint;
    deadline: number | bigint;
  },
): LoadedArtifact {
  const owner = hexToBytes(assertHex32(opts.ownerPkhHex, "ownerPkhHex"));
  const backer = hexToBytes(assertHex32(opts.backerPkhHex, "backerPkhHex"));
  const tag = hexToBytes(assertHex32(opts.campaignTagHex, "campaignTagHex"));
  const goal = BigInt(opts.goalSompi);
  const deadline = BigInt(opts.deadline);
  if (deadline < 500_000_000_000n) {
    throw new Error("deadline must be ≥ LOCK_TIME_THRESHOLD (500000000000) — use unix ms");
  }
  const demoOwner = hexToBytes(AON_DEMO_OWNER_PKH_HEX);
  const demoBacker = hexToBytes(AON_DEMO_BACKER_PKH_HEX);
  const demoTag = hexToBytes(AON_DEMO_CAMPAIGN_TAG_HEX);
  const demoGoal = encodeSilvercInt6(AON_DEMO_GOAL_SOMPI);
  const newGoal = encodeSilvercInt6(goal);
  const demoDead = encodeSilvercInt6(AON_DEMO_DEADLINE);
  const newDead = encodeSilvercInt6(deadline);
  if (newGoal.length !== demoGoal.length) {
    throw new Error(`goalSompi width ${newGoal.length} ≠ demo ${demoGoal.length}`);
  }
  if (newDead.length !== demoDead.length) {
    throw new Error(`deadline width ${newDead.length} ≠ demo ${demoDead.length}`);
  }
  let bc = replaceAllOccurrences(loaded.bytecode, demoOwner, owner);
  bc = replaceAllOccurrences(bc, demoBacker, backer);
  bc = replaceAllOccurrences(bc, demoTag, tag);
  bc = replaceAllOccurrences(bc, demoGoal, newGoal);
  bc = replaceAllOccurrences(bc, demoDead, newDead);
  return cloneWithBytecode(loaded, bc);
}
