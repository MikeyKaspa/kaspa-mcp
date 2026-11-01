import type { SignStore } from "./store.js";
import { signPageHtml, signCsp, SIGN_CSS, SIGN_APP_JS } from "./page.js";
import { summarizeL1SafeJson, summarizeEvmPrepared, explorerFor } from "./summary.js";
import { renderSVG } from "uqr";
import { resolveTemplateBytecodeForFund } from "../l1/resolve-template-bytecode.js";
import { setSessionBoundWallet } from "../session-bound-wallet.js";
import { createAoNCampaign } from "../crowdfund.js";
import { createCampaignPage } from "../campaign-page.js";

export async function handleSignHttp(
  request: Request,
  store: SignStore,
): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;

  if (pathname === "/sign/app.js") {
    return new Response(SIGN_APP_JS, {
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        "Content-Security-Policy": signCsp("asset"),
      },
    });
  }
  if (pathname === "/sign/app.css") {
    return new Response(SIGN_CSS, {
      headers: {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    });
  }

  const pageMatch = pathname.match(/^\/sign\/([a-f0-9]{32})$/i);
  if (pageMatch && request.method === "GET") {
    const id = pageMatch[1]!;
    const session = await store.get(id);
    const nonce = crypto.randomUUID().replace(/-/g, "");
    return new Response(signPageHtml(id, session, nonce), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": signCsp(nonce),
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  const apiMatch = pathname.match(/^\/api\/sign\/([a-f0-9]{32})$/i);
  if (apiMatch && request.method === "GET") {
    const id = apiMatch[1]!;
    const session = await store.get(id);
    if (!session) {
      return Response.json({ error: "Unknown or expired sign session" }, { status: 404 });
    }
    // Strip nothing sensitive — sessions never hold keys. Still omit huge redundancy.
    let summary;
    try {
      if (session.kind === "l1-fund" || session.kind === "l1-spend" || session.kind === "l1-send") {
        const json = session.signedSafeJson || session.safeJson;
        if (json) {
          summary = summarizeL1SafeJson(json, {
            kind: session.kind,
            networkLabel: session.networkLabel,
            isMainnet: session.isMainnet,
          });
        } else if (session.l1Build?.buildInBrowser) {
          // Provisional — page rebuilds summary from the tx it constructs
          summary = {
            title:
              (session.kind === "l1-fund"
                ? "Fund covenant on "
                : session.kind === "l1-send"
                  ? "Send KAS on "
                  : "Spend covenant on ") +
              session.networkLabel,
            lines: [
              { label: "Network", value: session.networkLabel },
              { label: "Mode", value: "Build in browser with kaspa-wasm" },
              ...(session.l1Build.amountSompi
                ? [{ label: "Amount (requested)", value: `${Number(session.l1Build.amountSompi) / 1e8} KAS` }]
                : []),
              ...(session.l1Build.fromAddress
                ? [{ label: "From", value: session.l1Build.fromAddress }]
                : []),
              ...(session.l1Build.destinationAddress
                ? [{ label: "Destination", value: session.l1Build.destinationAddress }]
                : []),
            ],
            warnings: session.isMainnet
              ? [
                  "MAINNET: UNAUDITED / USE AT YOUR OWN RISK. Final amounts come from the built tx — confirm in wallet.",
                ]
              : [],
          };
        } else {
          throw new Error("session missing SafeJSON and browser build params");
        }
      } else if (session.evm) {
        summary = summarizeEvmPrepared(session.evm, {
          kind: session.kind as "evm-deploy" | "evm-call",
          networkLabel: session.networkLabel,
          isMainnet: session.isMainnet,
          contractName: session.meta?.contractName,
        });
      } else {
        throw new Error("unsupported session");
      }
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
    return Response.json({
      session: {
        id: session.id,
        kind: session.kind,
        networkId: session.networkId,
        networkLabel: session.networkLabel,
        isMainnet: session.isMainnet,
        expiresAt: session.expiresAt,
        safeJson: session.safeJson,
        signedSafeJson: session.signedSafeJson,
        signInputs: session.signInputs,
        l1Build: session.l1Build,
        evm: session.evm,
        meta: session.meta,
      },
      summary,
    });
  }

  const expMatch = pathname.match(/^\/api\/sign\/([a-f0-9]{32})\/explorer$/i);
  if (expMatch && request.method === "GET") {
    const id = expMatch[1]!;
    const session = await store.get(id);
    const txid = url.searchParams.get("txid") || "";
    if (!session || !/^[a-fA-F0-9x]+$/.test(txid)) {
      return Response.json({ error: "bad request" }, { status: 400 });
    }
    const clean = txid.replace(/^0x/, "");
    session.submittedTxid = clean;
    session.submittedAt = Date.now();
    await store.put(session);
    return Response.json({ url: explorerFor(session.networkId, clean), submittedTxid: clean });
  }

  const statusMatch = pathname.match(/^\/api\/sign\/([a-f0-9]{32})\/status$/i);
  if (statusMatch && request.method === "GET") {
    const session = await store.get(statusMatch[1]!);
    if (!session) return Response.json({ error: "Unknown or expired sign session", status: "unknown" }, { status: 404 });
    const submitted = Boolean(session.submittedTxid);
    return Response.json({
      id: session.id,
      kind: session.kind,
      status: submitted ? "submitted" : "pending",
      submittedTxid: session.submittedTxid || null,
      submittedAt: session.submittedAt || null,
      explorerUrl: session.submittedTxid
        ? explorerFor(session.networkId, session.submittedTxid)
        : null,
      expiresAt: session.expiresAt,
      networkId: session.networkId,
      meta: session.meta || {},
    });
  }




  const bindMatch = pathname.match(/^\/api\/sign\/([a-f0-9]{32})\/bind$/i);
  if (bindMatch && request.method === "POST") {
    const id = bindMatch[1]!;
    const session = await store.get(id);
    if (!session) {
      return Response.json({ error: "Unknown or expired sign session" }, { status: 404 });
    }
    let body: { address?: string; clientKey?: string } = {};
    try {
      body = (await request.json()) as { address?: string; clientKey?: string };
    } catch {
      return Response.json({ error: "JSON body required" }, { status: 400 });
    }
    const address = String(body.address || "").trim();
    if (!address) return Response.json({ error: "address required" }, { status: 400 });
    const kaspaNetwork = session.l1Build?.kaspaNetwork || (session.isMainnet ? "mainnet" : "testnet-10");
    if (kaspaNetwork === "testnet-10" && !address.toLowerCase().startsWith("kaspatest:")) {
      return Response.json({ error: "address must be kaspatest: on testnet-10" }, { status: 400 });
    }
    if (kaspaNetwork === "mainnet" && (!address.toLowerCase().startsWith("kaspa:") || address.toLowerCase().startsWith("kaspatest:"))) {
      return Response.json({ error: "address must be kaspa: on mainnet" }, { status: 400 });
    }

    const meta = { ...(session.meta || {}) } as Record<string, unknown>;
    const bindKind = String(meta.bindKind || session.kind);

    try {
      if (bindKind === "aon-create" || meta.aonCreate) {
        const goalSompi = meta.goalSompi != null ? meta.goalSompi : "100000000";
        const c = createAoNCampaign({
          ownerAddress: address,
          goalSompi: goalSompi as string | number,
          deadlineMs: meta.deadlineMs as string | number | undefined,
          graceMs: meta.graceMs as string | number | undefined,
          network: kaspaNetwork,
        });
        const page = await createCampaignPage({
          networkId: session.networkId,
          ownerAddress: address,
          ownerPkhHex: c.ownerPkhHex,
          campaignTagHex: c.campaignTagHex,
          goalSompi: c.goalSompi,
          deadlineMs: c.deadlineMs,
          graceMs: c.graceMs,
          refundOpensAtMs: c.refundOpensAtMs,
          title: "All-or-nothing crowdfund",
        });
        meta.ownerAddress = address;
        meta.boundAddress = address;
        meta.aonCampaign = c;
        meta.sharePageUrl = page.url;
        meta.sharePageId = page.record.id;
        meta.quickStartBind = false;
        session.meta = meta;
        if (session.l1Build) {
          session.l1Build.fromAddress = address;
          session.l1Build.quickStartBind = false;
        }
        await store.put(session);
        await setSessionBoundWallet({
          address,
          networkId: session.networkId,
          kaspaNetwork,
          source: "quick_start_bind",
          clientKey: body.clientKey,
        });
        return Response.json({
          ok: true,
          boundAddress: address,
          sharePage: { url: page.url, id: page.record.id },
          campaign: c,
          session: { id: session.id, l1Build: session.l1Build, meta: session.meta },
        });
      }

      // Fund / send bind
      if (!session.l1Build) {
        return Response.json({ error: "session missing l1Build" }, { status: 400 });
      }

      if (session.kind === "l1-send") {
        session.l1Build.fromAddress = address;
        session.l1Build.quickStartBind = false;
        meta.boundAddress = address;
        meta.fromAddress = address;
        meta.quickStartBind = false;
        session.meta = meta;
        await store.put(session);
        await setSessionBoundWallet({
          address,
          networkId: session.networkId,
          kaspaNetwork,
          source: "quick_start_bind",
          clientKey: body.clientKey,
        });
        return Response.json({
          ok: true,
          boundAddress: address,
          session: { id: session.id, l1Build: session.l1Build, meta: session.meta },
        });
      }

      // l1-fund: rebind template to owner
      const templateId = String(meta.templateId || meta.bindTemplateId || "tipjar");
      const resolvedBc = resolveTemplateBytecodeForFund({
        templateId,
        artifact: meta.bindArtifact,
        contractName: meta.contractName as string | undefined,
        bytecodeHex: meta.bindBytecodeHex as string | undefined,
        ownerAddress: address,
        ownerPkhHex: undefined,
        expectedP2shAddress: undefined,
        unlockAtMs: meta.unlockAtMs != null ? BigInt(String(meta.unlockAtMs)) : undefined,
        goalSompi: meta.goalSompi != null ? BigInt(String(meta.goalSompi)) : undefined,
        deadlineMs: meta.deadlineMs != null ? BigInt(String(meta.deadlineMs)) : undefined,
        backerAddress: meta.backerAddress as string | undefined,
        campaignTagHex: meta.campaignTagHex as string | undefined,
        recipientXonlyHex: meta.recipientXonlyHex as string | undefined,
        senderXonlyHex: meta.senderXonlyHex as string | undefined,
        arbiterAddress: meta.arbiterAddress as string | undefined,
        buyerXonlyHex: meta.buyerXonlyHex as string | undefined,
        sellerXonlyHex: meta.sellerXonlyHex as string | undefined,
        networkId: session.networkId,
      });
      session.l1Build.bytecodeHex = resolvedBc.bytecodeHex;
      session.l1Build.fromAddress = address;
      session.l1Build.expectedP2shAddress = resolvedBc.p2shAddress;
      session.l1Build.quickStartBind = false;
      meta.boundAddress = address;
      meta.ownerAddress = address;
      meta.fromAddress = address;
      meta.p2shAddress = resolvedBc.p2shAddress;
      meta.expectedP2shAddress = resolvedBc.p2shAddress;
      meta.ownerPkhHex = resolvedBc.ownerPkhHex;
      meta.rebound = resolvedBc.rebound;
      meta.quickStartBind = false;
      session.meta = meta;
      await store.put(session);
      await setSessionBoundWallet({
        address,
        networkId: session.networkId,
        kaspaNetwork,
        source: "quick_start_bind",
        clientKey: body.clientKey,
      });
      return Response.json({
        ok: true,
        boundAddress: address,
        p2shAddress: resolvedBc.p2shAddress,
        ownerPkhHex: resolvedBc.ownerPkhHex,
        rebound: resolvedBc.rebound,
        session: { id: session.id, l1Build: session.l1Build, meta: session.meta },
      });
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  }

  if (pathname === "/api/qr.svg" && request.method === "GET") {
    const data = (url.searchParams.get("data") || "").trim();
    if (!data || data.length > 200) {
      return new Response("bad request", { status: 400 });
    }
    // Only allow Kaspa addresses / short URLs — no arbitrary open redirect payloads
    if (!/^(kaspa:|kaspatest:|https:\/\/)/i.test(data)) {
      return new Response("unsupported qr payload", { status: 400 });
    }
    const svg = renderSVG(data, { ecc: "M", border: 2 });
    return new Response(svg, {
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
        "Content-Security-Policy": "default-src 'none'",
      },
    });
  }

  return null;
}
