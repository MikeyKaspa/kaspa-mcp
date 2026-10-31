import type { SignStore } from "./store.js";
import { signPageHtml, signCsp, SIGN_CSS, SIGN_APP_JS } from "./page.js";
import { summarizeL1SafeJson, summarizeEvmPrepared, explorerFor } from "./summary.js";

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
      if (session.kind === "l1-fund" || session.kind === "l1-spend") {
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
              (session.kind === "l1-fund" ? "Fund covenant on " : "Spend covenant on ") +
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


  return null;
}
