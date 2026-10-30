import { loadKaspa, assertL1NetworkWritable } from "./kaspa-sdk.js";
import { buildEntryUnlock, bytesToHex, hexToBytes } from "./script.js";
import type { LoadedArtifact } from "./artifact.js";
import { entryOf } from "./artifact.js";
import { deriveP2shAddress } from "./p2sh.js";

const SUBNETWORK = "0000000000000000000000000000000000000000";

export interface PrepareFundResult {
  mode: "unsigned_safe_json";
  networkId: string;
  p2shAddress: string;
  amountSompi: string;
  changeAddress: string;
  /** Transaction.serializeToSafeJSON — sign with KasWare signPskt / pushPskt */
  safeJson: string;
  summary: string;
  walletHint: string;
}

export interface PrepareSpendResult {
  mode: "unsigned_safe_json" | "signed_testnet_only";
  networkId: string;
  p2shAddress: string;
  entry: string;
  safeJson: string;
  summary: string;
  walletHint: string;
  /** Present only when testnet privateKey was used to finish the unlock script */
  signedSafeJson?: string;
}

const KASWARE_HINT =
  "KasWare: use window.kasware.signPskt({ txJsonString }) then pushTx, or pushPskt for sign+broadcast. " +
  "Pass SafeJSON from serializeToSafeJSON. Covenant-aware submit preserves bindings. " +
  "See https://docs.kasware.xyz/wallet/developer-documentation/kaspa/kaspa-transaction";

function kaspaNetworkId(network: { id: string; isTestnet: boolean }): string {
  if (network.id.includes("testnet-10") || network.id.includes("tn10")) return "testnet-10";
  if (network.isTestnet) return "testnet-10";
  return "mainnet";
}

export async function prepareFund(opts: {
  network: { id: string; isTestnet: boolean; explorerUrl?: string };
  bytecode: Uint8Array;
  fromAddress: string;
  amountSompi: bigint;
  /** Optional: priority fee in sompi */
  priorityFeeSompi?: bigint;
}): Promise<PrepareFundResult> {
  assertL1NetworkWritable(opts.network.isTestnet);
  const kaspa = await loadKaspa();
  const net = kaspaNetworkId(opts.network);
  const p2sh = await deriveP2shAddress(opts.bytecode, net);

  // Build a minimal unsigned payment template as SafeJSON for the wallet to complete
  // (select UTXOs / fees). We return the destination + amount + a skeleton summary.
  // Full UTXO selection without keys uses createTransactions only when entries provided —
  // here we emit a wallet-oriented payload.
  const skeleton = {
    network: net,
    outputs: [{ address: p2sh.address, amount: opts.amountSompi.toString() }],
    changeAddress: opts.fromAddress,
    priorityFeeSompi: (opts.priorityFeeSompi ?? 10000n).toString(),
  };

  return {
    mode: "unsigned_safe_json",
    networkId: opts.network.id,
    p2shAddress: p2sh.address,
    amountSompi: opts.amountSompi.toString(),
    changeAddress: opts.fromAddress,
    safeJson: JSON.stringify(skeleton),
    summary:
      `Fund L1 covenant P2SH ${p2sh.address} with ${opts.amountSompi} sompi on ${net}. ` +
      `No separate deploy step — sending KAS to this address activates the contract.`,
    walletHint: KASWARE_HINT,
  };
}

/**
 * Prepare a spend of a P2SH covenant UTXO.
 * If `privateKeyHex` is provided (testnet only), finishes signatureScript (for e2e).
 * Otherwise returns unsigned tx SafeJSON + unlock recipe for the wallet.
 */
export async function prepareSpend(opts: {
  network: { id: string; isTestnet: boolean };
  loaded: LoadedArtifact;
  entryName: string;
  /** ABI args matching entry params (hex strings for pubkey/sig/bytes; numbers for int) */
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
  /** Exact output amount; if omitted, input - feeSompi */
  outputAmountSompi?: bigint;
  feeSompi?: bigint;
  /** Testnet only — finishes Schnorr sig for params of kind `sig` that are omitted / null */
  privateKeyHex?: string;
}): Promise<PrepareSpendResult> {
  assertL1NetworkWritable(opts.network.isTestnet);
  if (opts.privateKeyHex && !opts.network.isTestnet) {
    throw new Error("privateKey only allowed on testnet L1");
  }
  const kaspa = await loadKaspa();
  const net = kaspaNetworkId(opts.network);
  const entry = entryOf(opts.loaded, opts.entryName);
  const p2sh = await deriveP2shAddress(opts.loaded.bytecode, net);
  const inAmt = BigInt(opts.p2shUtxo.amount);
  const fee = opts.feeSompi ?? 300000n;
  const outAmt = opts.outputAmountSompi ?? inAmt - fee;
  if (outAmt <= 0n) throw new Error("output amount must be positive (fee too high?)");

  const utxo = {
    address: opts.p2shUtxo.address ?? p2sh.address,
    outpoint: opts.p2shUtxo.outpoint,
    amount: inAmt,
    scriptPublicKey: opts.p2shUtxo.scriptPublicKey,
    blockDaaScore: BigInt(opts.p2shUtxo.blockDaaScore ?? 0),
    isCoinbase: !!opts.p2shUtxo.isCoinbase,
  };

  const outSpk = kaspa.payToAddressScript(opts.destinationAddress);
  const mkTx = (sigScript: string) =>
    new kaspa.Transaction({
      version: 0,
      inputs: [
        new kaspa.TransactionInput({
          previousOutpoint: utxo.outpoint,
          signatureScript: sigScript,
          sequence: 0n,
          sigOpCount: 1,
          // kaspa-wasm accepts plain UTXO entry objects at runtime
          utxo: utxo as never,
        }),
      ],
      outputs: [new kaspa.TransactionOutput(outAmt, outSpk)],
      lockTime: 0n,
      subnetworkId: SUBNETWORK,
      gas: 0n,
      payload: "",
    });

  const unsigned = mkTx("");
  const safeJson = unsigned.serializeToSafeJSON();

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

    // Fill sig / pubkey args: null/"$sig"/"$pk" placeholders
    const filled = opts.args.map((a, i) => {
      const kind = entry.params[i]?.type.kind;
      if (a === null || a === undefined || a === "$sig" || a === "$signature") {
        if (kind !== "sig") throw new Error(`placeholder $sig for non-sig param ${entry.params[i]?.name}`);
        return sigBytes;
      }
      if (a === "$pk" || a === "$pubkey") {
        if (kind !== "pubkey") throw new Error(`placeholder $pk for non-pubkey param`);
        return xonly;
      }
      return a;
    });

    // If a sig param was provided as empty, still inject
    for (let i = 0; i < entry.params.length; i++) {
      if (entry.params[i]!.type.kind === "sig" && (filled[i] === "" || filled[i] == null)) {
        filled[i] = sigBytes;
      }
      if (entry.params[i]!.type.kind === "pubkey" && (filled[i] === "" || filled[i] == null)) {
        filled[i] = xonly;
      }
    }

    const unlock = buildEntryUnlock(entry, filled);
    const unlockHex = String(kaspa.payToScriptHashSignatureScript(opts.loaded.bytecode, unlock));
    const signed = mkTx(unlockHex);
    signedSafeJson = signed.serializeToSafeJSON();
    mode = "signed_testnet_only";
  } else {
    // Document required args for wallet-side completion
    void buildEntryUnlock; // used when signing
  }

  return {
    mode,
    networkId: opts.network.id,
    p2shAddress: p2sh.address,
    entry: opts.entryName,
    safeJson,
    signedSafeJson,
    summary:
      `Spend P2SH ${p2sh.address} via entry "${opts.entryName}" → ${opts.destinationAddress} ` +
      `(${outAmt} sompi, fee budget ${fee} sompi) on ${net}.`,
    walletHint: KASWARE_HINT,
  };
}

export { KASWARE_HINT, buildEntryUnlock, hexToBytes, bytesToHex };
