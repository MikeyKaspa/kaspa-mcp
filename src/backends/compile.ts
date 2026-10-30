/**
 * Solidity compile helpers.
 *
 * Workers free-tier bundle limit is ~3 MB compressed; solc-js soljson is ~11 MB,
 * so the Worker path loads soljson from the official CDN at runtime
 * (https://binaries.soliditylang.org) instead of bundling it.
 *
 * Node (`npm start` / tests) prefers the local `solc` package via a dynamic
 * import that wrangler cannot statically bundle; CDN is the fallback.
 *
 * Tradeoff: first Worker compile downloads ~10 MB soljson into the isolate
 * and may hit free-plan CPU limits on cold start. Reads / prepare / deploy
 * with pre-built bytecode are unaffected. Local Node compile stays offline.
 */
import type { CompileResult } from "../types.js";
import { assertSourceSize } from "../limits.js";

export type SolcLike = {
  compile(input: string): string;
  version(): string;
};

const SOLC_VERSION_TAG = "v0.8.28+commit.7893614a";
const SOLJSON_CDN = `https://binaries.soliditylang.org/bin/soljson-${SOLC_VERSION_TAG}.js`;

let cached: SolcLike | null = null;

function isCloudflareWorker(): boolean {
  return (
    typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair === "function" ||
    (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers")
  );
}

function parseCompileOutput(
  outputJson: string,
  options?: { contractName?: string },
  compilerLabel?: string,
): CompileResult {
  const output = JSON.parse(outputJson);
  if (output.errors?.some((e: { severity: string }) => e.severity === "error")) {
    const msgs = output.errors
      .filter((e: { severity: string }) => e.severity === "error")
      .map((e: { formattedMessage?: string; message: string }) => e.formattedMessage || e.message)
      .join("\n");
    throw new Error(`Solidity compile failed:\n${msgs}`);
  }
  const contracts = output.contracts?.["Contract.sol"];
  if (!contracts || Object.keys(contracts).length === 0) {
    throw new Error("No contracts found in source");
  }
  const name =
    options?.contractName && contracts[options.contractName]
      ? options.contractName
      : Object.keys(contracts)[0];
  const c = contracts[name];
  const bytecode = c.evm?.bytecode?.object;
  if (!bytecode) throw new Error(`No bytecode for ${name}`);
  return {
    contractName: name,
    abi: c.abi,
    bytecode: `0x${bytecode}` as `0x${string}`,
    compiler: compilerLabel ?? "solc",
  };
}

export function compileWithSolc(
  solc: SolcLike,
  source: string,
  options?: { contractName?: string },
): CompileResult {
  const input = {
    language: "Solidity",
    sources: { "Contract.sol": { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode"] } },
    },
  };
  const out = solc.compile(JSON.stringify(input));
  return parseCompileOutput(out, options, `solc ${solc.version()}`);
}

function wrapSoljson(soljson: Record<string, unknown>): SolcLike {
  const cwrap = soljson.cwrap as
    | ((name: string, ret: string, args: string[]) => (...a: unknown[]) => unknown)
    | undefined;
  if (typeof cwrap !== "function") {
    throw new Error("soljson from CDN missing cwrap — unexpected build");
  }
  let compileFn: ((input: string, cb: number, ctx: number) => string) | null = null;
  if (soljson["_solidity_compile"] != null) {
    const raw = cwrap("solidity_compile", "string", ["string", "number", "number"]);
    compileFn = (input, cb, ctx) => raw(input, cb, ctx) as string;
  } else if (soljson["_compileStandard"] != null) {
    const raw = cwrap("compileStandard", "string", ["string", "number"]);
    compileFn = (input, cb) => raw(input, cb) as string;
  }
  if (!compileFn) {
    throw new Error("soljson from CDN has no solidity_compile / compileStandard");
  }
  const versionFn =
    soljson["_solidity_version"] != null
      ? (cwrap("solidity_version", "string", []) as () => string)
      : soljson["_version"] != null
        ? (cwrap("version", "string", []) as () => string)
        : () => SOLC_VERSION_TAG;

  return {
    version: () => versionFn(),
    compile: (input: string) => compileFn!(input, 0, 0),
  };
}

async function loadSolcFromCdn(): Promise<SolcLike> {
  const res = await fetch(SOLJSON_CDN);
  if (!res.ok) {
    throw new Error(`Failed to fetch solc from CDN (${res.status}): ${SOLJSON_CDN}`);
  }
  const code = await res.text();
  // Emscripten build expects Module; polyfill __dirname/__filename for Workers.
  const moduleObj: Record<string, unknown> = {};
  const factory = new Function(
    "Module",
    "__dirname",
    "__filename",
    "exports",
    "module",
    `${code}\n; return Module;`,
  ) as (
    m: Record<string, unknown>,
    d: string,
    f: string,
    e: Record<string, unknown>,
    mod: { exports: Record<string, unknown> },
  ) => Record<string, unknown>;
  const exportsObj: Record<string, unknown> = {};
  const soljson = factory(moduleObj, "/", "/soljson.js", exportsObj, { exports: exportsObj });
  const resolved =
    soljson && typeof soljson.cwrap === "function"
      ? soljson
      : moduleObj && typeof moduleObj.cwrap === "function"
        ? moduleObj
        : exportsObj;
  if (typeof (resolved as { cwrap?: unknown }).cwrap !== "function") {
    throw new Error("CDN soljson evaluated but cwrap was not found");
  }
  return wrapSoljson(resolved as Record<string, unknown>);
}

async function loadSolcFromNodePackage(): Promise<SolcLike | null> {
  if (isCloudflareWorker()) return null;
  if (typeof process === "undefined" || !process.versions?.node) return null;
  try {
    // Split the specifier so wrangler/esbuild cannot statically bundle soljson (~11 MB).
    const spec = ["sol", "c"].join("");
    const mod = (await import(spec)) as { default?: SolcLike } & SolcLike;
    const solc = (mod.default ?? mod) as SolcLike;
    if (typeof solc.compile !== "function") return null;
    return solc;
  } catch {
    // Fallback: Function-based import (also non-analyzable by bundlers).
    try {
      const dynamicImport = new Function("m", "return import(m)") as (
        m: string,
      ) => Promise<{ default: SolcLike } & SolcLike>;
      const mod = await dynamicImport("solc");
      return (mod.default ?? mod) as SolcLike;
    } catch {
      return null;
    }
  }
}

export async function loadSolc(): Promise<SolcLike> {
  if (cached) return cached;
  const local = await loadSolcFromNodePackage();
  if (local) {
    cached = local;
    return cached;
  }
  cached = await loadSolcFromCdn();
  return cached;
}

/** Async compile — Worker-safe (CDN) and Node-friendly (local solc). */
export async function compileSolidityAsync(
  source: string,
  options?: { contractName?: string },
): Promise<CompileResult> {
  assertSourceSize(source);
  try {
    const solc = await loadSolc();
    return compileWithSolc(solc, source, options);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Code generation from strings disallowed/i.test(msg) || /Disallowed operation/i.test(msg)) {
      throw new Error(
        "compile_solidity cannot evaluate solc on this Cloudflare Worker request " +
          "(Workers block new Function after startup). Fix: self-host with `npm start` " +
          "(local solc), or pass bytecode+abi to prepare_deploy / deploy_contract. " +
          "The shared demo preloads solc at isolate startup when possible.",
      );
    }
    throw e;
  }
}

/** Best-effort Worker startup preload so new Function runs in the allowed startup phase. */
export async function preloadSolcAtStartup(): Promise<{ ok: boolean; detail: string }> {
  try {
    await loadSolc();
    return { ok: true, detail: cached ? `solc ready (${cached.version()})` : "solc ready" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: msg };
  }
}

/**
 * Sync compile for Node tests / scripts that already have a SolcLike instance.
 * Do not call from the Worker graph — use compileSolidityAsync instead.
 */
export function compileSoliditySync(
  solc: SolcLike,
  source: string,
  options?: { contractName?: string },
): CompileResult {
  return compileWithSolc(solc, source, options);
}
