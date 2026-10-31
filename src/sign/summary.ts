/**
 * Derive plain-English tx summary ONLY from the transaction payload itself.
 * Never trust free-text fields from the MCP tool args for amounts/recipients.
 */

export interface TxSummaryLine {
  label: string;
  value: string;
}

export interface DerivedSummary {
  title: string;
  lines: TxSummaryLine[];
  /** Above-the-fold rows (destination / amount / fee) — no Details click needed. */
  plainLines?: TxSummaryLine[];
  /** sompi or wei strings when known */
  warnings: string[];
}

function sompiToKas(sompi: string | number | bigint): string {
  const n = BigInt(sompi);
  const whole = n / 100_000_000n;
  const frac = (n % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "") || "0";
  return frac === "0" ? `${whole} KAS` : `${whole}.${frac} KAS`;
}

function isP2shScript(spk: string): boolean {
  const s = spk.replace(/^0x/, "").toLowerCase();
  // version(2 bytes hex)=0000 + OP_HASH256(aa) OP_DATA_32(20) ... OP_EQUAL(87) typical P2SH
  return s.includes("aa20") && s.endsWith("87");
}

/** Parse Kaspa SafeJSON from kaspa-wasm serializeToSafeJSON. */
export function summarizeL1SafeJson(
  safeJson: string,
  opts: { kind: "l1-fund" | "l1-spend"; networkLabel: string; isMainnet: boolean },
): DerivedSummary {
  const tx = JSON.parse(safeJson) as {
    inputs?: Array<{
      utxo?: { amount?: string; address?: string };
      signatureScript?: string;
    }>;
    outputs?: Array<{ value?: string; scriptPublicKey?: string }>;
  };
  if (!Array.isArray(tx.inputs) || !Array.isArray(tx.outputs)) {
    throw new Error("SafeJSON missing inputs/outputs");
  }

  let inSum = 0n;
  for (const inp of tx.inputs) {
    if (inp.utxo?.amount != null) inSum += BigInt(inp.utxo.amount);
  }
  let outSum = 0n;
  const outLines: TxSummaryLine[] = [];
  for (let i = 0; i < tx.outputs.length; i++) {
    const o = tx.outputs[i]!;
    const v = BigInt(o.value ?? 0);
    outSum += v;
    const spk = String(o.scriptPublicKey ?? "");
    const kind = isP2shScript(spk) ? "P2SH (covenant)" : "P2PK/address";
    outLines.push({ label: `Output ${i} (${kind})`, value: sompiToKas(v) });
  }
  const fee = inSum > 0n ? inSum - outSum : 0n;
  const warnings: string[] = [];
  if (opts.isMainnet) {
    warnings.push(
      "MAINNET: UNAUDITED / USE AT YOUR OWN RISK. Review every output in your wallet popup. This page never sees your keys.",
    );
  }
  const unsignedInputs = tx.inputs.filter((i) => !i.signatureScript || i.signatureScript === "").length;
  const title =
    opts.kind === "l1-fund"
      ? `Fund covenant on ${opts.networkLabel}`
      : `Spend covenant on ${opts.networkLabel}`;

  const lines: TxSummaryLine[] = [
    { label: "Network", value: opts.networkLabel },
    { label: "Inputs", value: `${tx.inputs.length} (${unsignedInputs} unsigned)` },
    ...outLines,
  ];
  if (inSum > 0n) {
    lines.push({ label: "Input total", value: sompiToKas(inSum) });
    lines.push({ label: "Fee (inputs − outputs)", value: sompiToKas(fee) });
  } else {
    lines.push({
      label: "Fee",
      value: "Not computable from this payload (missing input UTXO amounts) — confirm in wallet",
    });
  }
  if (opts.kind === "l1-spend" && unsignedInputs === 0) {
    lines.push({ label: "Status", value: "Unlock already filled — Approve will broadcast via pushTx only" });
  }
  const plainLines: TxSummaryLine[] = [];
  const p2shOut = outLines.find((l) => /P2SH/i.test(l.label));
  if (opts.kind === "l1-fund" && p2shOut) {
    plainLines.push({ label: "Amount to covenant", value: p2shOut.value });
  }
  if (fee > 0n) plainLines.push({ label: "Fee", value: sompiToKas(fee) });
  plainLines.push({ label: "Network", value: opts.networkLabel });

  return { title, lines, plainLines, warnings };
}

export function summarizeEvmPrepared(
  evm: {
    chainId: number;
    to: string | null;
    data: string;
    value: string;
    gasLimit?: string;
    gasPrice?: string;
  },
  opts: { kind: "evm-deploy" | "evm-call"; networkLabel: string; isMainnet: boolean; contractName?: string },
): DerivedSummary {
  const warnings: string[] = [];
  if (opts.isMainnet) {
    warnings.push(
      "MAINNET: UNAUDITED / USE AT YOUR OWN RISK. Confirm calldata and value in your wallet. Keys never leave the wallet.",
    );
  }
  const data = evm.data ?? "0x";
  const dataBytes = Math.max(0, (data.startsWith("0x") ? data.length - 2 : data.length) / 2);
  const lines: TxSummaryLine[] = [
    { label: "Network", value: `${opts.networkLabel} (chainId ${evm.chainId})` },
    { label: "Type", value: opts.kind === "evm-deploy" ? "Contract deploy" : "Contract call" },
    { label: "To", value: evm.to ?? "(create / deploy)" },
    { label: "Value", value: `${evm.value || "0"} wei` },
    { label: "Calldata", value: `${dataBytes} bytes` },
  ];
  if (opts.contractName) lines.splice(2, 0, { label: "Contract", value: opts.contractName });
  if (evm.gasLimit) lines.push({ label: "Gas limit", value: String(evm.gasLimit) });
  if (evm.gasPrice) lines.push({ label: "Gas price", value: `${evm.gasPrice} wei` });
  return {
    title: opts.kind === "evm-deploy" ? `Deploy on ${opts.networkLabel}` : `Call on ${opts.networkLabel}`,
    lines,
    warnings,
  };
}

export function explorerFor(networkId: string, txid: string): string {
  if (networkId.includes("testnet-10") || networkId.includes("tn10") || networkId === "kaspa-l1-testnet-10") {
    return `https://tn10.kaspa.stream/transactions/${txid}`;
  }
  if (networkId.includes("kaspa-l1") || networkId === "mainnet") {
    return `https://kaspa.stream/transactions/${txid}`;
  }
  if (networkId.includes("kasplex-testnet")) return `https://explorer.testnet.kasplextest.xyz/tx/${txid}`;
  if (networkId.includes("kasplex")) return `https://explorer.kasplex.org/tx/${txid}`;
  return txid;
}
