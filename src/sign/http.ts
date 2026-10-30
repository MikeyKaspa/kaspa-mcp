import type { SignStore } from "./store.js";
import { signPageHtml, SIGN_CSP, SIGN_CSS, SIGN_APP_JS } from "./page.js";
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
        "Content-Security-Policy": SIGN_CSP,
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
    return new Response(signPageHtml(id), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": SIGN_CSP,
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
        if (!json) throw new Error("session missing SafeJSON");
        summary = summarizeL1SafeJson(json, {
          kind: session.kind,
          networkLabel: session.networkLabel,
          isMainnet: session.isMainnet,
        });
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
    return Response.json({ url: explorerFor(session.networkId, txid.replace(/^0x/, "")) });
  }

  return null;
}
