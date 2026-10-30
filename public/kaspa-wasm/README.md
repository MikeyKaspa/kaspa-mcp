# kaspa-wasm (web / bundler target)

Official rusty-kaspa WASM web build served as Cloudflare Workers static assets
(not counted toward Worker script size; per-file limit 25 MiB; this wasm ~11 MiB).

Used by `/sign/l1-build.js` in the browser for L1 fund/spend SafeJSON construction
on the shared free Worker. Prefer this over a hand-rolled pure-JS builder: same
lineage KasWare uses (Transaction SafeJSON / createTransactions / sighash).

Source: kaspa-wasm npm web build (ESM + `init({ module_or_path })`).
Do not substitute the Node/CJS `vendor/kaspa` build here (`require`/`__dirname`).
