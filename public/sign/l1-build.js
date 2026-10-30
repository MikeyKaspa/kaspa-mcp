/**
 * Browser L1 fund/spend builder using official kaspa-wasm web build
 * at /kaspa-wasm/ (Workers static asset; not in Worker script size).
 * Same wasm lineage KasWare uses — preferred over a hand-rolled pure-JS builder.
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
    // createTransactions accepts { version, script } object form more reliably
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

export async function buildSpendTx(build) {
  await ensureKaspa();
  const fee = BigInt(build.feeSompi || 300000);
  const inAmt = BigInt(build.p2shUtxo.amount);
  const outAmt = BigInt(build.outputAmountSompi || inAmt - fee);
  const redeem = hexToBytes(build.bytecodeHex);

  let script = String(build.p2shUtxo.scriptPublicKey.script).replace(/^0x/, "");
  if (build.p2shUtxo.scriptPublicKey.version === 0 && !script.startsWith("0000")) {
    script = "0000" + script;
  }
  const utxo = {
    outpoint: build.p2shUtxo.outpoint,
    amount: inAmt,
    scriptPublicKey: script,
    blockDaaScore: 0n,
    isCoinbase: false,
  };
  const outSpk = payToAddressScript(build.destinationAddress);

  const mkTx = (sigScript) =>
    new Transaction({
      version: 0,
      inputs: [
        {
          previousOutpoint: utxo.outpoint,
          signatureScript: sigScript || "",
          sequence: 0n,
          sigOpCount: 1,
          utxo,
        },
      ],
      outputs: [{ value: outAmt, scriptPublicKey: outSpk }],
      lockTime: 0n,
      subnetworkId: "0000000000000000000000000000000000000000",
      gas: 0n,
      payload: "",
    });

  const unsigned = mkTx("");
  const safeJson = unsigned.serializeToSafeJSON();
  const testKey = typeof globalThis !== "undefined" ? globalThis.__SIGN_TEST_KEY__ : null;
  if (!testKey) {
    return {
      safeJson,
      mode: "unsigned_needs_unlock",
      note: "SilverScript unlock requires a local test key (__SIGN_TEST_KEY__) or Node prepareSpend; KasWare signPskt cannot fill covenant unlocks.",
      feeSompi: String(fee),
      outputAmountSompi: String(outAmt),
    };
  }

  const key = new PrivateKey(String(testKey).replace(/^0x/, ""));
  const xonlyHex = key.toPublicKey().toXOnlyPublicKey().toString();
  const xonly = hexToBytes(xonlyHex);
  const sigStr = String(createInputSignature(unsigned, 0, key, SighashType.All)).replace(/^0x/, "");
  const sigBytes = hexToBytes(sigStr);
  const entry = { dispatch_tag: build.dispatchTag, params: build.entryParams || [] };
  const filled = (build.args || []).map((a, i) => {
    const kind = entry.params[i]?.type?.kind;
    if (a === "$sig" || a === "$signature" || a == null) return sigBytes;
    if (a === "$pk" || a === "$pubkey") return xonly;
    return a;
  });
  for (let i = 0; i < entry.params.length; i++) {
    if (entry.params[i].type.kind === "sig" && !filled[i]) filled[i] = sigBytes;
    if (entry.params[i].type.kind === "pubkey" && !filled[i]) filled[i] = xonly;
  }
  const unlock = buildEntryUnlock(entry, filled);
  const unlockHex = String(payToScriptHashSignatureScript(redeem, unlock));
  const signed = mkTx(unlockHex);
  return {
    safeJson,
    signedSafeJson: signed.serializeToSafeJSON(),
    mode: "signed_ready_for_pushTx",
    feeSompi: String(fee),
    outputAmountSompi: String(outAmt),
  };
}

export function summarizeBuiltSafeJson(safeJson, opts) {
  const tx = JSON.parse(safeJson);
  let inSum = 0n;
  for (const inp of tx.inputs || []) {
    if (inp.utxo?.amount != null) inSum += BigInt(inp.utxo.amount);
  }
  let outSum = 0n;
  const lines = [{ label: "Network", value: opts.networkLabel }];
  (tx.outputs || []).forEach((o, i) => {
    const v = BigInt(o.value || 0);
    outSum += v;
    const spk = String(o.scriptPublicKey || "");
    const kind = spk.includes("aa20") && /87$/.test(spk) ? "P2SH (covenant)" : "P2PK/address";
    lines.push({ label: "Output " + i + " (" + kind + ")", value: Number(v) / 1e8 + " KAS" });
  });
  if (inSum > 0n) {
    lines.push({ label: "Fee (inputs − outputs)", value: Number(inSum - outSum) / 1e8 + " KAS" });
  }
  const warnings = [];
  if (opts.isMainnet) {
    warnings.push(
      "MAINNET: UNAUDITED / USE AT YOUR OWN RISK. Review every output in your wallet popup. This page never sees your keys.",
    );
  }
  return { title: opts.title, lines, warnings };
}
