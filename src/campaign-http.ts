/**
 * HTTP routes for AoN campaign share pages (Stag Hunt style).
 * authorized_by: pt277u
 */
import {
  getCampaignPage,
  computeCampaignStatus,
  renderCampaignPageHtml,
  campaignFundBuild,
  upsertCampaignPledge,
  derivePledgeForBacker,
} from "./campaign-page.js";
import { attachTapToApprove, utxoApiBaseFor, kaspaNetworkFor } from "./sign/attach.js";
import { resolveTemplateBytecodeForFund } from "./l1/resolve-template-bytecode.js";
import { fetchRestJson } from "./endpoints.js";
import { getTemplate } from "./l1/templates.js";
import { rebindAoNPledge, entryOf } from "./l1/artifact.js";
import { decodeAddress } from "./l1/pure/address.js";
import { AON_DEFAULT_GRACE_MS, computeRefundOpensAtMs } from "./crowdfund.js";
import type { L1BrowserBuild } from "./sign/types.js";
import type { CampaignPageRecord } from "./campaign-page.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function netKaspa(networkId: string): "testnet-10" | "mainnet" {
  return networkId.includes("mainnet") && !networkId.includes("test") ? "mainnet" : "testnet-10";
}

function refundOpensAtOf(rec: CampaignPageRecord): number {
  if (rec.refundOpensAtMs) return Number(rec.refundOpensAtMs);
  return Number(computeRefundOpensAtMs(rec.deadlineMs, rec.graceMs ?? AON_DEFAULT_GRACE_MS));
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

type UtxoRow = {
  outpoint: { transactionId: string; index: number };
  utxoEntry?: {
    amount?: string | number;
    scriptPublicKey?: unknown;
    blockDaaScore?: string | number;
    isCoinbase?: boolean;
  };
  amount?: string | number;
  scriptPublicKey?: unknown;
  blockDaaScore?: string | number;
  isCoinbase?: boolean;
};

function parseSpk(entryRow: { scriptPublicKey?: unknown }): { script: string; version: number } {
  let script = "";
  let version = 0;
  const spkRaw = entryRow.scriptPublicKey;
  if (typeof spkRaw === "string") script = spkRaw;
  else if (spkRaw && typeof spkRaw === "object") {
    const o = spkRaw as { scriptPublicKey?: string; script?: string; version?: number };
    script = o.scriptPublicKey || o.script || "";
    version = o.version ?? 0;
  }
  return { script, version };
}

async function fetchUtxos(networkId: string, address: string): Promise<UtxoRow[]> {
  const net = netKaspa(networkId);
  const { json: utxos } = await fetchRestJson<UtxoRow[]>(
    net,
    `/addresses/${encodeURIComponent(address)}/utxos`,
  );
  return Array.isArray(utxos) ? utxos : [];
}

function xonlyFromP2pkAddress(address: string): string {
  const d = decodeAddress(address.trim());
  if (d.version !== 0 || d.payload.length !== 32) {
    throw new Error("Need a P2PK receive address (kaspatest:q… / kaspa:q…)");
  }
  return [...d.payload].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleCampaignHttp(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (
    request.method === "GET" &&
    path.startsWith("/campaign/") &&
    !path.startsWith("/campaign/app")
  ) {
    const id = path.slice("/campaign/".length).split("/")[0] || "";
    if (!id || id.includes(".")) return null;
    const rec = await getCampaignPage(id);
    if (!rec) return new Response("Campaign not found or expired", { status: 404 });
    let st = undefined;
    try {
      st = await computeCampaignStatus(rec);
    } catch {
      /* page still renders */
    }
    const html = renderCampaignPageHtml(rec, st);
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=15" },
    });
  }

  if (request.method === "GET" && path.startsWith("/api/campaign/")) {
    const id = path.slice("/api/campaign/".length).split("/")[0] || "";
    if (id.includes("/")) return null;
    const rec = await getCampaignPage(id);
    if (!rec) return json({ error: "Campaign not found" }, 404);
    try {
      return json(await computeCampaignStatus(rec));
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  if (request.method === "POST" && /\/api\/campaign\/[^/]+\/pledge$/.test(path)) {
    const id = path.split("/")[3] || "";
    const rec = await getCampaignPage(id);
    if (!rec) return json({ error: "Campaign not found" }, 404);
    const body = await readBody(request);
    const backerAddress = String(body.backerAddress || "").trim();
    const amountSompi = body.amountSompi != null ? String(body.amountSompi) : "100000000";
    if (!backerAddress) return json({ error: "backerAddress required (connect wallet first)" }, 400);
    if (Date.now() >= Number(rec.deadlineMs)) return json({ error: "Campaign deadline has passed — pledging closed" }, 400);
    try {
      const built = campaignFundBuild(rec, backerAddress, amountSompi);
      const refundOpensAtMs = String(refundOpensAtOf(rec));
      resolveTemplateBytecodeForFund({
        templateId: "aon_pledge",
        ownerAddress: rec.ownerAddress,
        backerAddress,
        campaignTagHex: rec.campaignTagHex,
        goalSompi: rec.goalSompi,
        deadlineMs: rec.deadlineMs,
        refundOpensAtMs,
        expectedP2shAddress: built.derived.p2shAddress,
        networkId: rec.networkId,
      });
      await upsertCampaignPledge(rec.id, {
        backerAddress,
        backerPkhHex: built.derived.backerPkhHex,
        p2shAddress: built.derived.p2shAddress,
      });
      const tapToApprove = await attachTapToApprove("l1-fund", rec.networkId, {
        l1Build: built.l1Build,
        meta: built.meta,
      });
      if (!tapToApprove) return json({ error: "Sign session store unavailable" }, 503);
      return json({
        ok: true,
        p2shAddress: built.derived.p2shAddress,
        expectedP2shAddress: built.derived.p2shAddress,
        amountSompi,
        tapToApprove,
      });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }

  // Permissionless reclaim after deadline+grace
  if (request.method === "POST" && /\/api\/campaign\/[^/]+\/reclaim$/.test(path)) {
    const id = path.split("/")[3] || "";
    const rec = await getCampaignPage(id);
    if (!rec) return json({ error: "Campaign not found" }, 404);
    const opens = refundOpensAtOf(rec);
    if (Date.now() < opens) {
      return json(
        {
          error: "Refunds not open yet",
          refundOpensAtMs: String(opens),
          refundOpensAtIso: new Date(opens).toISOString(),
          hint: "Pledges stay locked until deadline + grace. Owner should claim if the goal was met.",
        },
        400,
      );
    }
    const body = await readBody(request);
    const backerAddress = String(body.backerAddress || "").trim();
    if (!backerAddress) return json({ error: "backerAddress required" }, 400);
    try {
      const derived = derivePledgeForBacker(rec, backerAddress);
      const list = await fetchUtxos(rec.networkId, derived.p2shAddress);
      if (!list.length) return json({ error: "No pledge UTXO found for this wallet" }, 404);
      const row = list[0]!;
      const entryRow = row.utxoEntry ?? row;
      const amount = BigInt((entryRow as { amount?: string | number }).amount ?? 0);
      const refundOpensAtMs = String(opens);
      const tpl = getTemplate("aon_pledge").loadedExample;
      const loaded = rebindAoNPledge(tpl, {
        ownerPkhHex: rec.ownerPkhHex,
        backerPkhHex: derived.backerPkhHex,
        campaignTagHex: rec.campaignTagHex,
        goalSompi: BigInt(rec.goalSompi),
        deadline: BigInt(refundOpensAtMs),
      });
      const entry = entryOf(loaded, "reclaim");
      const fee = 3500000n;
      const outAmt = amount - fee;
      if (outAmt <= 0n) return json({ error: "Pledge too small to reclaim after fee" }, 400);
      const { script, version } = parseSpk(entryRow as { scriptPublicKey?: unknown });
      const net = netKaspa(rec.networkId);
      const isTestnet = net === "testnet-10";
      const bytecodeHex = [...loaded.bytecode].map((b) => b.toString(16).padStart(2, "0")).join("");
      const backerXonly = xonlyFromP2pkAddress(backerAddress);
      const l1Build: L1BrowserBuild = {
        buildInBrowser: true,
        kaspaNetwork: kaspaNetworkFor(rec.networkId, isTestnet),
        utxoApiBase: utxoApiBaseFor(rec.networkId, isTestnet),
        bytecodeHex,
        entryName: "reclaim",
        dispatchTag: entry.dispatch_tag,
        entryParams: entry.params,
        args: [backerXonly],
        destinationAddress: backerAddress,
        feeSompi: String(fee),
        outputAmountSompi: String(outAmt),
        lockTimeMs: refundOpensAtMs,
        expectedP2shAddress: derived.p2shAddress,
        sigOpCount: 10,
        p2shUtxo: {
          outpoint: row.outpoint,
          amount: String(amount),
          scriptPublicKey: { version, script },
        },
      };
      const tapToApprove = await attachTapToApprove("l1-spend", rec.networkId, {
        l1Build,
        meta: {
          templateId: "aon_pledge",
          contractName: "AoNPledge reclaim",
          entry: "reclaim",
          p2shAddress: derived.p2shAddress,
          expectedP2shAddress: derived.p2shAddress,
          campaignId: rec.id,
          sharePageUrl: `/campaign/${rec.id}`,
          backerAddress,
          permissionless: true,
        },
      });
      if (!tapToApprove) return json({ error: "Sign session store unavailable" }, 503);
      await upsertCampaignPledge(rec.id, {
        backerAddress,
        backerPkhHex: derived.backerPkhHex,
        p2shAddress: derived.p2shAddress,
      });
      return json({ ok: true, tapToApprove, p2shAddress: derived.p2shAddress });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }

  // Owner claim when goal met (anytime) — single-input when one UTXO covers goal;
  // multi-input co-spend when several pledges must be combined.
  if (request.method === "POST" && /\/api\/campaign\/[^/]+\/claim$/.test(path)) {
    const id = path.split("/")[3] || "";
    const rec = await getCampaignPage(id);
    if (!rec) return json({ error: "Campaign not found" }, 404);
    const body = await readBody(request);
    const ownerAddress = String(body.ownerAddress || "").trim() || rec.ownerAddress;
    if (ownerAddress.trim().toLowerCase() !== rec.ownerAddress.trim().toLowerCase()) {
      return json({ error: "Only the campaign owner can claim" }, 403);
    }
    try {
      const goal = BigInt(rec.goalSompi);
      const refundOpensAtMs = String(refundOpensAtOf(rec));
      const pledgeUtxos: Array<{
        pledge: (typeof rec.pledges)[0];
        row: UtxoRow;
        amount: bigint;
        script: string;
        version: number;
        bytecodeHex: string;
        dispatchTag: string;
        entryParams: ReturnType<typeof entryOf>["params"];
      }> = [];
      let total = 0n;
      for (const p of rec.pledges) {
        const list = await fetchUtxos(rec.networkId, p.p2shAddress);
        if (!list.length) continue;
        const row = list[0]!;
        const entryRow = row.utxoEntry ?? row;
        const amount = BigInt((entryRow as { amount?: string | number }).amount ?? 0);
        if (amount <= 0n) continue;
        const derived = derivePledgeForBacker(rec, p.backerAddress);
        const tpl = getTemplate("aon_pledge").loadedExample;
        const loaded = rebindAoNPledge(tpl, {
          ownerPkhHex: rec.ownerPkhHex,
          backerPkhHex: derived.backerPkhHex,
          campaignTagHex: rec.campaignTagHex,
          goalSompi: goal,
          deadline: BigInt(refundOpensAtMs),
        });
        const entry = entryOf(loaded, "claim");
        const { script, version } = parseSpk(entryRow as { scriptPublicKey?: unknown });
        const bytecodeHex = [...loaded.bytecode].map((b) => b.toString(16).padStart(2, "0")).join("");
        pledgeUtxos.push({
          pledge: p,
          row,
          amount,
          script,
          version,
          bytecodeHex,
          dispatchTag: entry.dispatch_tag,
          entryParams: entry.params,
        });
        total += amount;
      }
      if (total < goal) {
        return json({ error: `Goal not met yet (${total} < ${goal} sompi)` }, 400);
      }
      if (!pledgeUtxos.length) return json({ error: "No pledge UTXOs to claim" }, 404);

      // Browser builder currently supports one P2SH input; co-spend up to 8 via first N
      // when a single UTXO alone meets the goal, claim that one. Otherwise claim the
      // minimal prefix of pledges whose sum >= goal (owner signs once per input on /sign
      // when multi-input lands; for now use the largest single UTXO if it alone meets goal,
      // else return all matching builds for the first pledge that... )
      // Practical approach: pick pledges in order until sum >= goal, and if exactly 1 use
      // existing single-input path; if >1 return multiClaim plan for the agent / e2e.
      let run: typeof pledgeUtxos = [];
      let runSum = 0n;
      const sorted = [...pledgeUtxos].sort((a, b) => (a.amount < b.amount ? 1 : -1));
      for (const u of sorted) {
        run.push(u);
        runSum += u.amount;
        if (runSum >= goal) break;
      }
      if (run.length > 1) {
        return json({
          ok: false,
          needMultiInput: true,
          error:
            "This campaign needs a multi-input claim (several pledges). Use your bot: ask it to claim the crowdfund with l1_prepare_spend / the campaign claim helper. One-tap multi-input claim is coming next.",
          pledges: run.map((u) => ({
            p2shAddress: u.pledge.p2shAddress,
            amountSompi: String(u.amount),
            backerAddress: u.pledge.backerAddress,
          })),
          totalSompi: String(runSum),
          goalSompi: String(goal),
        }, 400);
      }
      const u = run[0]!;
      const fee = 3500000n;
      const outAmt = u.amount - fee;
      if (outAmt <= 0n) return json({ error: "Pledge too small to claim after fee" }, 400);
      const net = netKaspa(rec.networkId);
      const isTestnet = net === "testnet-10";
      const l1Build: L1BrowserBuild = {
        buildInBrowser: true,
        kaspaNetwork: kaspaNetworkFor(rec.networkId, isTestnet),
        utxoApiBase: utxoApiBaseFor(rec.networkId, isTestnet),
        bytecodeHex: u.bytecodeHex,
        entryName: "claim",
        dispatchTag: u.dispatchTag,
        entryParams: u.entryParams,
        args: [null, null],
        destinationAddress: rec.ownerAddress,
        feeSompi: String(fee),
        outputAmountSompi: String(outAmt),
        expectedP2shAddress: u.pledge.p2shAddress,
        sigOpCount: 10,
        p2shUtxo: {
          outpoint: u.row.outpoint,
          amount: String(u.amount),
          scriptPublicKey: { version: u.version, script: u.script },
        },
      };
      const tapToApprove = await attachTapToApprove("l1-spend", rec.networkId, {
        l1Build,
        meta: {
          templateId: "aon_pledge",
          contractName: "AoNPledge claim",
          entry: "claim",
          p2shAddress: u.pledge.p2shAddress,
          expectedP2shAddress: u.pledge.p2shAddress,
          campaignId: rec.id,
          sharePageUrl: `/campaign/${rec.id}`,
          ownerAddress: rec.ownerAddress,
        },
      });
      if (!tapToApprove) return json({ error: "Sign session store unavailable" }, 503);
      return json({ ok: true, tapToApprove, p2shAddress: u.pledge.p2shAddress, mode: "single" });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }

  return null;
}
