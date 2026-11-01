/**
 * One-click Testnet / Mainnet selection across MCP hosts:
 * 1) elicitation/create (when client advertises elicitation)
 * 2) structured `choices` for host button widgets
 * 3) hosted /choose/<id> fallback page (KV-backed)
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { L1_UNAUDITED_WARNING } from "../l1/kaspa-sdk.js";
import {
  type NetworkChoice,
  type NetworkResolveAsk,
  type NetworkResolveOk,
  type NetworkResolveResult,
  resolveNetwork,
  setSessionNetworkChoice,
  getSessionNetworkPreference,
  ASK_NETWORK_PROMPT,
  DEFAULT_L1_TESTNET,
  DEFAULT_L1_MAINNET,
} from "../session-network.js";
import { DEFAULT_EVM_TESTNET } from "../networks.js";

export type NetworkChoiceItem = {
  id: NetworkChoice;
  label: string;
  description: string;
};

/** Canonical clickable options — keep descriptions visible on every host path. */
export const NETWORK_CHOICES: NetworkChoiceItem[] = [
  {
    id: "testnet",
    label: "Testnet",
    description:
      "Free test KAS (TN10 faucet). Safe to experiment — no real money at risk.",
  },
  {
    id: "mainnet",
    label: "Mainnet",
    description:
      "Real KAS. SilverScript / L1 helpers are UNAUDITED — use at your own risk. Quick-start wallet capped at 50 KAS.",
  },
];

export const HOST_BUTTON_INSTRUCTIONS =
  "Present these as ONE-CLICK options (native choice/button widget). " +
  "Show each option's description. NEVER ask the user to type testnet or mainnet. " +
  "When they tap an option, call choose_network({ choice }) with that id.";

type KvLike = {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  get(key: string): Promise<string | null>;
};

type ChooseSession = {
  id: string;
  clientKey: string;
  createdAt: string;
  expiresAt: number;
  chosen?: NetworkChoice;
};

type ChooseCtx = {
  kv: KvLike | null;
  publicBaseUrl: string | null;
  /** In-memory fallback for Node/tests */
  memory: Map<string, ChooseSession>;
};

function chooseCtx(): ChooseCtx {
  const g = globalThis as { __kaspaChooseCtx?: ChooseCtx };
  if (!g.__kaspaChooseCtx) {
    g.__kaspaChooseCtx = { kv: null, publicBaseUrl: null, memory: new Map() };
  }
  return g.__kaspaChooseCtx;
}

const CHOOSE_TTL_SEC = 60 * 30; // 30 min

export function setChooseNetworkContext(opts: {
  kv: KvLike | null;
  publicBaseUrl: string | null;
}): void {
  const c = chooseCtx();
  c.kv = opts.kv;
  c.publicBaseUrl = opts.publicBaseUrl;
}

function newChooseId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function kvKey(id: string): string {
  return `choose-net:${id}`;
}

export async function createChooseNetworkSession(clientKey: string): Promise<{
  id: string;
  url: string | null;
  expiresAt: string;
}> {
  const c = chooseCtx();
  const id = newChooseId();
  const expiresAt = Date.now() + CHOOSE_TTL_SEC * 1000;
  const sess: ChooseSession = {
    id,
    clientKey: clientKey || "local",
    createdAt: new Date().toISOString(),
    expiresAt,
  };
  c.memory.set(id, sess);
  if (c.kv) {
    await c.kv.put(kvKey(id), JSON.stringify(sess), { expirationTtl: CHOOSE_TTL_SEC });
  }
  const base = c.publicBaseUrl?.replace(/\/$/, "") || null;
  return {
    id,
    url: base ? `${base}/choose/${id}` : `/choose/${id}`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export async function getChooseNetworkSession(id: string): Promise<ChooseSession | null> {
  const c = chooseCtx();
  let sess = c.memory.get(id) || null;
  if (!sess && c.kv) {
    try {
      const raw = await c.kv.get(kvKey(id));
      if (raw) sess = JSON.parse(raw) as ChooseSession;
    } catch {
      return null;
    }
  }
  if (!sess) return null;
  if (Date.now() > sess.expiresAt) {
    c.memory.delete(id);
    return null;
  }
  return sess;
}

export async function applyChooseNetworkSelection(
  id: string,
  choice: NetworkChoice,
): Promise<{ ok: true; preference: Awaited<ReturnType<typeof setSessionNetworkChoice>> } | { ok: false; error: string }> {
  if (choice !== "testnet" && choice !== "mainnet") {
    return { ok: false, error: "choice must be testnet or mainnet" };
  }
  const sess = await getChooseNetworkSession(id);
  if (!sess) return { ok: false, error: "Unknown or expired choose session" };
  const pref = await setSessionNetworkChoice(choice, sess.clientKey);
  sess.chosen = choice;
  const c = chooseCtx();
  c.memory.set(id, sess);
  if (c.kv) {
    const remaining = Math.max(60, Math.floor((sess.expiresAt - Date.now()) / 1000));
    await c.kv.put(kvKey(id), JSON.stringify(sess), { expirationTtl: remaining });
  }
  return { ok: true, preference: pref };
}

export function networkChoicesPayload(): {
  choices: NetworkChoiceItem[];
  presentation: "clickable_buttons";
  hostInstructions: string;
  askUser: string;
} {
  return {
    choices: NETWORK_CHOICES,
    presentation: "clickable_buttons",
    hostInstructions: HOST_BUTTON_INSTRUCTIONS,
    askUser: ASK_NETWORK_PROMPT,
  };
}

export async function enrichAskPayload(
  ask: NetworkResolveAsk,
  clientKey: string,
): Promise<
  NetworkResolveAsk & {
    choices: NetworkChoiceItem[];
    presentation: "clickable_buttons";
    hostInstructions: string;
    chooseUrl?: string;
    chooseId?: string;
    chooseExpiresAt?: string;
    options: NetworkResolveAsk["options"];
  }
> {
  const choose = await createChooseNetworkSession(clientKey);
  return {
    ...ask,
    askUser: ASK_NETWORK_PROMPT,
    choices: NETWORK_CHOICES,
    presentation: "clickable_buttons",
    hostInstructions: HOST_BUTTON_INSTRUCTIONS,
    chooseUrl: choose.url || undefined,
    chooseId: choose.id,
    chooseExpiresAt: choose.expiresAt,
    options: {
      testnet: {
        l1: DEFAULT_L1_TESTNET,
        evm: DEFAULT_EVM_TESTNET,
        note: NETWORK_CHOICES[0]!.description,
      },
      mainnet: {
        l1: DEFAULT_L1_MAINNET,
        evm: "kasplex-mainnet",
        warning: `${L1_UNAUDITED_WARNING} Quick-start wallet capped at 50 KAS.`,
      },
    },
    hint: HOST_BUTTON_INSTRUCTIONS + ' Then call choose_network({ choice: "testnet" | "mainnet" }).',
  };
}

/** True when the connected MCP client advertised elicitation support. */
export function clientSupportsElicitation(mcp: McpServer): boolean {
  try {
    const caps = mcp.server.getClientCapabilities() as
      | { elicitation?: unknown }
      | undefined;
    return Boolean(caps && caps.elicitation !== undefined && caps.elicitation !== false);
  } catch {
    return false;
  }
}

export async function tryElicitNetworkChoice(mcp: McpServer): Promise<NetworkChoice | null> {
  if (!clientSupportsElicitation(mcp)) return null;
  try {
    const result = await mcp.server.elicitInput({
      mode: "form",
      message:
        "Choose a network before we build or deploy. Tap one option — do not type.",
      requestedSchema: {
        type: "object",
        properties: {
          network: {
            type: "string",
            title: "Network",
            description:
              "Testnet: free test KAS, safe to experiment. Mainnet: real KAS, UNAUDITED SilverScript, 50 KAS Quick-start cap.",
            enum: ["testnet", "mainnet"],
            enumNames: [
              "Testnet — free test KAS, safe to experiment",
              "Mainnet — real KAS; UNAUDITED; Quick-start 50 KAS cap",
            ],
          },
        },
        required: ["network"],
      },
    });
    if (result.action === "accept" && result.content) {
      const n = String((result.content as { network?: string }).network || "");
      if (n === "testnet" || n === "mainnet") return n;
    }
  } catch {
    // Client may reject elicitation mid-flight — fall through to choices /choose page.
  }
  return null;
}

export type GateNetworkOk = NetworkResolveOk;
export type GateNetworkAsk = { ok: false; response: { content: Array<{ type: string; text: string }>; isError?: boolean } };

/**
 * Resolve network for a write tool. Tries elicitation when advertised, else
 * returns a tool result with clickable `choices` + optional /choose/<id> URL.
 */
export async function gateNetworkChoice(
  mcp: McpServer,
  opts: Parameters<typeof resolveNetwork>[0],
  clientKey: string,
  wrapOk: (data: unknown) => GateNetworkAsk["response"],
): Promise<GateNetworkOk | GateNetworkAsk> {
  let resolved: NetworkResolveResult = resolveNetwork(opts);
  if (resolved.ok) return resolved;

  const elicited = await tryElicitNetworkChoice(mcp);
  if (elicited) {
    await setSessionNetworkChoice(elicited, clientKey);
    resolved = resolveNetwork(opts);
    if (resolved.ok) return resolved;
  }

  if (resolved.ok) return resolved;
  const enriched = await enrichAskPayload(resolved, clientKey);
  return { ok: false, response: wrapOk(enriched) };
}

/** For tests: clear in-memory choose sessions. */
export function clearChooseNetworkMemory(): void {
  chooseCtx().memory.clear();
}

export function choosePageHtml(sess: ChooseSession, origin: string): string {
  const testnet = NETWORK_CHOICES[0]!;
  const mainnet = NETWORK_CHOICES[1]!;
  const base = origin.replace(/\/$/, "");
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  if (sess.chosen) {
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Network selected</title>
<style>
body{font-family:system-ui,sans-serif;background:#0b1220;color:#e8eefc;margin:0;padding:2rem;display:flex;justify-content:center}
.card{max-width:28rem;background:#151d2e;border-radius:16px;padding:1.5rem;border:1px solid #2a3550}
h1{font-size:1.25rem;margin:0 0 .75rem}
.ok{color:#6ee7a8}
</style></head><body><div class="card">
<h1 class="ok">Saved: ${esc(sess.chosen === "testnet" ? "Testnet" : "Mainnet")}</h1>
<p>You can close this tab and return to your chat. The next tool call will use this network.</p>
</div></body></html>`;
  }
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Choose network</title>
<style>
:root{color-scheme:dark}
body{font-family:system-ui,-apple-system,sans-serif;background:#0b1220;color:#e8eefc;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.25rem}
.wrap{width:100%;max-width:28rem}
h1{font-size:1.35rem;margin:0 0 .5rem}
.sub{color:#9db0d0;margin:0 0 1.25rem;line-height:1.45;font-size:.95rem}
.btn{display:block;width:100%;text-align:left;border:none;border-radius:14px;padding:1.1rem 1.2rem;margin:0 0 .85rem;cursor:pointer;text-decoration:none;color:inherit;box-sizing:border-box}
.btn .label{font-size:1.15rem;font-weight:700;display:block;margin-bottom:.35rem}
.btn .desc{font-size:.9rem;line-height:1.4;opacity:.92}
.testnet{background:linear-gradient(135deg,#0f766e,#115e59);box-shadow:0 8px 24px rgba(15,118,110,.35)}
.mainnet{background:linear-gradient(135deg,#9a3412,#7c2d12);box-shadow:0 8px 24px rgba(154,52,18,.35)}
.btn:active{transform:scale(.98)}
.fine{font-size:.75rem;color:#7a8bab;margin-top:1rem}
</style></head><body><div class="wrap">
<h1>Choose a network</h1>
<p class="sub">One tap — no typing. This choice is remembered for your chat session.</p>
<a class="btn testnet" href="${base}/choose/${sess.id}?choice=testnet">
  <span class="label">${esc(testnet.label)}</span>
  <span class="desc">${esc(testnet.description)}</span>
</a>
<a class="btn mainnet" href="${base}/choose/${sess.id}?choice=mainnet">
  <span class="label">${esc(mainnet.label)}</span>
  <span class="desc">${esc(mainnet.description)}</span>
</a>
<p class="fine">Public connector · non-custodial · ${esc(L1_UNAUDITED_WARNING.slice(0, 80))}…</p>
</div></body></html>`;
}

const CHOOSE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

export async function handleChooseNetworkHttp(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/choose\/([a-f0-9]{32})$/i);
  if (!m) return null;
  const id = m[1]!;

  if (request.method === "GET") {
    const choiceParam = url.searchParams.get("choice");
    if (choiceParam === "testnet" || choiceParam === "mainnet") {
      const applied = await applyChooseNetworkSelection(id, choiceParam);
      if (!applied.ok) {
        return new Response(applied.error, { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      // Redirect to clean confirmation URL
      return Response.redirect(`${url.origin}/choose/${id}`, 303);
    }
    const sess = await getChooseNetworkSession(id);
    if (!sess) {
      return new Response("Unknown or expired network choice link", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return new Response(choosePageHtml(sess, url.origin), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": CHOOSE_CSP,
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
      },
    });
  }

  if (request.method === "POST") {
    let choice: string | null = null;
    const ct = request.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      try {
        const body = (await request.json()) as { choice?: string };
        choice = body.choice || null;
      } catch {
        choice = null;
      }
    } else {
      const form = await request.formData();
      choice = String(form.get("choice") || "");
    }
    if (choice !== "testnet" && choice !== "mainnet") {
      return Response.json({ error: "choice must be testnet or mainnet" }, { status: 400 });
    }
    const applied = await applyChooseNetworkSelection(id, choice);
    if (!applied.ok) return Response.json({ error: applied.error }, { status: 404 });
    return Response.json({ ok: true, choice, preference: applied.preference });
  }

  return new Response("Method not allowed", { status: 405 });
}

export { getSessionNetworkPreference };
