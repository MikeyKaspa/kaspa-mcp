/**
 * AoN crowdfund campaign share page: live pledge tracker + one-tap pledge/claim/reclaim.
 * authorized_by: pt277u — Stag Hunt grace; no warning flags; track pledges from chain via REST failover.
 */
import { newSignId, type KvLike } from "./sign/store.js";
import { fetchRestJson, type NetworkId } from "./endpoints.js";
import { buildAoNPledgeAddress, AON_DEFAULT_GRACE_MS, computeRefundOpensAtMs } from "./crowdfund.js";
import { ownerPkhFromP2pkAddress } from "./l1/owner-pkh.js";
import { utxoApiBaseFor, kaspaNetworkFor } from "./sign/attach.js";

export type CampaignPledgeRecord = {
  backerAddress: string;
  backerPkhHex: string;
  p2shAddress: string;
  registeredAt: string;
  /** First time we observed a UTXO (ISO), if known */
  firstSeenAt?: string;
  /** Last observed amount at this pledge address (sompi string) */
  lastAmountSompi?: string;
  /** Funding outpoint txid when known */
  fundTxid?: string;
};

export type CampaignPageRecord = {
  id: string;
  kind: "aon_campaign";
  createdAt: string;
  expiresAt: number;
  networkId: string;
  ownerAddress: string;
  ownerPkhHex: string;
  campaignTagHex: string;
  goalSompi: string;
  deadlineMs: string;
  /** Grace after deadline before refunds open (default 3d). */
  graceMs: string;
  /** On-chain temporal = deadline + grace. */
  refundOpensAtMs: string;
  title: string;
  pledges: CampaignPledgeRecord[];
  /** Peak raised observed (helps distinguish claimed vs never-funded) */
  peakRaisedSompi?: string;
};

export type CampaignPledgeLive = {
  backerAddress: string;
  backerShort: string;
  p2shAddress: string;
  amountSompi: string;
  amountKas: string;
  time: string | null;
  explorerUrl: string | null;
  fundTxid: string | null;
  hasUtxo: boolean;
};

export type CampaignStatus = {
  campaignId: string;
  networkId: string;
  ownerAddress: string;
  campaignTagHex: string;
  goalSompi: string;
  goalKas: string;
  deadlineMs: string;
  deadlineIso: string;
  graceMs: string;
  refundOpensAtMs: string;
  refundOpensAtIso: string;
  nowMs: number;
  raisedSompi: string;
  raisedKas: string;
  progressPct: number;
  status: "open" | "goal_met" | "grace" | "claimed" | "refunding";
  statusLabel: string;
  secondsRemaining: number | null;
  secondsUntilRefunds: number | null;
  canClaim: boolean;
  canReclaim: boolean;
  pledges: CampaignPledgeLive[];
  pledgeCount: number;
  sharePath: string;
};

const TTL_SEC = 60 * 60 * 24 * 90;

type Mem = Map<string, CampaignPageRecord>;

function mem(): Mem {
  const g = globalThis as { __kaspaCampaignPages?: Mem };
  if (!g.__kaspaCampaignPages) g.__kaspaCampaignPages = new Map();
  return g.__kaspaCampaignPages;
}

let kv: KvLike | null = null;
let publicBase = "";

export function setCampaignPageContext(opts: { kv: KvLike | null; publicBaseUrl: string }): void {
  kv = opts.kv;
  publicBase = opts.publicBaseUrl.replace(/\/$/, "");
}

function netOf(networkId: string): NetworkId {
  return networkId.includes("mainnet") && !networkId.includes("test") ? "mainnet" : "testnet-10";
}

function explorerBase(networkId: string): string {
  return netOf(networkId) === "mainnet" ? "https://kaspa.stream" : "https://tn10.kaspa.stream";
}

function shortAddr(a: string): string {
  const s = a.trim();
  if (s.length <= 16) return s;
  return s.slice(0, 10) + "…" + s.slice(-6);
}

function sompiToKas(sompi: bigint | string | number): string {
  const n = BigInt(sompi);
  const whole = n / 100000000n;
  const frac = (n % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

async function persist(rec: CampaignPageRecord): Promise<void> {
  mem().set(rec.id, rec);
  if (kv) {
    await kv.put(`campaign-page:${rec.id}`, JSON.stringify(rec), { expirationTtl: TTL_SEC });
  }
}

export async function createCampaignPage(input: {
  networkId: string;
  ownerAddress: string;
  ownerPkhHex?: string;
  campaignTagHex: string;
  goalSompi: string | number | bigint;
  deadlineMs: string | number | bigint;
  graceMs?: string | number | bigint;
  refundOpensAtMs?: string | number | bigint;
  title?: string;
  pledges?: CampaignPledgeRecord[];
}): Promise<{ record: CampaignPageRecord; url: string }> {
  const id = newSignId();
  const ownerPkhHex = input.ownerPkhHex || ownerPkhFromP2pkAddress(input.ownerAddress);
  const deadlineMs = String(input.deadlineMs);
  const graceMs = String(input.graceMs ?? AON_DEFAULT_GRACE_MS);
  const refundOpensAtMs = String(input.refundOpensAtMs ?? computeRefundOpensAtMs(deadlineMs, graceMs));
  const record: CampaignPageRecord = {
    id,
    kind: "aon_campaign",
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + TTL_SEC * 1000,
    networkId: input.networkId,
    ownerAddress: input.ownerAddress.trim(),
    ownerPkhHex,
    campaignTagHex: input.campaignTagHex.replace(/^0x/, "").toLowerCase(),
    goalSompi: String(input.goalSompi),
    deadlineMs,
    graceMs,
    refundOpensAtMs,
    title: input.title || "All-or-nothing crowdfund",
    pledges: input.pledges || [],
    peakRaisedSompi: "0",
  };
  await persist(record);
  const url = `${publicBase || ""}/campaign/${id}`;
  return { record, url };
}

export async function getCampaignPage(id: string): Promise<CampaignPageRecord | null> {
  const hit = mem().get(id);
  if (hit && Date.now() <= hit.expiresAt) return hit;
  if (!kv) return null;
  const raw = await kv.get(`campaign-page:${id}`);
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as CampaignPageRecord;
    if (Date.now() > r.expiresAt) return null;
    if (!r.graceMs) r.graceMs = String(AON_DEFAULT_GRACE_MS);
    if (!r.refundOpensAtMs) r.refundOpensAtMs = computeRefundOpensAtMs(r.deadlineMs, r.graceMs);
    mem().set(id, r);
    return r;
  } catch {
    return null;
  }
}

export async function upsertCampaignPledge(
  campaignId: string,
  pledge: Omit<CampaignPledgeRecord, "registeredAt"> & { registeredAt?: string },
): Promise<CampaignPageRecord | null> {
  const rec = await getCampaignPage(campaignId);
  if (!rec) return null;
  const existing = rec.pledges.findIndex((p) => p.p2shAddress === pledge.p2shAddress);
  const row: CampaignPledgeRecord = {
    backerAddress: pledge.backerAddress,
    backerPkhHex: pledge.backerPkhHex,
    p2shAddress: pledge.p2shAddress,
    registeredAt: pledge.registeredAt || new Date().toISOString(),
    firstSeenAt: pledge.firstSeenAt,
    lastAmountSompi: pledge.lastAmountSompi,
    fundTxid: pledge.fundTxid,
  };
  if (existing >= 0) {
    const prev = rec.pledges[existing]!;
    rec.pledges[existing] = {
      ...prev,
      ...row,
      registeredAt: prev.registeredAt,
      firstSeenAt: prev.firstSeenAt || row.firstSeenAt,
      fundTxid: row.fundTxid || prev.fundTxid,
    };
  } else {
    rec.pledges.push(row);
  }
  await persist(rec);
  return rec;
}

type RestUtxoRow = {
  outpoint?: { transactionId: string; index: number };
  utxoEntry?: { amount?: string | number; blockDaaScore?: string | number };
  amount?: string | number;
};

async function fetchAddressUtxos(networkId: string, address: string): Promise<RestUtxoRow[]> {
  const net = netOf(networkId);
  const path = `/addresses/${encodeURIComponent(address)}/utxos`;
  try {
    const { json } = await fetchRestJson<RestUtxoRow[]>(net, path, { allowStatuses: [404] });
    if (!Array.isArray(json)) return [];
    return json;
  } catch {
    return [];
  }
}

function utxoAmount(row: RestUtxoRow): bigint {
  const a = row.utxoEntry?.amount ?? row.amount ?? 0;
  return BigInt(a);
}

function utxoTxid(row: RestUtxoRow): string | null {
  return row.outpoint?.transactionId || null;
}

/**
 * Compute live campaign status from known pledges + chain UTXOs (REST failover).
 */
export async function computeCampaignStatus(rec: CampaignPageRecord, nowMs = Date.now()): Promise<CampaignStatus> {
  const goal = BigInt(rec.goalSompi);
  const deadline = Number(rec.deadlineMs);
  const exp = explorerBase(rec.networkId);
  let raised = 0n;
  const live: CampaignPledgeLive[] = [];
  let dirty = false;

  for (const p of rec.pledges) {
    const utxos = await fetchAddressUtxos(rec.networkId, p.p2shAddress);
    let amt = 0n;
    let fundTxid = p.fundTxid || null;
    for (const u of utxos) {
      amt += utxoAmount(u);
      if (!fundTxid) fundTxid = utxoTxid(u);
    }
    raised += amt;
    if (amt > 0n) {
      if (!p.firstSeenAt) {
        p.firstSeenAt = new Date(nowMs).toISOString();
        dirty = true;
      }
      if (p.lastAmountSompi !== String(amt) || (fundTxid && p.fundTxid !== fundTxid)) {
        p.lastAmountSompi = String(amt);
        if (fundTxid) p.fundTxid = fundTxid;
        dirty = true;
      }
    } else if (p.lastAmountSompi && p.lastAmountSompi !== "0") {
      p.lastAmountSompi = "0";
      dirty = true;
    }
    // Only list pledges that are registered (always) — show amount 0 if empty
    live.push({
      backerAddress: p.backerAddress,
      backerShort: shortAddr(p.backerAddress),
      p2shAddress: p.p2shAddress,
      amountSompi: String(amt),
      amountKas: sompiToKas(amt),
      time: p.firstSeenAt || p.registeredAt || null,
      explorerUrl: fundTxid ? `${exp}/transactions/${fundTxid}` : null,
      fundTxid,
      hasUtxo: amt > 0n,
    });
  }

  const peak = BigInt(rec.peakRaisedSompi || "0");
  if (raised > peak) {
    rec.peakRaisedSompi = String(raised);
    dirty = true;
  }
  if (dirty) await persist(rec);

  const graceMs = Number(rec.graceMs ?? AON_DEFAULT_GRACE_MS);
  const refundOpensAt = Number(rec.refundOpensAtMs ?? computeRefundOpensAtMs(deadline, graceMs));
  const pastDeadline = nowMs >= deadline;
  const refundsOpen = nowMs >= refundOpensAt;
  const peakNow = BigInt(rec.peakRaisedSompi || "0");
  let status: CampaignStatus["status"];
  let statusLabel: string;
  if (raised >= goal && raised > 0n) {
    status = "goal_met";
    statusLabel = "Goal met — claim available";
  } else if (!pastDeadline) {
    status = "open";
    statusLabel = "Open";
  } else if (raised > 0n && !refundsOpen) {
    status = "grace";
    statusLabel = "Grace — owner should claim";
  } else if (raised > 0n && refundsOpen) {
    status = "refunding";
    statusLabel = "Refunds open";
  } else if (peakNow >= goal) {
    status = "claimed";
    statusLabel = "Claimed";
  } else {
    status = "refunding";
    statusLabel = "Refunds open";
  }

  const pct =
    goal === 0n ? 0 : Number((raised * 10000n) / goal) / 100;
  const progressPct = Math.min(100, Math.max(0, pct));
  const secondsRemaining = pastDeadline ? null : Math.max(0, Math.floor((deadline - nowMs) / 1000));
  const secondsUntilRefunds = refundsOpen ? null : Math.max(0, Math.floor((refundOpensAt - nowMs) / 1000));
  const canClaim = raised >= goal && raised > 0n;
  const canReclaim = refundsOpen && raised > 0n && raised < goal;

  return {
    campaignId: rec.id,
    networkId: rec.networkId,
    ownerAddress: rec.ownerAddress,
    campaignTagHex: rec.campaignTagHex,
    goalSompi: rec.goalSompi,
    goalKas: sompiToKas(goal),
    deadlineMs: rec.deadlineMs,
    deadlineIso: new Date(deadline).toISOString(),
    graceMs: String(graceMs),
    refundOpensAtMs: String(refundOpensAt),
    refundOpensAtIso: new Date(refundOpensAt).toISOString(),
    nowMs,
    raisedSompi: String(raised),
    raisedKas: sompiToKas(raised),
    progressPct,
    status,
    statusLabel,
    secondsRemaining,
    secondsUntilRefunds,
    canClaim,
    canReclaim,
    pledges: live.sort((a, b) => {
      const ta = a.time ? Date.parse(a.time) : 0;
      const tb = b.time ? Date.parse(b.time) : 0;
      return tb - ta;
    }),
    pledgeCount: live.length,
    sharePath: `/campaign/${rec.id}`,
  };
}

/** Derive pledge address for a backer on this campaign (keeps expectedP2sh binding). */
export function derivePledgeForBacker(
  rec: CampaignPageRecord,
  backerAddress: string,
): { p2shAddress: string; bytecodeHex: string; backerPkhHex: string } {
  const backerPkhHex = ownerPkhFromP2pkAddress(backerAddress);
  const refundOpensAtMs = rec.refundOpensAtMs || computeRefundOpensAtMs(rec.deadlineMs, rec.graceMs ?? AON_DEFAULT_GRACE_MS);
  const built = buildAoNPledgeAddress({
    ownerPkhHex: rec.ownerPkhHex,
    backerPkhHex,
    campaignTagHex: rec.campaignTagHex,
    goalSompi: rec.goalSompi,
    refundOpensAtMs,
    network: netOf(rec.networkId),
  });
  return { ...built, backerPkhHex };
}

export function campaignFundBuild(rec: CampaignPageRecord, backerAddress: string, amountSompi: string | number | bigint) {
  const derived = derivePledgeForBacker(rec, backerAddress);
  const isTestnet = netOf(rec.networkId) === "testnet-10";
  return {
    derived,
    l1Build: {
      buildInBrowser: true as const,
      kaspaNetwork: kaspaNetworkFor(rec.networkId, isTestnet),
      utxoApiBase: utxoApiBaseFor(rec.networkId, isTestnet),
      fromAddress: backerAddress.trim(),
      amountSompi: String(amountSompi),
      bytecodeHex: derived.bytecodeHex,
      expectedP2shAddress: derived.p2shAddress,
      destinationAddress: derived.p2shAddress,
    },
    meta: {
      templateId: "aon_pledge",
      contractName: "AoNPledge",
      p2shAddress: derived.p2shAddress,
      expectedP2shAddress: derived.p2shAddress,
      campaignId: rec.id,
      campaignTagHex: rec.campaignTagHex,
      goalSompi: rec.goalSompi,
      deadlineMs: rec.deadlineMs,
      graceMs: rec.graceMs,
      refundOpensAtMs: rec.refundOpensAtMs,
      backerAddress: backerAddress.trim(),
      sharePageUrl: `${publicBase || ""}/campaign/${rec.id}`,
    },
  };
}

export function renderCampaignPageHtml(rec: CampaignPageRecord, bootstrap?: CampaignStatus): string {
  const boot = bootstrap ? JSON.stringify(bootstrap) : "null";
  const unit = netOf(rec.networkId) === "testnet-10" ? "test KAS" : "KAS";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(rec.title)} · Crowdfund</title>
<style>
:root{--bg:#0b0f14;--card:#141a22;--text:#e8eef6;--muted:#8b9bb0;--accent:#49eacb;--bar:#1e2a38;--ok:#3dd68c;--warn:#f5a524}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);line-height:1.45}
.wrap{max-width:36rem;margin:0 auto;padding:1rem 1rem 3rem}
h1{font-size:1.35rem;margin:.4rem 0 .6rem}
.card{background:var(--card);border-radius:14px;padding:1rem 1.1rem;margin:0 0 1rem;border:1px solid #243041}
.muted{color:var(--muted);font-size:.9rem}
.row{display:flex;justify-content:space-between;gap:.75rem;align-items:baseline;flex-wrap:wrap}
.big{font-size:1.55rem;font-weight:700;letter-spacing:-.02em}
.bar{height:12px;background:var(--bar);border-radius:999px;overflow:hidden;margin:.65rem 0 .35rem}
.bar>i{display:block;height:100%;width:0;background:linear-gradient(90deg,#2dd4bf,var(--accent));border-radius:999px;transition:width .4s ease}
.badge{display:inline-block;padding:.2rem .55rem;border-radius:999px;font-size:.75rem;font-weight:600;background:#1a2838;color:var(--accent);text-transform:uppercase;letter-spacing:.04em}
.badge.goal_met{background:#143528;color:var(--ok)}
.badge.goal_met{background:#143528;color:var(--ok)}
.badge.grace{background:#2a2412;color:var(--warn)}
.badge.refunding{background:#3a2a12;color:var(--warn)}
.badge.claimed{background:#1a2838;color:#9db0c7}
.pledge{padding:.7rem 0;border-top:1px solid #243041}
.pledge:first-child{border-top:0}
.pledge a{color:var(--accent);text-decoration:none;font-size:.85rem}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem;word-break:break-all}
label{display:block;font-size:.85rem;color:var(--muted);margin:0 0 .35rem}
input{width:100%;padding:.7rem .8rem;border-radius:10px;border:1px solid #2a3a4d;background:#0e141c;color:var(--text);font-size:1rem}
.actions{display:flex;flex-direction:column;gap:.55rem;margin-top:.8rem}
button,.btn{appearance:none;border:0;border-radius:12px;padding:.85rem 1rem;font-size:1rem;font-weight:600;cursor:pointer;text-align:center;text-decoration:none}
button.primary,.btn.primary{background:var(--accent);color:#06241d}
button.secondary,.btn.secondary{background:#1e2a38;color:var(--text)}
button:disabled{opacity:.45;cursor:not-allowed}
.statusline{min-height:1.3rem;font-size:.9rem;margin:.4rem 0;color:var(--muted)}
.statusline.err{color:#ff8e8e}
.statusline.ok{color:var(--ok)}
.cue{display:none;margin:.4rem 0;padding:.55rem .7rem;border-radius:10px;background:#1a2838;color:var(--accent);font-size:.9rem}
.cue.show{display:block}
@media(min-width:480px){.actions{flex-direction:row}.actions>*{flex:1}}
</style>
</head>
<body>
<div class="wrap">
  <div class="row"><span class="badge" id="statusBadge">…</span><span class="muted" id="networkLabel"></span></div>
  <h1>${escapeHtml(rec.title)}</h1>
  <div class="card" id="progressCard">
    <div class="row"><span class="big" id="raisedLabel">—</span><span class="muted" id="goalLabel">goal —</span></div>
    <div class="bar" aria-hidden="true"><i id="barFill"></i></div>
    <div class="row muted"><span id="pctLabel"></span><span id="countdown"></span></div>
    <p class="muted" style="margin:.55rem 0 0;font-size:.8rem" id="lockLine"></p>
  </div>
  <div class="card">
    <h2 style="font-size:1rem;margin:0 0 .6rem">Pledge</h2>
    <label for="amt">Amount (${escapeHtml(unit)})</label>
    <input id="amt" type="number" min="0.01" step="0.01" value="1" inputmode="decimal"/>
    <div class="statusline" id="pledgeStatus"></div>
    <div class="cue" id="walletCue">Check your wallet popup…</div>
    <div class="actions">
      <button type="button" class="primary" id="btnPledge">Connect &amp; pledge</button>
      <button type="button" class="primary" id="btnClaim" hidden>Claim (owner)</button>
      <button type="button" class="secondary" id="btnReclaim" hidden>Reclaim my pledge</button>
    </div>
    <p class="muted" style="margin:.7rem 0 0;font-size:.8rem">Pledges stay locked until the deadline. If the goal is missed, refunds open after a grace period — anyone can reclaim to the backer address (no host key).</p>
  </div>
  <div class="card">
    <div class="row"><h2 style="font-size:1rem;margin:0">Pledges</h2><span class="muted" id="pledgeCount"></span></div>
    <div id="pledgeList"><p class="muted">Loading…</p></div>
  </div>
</div>
<script>
window.__CAMPAIGN_ID__=${JSON.stringify(rec.id)};
window.__CAMPAIGN_BOOT__=${boot};
window.__CAMPAIGN_META__=${JSON.stringify({
  networkId: rec.networkId,
  goalSompi: rec.goalSompi,
  deadlineMs: rec.deadlineMs,
  graceMs: rec.graceMs,
  refundOpensAtMs: rec.refundOpensAtMs,
  ownerAddress: rec.ownerAddress,
  campaignTagHex: rec.campaignTagHex,
  unit,
})};
</script>
<script src="/campaign/app.js"></script>
</body>
</html>`;
}
