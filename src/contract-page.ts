/**
 * One-tap shareable public HTML for a P2SH — QR + live funded status from chain.
 */
import { newSignId, type KvLike } from "./sign/store.js";
import { L1_UNAUDITED_WARNING } from "./l1/kaspa-sdk.js";
import { renderSVG } from "uqr";
import { getNetwork } from "./networks.js";

export type ContractPageRecord = {
  id: string;
  createdAt: string;
  expiresAt: number;
  networkId: string;
  templateId?: string;
  contractName?: string;
  p2shAddress: string;
  fundTxid?: string;
  explorer?: string;
  title: string;
  blurb: string;
};

const TTL_SEC = 60 * 60 * 24 * 90;

type Mem = Map<string, ContractPageRecord>;

function mem(): Mem {
  const g = globalThis as { __kaspaContractPages?: Mem };
  if (!g.__kaspaContractPages) g.__kaspaContractPages = new Map();
  return g.__kaspaContractPages;
}

let kv: KvLike | null = null;
let publicBase = "";

export function setContractPageContext(opts: { kv: KvLike | null; publicBaseUrl: string }): void {
  kv = opts.kv;
  publicBase = opts.publicBaseUrl.replace(/\/$/, "");
}

export async function createContractPage(
  input: Omit<ContractPageRecord, "id" | "createdAt" | "expiresAt" | "title" | "blurb"> & {
    title?: string;
    blurb?: string;
  },
): Promise<{ record: ContractPageRecord; url: string }> {
  const id = newSignId();
  const title = input.title || input.contractName || input.templateId || "Kaspa contract";
  const blurb =
    input.blurb ||
    (input.fundTxid
      ? `Funded covenant on ${input.networkId}.`
      : `Ready — not on chain until funded. Send KAS to the address below (or use a one-tap fund link from your AI).`);
  const record: ContractPageRecord = {
    id,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + TTL_SEC * 1000,
    networkId: input.networkId,
    templateId: input.templateId,
    contractName: input.contractName,
    p2shAddress: input.p2shAddress,
    fundTxid: input.fundTxid,
    explorer: input.explorer,
    title,
    blurb,
  };
  mem().set(id, record);
  if (kv) {
    await kv.put(`contract-page:${id}`, JSON.stringify(record), { expirationTtl: TTL_SEC });
  }
  const url = `${publicBase || ""}/page/${id}`;
  return { record, url };
}

export async function getContractPage(id: string): Promise<ContractPageRecord | null> {
  const hit = mem().get(id);
  if (hit && Date.now() <= hit.expiresAt) return hit;
  if (!kv) return null;
  const raw = await kv.get(`contract-page:${id}`);
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as ContractPageRecord;
    if (Date.now() > r.expiresAt) return null;
    mem().set(id, r);
    return r;
  } catch {
    return null;
  }
}

async function liveBalanceSompi(networkId: string, address: string): Promise<bigint | null> {
  try {
    const n = getNetwork(networkId);
    const base = (n.rpcUrl || "").replace(/\/$/, "");
    if (!base) return null;
    const res = await fetch(`${base}/addresses/${encodeURIComponent(address)}/balance`);
    if (!res.ok) return null;
    const data = (await res.json()) as { balance?: number | string };
    return BigInt(data.balance ?? 0);
  } catch {
    return null;
  }
}

export async function renderContractPageHtml(r: ContractPageRecord): Promise<string> {
  const warn =
    r.networkId.includes("mainnet") && !r.networkId.includes("test")
      ? `<p class="warn">${escapeHtml(L1_UNAUDITED_WARNING)}</p>`
      : "";
  const bal = await liveBalanceSompi(r.networkId, r.p2shAddress);
  const funded = bal != null && bal > 0n;
  const balKas = bal != null ? (Number(bal) / 1e8).toFixed(8).replace(/\.?0+$/, "") : "unknown";
  const statusHtml = funded
    ? `<p class="ok"><strong>Status:</strong> Funded on chain · ${escapeHtml(balKas)} ${
        r.networkId.includes("test") ? "tKAS" : "KAS"
      }</p>`
    : `<p class="warn"><strong>Status:</strong> Ready — not on chain until funded` +
      (bal === 0n ? " (balance 0)" : "") +
      `. Do not say this contract is live yet.</p>`;
  const exp = r.explorer
    ? `<p><a href="${escapeHtml(r.explorer)}" rel="noopener" target="_blank">View fund transaction</a></p>`
    : "";
  let qr = "";
  try {
    qr = renderSVG(r.p2shAddress, { ecc: "M", border: 2 });
    qr = qr.replace("<svg ", '<svg class="qr" width="180" height="180" ');
  } catch {
    qr = "";
  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(r.title)} · Kaspa</title>
<style>
body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#111;background:#fafafa}
h1{font-size:1.4rem} .addr{word-break:break-all;background:#111;color:#0f0;padding:.75rem 1rem;border-radius:8px;font-family:ui-monospace,monospace}
.warn{background:#fff3cd;border:1px solid #ffecb5;padding:.75rem;border-radius:8px;font-size:.9rem}
.ok{background:#d1e7dd;border:1px solid #badbcc;padding:.75rem;border-radius:8px;font-size:.9rem}
.fine{color:#666;font-size:.85rem}
.qr{display:block;margin:1rem 0;background:#fff;padding:8px;border-radius:8px;border:1px solid #ddd}
</style>
</head>
<body>
<h1>${escapeHtml(r.title)}</h1>
<p>${escapeHtml(r.blurb)}</p>
${warn}
${statusHtml}
<p><strong>Network:</strong> ${escapeHtml(r.networkId)}</p>
${r.templateId ? `<p><strong>Template:</strong> ${escapeHtml(r.templateId)}</p>` : ""}
<p><strong>P2SH address</strong> — send KAS here to fund:</p>
<p class="addr" id="addr">${escapeHtml(r.p2shAddress)}</p>
<p><button type="button" id="copy">Copy address</button></p>
${qr ? `<p>Scan to copy/send:</p>${qr}` : ""}
${exp}
<p class="fine">Generated by kaspa-mcp · UNAUDITED contracts · Prefer testnet for experiments. Status refreshed from public chain API on each load.</p>
<script>
document.getElementById("copy").onclick=function(){
  var t=document.getElementById("addr").textContent;
  if(navigator.clipboard) navigator.clipboard.writeText(t);
};
</script>
</body>
</html>`;
}

/** Sync fallback for callers that cannot await (tests). Prefer async. */
export function renderContractPageHtmlSync(r: ContractPageRecord): string {
  return `<!DOCTYPE html><html><body><p>${escapeHtml(r.p2shAddress)}</p><p>Use async render for funded status + QR.</p></body></html>`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
