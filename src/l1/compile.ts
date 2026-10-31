import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSilArtifact, type LoadedArtifact } from "./artifact.js";

/**
 * Self-host only: invoke silverc binary. Disabled on Cloudflare Workers
 * (no subprocess; no official WASM silverc).
 */
export function isSilvercAvailable(): boolean {
  if (typeof process === "undefined" || !process.versions?.node) return false;
  // Workers with nodejs_compat still should not shell out
  if ((globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent?.includes("Cloudflare")) {
    return false;
  }
  const bin = process.env.SILVERC_PATH || "silverc";
  const r = spawnSync(bin, ["--help"], { encoding: "utf8" });
  return r.status === 0;
}

export function compileSilverscript(opts: {
  source: string;
  constructorArgs?: unknown[];
  silvercPath?: string;
}): LoadedArtifact {
  if (typeof process === "undefined" || !process.versions?.node) {
    throw new Error(
      "silverscript_compile requires Node self-host (silverc binary). " +
        "On the shared Workers demo: use silverscript_templates or paste an artifact into silverscript_load_artifact.",
    );
  }
  const bin = opts.silvercPath || process.env.SILVERC_PATH || "silverc";
  const dir = mkdtempSync(join(tmpdir(), "silverc-"));
  try {
    const srcPath = join(dir, "contract.sil");
    writeFileSync(srcPath, opts.source);
    const args = [srcPath, "-c"];
    if (opts.constructorArgs && opts.constructorArgs.length) {
      const argsPath = join(dir, "args.json");
      writeFileSync(argsPath, JSON.stringify(opts.constructorArgs));
      args.push("--constructor-args", argsPath);
    }
    const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    if (r.status !== 0) {
      throw new Error(`silverc failed: ${(r.stderr || r.stdout || "unknown error").trim()}`);
    }
    const artifact = JSON.parse(r.stdout);
    return loadSilArtifact(artifact);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function silvercCompileHint(): string {
  return (
    "Install official silverc v1.0.0 from https://github.com/kaspanet/silverscript/releases — " +
    "put it on PATH or set SILVERC_PATH. Shared Workers demo cannot compile (no WASM silverc; no eval). " +
    "Use silverscript_templates (TipJar/Vault/Escrow rebind on Workers) or paste an artifact. Optional: local silverc via SILVERC_PATH."
  );
}
