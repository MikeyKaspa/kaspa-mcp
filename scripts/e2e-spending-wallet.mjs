#!/usr/bin/env node
/**
 * TN10 e2e: spending wallet create(mainAddress) → fund → tipjar deploy → withdraw → withdraw_all.
 * Secrets never printed / never written to results JSON. No shared Worker deploy.
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY_FILE = "/home/box/.kaspa-operator/tn10/tn10.key";
const SPEND_PATH = join(ROOT, ".e2e-spending.key");
const REG_PATH = join(ROOT, ".e2e-spending.registry.json");
const OUT = join(ROOT, "docs/E2E_SPENDING_WALLET_RESULTS.json");
const SILVERC = process.env.SILVERC_PATH || "/workspace/silverscript-tools/silverc";

process.env.SILVERC_PATH = SILVERC;
process.env.KASPA_SPENDING_WALLET_PATH = SPEND_PATH;
process.env.KASPA_SPENDING_REGISTRY_PATH = REG_PATH;
delete process.env.MCP_PUBLIC;
delete process.env.KASPA_L1_BROWSER_BUILD;
delete process.env.KASPA_SPENDING_PRIVATE_KEY;
for (const p of [SPEND_PATH, REG_PATH]) {
  if (existsSync(p)) unlinkSync(p);
}

function loadOperator() {
  const env = Object.fromEntries(
    readFileSync(KEY_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), l.slice(i + 1)];
      }),
  );
  const hex = env.KASPA_PRIVATE_KEY.startsWith("0x") ? env.KASPA_PRIVATE_KEY : `0x${env.KASPA_PRIVATE_KEY}`;
  return { privateKeyHex: hex, address: env.KASPA_ADDRESS };
}

function assertNoKeyMaterial(obj) {
  const s = JSON.stringify(obj);
  if (/0x[0-9a-fA-F]{64}/.test(s)) throw new Error("RESULTS_LEAKED_KEY_MATERIAL");
}

async function main() {
  const { createSpendingWallet, loadSpendingPrivateKeyHex, ownerPkhHex } =
    await import("../dist/spending-wallet.js");
  const { getNetwork } = await import("../dist/networks.js");
  const { getTemplate } = await import("../dist/l1/templates.js");
  const { compileSilverscript } = await import("../dist/l1/compile.js");
  const {
    autoFundCovenant,
    autoSpendCovenant,
    spendingWalletWithdrawAll,
    balanceSompi,
    apiBaseFor,
  } = await import("../dist/l1/auto-sign.js");
  const { fetchUtxosRest } = await import("../dist/l1/utxo.js");
  const kaspa = await import("kaspa");

  const network = getNetwork("kaspa-l1-testnet-10");
  const op = loadOperator();
  const results = { ok: false, steps: [], at: new Date().toISOString() };

  const created = await createSpendingWallet({ network, mainAddress: op.address });
  assertNoKeyMaterial(created);
  results.steps.push({
    step: "create",
    address: created.address,
    mainAddress: created.mainAddress,
    persisted: Boolean(created.persistedTo),
  });
  const spendAddr = created.address;

  const fundAmt = 2_0000_0000n;
  const rpcUrl = process.env.KASPA_RPC_URL || "wss://electron-10.kaspa.blue/kaspa/testnet-10/wrpc/borsh";
  const rpc = new kaspa.RpcClient({ url: rpcUrl, encoding: kaspa.Encoding.Borsh, networkId: "testnet-10" });
  await rpc.connect();
  try {
    const { entries } = await rpc.getUtxosByAddresses({ addresses: [op.address] });
    const { transactions } = await kaspa.createTransactions({
      entries,
      outputs: [{ address: spendAddr, amount: fundAmt }],
      changeAddress: op.address,
      priorityFee: kaspa.kaspaToSompi("0.0002"),
      networkId: "testnet-10",
    });
    const pending = transactions[0];
    const pk = new kaspa.PrivateKey(op.privateKeyHex.replace(/^0x/, ""));
    pending.sign([pk]);
    const txid = await pending.submit(rpc);
    results.steps.push({
      step: "fund_spending_wallet",
      txid: typeof txid === "string" ? txid : String(txid),
      amountSompi: String(fundAmt),
    });
    let bal1 = 0n;
    for (let i = 0; i < 60; i++) {
      const got = await rpc.getUtxosByAddresses({ addresses: [spendAddr] });
      bal1 = (got.entries || []).reduce((a, u) => a + BigInt(u.amount), 0n);
      if (bal1 >= fundAmt) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    results.steps.push({ step: "spending_balance", balanceSompi: String(bal1) });
    if (bal1 < fundAmt) throw new Error("spending wallet not funded in time (wRPC)");
  } finally {
    await rpc.disconnect().catch(() => {});
  }

  const key = loadSpendingPrivateKeyHex();
  if (!key) throw new Error("spending key missing after create");
  const pkhHex = await ownerPkhHex(key.hex);
  const pkh = Array.from(Buffer.from(pkhHex, "hex"));
  const tipjar = getTemplate("tipjar");
  const loaded = compileSilverscript({
    source: tipjar.source,
    constructorArgs: [{ kind: "bytes", value: pkh }],
  });
  const funded = await autoFundCovenant({
    network,
    bytecode: loaded.bytecode,
    amountSompi: 1_0000_0000n,
    templateId: "tipjar",
  });
  assertNoKeyMaterial(funded);
  results.steps.push({
    step: "tipjar_fund",
    p2shAddress: funded.p2shAddress,
    txid: funded.txid,
    explorer: funded.explorer,
  });

  let utxo;
  for (let i = 0; i < 40; i++) {
    const list = await fetchUtxosRest(apiBaseFor(network), funded.p2shAddress);
    utxo = list.find((u) => u.outpoint.transactionId === funded.txid) || list[0];
    if (utxo) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!utxo) throw new Error("P2SH UTXO timeout");

  const spent = await autoSpendCovenant({
    network,
    loaded,
    entryName: "withdraw",
    args: [null, null],
    destinationAddress: spendAddr,
    p2shAddress: funded.p2shAddress,
    p2shUtxo: {
      outpoint: utxo.outpoint,
      amount: utxo.amount,
      scriptPublicKey: utxo.scriptPublicKey,
    },
  });
  assertNoKeyMaterial(spent);
  results.steps.push({ step: "tipjar_withdraw", txid: spent.txid, explorer: spent.explorer });

  await new Promise((r) => setTimeout(r, 2000));
  const bal2 = await balanceSompi(network, spendAddr);
  results.steps.push({ step: "balance_before_withdraw_all", balanceSompi: String(bal2) });
  if (bal2 > 50_000n) {
    const swept = await spendingWalletWithdrawAll({ network });
    assertNoKeyMaterial(swept);
    if (swept.destinationAddress !== op.address) {
      throw new Error("withdraw_all destination mismatch");
    }
    results.steps.push({
      step: "withdraw_all",
      txid: swept.txid,
      amountSompi: swept.amountSompi,
      destination: swept.destinationAddress,
    });
  }

  assertNoKeyMaterial(results);
  results.ok = true;
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ ok: true, out: OUT, steps: results.steps.map((s) => s.step) }));
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("E2E_FAIL", msg);
  writeFileSync(OUT, JSON.stringify({ ok: false, error: msg }, null, 2));
  process.exit(1);
});
