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
