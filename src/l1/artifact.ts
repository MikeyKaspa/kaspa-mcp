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
