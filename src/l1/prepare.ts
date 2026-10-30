/**
 * L1 fund/spend builders producing KasWare-compatible Safe JSON.
 *
 * KasWare source of truth (verified 2026-10-30):
 * - Docs: https://docs.kasware.xyz/wallet/developer-documentation/kaspa/kaspa-transaction
 *   signPskt({ txJsonString }) requires Safe JSON deserializable by
 *   kaspa-wasm Transaction.deserializeFromSafeJSON(); returns signed Safe JSON;
 *   pushTx(txJsonString) broadcasts.
 * - Extension: kasware-wallet/extension src/background/controller/wallet.ts
 *   signPskt → Transaction.deserializeFromSafeJSON(txJsonString) → walletSignTransaction
 *   → signedTx.serializeToSafeJSON(); pushTx → deserializeFromSafeJSON → submit.
 * - Example Safe JSON in KasWare docs includes inputs[].utxo with address/amount/
 *   scriptPublicKey/blockDaaScore — matching PendingTransaction.transaction.serializeToSafeJSON().
 *
 * Fund: P2PK inputs → KasWare signPskt / pushPskt (or sendKaspa for simple sends).
 * Spend (SilverScript P2SH): covenant unlock (checkSig args + dispatch tag + redeem)
 * must be pre-filled before pushTx. KasWare signPskt only signs account P2PK inputs
 * (see KCC-20 docs: "signs only the open P2PK funding inputs"; covenant arg scripts
 * are assembled by the dApp). Testnet privateKey path fills the unlock for e2e.
 */
import { loadKaspa, assertL1NetworkWritable } from "./kaspa-sdk.js";
import { buildEntryUnlock } from "./script.js";
import type { LoadedArtifact } from "./artifact.js";
import { entryOf } from "./artifact.js";
import { deriveP2shAddress } from "./p2sh.js";
import {
  assertAddressNetwork,
  fetchUtxosRest,
  toKaspaEntries,
  type RestUtxo,
} from "./utxo.js";

const SUBNETWORK = "0000000000000000000000000000000000000000";

/** Dust / change threshold aligned with KasWare kaspaMass CHANGE_THRESHOLD spirit (~1e5 sompi mass fee floor). */
export const MIN_CHANGE_SOMPI = 100_000n;
/** Reject covenant fund outputs below this (storage-mass traps on tiny P2SH coins). */
export const MIN_FUND_SOMPI = 10_000_000n; // 0.1 KAS

export interface PrepareFundResult {
  mode: "unsigned_safe_json";
  networkId: string;
  kaspaNetwork: string;
  p2shAddress: string;
  amountSompi: string;
  changeAddress: string;
  feeSompi: string;
  inputCount: number;
  outputCount: number;
  /** Exact KasWare signPskt txJsonString (unsigned; empty signatureScript). */
  safeJson: string;
  /** Pass to KasWare: signPskt({ txJsonString: safeJson, options: { signInputs } }) */
  kasware: {
    method: "signPskt" | "pushPskt";
    signInputs: Array<{ index: number; sighashType: number }>;
    docs: string;
    sourceCite: string;
  };
  summary: string;
  walletHint: string;
}

export interface PrepareSpendResult {
  mode: "unsigned_safe_json" | "signed_ready_for_pushTx";
  networkId: string;
  kaspaNetwork: string;
  p2shAddress: string;
  entry: string;
  feeSompi: string;
  outputAmountSompi: string;
  safeJson: string;
  signedSafeJson?: string;
  kasware: {
    /** After unlock is filled: pushTx(signedSafeJson). Unsigned P2SH needs pre-filled unlock. */
    method: "pushTx" | "signPskt_then_pushTx";
    signInputs: Array<{ index: number; sighashType: number }>;
    docs: string;
    sourceCite: string;
    note: string;
  };
  summary: string;
  walletHint: string;
}

export const KASWARE_HINT =
  "KasWare fund: signPskt({ txJsonString: safeJson }) then pushTx, or pushPskt({ txJsonString }). " +
  "Spend: SilverScript unlock must be filled first (testnet privateKey path or compatible signer), then pushTx. " +
  "Docs: https://docs.kasware.xyz/wallet/developer-documentation/kaspa/kaspa-transaction";

const KASWARE_SOURCE_CITE =
  "kasware-wallet/extension wallet.ts: signPskt=deserializeFromSafeJSON→walletSignTransaction→serializeToSafeJSON; " +
  "pushTx=deserializeFromSafeJSON→submit. docs.kasware.xyz …/kaspa-transaction. " +
  "pushPskt is documented there but was NOT present in extension main source as of 2026-10-30 (prefer signPskt+pushTx).";

function kaspaNetworkId(network: { id: string; isTestnet: boolean }): "testnet-10" | "mainnet" {
  if (network.id.includes("testnet-10") || network.id.includes("tn10")) return "testnet-10";
  if (!network.isTestnet) return "mainnet";
  return "testnet-10";
}

function apiBaseFor(network: { id: string; isTestnet: boolean; rpcUrl?: string }): string {
  if (network.rpcUrl) return network.rpcUrl.replace(/\/$/, "");
  return network.isTestnet ? "https://api-tn10.kaspa.org" : "https://api.kaspa.org";
}

function sighashAllInputs(n: number) {
  return Array.from({ length: n }, (_, index) => ({ index, sighashType: 1 }));
}

/**
 * Prefer wRPC when available (accurate ScriptPublicKey objects); fall back to REST.
 */
async function loadEntries(
  kaspa: Awaited<ReturnType<typeof loadKaspa>>,
  net: "testnet-10" | "mainnet",
  address: string,
  apiBase: string,
): Promise<{ entries: unknown[]; rest: RestUtxo[] }> {
  const wrpcUrls =
    net === "testnet-10"
      ? [
          process.env.KASPA_RPC_URL,
          "wss://electron-10.kaspa.blue/kaspa/testnet-10/wrpc/borsh",
        ].filter(Boolean) as string[]
      : [process.env.KASPA_MAINNET_RPC_URL].filter(Boolean) as string[];

  for (const url of wrpcUrls) {
    try {
      const rpc = new kaspa.RpcClient({
        url,
        encoding: kaspa.Encoding.Borsh,
        networkId: net,
      });
      await rpc.connect();
      try {
        const { entries } = await rpc.getUtxosByAddresses({ addresses: [address] });
        if (entries?.length) {
          return { entries, rest: [] };
        }
      } finally {
        try {
          await rpc.disconnect();
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* try next / REST */
    }
  }

  const rest = await fetchUtxosRest(apiBase, address);
  return { entries: toKaspaEntries(rest), rest };
}

export async function prepareFund(opts: {
  network: { id: string; isTestnet: boolean; explorerUrl?: string; rpcUrl?: string };
  bytecode: Uint8Array;
  fromAddress: string;
  amountSompi: bigint;
  priorityFeeSompi?: bigint;
  /** Injected UTXOs for unit tests (skips network fetch). */
  utxoEntries?: unknown[];
}): Promise<PrepareFundResult> {
  assertL1NetworkWritable(opts.network.isTestnet, opts.network.id);
  const kaspa = await loadKaspa();
  const net = kaspaNetworkId(opts.network);
  assertAddressNetwork(opts.fromAddress, net);

  if (opts.amountSompi < MIN_FUND_SOMPI) {
    throw new Error(
      `amountSompi ${opts.amountSompi} is below MIN_FUND_SOMPI ${MIN_FUND_SOMPI} (0.1 KAS). ` +
        `Tiny P2SH outputs often fail storage-mass / relay policy.`,
    );
  }

  const p2sh = await deriveP2shAddress(opts.bytecode, net);
  assertAddressNetwork(p2sh.address, net);

  let entries = opts.utxoEntries;
  if (!entries) {
    const loaded = await loadEntries(kaspa, net, opts.fromAddress, apiBaseFor(opts.network));
    entries = loaded.entries;
  }
  if (!entries.length) {
    throw new Error(`No UTXOs at ${opts.fromAddress} on ${net}`);
  }

  const priorityFee = opts.priorityFeeSompi ?? 10_000n;
  let pending;
  try {
    const { transactions } = await kaspa.createTransactions({
      entries: entries as never,
      outputs: [{ address: p2sh.address, amount: opts.amountSompi }],
      changeAddress: opts.fromAddress,
      priorityFee,
      networkId: net,
    });
    pending = transactions[0];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/storage mass/i.test(msg)) {
      throw new Error(
        `Storage mass exceeds maximum for this fund (amount ${opts.amountSompi} sompi). ` +
          `Use a larger amount (≥ ${MIN_FUND_SOMPI}) or consolidate small UTXOs first. Underlying: ${msg}`,
      );
    }
    if (/insufficient|lack of funds|amount.*exceed/i.test(msg)) {
      throw new Error(`Insufficient funds to fund ${opts.amountSompi} sompi (+ fees) from ${opts.fromAddress}`);
    }
    throw e;
  }
  if (!pending) throw new Error("createTransactions returned no pending transaction");

  const tx = pending.transaction;
  const safeJson = tx.serializeToSafeJSON();
  // Round-trip verify KasWare deserialization path
  const roundTrip = kaspa.Transaction.deserializeFromSafeJSON(safeJson);
  if (roundTrip.inputs.length !== tx.inputs.length) {
    throw new Error("SafeJSON round-trip input count mismatch");
  }

  const parsed = JSON.parse(safeJson) as {
    inputs: Array<{ utxo?: { amount: string } }>;
    outputs: Array<{ value: string }>;
  };
  const inSum = parsed.inputs.reduce((a, i) => a + BigInt(i.utxo?.amount ?? 0), 0n);
  const outSum = parsed.outputs.reduce((a, o) => a + BigInt(o.value), 0n);
  const feeSompi = inSum - outSum;

  return {
    mode: "unsigned_safe_json",
    networkId: opts.network.id,
    kaspaNetwork: net,
    p2shAddress: p2sh.address,
    amountSompi: opts.amountSompi.toString(),
    changeAddress: opts.fromAddress,
    feeSompi: feeSompi.toString(),
    inputCount: parsed.inputs.length,
    outputCount: parsed.outputs.length,
    safeJson,
    kasware: {
      method: "signPskt",
      signInputs: sighashAllInputs(parsed.inputs.length),
      docs: "https://docs.kasware.xyz/wallet/developer-documentation/kaspa/kaspa-transaction",
      sourceCite: KASWARE_SOURCE_CITE,
    },
    summary:
      `Fund P2SH ${p2sh.address} with ${opts.amountSompi} sompi on ${net} ` +
      `(${parsed.inputs.length} inputs, fee ${feeSompi} sompi). ` +
      `KasWare: signPskt then pushTx (or pushPskt).`,
    walletHint: KASWARE_HINT,
  };
}

export async function prepareSpend(opts: {
  network: { id: string; isTestnet: boolean; rpcUrl?: string };
  loaded: LoadedArtifact;
  entryName: string;
  args: unknown[];
  p2shUtxo: {
    outpoint: { transactionId: string; index: number };
    amount: bigint | string;
    scriptPublicKey: { version: number; script: string };
    blockDaaScore?: bigint | string | number;
    isCoinbase?: boolean;
    address?: string;
  };
  destinationAddress: string;
  outputAmountSompi?: bigint;
  feeSompi?: bigint;
  /** Optional lockTime (ms) for timeout-path spends */
  lockTimeMs?: bigint;
  privateKeyHex?: string;
  /** Extra P2PK fee-funding UTXOs (same owner) — KasWare can signPskt these if unlock pre-filled on P2SH */
  feeFundingEntries?: unknown[];
}): Promise<PrepareSpendResult> {
  assertL1NetworkWritable(opts.network.isTestnet, opts.network.id);
  if (opts.privateKeyHex && !opts.network.isTestnet) {
    throw new Error("privateKey only allowed on testnet L1");
  }
  const kaspa = await loadKaspa();
  const net = kaspaNetworkId(opts.network);
  assertAddressNetwork(opts.destinationAddress, net);

  const entry = entryOf(opts.loaded, opts.entryName);
  const p2sh = await deriveP2shAddress(opts.loaded.bytecode, net);
  const inAmt = BigInt(opts.p2shUtxo.amount);
  const fee = opts.feeSompi ?? 300_000n;
  const outAmt = opts.outputAmountSompi ?? inAmt - fee;
  if (outAmt <= 0n) throw new Error("output amount must be positive (fee too high for this UTXO)");
  if (outAmt < MIN_CHANGE_SOMPI && outAmt !== inAmt - fee) {
    // allow exact escrow formulas
  }

  const utxo = {
    address: opts.p2shUtxo.address ?? p2sh.address,
    outpoint: opts.p2shUtxo.outpoint,
    amount: inAmt,
    scriptPublicKey: opts.p2shUtxo.scriptPublicKey,
    blockDaaScore: BigInt(opts.p2shUtxo.blockDaaScore ?? 0),
    isCoinbase: !!opts.p2shUtxo.isCoinbase,
  };

  const outSpk = kaspa.payToAddressScript(opts.destinationAddress);
  const lockTime = opts.lockTimeMs ?? 0n;

  const mkTx = (sigScript: string) =>
    new kaspa.Transaction({
      version: 0,
      inputs: [
        new kaspa.TransactionInput({
          previousOutpoint: utxo.outpoint,
          signatureScript: sigScript,
          sequence: 0n,
          sigOpCount: 1,
          utxo: utxo as never,
        }),
      ],
      outputs: [new kaspa.TransactionOutput(outAmt, outSpk)],
      lockTime,
      subnetworkId: SUBNETWORK,
      gas: 0n,
      payload: "",
    });

  const unsigned = mkTx("");
  const safeJson = unsigned.serializeToSafeJSON();
  // Verify KasWare can deserialize
  kaspa.Transaction.deserializeFromSafeJSON(safeJson);

  let signedSafeJson: string | undefined;
  let mode: PrepareSpendResult["mode"] = "unsigned_safe_json";

  if (opts.privateKeyHex) {
    const keyHex = opts.privateKeyHex.replace(/^0x/, "");
    const privateKey = new kaspa.PrivateKey(keyHex);
    const xonly = Buffer.from(privateKey.toPublicKey().toXOnlyPublicKey().toString(), "hex");
    const sigBytes = Buffer.from(
      String(kaspa.createInputSignature(unsigned, 0, privateKey)).replace(/^0x/, ""),
      "hex",
    );

    const filled = opts.args.map((a, i) => {
      const kind = entry.params[i]?.type.kind;
      if (a === null || a === undefined || a === "$sig" || a === "$signature") {
        if (kind !== "sig") throw new Error(`$sig placeholder on non-sig param ${entry.params[i]?.name}`);
        return sigBytes;
      }
      if (a === "$pk" || a === "$pubkey") {
        if (kind !== "pubkey") throw new Error(`$pk placeholder on non-pubkey param`);
        return xonly;
      }
      return a;
    });
    for (let i = 0; i < entry.params.length; i++) {
      if (entry.params[i]!.type.kind === "sig" && (filled[i] === "" || filled[i] == null)) filled[i] = sigBytes;
      if (entry.params[i]!.type.kind === "pubkey" && (filled[i] === "" || filled[i] == null)) filled[i] = xonly;
    }

    const unlock = buildEntryUnlock(entry, filled);
    const unlockHex = String(kaspa.payToScriptHashSignatureScript(opts.loaded.bytecode, unlock));
    const signed = mkTx(unlockHex);
    signedSafeJson = signed.serializeToSafeJSON();
    kaspa.Transaction.deserializeFromSafeJSON(signedSafeJson);
    mode = "signed_ready_for_pushTx";
  }

  return {
    mode,
    networkId: opts.network.id,
    kaspaNetwork: net,
    p2shAddress: p2sh.address,
    entry: opts.entryName,
    feeSompi: fee.toString(),
    outputAmountSompi: outAmt.toString(),
    safeJson,
    signedSafeJson,
    kasware: {
      method: mode === "signed_ready_for_pushTx" ? "pushTx" : "signPskt_then_pushTx",
      signInputs: [],
      docs: "https://docs.kasware.xyz/wallet/developer-documentation/kaspa/kaspa-transaction",
      sourceCite: KASWARE_SOURCE_CITE,
      note:
        mode === "signed_ready_for_pushTx"
          ? "Unlock filled. Broadcast with KasWare pushTx(signedSafeJson) or RpcClient.submitTransaction."
          : "SilverScript P2SH unlock is NOT filled by KasWare signPskt (wallet only signs owned P2PK inputs; " +
            "see KCC-20 docs). Fill unlock (testnet privateKey on this tool) then pushTx.",
    },
    summary:
      `Spend P2SH ${p2sh.address} entry "${opts.entryName}" → ${opts.destinationAddress} ` +
      `(${outAmt} sompi, fee ${fee} sompi) on ${net}.`,
    walletHint: KASWARE_HINT,
  };
}

/** Mimic KasWare signPskt for P2PK-funded SafeJSON (fund path). */
export async function mimicKaswareSignPskt(
  safeJson: string,
  privateKeyHex: string,
  signInputs?: Array<{ index: number; sighashType: number }>,
): Promise<string> {
  const kaspa = await loadKaspa();
  const key = new kaspa.PrivateKey(privateKeyHex.replace(/^0x/, ""));
  const tx = kaspa.Transaction.deserializeFromSafeJSON(safeJson);
  const indices =
    signInputs?.map((s) => s.index) ??
    Array.from({ length: tx.inputs.length }, (_, i) => i);
  for (const idx of indices) {
    const sig = kaspa.createInputSignature(tx, idx, key, kaspa.SighashType.All);
    // Standard P2PK unlock is the push-encoded signature from createInputSignature
    tx.inputs[idx]!.signatureScript = sig;
  }
  return tx.serializeToSafeJSON();
}

export async function submitSafeJson(
  safeJson: string,
  network: { id: string; isTestnet: boolean },
): Promise<string> {
  const kaspa = await loadKaspa();
  const net = kaspaNetworkId(network);
  const url =
    net === "testnet-10"
      ? process.env.KASPA_RPC_URL || "wss://electron-10.kaspa.blue/kaspa/testnet-10/wrpc/borsh"
      : process.env.KASPA_MAINNET_RPC_URL;
  if (!url) throw new Error("No wRPC URL for submit");
  const rpc = new kaspa.RpcClient({ url, encoding: kaspa.Encoding.Borsh, networkId: net });
  await rpc.connect();
  try {
    const tx = kaspa.Transaction.deserializeFromSafeJSON(safeJson);
    const res = await rpc.submitTransaction({ transaction: tx, allowOrphan: false });
    return (res as { transactionId?: string }).transactionId || String(res);
  } finally {
    try {
      await rpc.disconnect();
    } catch {
      /* ignore */
    }
  }
}

export { assertAddressNetwork, MIN_CHANGE_SOMPI as DUST_THRESHOLD_SOMPI };
