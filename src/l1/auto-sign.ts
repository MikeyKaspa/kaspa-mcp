/**
 * Self-host auto-sign helpers using the dedicated spending wallet.
 * Allowlisted templates + registered covenants only; withdraw_all → mainAddress.
 */
import { createHash } from "node:crypto";
import {
  prepareFund,
  prepareSpend,
  mimicKaswareSignPskt,
  submitSafeJson,
} from "./prepare.js";
import { loadKaspa } from "./kaspa-sdk.js";
import { deriveP2shAddress } from "./p2sh.js";
import type { LoadedArtifact } from "./artifact.js";
import type { NetworkInfo } from "../types.js";
import {
  assertCanAutoSign,
  assertBalanceAndTxCaps,
  assertReviewedTemplate,
  assertCovenantOwned,
  assertDestinationAllowedForSpend,
  assertWithdrawDestination,
  addressForKey,
  recordCovenant,
  readRegistry,
  type ReviewedTemplateId,
  SPENDING_MAINNET_BANNER,
} from "../spending-wallet.js";
import { fetchUtxosRest } from "./utxo.js";

export function apiBaseFor(network: NetworkInfo): string {
  return network.isTestnet || network.id.includes("testnet")
    ? "https://api-tn10.kaspa.org"
    : "https://api.kaspa.org";
}

export async function balanceSompi(network: NetworkInfo, address: string): Promise<bigint> {
  const utxos = await fetchUtxosRest(apiBaseFor(network), address);
  return utxos.reduce((a, u) => a + u.amount, 0n);
}

function bytecodeHashHex(bytecode: Uint8Array): string {
  return createHash("sha256").update(bytecode).digest("hex");
}

export async function autoFundCovenant(opts: {
  network: NetworkInfo;
  bytecode: Uint8Array;
  amountSompi: bigint;
  priorityFeeSompi?: bigint;
  templateId: ReviewedTemplateId;
}): Promise<{
  txid: string;
  p2shAddress: string;
  fromAddress: string;
  amountSompi: string;
  templateId: ReviewedTemplateId;
  explorer: string;
  mainnetBanner?: string;
}> {
  assertReviewedTemplate(opts.templateId);
  const key = assertCanAutoSign(opts.network);
  const fromAddress = await addressForKey(key.hex, opts.network);
  await assertBalanceAndTxCaps(opts.network, fromAddress, opts.amountSompi, (a) =>
    balanceSompi(opts.network, a),
  );

  const prepared = await prepareFund({
    network: opts.network,
    bytecode: opts.bytecode,
    fromAddress,
    amountSompi: opts.amountSompi,
    priorityFeeSompi: opts.priorityFeeSompi,
  });
  const signed = await mimicKaswareSignPskt(prepared.safeJson, key.hex, prepared.kasware.signInputs);
  const txid = await submitSafeJson(signed, opts.network);
  recordCovenant({
    p2shAddress: prepared.p2shAddress,
    templateId: opts.templateId,
    fundTxid: txid,
    bytecodeHashHex: bytecodeHashHex(opts.bytecode),
  });
  const explorer = opts.network.isTestnet
    ? `https://tn10.kaspa.stream/transactions/${txid}`
    : `https://explorer.kaspa.org/transactions/${txid}`;
  return {
    txid,
    p2shAddress: prepared.p2shAddress,
    fromAddress,
    amountSompi: opts.amountSompi.toString(),
    templateId: opts.templateId,
    explorer,
    mainnetBanner: opts.network.isTestnet ? undefined : SPENDING_MAINNET_BANNER,
  };
}

export async function autoSpendCovenant(opts: {
  network: NetworkInfo;
  loaded: LoadedArtifact;
  entryName: string;
  args: unknown[];
  destinationAddress: string;
  p2shUtxo: {
    outpoint: { transactionId: string; index: number };
    amount: bigint | string;
    scriptPublicKey: { version: number; script: string };
  };
  feeSompi?: bigint;
  outputAmountSompi?: bigint;
  /** When known, verify ownership via registry; also derived from bytecode if missing */
  p2shAddress?: string;
}): Promise<{
  txid: string;
  p2shAddress: string;
  destinationAddress: string;
  explorer: string;
  mainnetBanner?: string;
}> {
  const key = assertCanAutoSign(opts.network);
  const fromAddress = await addressForKey(key.hex, opts.network);
  assertDestinationAllowedForSpend(opts.destinationAddress, fromAddress);

  const net = opts.network.id.includes("mainnet") || !opts.network.isTestnet ? "mainnet" : "testnet-10";
  const derived = await deriveP2shAddress(opts.loaded.bytecode, net);
  const p2shAddress = opts.p2shAddress ?? derived.address;
  assertCovenantOwned(p2shAddress);

  const inAmt = BigInt(opts.p2shUtxo.amount);
  const fee = opts.feeSompi ?? 300_000n;
  const outAmt = opts.outputAmountSompi ?? inAmt - fee;
  await assertBalanceAndTxCaps(opts.network, fromAddress, outAmt, (a) => balanceSompi(opts.network, a));

  const prepared = await prepareSpend({
    network: opts.network,
    loaded: opts.loaded,
    entryName: opts.entryName,
    args: opts.args,
    destinationAddress: opts.destinationAddress,
    p2shUtxo: opts.p2shUtxo,
    feeSompi: opts.feeSompi,
    outputAmountSompi: opts.outputAmountSompi,
    privateKeyHex: key.hex,
  });
  if (!prepared.signedSafeJson) {
    throw new Error("auto-spend expected signed SafeJSON (unlock fill failed)");
  }
  const txid = await submitSafeJson(prepared.signedSafeJson, opts.network);
  const explorer = opts.network.isTestnet
    ? `https://tn10.kaspa.stream/transactions/${txid}`
    : `https://explorer.kaspa.org/transactions/${txid}`;
  return {
    txid,
    p2shAddress: prepared.p2shAddress,
    destinationAddress: opts.destinationAddress,
    explorer,
    mainnetBanner: opts.network.isTestnet ? undefined : SPENDING_MAINNET_BANNER,
  };
}

/** Sweep spending wallet → locked mainAddress only (one UTXO at a time; storage-mass safe). */
export async function spendingWalletWithdrawAll(opts: {
  network: NetworkInfo;
  priorityFeeSompi?: bigint;
}): Promise<{
  txid: string;
  txids: string[];
  fromAddress: string;
  destinationAddress: string;
  amountSompi: string;
  explorer: string;
  mainnetBanner?: string;
}> {
  const key = assertCanAutoSign(opts.network);
  const kaspa = await loadKaspa();
  const fromAddress = await addressForKey(key.hex, opts.network);
  const reg = readRegistry();
  if (!reg?.mainAddress) throw new Error("mainAddress missing from registry");
  assertWithdrawDestination(reg.mainAddress);

  const networkId = opts.network.id.includes("mainnet") || !opts.network.isTestnet ? "mainnet" : "testnet-10";
  const rpcUrl =
    networkId === "testnet-10"
      ? process.env.KASPA_RPC_URL || "wss://electron-10.kaspa.blue/kaspa/testnet-10/wrpc/borsh"
      : process.env.KASPA_MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("No wRPC URL for submit");
  const rpc = new kaspa.RpcClient({ url: rpcUrl, encoding: kaspa.Encoding.Borsh, networkId });
  await rpc.connect();
  const privateKey = new kaspa.PrivateKey(key.hex.replace(/^0x/, ""));
  const priorityFee = opts.priorityFeeSompi ?? 100_000n;
  const txids: string[] = [];
  let totalSent = 0n;
  try {
    let { entries } = await rpc.getUtxosByAddresses({ addresses: [fromAddress] });
    if (!entries?.length) throw new Error(`No UTXOs at spending wallet ${fromAddress}`);

    // Sweep per-UTXO with change to mainAddress — avoids TN10 storage-mass traps on compound sweeps.
    while (entries.length) {
      const entry = entries[0]!;
      const amt = BigInt(entry.amount);
      // Prefer ~0.5 KAS outputs when UTXO is large enough; else leave 0.01 KAS fee buffer.
      const sendAmt = amt > 60_000_000n ? 50_000_000n : amt > 1_500_000n ? amt - 1_000_000n : 0n;
      if (sendAmt <= 0n) {
        throw new Error(
          `Remaining UTXO ${amt} sompi too small to withdraw safely (storage-mass). Top up or consolidate manually.`,
        );
      }
      await assertBalanceAndTxCaps(opts.network, fromAddress, sendAmt, async () =>
        entries.reduce((a: bigint, u: { amount: bigint | string | number }) => a + BigInt(u.amount), 0n),
      );
      const { transactions } = await kaspa.createTransactions({
        entries: [entry] as never,
        outputs: [{ address: reg.mainAddress, amount: sendAmt }],
        changeAddress: reg.mainAddress,
        priorityFee,
        networkId,
      });
      const pending = transactions[0];
      if (!pending) throw new Error("createTransactions returned no tx");
      pending.sign([privateKey]);
      const txid = await pending.submit(rpc);
      const id = typeof txid === "string" ? txid : String((txid as { transactionId?: string }).transactionId ?? txid);
      txids.push(id);
      totalSent += sendAmt;
      await new Promise((r) => setTimeout(r, 1500));
      ({ entries } = await rpc.getUtxosByAddresses({ addresses: [fromAddress] }));
    }

    const explorer =
      networkId === "testnet-10"
        ? `https://tn10.kaspa.stream/transactions/${txids[txids.length - 1]}`
        : `https://explorer.kaspa.org/transactions/${txids[txids.length - 1]}`;
    return {
      txid: txids[txids.length - 1]!,
      txids,
      fromAddress,
      destinationAddress: reg.mainAddress,
      amountSompi: totalSent.toString(),
      explorer,
      mainnetBanner: opts.network.isTestnet ? undefined : SPENDING_MAINNET_BANNER,
    };
  } finally {
    try {
      await rpc.disconnect();
    } catch {
      /* ignore */
    }
  }
}

