#!/usr/bin/env node
/**
 * One-command Cloudflare self-host setup (no-popup path).
 *
 * - Deploys wrangler.selfhost.toml (never the shared demo name)
 * - Does NOT invent or print keys unless --create-wallet is passed with --main-address
 * - With --create-wallet: calls spending_wallet_create on the live Worker, puts secret via stdin
 *
 * Usage:
 *   npx wrangler login   # once
 *   npm run selfhost:setup
 *   npm run selfhost:setup -- --create-wallet --main-address kaspatest:q…
 *
 * Never commits secrets. Never touches mainnet keys.
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CFG = "wrangler.selfhost.toml";
const SECRET_TMP = join(ROOT, ".selfhost-setup.secret");

function parseArgs(argv) {
  const out = { createWallet: false, mainAddress: "", help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--create-wallet") out.createWallet = true;
    else if (a === "--main-address") out.mainAddress = String(argv[++i] || "").trim();
    else if (a.startsWith("--main-address=")) out.mainAddress = a.slice(15).trim();
  }
  return out;
}

function readWorkerName() {
  const toml = readFileSync(join(ROOT, CFG), "utf8");
  const m = /^name\s*=\s*"([^"]+)"/m.exec(toml);
  return m?.[1] || "kaspa-mcp-selfhost";
}

async function mcp(base, method, params, id = 1) {
  const res = await fetch(base.replace(/\/$/, "") + "/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": "kaspa-selfhost-setup/1.0",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  const line = text.includes("data:")
    ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5)
    : text;
  return JSON.parse(line || text || "{}");
}

async function tool(base, name, args) {
  const r = await mcp(base, "tools/call", { name, arguments: args }, Math.floor(Math.random() * 1e6));
  const text = r.result?.content?.[0]?.text || "";
  if (r.error) throw new Error(JSON.stringify(r.error));
  if (r.result?.isError) throw new Error(text || JSON.stringify(r));
  return JSON.parse(text);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: npm run selfhost:setup [-- --create-wallet --main-address kaspatest:…]

Deploys ${CFG} to YOUR Cloudflare account (free workers.dev).
Optional: create spending wallet + put KASPA_SPENDING_PRIVATE_KEY secret.`);
    process.exit(0);
  }

  console.log("→ Deploying self-host Worker (", CFG, ")…");
  const deployOut = execFileSync("npx", ["wrangler", "deploy", "-c", CFG], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.stdout.write(deployOut);
  const name = readWorkerName();
  // Account subdomain often appears in deploy output; fall back to common pattern
  const urlMatch = deployOut.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i);
  const base = urlMatch?.[0] || `https://${name}.workers.dev`;
  const mcpUrl = `${base}/mcp`;
  console.log("\n✓ Deployed");
  console.log("  MCP URL:", mcpUrl);
  console.log("  Next: add that URL as a custom MCP connector in your AI app.");

  if (!args.createWallet) {
    console.log(`\nOptional next (no-popup wallet):
  npm run selfhost:setup -- --create-wallet --main-address kaspatest:YOUR_ADDRESS
Then fund the spending address from https://faucet-tn10.kaspanet.io/`);
    return;
  }

  if (!args.mainAddress.startsWith("kaspatest:") && !args.mainAddress.startsWith("kaspa:")) {
    console.error("Refusing: --main-address must be kaspatest:… or kaspa:…");
    process.exit(1);
  }

  (async () => {
    await mcp(base, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "selfhost-setup", version: "0.1" },
    });
    try {
      await mcp(base, "notifications/initialized", {});
    } catch {
      /* empty body ok */
    }
    await tool(base, "choose_network", { choice: "testnet" });
    let created;
    try {
      created = await tool(base, "spending_wallet_create", {
        mainAddress: args.mainAddress,
        network: "kaspa-l1-testnet-10",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/already configured/i.test(msg)) {
        const st = await tool(base, "spending_wallet_status", { network: "kaspa-l1-testnet-10" });
        console.log("\n✓ Spending wallet already configured");
        console.log("  address:", st.address);
        console.log("  Fund it, then: choose_network testnet → l1_tipjar_chat_deploy");
        return;
      }
      throw e;
    }
    const key = created.privateKeyHex;
    const address = created.address;
    if (!key) {
      console.log("\n✓ Wallet created (key persisted on Node path)");
      console.log("  address:", address);
      return;
    }
    writeFileSync(SECRET_TMP, key, { mode: 0o600 });
    try {
      execFileSync(
        "npx",
        ["wrangler", "secret", "put", "KASPA_SPENDING_PRIVATE_KEY", "-c", CFG],
        { cwd: ROOT, input: key, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" },
      );
    } finally {
      if (existsSync(SECRET_TMP)) unlinkSync(SECRET_TMP);
    }
    console.log("\n✓ Spending wallet created + secret stored on YOUR Cloudflare account");
    console.log("  spending address:", address);
    console.log("  locked withdraw-to:", created.mainAddress);
    console.log("  Fund:", "https://faucet-tn10.kaspanet.io/");
    console.log("  Then in chat: choose_network testnet → “build me a tip jar”");
  })().catch((e) => {
    console.error("setup failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

main();
