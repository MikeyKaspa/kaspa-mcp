/**
 * Self-host auto-sign via pure-JS Kaspa signer (Worker + Node).
 * Allowlisted templates + registered covenants only; withdraw_all → mainAddress.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
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
import {
  fetchUtxos,
  fundP2sh,
  spendP2sh,
  buildAndSignPayment,
  privateKeyToAddress,
  type RestUtxo,
  type SubmitConfirmMeta,
} from "./pure/tx.js";
import { explorerTxUrl } from "./confirm.js";
import { resolvePriorityFeeSompi } from "./fee.js";
import { privateKeyToAddress as pureAddr } from "./pure/sign.js";

function networkIdOf(network: NetworkInfo): "testnet-10" | "mainnet" {
  return network.id.includes("mainnet") || !network.isTestnet ? "mainnet" : "testnet-10";
}

export function apiBaseFor(network: NetworkInfo): string {
  return networkIdOf(network) === "mainnet" ? "https://api.kaspa.org" : "https://api-tn10.kaspa.org";
}

export async function balanceSompi(network: NetworkInfo, address: string): Promise<bigint> {
  const utxos = await fetchUtxos(networkIdOf(network), address);
  return utxos.reduce((a, u) => a + u.amount, 0n);
}

function bytecodeHashHex(bytecode: Uint8Array): string {
  return bytesToHex(sha256(bytecode));
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
  confirmation?: SubmitConfirmMeta;
  mainnetBanner?: string;
}> {
  assertReviewedTemplate(opts.templateId);
  const key = assertCanAutoSign(opts.network);
  const net = networkIdOf(opts.network);
  const fromAddress = pureAddr(key.hex, net);
  await assertBalanceAndTxCaps(opts.network, fromAddress, opts.amountSompi, (a) =>
    balanceSompi(opts.network, a),
  );

  const priorityFeeSompi =
    opts.priorityFeeSompi ?? (await resolvePriorityFeeSompi(net, undefined, "fund"));
  const funded = await fundP2sh({
    networkId: net,
    privateKeyHex: key.hex,
    redeemBytecode: opts.bytecode,
    amountSompi: opts.amountSompi,
    priorityFeeSompi,
  });
  await recordCovenant({
    p2shAddress: funded.p2shAddress,
    templateId: opts.templateId,
    fundTxid: funded.txid,
    bytecodeHashHex: bytecodeHashHex(opts.bytecode),
  });
  const explorer = funded.confirmation?.explorer ?? explorerTxUrl(net, funded.txid);
  return {
    txid: funded.txid,
    p2shAddress: funded.p2shAddress,
    fromAddress,
    amountSompi: funded.amountSompi,
    templateId: opts.templateId,
    explorer,
    confirmation: funded.confirmation,
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
  p2shAddress?: string;
}): Promise<{
  txid: string;
  p2shAddress: string;
  destinationAddress: string;
  explorer: string;
  confirmation?: SubmitConfirmMeta;
  mainnetBanner?: string;
}> {
  const key = assertCanAutoSign(opts.network);
  const net = networkIdOf(opts.network);
  const fromAddress = pureAddr(key.hex, net);
  assertDestinationAllowedForSpend(opts.destinationAddress, fromAddress);

  const { p2shAddress: derived } = await import("./pure/sign.js").then((m) => ({
    p2shAddress: m.p2shAddress(opts.loaded.bytecode, net),
  }));
  const p2shAddress = opts.p2shAddress ?? derived;
  assertCovenantOwned(p2shAddress);

  const inAmt = BigInt(opts.p2shUtxo.amount);
  const fee = opts.feeSompi ?? 500_000n;
  const outAmt = opts.outputAmountSompi ?? inAmt - fee;
  await assertBalanceAndTxCaps(opts.network, fromAddress, outAmt, (a) => balanceSompi(opts.network, a));

  const restUtxo: RestUtxo = {
    outpoint: opts.p2shUtxo.outpoint,
    amount: inAmt,
    scriptPublicKey: opts.p2shUtxo.scriptPublicKey,
  };
  const spent = await spendP2sh({
    networkId: net,
    privateKeyHex: key.hex,
    loaded: opts.loaded,
    entryName: opts.entryName,
    args: opts.args,
    destinationAddress: opts.destinationAddress,
    p2shUtxo: restUtxo,
    feeSompi: fee,
  });
  const explorer = spent.confirmation?.explorer ?? explorerTxUrl(net, spent.txid);
  return {
    txid: spent.txid,
    p2shAddress: spent.p2shAddress,
    destinationAddress: opts.destinationAddress,
    explorer,
    confirmation: spent.confirmation,
    mainnetBanner: opts.network.isTestnet ? undefined : SPENDING_MAINNET_BANNER,
  };
}

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
  confirmations?: SubmitConfirmMeta[];
  explanation: string;
  chunkCount: number;
  mainnetBanner?: string;
}> {
  const key = assertCanAutoSign(opts.network);
  const net = networkIdOf(opts.network);
  const fromAddress = pureAddr(key.hex, net);
  const reg = readRegistry();
  if (!reg?.mainAddress) throw new Error("mainAddress missing from registry");
  assertWithdrawDestination(reg.mainAddress);

  const priorityFee = opts.priorityFeeSompi ?? (await resolvePriorityFeeSompi(net, undefined, "p2pk"));
  const txids: string[] = [];
  const confirmations: SubmitConfirmMeta[] = [];
  let totalSent = 0n;

  // Sweep per-UTXO (storage-mass safe)
  for (let guard = 0; guard < 50; guard++) {
    const utxos = await fetchUtxos(net, fromAddress);
    if (!utxos.length) break;
    const entry = utxos[0]!;
    const amt = entry.amount;
    const sendAmt = amt > 60_000_000n ? 50_000_000n : amt > 1_500_000n ? amt - 1_000_000n : 0n;
    if (sendAmt <= 0n) {
      throw new Error(`Remaining UTXO ${amt} sompi too small to withdraw safely`);
    }
    await assertBalanceAndTxCaps(opts.network, fromAddress, sendAmt, async () =>
      utxos.reduce((a, u) => a + u.amount, 0n),
    );
    const paid = await buildAndSignPayment({
      networkId: net,
      privateKeyHex: key.hex,
      outputs: [{ address: reg.mainAddress, amount: sendAmt }],
      priorityFeeSompi: priorityFee,
      changeAddress: reg.mainAddress,
    });
    // Avoid stuck loops when REST recovers the same landed txid (UTXO index lag).
    if (txids.includes(paid.txid)) {
      confirmations.push(paid.confirmation);
      await new Promise((r) => setTimeout(r, 2500));
      const left = await fetchUtxos(net, fromAddress);
      if (!left.length || left[0]!.outpoint.transactionId === entry.outpoint.transactionId) {
        break;
      }
      continue;
    }
    txids.push(paid.txid);
    confirmations.push(paid.confirmation);
    totalSent += sendAmt;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!txids.length) throw new Error(`No UTXOs at spending wallet ${fromAddress}`);

  const last = txids[txids.length - 1]!;
  const explorer = confirmations[confirmations.length - 1]?.explorer ?? explorerTxUrl(net, last);
  const chunkCount = txids.length;
  const explanation =
    chunkCount <= 1
      ? `Swept the spending wallet to your locked main address in one transaction.`
      : `Your spending wallet had several separate coins (UTXOs). Kaspa charges more when one transaction tries to move too many at once, so we sent them home in ${chunkCount} smaller transfers — all only to your locked main address. Total moved: ${totalSent} sompi.`;
  return {
    txid: last,
    txids,
    fromAddress,
    destinationAddress: reg.mainAddress,
    amountSompi: totalSent.toString(),
    explorer,
    confirmations,
    explanation,
    chunkCount,
    mainnetBanner: opts.network.isTestnet ? undefined : SPENDING_MAINNET_BANNER,
  };
}

// Keep addressForKey import used via spending-wallet for status; silence unused
void addressForKey;
void privateKeyToAddress;
