/**
 * Pure-JS Kaspa tx build / SafeJSON / REST submit (Worker-safe).
 */
import {
  signInputSchnorr,
  payToScriptHashScript,
  payToScriptHashSignatureScript,
  p2shAddress,
  privateKeyToAddress,
  privateKeyToXonly,
  hexIdToBytes,
  SIG_HASH_ALL,
} from "./sign.js";
import { scriptPublicKeyFromAddress } from "./address.js";
import { bytesToHex, hexToBytes, concatBytes, encodePush, buildEntryUnlock } from "../script.js";
import type { LoadedArtifact } from "../artifact.js";
import { entryOf } from "../artifact.js";
import type { PureTx, PureInput, PureOutput } from "./sighash.js";
import { calcSchnorrSignatureHash } from "./sighash.js";

const NATIVE_SUBNET = new Uint8Array(20);
const MIN_FUND_SOMPI = 10_000_000n; // 0.1 KAS

export type RestUtxo = {
  address?: string;
  outpoint: { transactionId: string; index: number };
  amount: bigint;
  scriptPublicKey: { version: number; script: string };
  blockDaaScore?: bigint;
  isCoinbase?: boolean;
};

export function apiBase(networkId: "testnet-10" | "mainnet"): string {
  return networkId === "mainnet" ? "https://api.kaspa.org" : "https://api-tn10.kaspa.org";
}

export async function fetchUtxos(networkId: "testnet-10" | "mainnet", address: string): Promise<RestUtxo[]> {
  const url = `${apiBase(networkId)}/addresses/${encodeURIComponent(address)}/utxos`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`UTXO fetch HTTP ${res.status}`);
  const data = (await res.json()) as Array<{
    address?: string;
    outpoint: { transactionId: string; index: number };
    utxoEntry?: {
      amount: string | number;
      scriptPublicKey: { scriptPublicKey?: string; version?: number } | string;
      blockDaaScore?: string | number;
      isCoinbase?: boolean;
    };
    amount?: string | number;
    scriptPublicKey?: { scriptPublicKey?: string; version?: number } | string;
    blockDaaScore?: string | number;
    isCoinbase?: boolean;
  }>;
  return (data ?? []).map((row) => {
    const entry = row.utxoEntry ?? row;
    const spkRaw = entry.scriptPublicKey ?? { scriptPublicKey: "", version: 0 };
    let script = "";
    let version = 0;
    if (typeof spkRaw === "string") script = spkRaw;
    else {
      script = spkRaw.scriptPublicKey ?? (spkRaw as { script?: string }).script ?? "";
      version = spkRaw.version ?? 0;
    }
    // Strip version prefix if present (0000…)
    if (script.startsWith("0000") && script.length > 4) {
      // keep as-is for SafeJSON which uses versioned form in some paths; our SPK uses bare
      const bare = script.slice(4);
      if (bare.length >= 66) script = bare;
    }
    return {
      address: row.address ?? address,
      outpoint: row.outpoint,
      amount: BigInt(entry.amount as string | number),
      scriptPublicKey: { version, script },
      blockDaaScore: BigInt(entry.blockDaaScore ?? 0),
      isCoinbase: !!(entry as { isCoinbase?: boolean }).isCoinbase,
    };
  });
}

function spkBytes(spk: { version: number; script: string }): { version: number; script: Uint8Array } {
  let script = spk.script;
  if (script.startsWith("0000") && script.length >= 70) script = script.slice(4);
  return { version: spk.version, script: hexToBytes(script) };
}

export function buildPureTx(opts: {
  inputs: Array<{ utxo: RestUtxo; sequence?: bigint; sigOpCount?: number }>;
  outputs: Array<{ address: string; amount: bigint }>;
  lockTime?: bigint;
}): PureTx {
  return {
    version: 0,
    inputs: opts.inputs.map(({ utxo, sequence, sigOpCount }) => ({
      previousOutpoint: {
        transactionId: hexIdToBytes(utxo.outpoint.transactionId),
        index: utxo.outpoint.index,
      },
      sequence: sequence ?? 0n,
      sigOpCount: sigOpCount ?? 1,
      utxo: {
        amount: utxo.amount,
        scriptPublicKey: spkBytes(utxo.scriptPublicKey),
      },
    })),
    outputs: opts.outputs.map((o) => {
      const spk = scriptPublicKeyFromAddress(o.address);
      return {
        value: o.amount,
        scriptPublicKey: { version: spk.version, script: hexToBytes(spk.script) },
        covenant: null,
      };
    }),
    lockTime: opts.lockTime ?? 0n,
    subnetworkId: NATIVE_SUBNET.slice(),
    gas: 0n,
    payload: new Uint8Array(0),
  };
}

/** KasWare-compatible SafeJSON (unsigned or signed). */
export function toSafeJson(tx: PureTx, signatureScripts: string[]): string {
  const inputs = tx.inputs.map((inp, i) => {
    const txid = bytesToHex(inp.previousOutpoint.transactionId);
    const scriptHex = bytesToHex(inp.utxo.scriptPublicKey.script);
    // SafeJSON often stores version-prefixed scriptPublicKey string
    const spkStr =
      inp.utxo.scriptPublicKey.version === 0
        ? `0000${scriptHex}`
        : `${inp.utxo.scriptPublicKey.version.toString(16).padStart(4, "0")}${scriptHex}`;
    return {
      transactionId: txid,
      index: inp.previousOutpoint.index,
      sequence: inp.sequence.toString(),
      sigOpCount: inp.sigOpCount,
      computeBudget: 0,
      signatureScript: signatureScripts[i] ?? "",
      utxo: {
        amount: inp.utxo.amount.toString(),
        scriptPublicKey: spkStr,
        blockDaaScore: "0",
        isCoinbase: false,
      },
    };
  });
  const outputs = tx.outputs.map((o) => ({
    value: o.value.toString(),
    scriptPublicKey: `0000${bytesToHex(o.scriptPublicKey.script)}`,
  }));
  // id left empty — node recomputes; for differential we compare signed fields
  return JSON.stringify({
    id: "0000000000000000000000000000000000000000000000000000000000000000",
    version: tx.version,
    inputs,
    outputs,
    subnetworkId: bytesToHex(tx.subnetworkId),
    lockTime: tx.lockTime.toString(),
    gas: tx.gas.toString(),
    payload: "",
  });
}

export function toSubmitModel(tx: PureTx, signatureScripts: string[]) {
  return {
    version: tx.version,
    inputs: tx.inputs.map((inp, i) => ({
      previousOutpoint: {
        transactionId: bytesToHex(inp.previousOutpoint.transactionId),
        index: inp.previousOutpoint.index,
      },
      signatureScript: signatureScripts[i] ?? "",
      sequence: Number(inp.sequence),
      sigOpCount: inp.sigOpCount,
    })),
    outputs: tx.outputs.map((o) => ({
      amount: Number(o.value),
      scriptPublicKey: {
        version: o.scriptPublicKey.version,
        scriptPublicKey: bytesToHex(o.scriptPublicKey.script),
      },
    })),
    lockTime: Number(tx.lockTime),
    subnetworkId: bytesToHex(tx.subnetworkId),
  };
}

export type SubmitConfirmMeta = {
  confirmed: boolean;
  status: string;
  explorer: string;
  recoveredFromSubmitRace?: boolean;
  detail?: string;
};

/**
 * Submit via REST, then poll until accepted (or recover reject-but-landed races).
 * Returns txid; attach confirmation on the returned object via submitTxRestDetailed when needed.
 */
export async function submitTxRest(
  networkId: "testnet-10" | "mainnet",
  tx: PureTx,
  signatureScripts: string[],
): Promise<string> {
  const detailed = await submitTxRestDetailed(networkId, tx, signatureScripts);
  return detailed.txid;
}

export async function submitTxRestDetailed(
  networkId: "testnet-10" | "mainnet",
  tx: PureTx,
  signatureScripts: string[],
): Promise<{ txid: string; confirmation: SubmitConfirmMeta }> {
  const { confirmTransaction, extractTxidFromMessage, isLikelySubmitRaceError, explorerTxUrl } =
    await import("../confirm.js");
  const body = {
    transaction: toSubmitModel(tx, signatureScripts),
    // Testnet: brief propagation lag between REST nodes; allow orphan so chained funds settle.
    allowOrphan: networkId !== "mainnet",
  };
  let submitError: string | undefined;
  let txid: string | undefined;
  try {
    const res = await fetch(`${apiBase(networkId)}/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { transactionId?: string; error?: string; detail?: string };
    txid = json.transactionId?.toLowerCase();
    if (!res.ok || json.error) {
      submitError = json.error || json.detail || `submit HTTP ${res.status}`;
      if (!txid) txid = extractTxidFromMessage(submitError);
    }
  } catch (e) {
    submitError = e instanceof Error ? e.message : String(e);
    txid = extractTxidFromMessage(submitError);
  }

  if (!txid) {
    throw new Error(submitError || "submit missing transactionId");
  }

  let conf = await confirmTransaction(networkId, txid);
  // Orphan / reject races: indexer may lag — one extra confirm window before failing.
  if (
    submitError &&
    isLikelySubmitRaceError(submitError) &&
    conf.status === "not_found"
  ) {
    await new Promise((r) => setTimeout(r, 2000));
    conf = await confirmTransaction(networkId, txid, { timeoutMs: 10_000 });
  }
  if (conf.isAccepted) {
    return {
      txid,
      confirmation: {
        confirmed: true,
        status: conf.status,
        explorer: conf.explorer,
        recoveredFromSubmitRace: Boolean(submitError),
        detail: submitError
          ? `Submit reported: ${submitError} — REST later showed accepted`
          : undefined,
      },
    };
  }

  // Submit looked OK but not yet accepted — still return txid with pending meta when no hard error
  if (!submitError) {
    return {
      txid,
      confirmation: {
        confirmed: false,
        status: conf.status,
        explorer: conf.explorer,
        detail: conf.detail,
      },
    };
  }

  // Submit failed; only recover if REST found the tx (pending or accepted) on a race-like error
  if (isLikelySubmitRaceError(submitError) && (conf.status === "pending" || conf.status === "accepted")) {
    return {
      txid,
      confirmation: {
        confirmed: conf.isAccepted,
        status: conf.status,
        explorer: conf.explorer,
        recoveredFromSubmitRace: true,
        detail: `Submit reported: ${submitError} — REST shows ${conf.status}`,
      },
    };
  }

  throw new Error(
    `${submitError} (confirm=${conf.status}; ${explorerTxUrl(networkId, txid)})`,
  );
}

/** Wait until REST shows UTXOs (bridges wRPC-fund → REST-submit lag). */
export async function waitForRestUtxos(
  networkId: "testnet-10" | "mainnet",
  address: string,
  minSompi: bigint,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<bigint> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const intervalMs = opts?.intervalMs ?? 800;
  const start = Date.now();
  let last = 0n;
  while (Date.now() - start < timeoutMs) {
    const utxos = await fetchUtxos(networkId, address);
    last = utxos.reduce((a, u) => a + u.amount, 0n);
    if (last >= minSompi) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`REST UTXO wait timeout for ${address}: have ${last}, need ${minSompi}`);
}

/** Select UTXOs + build + sign P2PK payment (fund or withdraw). */
export async function buildAndSignPayment(opts: {
  networkId: "testnet-10" | "mainnet";
  privateKeyHex: string;
  outputs: Array<{ address: string; amount: bigint }>;
  priorityFeeSompi?: bigint;
  changeAddress?: string;
  /** Internal: orphan rebuild attempts (max 1 retry). */
  _orphanAttempt?: number;
}): Promise<{
  tx: PureTx;
  signatureScripts: string[];
  txid: string;
  safeJson: string;
  confirmation: SubmitConfirmMeta;
}> {
  const from = privateKeyToAddress(opts.privateKeyHex, opts.networkId);
  const utxos = await fetchUtxos(opts.networkId, from);
  if (!utxos.length) throw new Error(`No UTXOs at ${from}`);

  const fee = opts.priorityFeeSompi ?? 500_000n; // ≥ TN10 compute-mass minimum for typical 1-in/2-out
  const outSum = opts.outputs.reduce((a, o) => a + o.amount, 0n);
  const need = outSum + fee;
  const selected: RestUtxo[] = [];
  let total = 0n;
  for (const u of utxos.sort((a, b) => (a.amount < b.amount ? 1 : -1))) {
    selected.push(u);
    total += u.amount;
    if (total >= need) break;
  }
  if (total < need) throw new Error(`Insufficient funds: have ${total}, need ${need}`);

  const change = total - need;
  const outputs = [...opts.outputs];
  const changeAddr = opts.changeAddress ?? from;
  if (change >= 1000n) outputs.push({ address: changeAddr, amount: change });

  const tx = buildPureTx({
    inputs: selected.map((u) => ({ utxo: u })),
    outputs,
  });
  const signatureScripts = tx.inputs.map((_, i) => bytesToHex(signInputSchnorr(tx, i, opts.privateKeyHex)));
  try {
    const { txid, confirmation } = await submitTxRestDetailed(opts.networkId, tx, signatureScripts);
    return { tx, signatureScripts, txid, safeJson: toSafeJson(tx, signatureScripts), confirmation };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const attempt = opts._orphanAttempt ?? 0;
    if (attempt >= 1 || !/orphan/i.test(msg)) throw e;
    // REST node lagged on parent UTXO — wait, refetch, rebuild once.
    await new Promise((r) => setTimeout(r, 3000));
    return buildAndSignPayment({ ...opts, _orphanAttempt: attempt + 1 });
  }
}

export async function fundP2sh(opts: {
  networkId: "testnet-10" | "mainnet";
  privateKeyHex: string;
  redeemBytecode: Uint8Array;
  amountSompi: bigint;
  priorityFeeSompi?: bigint;
}): Promise<{ txid: string; p2shAddress: string; amountSompi: string; confirmation: SubmitConfirmMeta }> {
  if (opts.amountSompi < MIN_FUND_SOMPI) {
    throw new Error(`amount below MIN_FUND_SOMPI ${MIN_FUND_SOMPI}`);
  }
  const p2sh = p2shAddress(opts.redeemBytecode, opts.networkId);
  const { txid, confirmation } = await buildAndSignPayment({
    networkId: opts.networkId,
    privateKeyHex: opts.privateKeyHex,
    outputs: [{ address: p2sh, amount: opts.amountSompi }],
    priorityFeeSompi: opts.priorityFeeSompi,
  });
  return { txid, p2shAddress: p2sh, amountSompi: opts.amountSompi.toString(), confirmation };
}

export async function spendP2sh(opts: {
  networkId: "testnet-10" | "mainnet";
  privateKeyHex: string;
  loaded: LoadedArtifact;
  entryName: string;
  args: unknown[];
  destinationAddress: string;
  p2shUtxo: RestUtxo;
  feeSompi?: bigint;
}): Promise<{ txid: string; p2shAddress: string; confirmation: SubmitConfirmMeta }> {
  const fee = opts.feeSompi ?? 500_000n;
  const inAmt = opts.p2shUtxo.amount;
  const outAmt = inAmt - fee;
  if (outAmt <= 0n) throw new Error("fee too high");
  const p2sh = p2shAddress(opts.loaded.bytecode, opts.networkId);

  const tx = buildPureTx({
    inputs: [{ utxo: opts.p2shUtxo, sigOpCount: 1 }],
    outputs: [{ address: opts.destinationAddress, amount: outAmt }],
  });

  // Sign as if empty unlock first (sighash uses UTXO scriptPublicKey = P2SH, not redeem)
  const sigFrag = signInputSchnorr(tx, 0, opts.privateKeyHex);
  const xonly = privateKeyToXonly(opts.privateKeyHex);
  const entry = entryOf(opts.loaded, opts.entryName);
  const filled = opts.args.map((a, i) => {
    const kind = entry.params[i]?.type.kind;
    if (a === null || a === undefined || a === "$sig" || a === "$signature") {
      if (kind === "sig") return sigFrag;
      if (kind === "pubkey") return xonly;
      throw new Error(`null on non-sig/pubkey ${entry.params[i]?.name}`);
    }
    if (a === "$pk" || a === "$pubkey") return xonly;
    if (a === "$sig" || a === "$signature") return sigFrag;
    return a;
  });
  for (let i = 0; i < entry.params.length; i++) {
    if (entry.params[i]!.type.kind === "sig" && (filled[i] == null || filled[i] === "")) filled[i] = sigFrag;
    if (entry.params[i]!.type.kind === "pubkey" && (filled[i] == null || filled[i] === "")) filled[i] = xonly;
  }
  const unlock = buildEntryUnlock(entry, filled);
  const sigScript = payToScriptHashSignatureScript(opts.loaded.bytecode, unlock);
  const { txid, confirmation } = await submitTxRestDetailed(opts.networkId, tx, [bytesToHex(sigScript)]);
  return { txid, p2shAddress: p2sh, confirmation };
}

export { calcSchnorrSignatureHash, payToScriptHashScript, privateKeyToAddress, privateKeyToXonly };
