/**
 * Browser L1 fund/spend builder using official kaspa-wasm web build
 * at /kaspa-wasm/ (Workers static asset; not in Worker script size).
 *
 * Spend / TipJar withdraw (one KasWare approval):
 * 1) Build unsigned P2SH spend SafeJSON
 * 2) kasware.signPskt({ signInputs:[{index:0,sighashType:1}] }) — wallet signs the
 *    input sighash with the account key even when the UTXO is P2SH
 *    (kasware-wallet/extension wallet.ts signPskt → walletSignTransaction →
 *    signSchnorrTransaction with verifySig=false; docs claim "only owned P2PK"
 *    but source signs the requested indices with the account pubkey)
 * 3) Extract signatureScript, wrap SilverScript unlock (pk + sig + dispatch + redeem)
 *    via payToScriptHashSignatureScript, then pushTx
 * signMessage is NOT used (not a transaction sighash).
 */
import init, {
  createTransactions,
  PrivateKey,
  Transaction,
  createInputSignature,
  payToScriptHashSignatureScript,
  payToScriptHashScript,
  payToAddressScript,
  addressFromScriptPublicKey,
  SighashType,
  RpcClient,
  Encoding,
} from "/kaspa-wasm/kaspa.js";

let ready;
export async function ensureKaspa() {
  if (!ready) ready = init({ module_or_path: "/kaspa-wasm/kaspa_bg.wasm" });
  await ready;
}

function hexToBytes(hex) {
  const h = String(hex).replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function encodePush(data) {
  const d = data instanceof Uint8Array ? data : hexToBytes(data);
  if (d.length < 0x4c) {
    const o = new Uint8Array(1 + d.length);
    o[0] = d.length;
    o.set(d, 1);
    return o;
  }
  if (d.length <= 0xff) {
    const o = new Uint8Array(2 + d.length);
    o[0] = 0x4c;
    o[1] = d.length;
    o.set(d, 2);
    return o;
  }
  throw new Error("push too large");
}

function buildEntryUnlock(entry, filled) {
  const parts = [];
  for (let i = 0; i < entry.params.length; i++) {
    const kind = entry.params[i].type.kind;
    const v = filled[i];
    if (kind === "sig") {
      const raw = typeof v === "string" ? hexToBytes(v.replace(/^0x/, "")) : v;
      // createInputSignature / KasWare signPskt → [0x41][64 sig][sighash] already pushed
      parts.push(raw);
    } else if (kind === "pubkey" || kind === "bytes") {
      parts.push(encodePush(v instanceof Uint8Array ? v : hexToBytes(String(v))));
    } else {
      throw new Error("unsupported param " + kind);
    }
  }
  const tag = hexToBytes(entry.dispatch_tag);
  if (tag.length !== 4) throw new Error("dispatch_tag must be 4 bytes");
  parts.push(encodePush(tag));
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Normalize compressed (33) or x-only (32) pubkey hex → 32-byte x-only. */
export function toXOnlyHex(pubHex) {
  const h = String(pubHex).replace(/^0x/, "").toLowerCase();
  if (h.length === 64) return h;
  if (h.length === 66 && (h.startsWith("02") || h.startsWith("03"))) return h.slice(2);
  throw new Error("expected 32-byte x-only or 33-byte compressed pubkey, got len " + h.length / 2);
}

async function fetchUtxos(apiBase, address) {
  const url = apiBase.replace(/\/$/, "") + "/addresses/" + encodeURIComponent(address) + "/utxos";
  const res = await fetch(url);
  if (!res.ok) throw new Error("UTXO fetch HTTP " + res.status + " from " + url);
  const data = await res.json();
  const list = Array.isArray(data) ? data : data.utxos || [];
  return list.map((u) => {
    const entry = u.utxoEntry || u.entry || u.utxo || u;
    const outpoint = u.outpoint || {
      transactionId: entry.transaction_id || entry.transactionId,
      index: entry.index,
    };
    let spkRaw = entry.scriptPublicKey ?? entry.script_public_key ?? "";
    let script = "";
    let version = 0;
    if (typeof spkRaw === "string") script = spkRaw;
    else if (spkRaw && typeof spkRaw === "object") {
      script = spkRaw.scriptPublicKey || spkRaw.script || "";
      version = spkRaw.version ?? 0;
    }
    script = String(script).replace(/^0x/, "");
    const scriptPublicKey = { version, script };
    return {
      address,
      outpoint: {
        transactionId: String(outpoint.transactionId || outpoint.transaction_id),
        index: Number(outpoint.index),
      },
      amount: BigInt(entry.amount ?? 0),
      scriptPublicKey,
      blockDaaScore: BigInt(entry.blockDaaScore ?? entry.block_daa_score ?? 0),
      isCoinbase: !!(entry.isCoinbase ?? entry.is_coinbase),
    };
  });
}

function formatKas(sompi) {
  const n = BigInt(sompi);
  const whole = n / 100_000_000n;
  const frac = (n % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? whole + "." + frac : String(whole);
}

function isP2shSpk(spk) {
  const s = String(spk).replace(/^0x/, "").toLowerCase();
  return s.includes("aa20") && /87$/.test(s);
}

export async function buildFundTx(build) {
  await ensureKaspa();
  const net = build.kaspaNetwork;
  const amount = BigInt(build.amountSompi);
  if (amount < 10_000_000n) throw new Error("amount below 0.1 KAS MIN_FUND");
  const entries = await fetchUtxos(build.utxoApiBase, build.fromAddress);
  if (!entries.length) throw new Error("No UTXOs for " + build.fromAddress);

  const redeem = hexToBytes(build.bytecodeHex);
  const p2shScript = payToScriptHashScript(redeem);
  const p2shAddr = addressFromScriptPublicKey(p2shScript, net).toString();
  const expected = (build.expectedP2shAddress || "").trim();
  if (expected && expected.toLowerCase() !== p2shAddr.toLowerCase()) {
    throw new Error(
      "SECURITY: computed P2SH " +
        p2shAddr +
        " does not match expected contract " +
        expected +
        ". Refusing to build — do not approve. Re-prepare fund with the owner-bound tipjar.",
    );
  }

  const { transactions, summary } = await createTransactions({
    entries,
    outputs: [{ address: p2shAddr, amount }],
    changeAddress: build.fromAddress,
    priorityFee: BigInt(build.priorityFeeSompi || 0),
    networkId: net,
  });
  const pending = transactions[0];
  if (!pending) throw new Error("createTransactions returned no tx");
  const tx = pending.transaction;
  const safeJson = tx.serializeToSafeJSON();
  return {
    safeJson,
    signInputs: Array.from({ length: tx.inputs.length }, (_, i) => ({ index: i, sighashType: 1 })),
    p2shAddress: p2shAddr,
    feeSompi: String(summary?.fees ?? ""),
    mode: "unsigned_safe_json",
  };
}

function normalizeSpk(spkObj) {
  let script = String(spkObj.script || spkObj.scriptPublicKey || "").replace(/^0x/, "");
  const version = spkObj.version ?? 0;
  if (version === 0 && !script.startsWith("0000")) {
    script = "0000" + script;
  }
  return { script, version };
}

/** Single or multi P2SH inputs for spend/claim. */
function spendInputsOf(build) {
  const fee = BigInt(build.feeSompi || 300000);
  const sigOpDefault = Number(build.sigOpCount || 1);
  if (Array.isArray(build.p2shInputs) && build.p2shInputs.length) {
    const inputs = build.p2shInputs.map((row, i) => {
      const amount = BigInt(row.amount);
      const { script } = normalizeSpk(row.scriptPublicKey || {});
      return {
        index: i,
        amount,
        utxo: {
          outpoint: row.outpoint,
          amount,
          scriptPublicKey: script,
          blockDaaScore: 0n,
          isCoinbase: false,
        },
        bytecodeHex: row.bytecodeHex || build.bytecodeHex,
        dispatchTag: row.dispatchTag || build.dispatchTag,
        sigOpCount: Number(row.sigOpCount || sigOpDefault),
        expectedP2shAddress: row.expectedP2shAddress,
      };
    });
    const inAmt = inputs.reduce((a, x) => a + x.amount, 0n);
    const outAmt = BigInt(build.outputAmountSompi || inAmt - fee);
    return { fee, inAmt, outAmt, inputs };
  }
  if (!build.p2shUtxo) throw new Error("Missing p2shUtxo / p2shInputs");
  const inAmt = BigInt(build.p2shUtxo.amount);
  const outAmt = BigInt(build.outputAmountSompi || inAmt - fee);
  const { script } = normalizeSpk(build.p2shUtxo.scriptPublicKey || {});
  const inputs = [
    {
      index: 0,
      amount: inAmt,
      utxo: {
        outpoint: build.p2shUtxo.outpoint,
        amount: inAmt,
        scriptPublicKey: script,
        blockDaaScore: 0n,
        isCoinbase: false,
      },
      bytecodeHex: build.bytecodeHex,
      dispatchTag: build.dispatchTag,
      sigOpCount: sigOpDefault,
      expectedP2shAddress: build.expectedP2shAddress,
    },
  ];
  return { fee, inAmt, outAmt, inputs };
}

function mkSpendTx(inputs, outAmt, destinationAddress, sigScripts, lockTimeMs) {
  const outSpk = payToAddressScript(destinationAddress);
  const lockTime = lockTimeMs != null && lockTimeMs !== "" ? BigInt(lockTimeMs) : 0n;
  return new Transaction({
    version: 0,
    inputs: inputs.map((inp, i) => ({
      previousOutpoint: inp.utxo.outpoint,
      signatureScript: (sigScripts && sigScripts[i]) || "",
      sequence: 0n,
      sigOpCount: inp.sigOpCount || 1,
      utxo: inp.utxo,
    })),
    outputs: [{ value: outAmt, scriptPublicKey: outSpk }],
    lockTime,
    subnetworkId: "0000000000000000000000000000000000000000",
    gas: 0n,
    payload: "",
  });
}

/**
 * Unsigned P2SH spend for KasWare signPskt (sighash) then finalizeCovenantSpend.
 * Supports multi-input AoN claim (p2shInputs).
 */
export async function buildSpendTx(build) {
  await ensureKaspa();
  const { fee, outAmt, inputs } = spendInputsOf(build);
  if (outAmt <= 0n) throw new Error("fee too high for spend amount");
  const unsigned = mkSpendTx(inputs, outAmt, build.destinationAddress, null, build.lockTimeMs);
  const safeJson = unsigned.serializeToSafeJSON();
  const base = {
    safeJson,
    signInputs: inputs.map((_, i) => ({ index: i, sighashType: 1 })),
    mode: "unsigned_needs_wallet_sig",
    note:
      inputs.length > 1
        ? "Approve once: wallet signs all " + inputs.length + " pledge inputs; this page wraps each covenant unlock and broadcasts."
        : "Approve once in KasWare: signPskt produces the Schnorr sighash signature; this page wraps the SilverScript unlock and pushTx.",
    feeSompi: String(fee),
    outputAmountSompi: String(outAmt),
    inputCount: inputs.length,
  };

  const entryParams = build.entryParams || [];
  const needsSig = entryParams.some((p) => p.type && p.type.kind === "sig");
  if (!needsSig) {
    const xonlyArg = (build.args || []).find((a) => typeof a === "string" && /^[0-9a-fA-F]{64}$/i.test(String(a).replace(/^0x/, "")));
    const finalized = await finalizeCovenantSpend(build, safeJson, {
      signatureScriptHex: "00",
      xonlyPubkeyHex: xonlyArg || "00".repeat(32),
    });
    return { ...base, ...finalized, mode: "signed_ready_for_pushTx", note: "Permissionless reclaim — Approve broadcasts only (no signature required)." };
  }

  const testKey = typeof globalThis !== "undefined" ? globalThis.__SIGN_TEST_KEY__ : null;
  if (!testKey || !globalThis.__SIGN_PREFILL_UNLOCK__) return base;

  const key = new PrivateKey(String(testKey).replace(/^0x/, ""));
  const xonlyHex = key.toPublicKey().toXOnlyPublicKey().toString();
  // Prefill: sign every input, then finalize (test harness)
  const partial = JSON.parse(safeJson);
  for (let i = 0; i < inputs.length; i++) {
    partial.inputs[i].signatureScript = String(createInputSignature(unsigned, i, key, SighashType.All)).replace(/^0x/, "");
  }
  const finalized = await finalizeCovenantSpend(build, JSON.stringify(partial), {
    xonlyPubkeyHex: xonlyHex,
  });
  return { ...base, ...finalized, mode: "signed_ready_for_pushTx" };
}

/**
 * After wallet signPskt on the unsigned P2SH spend, wrap unlock + redeem per input.
 * Multi-input: each input uses its own bytecodeHex (AoN backer window) and its own sighash sig.
 */
export async function finalizeCovenantSpend(build, partialSignedSafeJson, opts) {
  await ensureKaspa();
  const { fee, outAmt, inputs } = spendInputsOf(build);
  const parsed = JSON.parse(partialSignedSafeJson);
  const entryBase = { dispatch_tag: build.dispatchTag, params: build.entryParams || [] };
  const needsSig = (entryBase.params || []).some((p) => p.type && p.type.kind === "sig");
  const xonlyHexOpt =
    opts.xonlyPubkeyHex ||
    (build.args || []).find((a) => typeof a === "string" && /^[0-9a-fA-F]{64}$/.test(String(a).replace(/^0x/, "")));
  const xonly = hexToBytes(toXOnlyHex(xonlyHexOpt || opts.xonlyPubkeyHex || "00".repeat(32)));

  const unlockHexes = [];
  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i];
    const entry = {
      dispatch_tag: inp.dispatchTag || build.dispatchTag,
      params: build.entryParams || [],
    };
    let sigHex = "";
    if (opts.signatureScriptHex && inputs.length === 1) {
      sigHex = String(opts.signatureScriptHex).replace(/^0x/, "");
    } else {
      sigHex = String(parsed.inputs?.[i]?.signatureScript || "").replace(/^0x/, "");
    }
    if (needsSig && !sigHex) {
      throw new Error("No signatureScript on input " + i + " from wallet — cannot unlock covenant");
    }
    const sigBytes = sigHex && sigHex !== "00" ? hexToBytes(sigHex) : new Uint8Array(0);
    const filled = (build.args || []).map((a, pi) => {
      const kind = entry.params[pi]?.type?.kind;
      if (a === "$sig" || a === "$signature" || (a == null && kind === "sig")) return sigBytes;
      if (a === "$pk" || a === "$pubkey" || (a == null && kind === "pubkey")) return xonly;
      if (typeof a === "string" && kind === "pubkey") return hexToBytes(toXOnlyHex(a));
      return a;
    });
    for (let pi = 0; pi < entry.params.length; pi++) {
      if (entry.params[pi].type.kind === "sig" && !filled[pi]) filled[pi] = sigBytes;
      if (entry.params[pi].type.kind === "pubkey" && !filled[pi]) filled[pi] = xonly;
    }
    const unlock = buildEntryUnlock(entry, filled);
    const redeem = hexToBytes(inp.bytecodeHex);
    unlockHexes.push(String(payToScriptHashSignatureScript(redeem, unlock)));
  }

  const signed = mkSpendTx(inputs, outAmt, build.destinationAddress, unlockHexes, build.lockTimeMs);
  return {
    safeJson: partialSignedSafeJson,
    signedSafeJson: signed.serializeToSafeJSON(),
    mode: "signed_ready_for_pushTx",
    feeSompi: String(fee),
    outputAmountSompi: String(outAmt),
    inputCount: inputs.length,
  };
}

/**
 * Plain-English summary derived only from SafeJSON + session labels (not agent text amounts).
 */
export function summarizeBuiltSafeJson(safeJson, opts) {
  const tx = JSON.parse(safeJson);
  let inSum = 0n;
  for (const inp of tx.inputs || []) {
    if (inp.utxo?.amount != null) inSum += BigInt(inp.utxo.amount);
  }
  let outSum = 0n;
  const detailLines = [];
  const plainLines = [];
  const contract = opts.contractName || opts.templateId || "";
  const isFund = opts.kind === "l1-fund";
  const isSpend = opts.kind === "l1-spend";

  (tx.outputs || []).forEach((o, i) => {
    const v = BigInt(o.value || 0);
    outSum += v;
    const spk = String(o.scriptPublicKey || "");
    const p2sh = isP2shSpk(spk);
    detailLines.push({
      label: "Output " + i + (p2sh ? " (P2SH covenant)" : " (P2PK/address)"),
      value: formatKas(v) + " KAS",
    });
    if (isFund && p2sh) {
      plainLines.push({
        label: "Send",
        value: formatKas(v) + " KAS to " + (contract || "covenant"),
      });
    } else if (isFund && !p2sh) {
      plainLines.push({ label: "Change back to you", value: formatKas(v) + " KAS" });
    } else if (isSpend) {
      plainLines.push({
        label: i === 0 ? "Withdraw to you" : "Output " + i,
        value: formatKas(v) + " KAS",
      });
    }
  });

  const fee = inSum > 0n ? inSum - outSum : 0n;
  if (inSum > 0n) {
    plainLines.push({ label: "Fee", value: formatKas(fee) + " KAS" });
    detailLines.push({ label: "Fee (inputs − outputs)", value: formatKas(fee) + " KAS" });
    detailLines.push({ label: "Input total", value: formatKas(inSum) + " KAS" });
  }

  let title;
  if (isFund && /tipjar/i.test(contract)) title = "Send " + (plainLines[0] ? plainLines[0].value.replace(/ to .*/, "") : "KAS") + " to Tip Jar";
  else if (isFund) title = "Fund " + (contract || "covenant");
  else if (isSpend && /tipjar/i.test(contract)) title = "Withdraw from Tip Jar";
  else if (isSpend) title = "Spend " + (contract || "covenant");
  else title = opts.title || "Approve transaction";

  // Prefer explicit plain headline from first fund P2SH amount
  if (isFund) {
    const p2shOut = (tx.outputs || []).find((o) => isP2shSpk(String(o.scriptPublicKey || "")));
    if (p2shOut) {
      const name = /tipjar/i.test(contract) ? "Tip Jar" : contract || "covenant";
      title = "Send " + formatKas(p2shOut.value) + " KAS to " + name;
    }
  }
  if (isSpend && /tipjar/i.test(contract)) {
    title = "Withdraw from Tip Jar";
  }

  const warnings = [];
  if (opts.isMainnet) {
    warnings.push(
      "MAINNET: UNAUDITED / USE AT YOUR OWN RISK. Review every output in your wallet popup. This page never sees your keys.",
    );
  }

  const dest = opts.destinationAddress || (isFund ? opts.p2shAddress : null);
  if (dest) {
    // Destination is safety-critical — show first in the plain summary (not buried in Details).
    plainLines.unshift({ label: "Destination (verify)", value: dest });
    detailLines.push({ label: "Destination", value: dest });
  }
  detailLines.unshift({ label: "Network", value: opts.networkLabel });
  if (contract) detailLines.unshift({ label: "Contract", value: contract });
  if (opts.p2shAddress) detailLines.push({ label: "P2SH", value: opts.p2shAddress });
  if (opts.entryName) detailLines.push({ label: "Entry", value: opts.entryName });

  return {
    title,
    plainLines,
    lines: detailLines,
    warnings,
    networkBadge: opts.isMainnet ? "Mainnet" : "Testnet",
    contractName: contract || null,
    primaryAction: isSpend && /tipjar/i.test(contract) ? "Withdraw" : isSpend ? "Approve spend" : "Approve",
  };
}


/** Broadcast a fully signed SafeJSON via public wRPC (for wallets without pushTx, e.g. Kastle). */
export async function submitSignedTx(safeJson, kaspaNetwork) {
  await ensureKaspa();
  const net = kaspaNetwork || "testnet-10";
  const url =
    net === "mainnet"
      ? "wss://protonet.aspectron.org/kaspa/mainnet/wrpc/borsh"
      : "wss://electron-10.kaspa.blue/kaspa/testnet-10/wrpc/borsh";
  const tx = Transaction.deserializeFromSafeJSON(safeJson);
  const rpc = new RpcClient({ url, encoding: Encoding.Borsh, networkId: net });
  await rpc.connect();
  try {
    const res = await rpc.submitTransaction({ transaction: tx, allowOrphan: false });
    return res.transactionId || String(res);
  } finally {
    try { await rpc.disconnect(); } catch (_) {}
  }
}
