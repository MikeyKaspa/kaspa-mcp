/**
 * HTTP routes for AoN campaign share pages.
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
import type { L1BrowserBuild } from "./sign/types.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function netKaspa(networkId: string): "testnet-10" | "mainnet" {
  return networkId.includes("mainnet") && !networkId.includes("test") ? "mainnet" : "testnet-10";
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

export async function handleCampaignHttp(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  // GET /campaign/:id (HTML) — not /campaign/app.js (static assets)
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
      /* page still renders; client will refresh */
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
    if (Date.now() >= Number(rec.deadlineMs)) return json({ error: "Campaign deadline has passed" }, 400);
    try {
      const built = campaignFundBuild(rec, backerAddress, amountSompi);
      resolveTemplateBytecodeForFund({
        templateId: "aon_pledge",
        ownerAddress: rec.ownerAddress,
        backerAddress,
        campaignTagHex: rec.campaignTagHex,
        goalSompi: rec.goalSompi,
        deadlineMs: rec.deadlineMs,
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

  if (request.method === "POST" && /\/api\/campaign\/[^/]+\/reclaim$/.test(path)) {
    const id = path.split("/")[3] || "";
    const rec = await getCampaignPage(id);
    if (!rec) return json({ error: "Campaign not found" }, 404);
    if (Date.now() < Number(rec.deadlineMs)) return json({ error: "Deadline not reached yet" }, 400);
    const body = await readBody(request);
    const backerAddress = String(body.backerAddress || "").trim();
    if (!backerAddress) return json({ error: "backerAddress required" }, 400);
    try {
      const derived = derivePledgeForBacker(rec, backerAddress);
      const net = netKaspa(rec.networkId);
      const { json: utxos } = await fetchRestJson<
        Array<{
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
        }>
      >(net, `/addresses/${encodeURIComponent(derived.p2shAddress)}/utxos`);
      const list = Array.isArray(utxos) ? utxos : [];
      if (!list.length) return json({ error: "No pledge UTXO found for this wallet" }, 404);
      const row = list[0]!;
      const entryRow = row.utxoEntry ?? row;
      const amount = BigInt((entryRow as { amount?: string | number }).amount ?? 0);
      const tpl = getTemplate("aon_pledge").loadedExample;
      const loaded = rebindAoNPledge(tpl, {
        ownerPkhHex: rec.ownerPkhHex,
        backerPkhHex: derived.backerPkhHex,
        campaignTagHex: rec.campaignTagHex,
        goalSompi: BigInt(rec.goalSompi),
        deadline: BigInt(rec.deadlineMs),
      });
      const entry = entryOf(loaded, "reclaim");
      const fee = 3500000n;
      const outAmt = amount - fee;
      if (outAmt <= 0n) return json({ error: "Pledge too small to reclaim after fee" }, 400);

      let script = "";
      let version = 0;
      const spkRaw = (entryRow as { scriptPublicKey?: unknown }).scriptPublicKey;
      if (typeof spkRaw === "string") script = spkRaw;
      else if (spkRaw && typeof spkRaw === "object") {
        const o = spkRaw as { scriptPublicKey?: string; script?: string; version?: number };
        script = o.scriptPublicKey || o.script || "";
        version = o.version ?? 0;
      }

      const isTestnet = net === "testnet-10";
      const bytecodeHex = [...loaded.bytecode].map((b) => b.toString(16).padStart(2, "0")).join("");
      const l1Build: L1BrowserBuild = {
        buildInBrowser: true,
        kaspaNetwork: kaspaNetworkFor(rec.networkId, isTestnet),
        utxoApiBase: utxoApiBaseFor(rec.networkId, isTestnet),
        bytecodeHex,
        entryName: "reclaim",
        dispatchTag: entry.dispatch_tag,
        entryParams: entry.params,
        args: [null, null],
        destinationAddress: backerAddress,
        feeSompi: String(fee),
        outputAmountSompi: String(outAmt),
        lockTimeMs: String(rec.deadlineMs),
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

  return null;
}
