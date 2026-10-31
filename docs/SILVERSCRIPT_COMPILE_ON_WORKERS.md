# Research: compiling custom SilverScript without Node on Workers

**Date:** 2026-10-30 (America/Phoenix)  
**Question:** Can kaspa-mcp compile arbitrary `.sil` on Cloudflare Workers (no Node `silverc` binary)?

## Primary sources

| Source | What it says |
|--------|----------------|
| [kaspanet/silverscript README](https://github.com/kaspanet/silverscript/blob/master/README.md) | Compiler is a **Rust** workspace; `silverc` is a Cargo/`cargo run` **native CLI**, not a browser/WASM package. |
| [docs/TUTORIAL.md](https://github.com/kaspanet/silverscript/blob/master/docs/TUTORIAL.md) | Compile via CLI or Rust `sil_abi_artifact` / `compile_contract` APIs. No JS/WASM compile API documented. |
| [Kaspalytics SilverScript](https://www.kaspalytics.com/learn/programmability/silverscript) (updated 2026-08-14) | Language support table: **Rust**, **Python** (`kaspa.experimental.silverscript`), **CLI**. Quote: **“JavaScript — No binding today. Compile with silverc and load the artifact’s script bytes.”** |
| [Kaspa Python SDK — Compiling](https://kaspanet.github.io/kaspa-python-sdk/dev/learn/silverscript/compiling/) | Compile produces portable JSON artifacts; CI can compile once and ship artifacts without the compiler at runtime. |
| Kaspa News “From DAP to no_std” (2026-03) | WASM work described is for **covenant execution / SDK**, not shipping `silverc` as WASM. |

## Cloudflare Workers constraints (this project)

- Free Workers: **no `eval` / `new Function`**, ~**3 MiB** script limit, no arbitrary native binaries.
- `silverc` is a multi-MB Rust binary → cannot embed as-is.
- No official `silverc.wasm` release in the silverscript repo as of this research.

## Feasible paths (honest)

1. **Prebuilt / rebind artifacts (shipped now)** — TipJar, TimeoutVault, Escrow: rebind constructor bytes without silverc; **byte-identical to silverc** in tests. Covers the reviewed chat-deploy templates on Workers.
2. **User/CI compile step** — Developer runs `silverc` (or Python SDK) locally/CI, pastes artifact into `silverscript_load_artifact` / prepare tools. Best for custom contracts today.
3. **Self-host Node** — `npm start` + `SILVERC_PATH` for full `silverscript_compile` on the user’s machine.
4. **Future: silverc → WASM** — Would require upstream `wasm32` / `wasm-bindgen` packaging of `silverscript-lang` (not published). Size + no_std may be non-trivial; **not prototypeable here without a multi-day Rust port and still may exceed Worker limits**.

## Prototype attempt

- Searched silverscript releases/workspace for wasm targets / npm packages: **none**.
- Did **not** attempt an unofficial `cargo build --target wasm32-unknown-unknown` in this pass: would be speculative, likely oversized for free Workers, and unsupported by Kaspa maintainers.

## Recommendation for “idea → mainnet” seamlessness

- **Templates** (TipJar / Vault / Escrow): Worker rebind + spending wallet — already seamless on self-host.
- **Custom `.sil`:** keep **artifact-first** UX (bot asks user to compile once, or agent runs silverc on Node self-host / CI), then deploy via prepare/fund. Track upstream WASM silverc; do not pretend Workers can compile arbitrary SilverScript today.

