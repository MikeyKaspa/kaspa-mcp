#!/usr/bin/env node
/**
 * Fresh-user MCP-over-HTTP smoke against deployed Worker (or MCP_URL).
 * No secrets. Exercises initialize, tools/list annotations, choose_network,
 * tipjar/crowdfund/lockbox prepare paths, connector_version, legal pages.
 */
const BASE = (process.env.MCP_URL || "https://kaspa-mcp.kaspa-mcp.workers.dev").replace(/\/$/, "");
const MCP = BASE.endsWith("/mcp") ? BASE : `${BASE}/mcp`;
const ORIGIN = MCP.replace(/\/mcp$/, "");

async function rpc(method, params = {}, id = 1) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // SSE-ish
    const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
    body = dataLine ? JSON.parse(dataLine.slice(6)) : { raw: text };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function callTool(name, args = {}) {
  const result = await rpc("tools/call", { name, arguments: args }, Math.floor(Math.random() * 1e6));
  const text = result?.content?.[0]?.text ?? JSON.stringify(result);
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* plain */
  }
  return { result, text, parsed, isError: !!result?.isError };
}

const out = { ok: false, base: ORIGIN, mcp: MCP, steps: [] };
function step(name, data) {
  out.steps.push({ name, ...data });
  console.log("OK", name, data.note || "");
}

try {
  const init = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "kaspa-fresh-e2e", version: "0.1.0" },
  });
  step("initialize", { server: init?.serverInfo?.name, version: init?.serverInfo?.version });

  // notifications/initialized is optional for many servers
  try {
    await fetch(MCP, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
  } catch {
    /* ignore */
  }

  const listed = await rpc("tools/list", {});
  const tools = listed.tools || [];
  const missingAnn = tools.filter((t) => !t.annotations?.title || typeof t.annotations.readOnlyHint !== "boolean");
  if (tools.length < 40) throw new Error(`expected ~42 tools, got ${tools.length}`);
  if (missingAnn.length) throw new Error(`tools missing annotations: ${missingAnn.map((t) => t.name).join(",")}`);
  step("tools/list", { count: tools.length, annotated: tools.length - missingAnn.length });

  const ver = await callTool("connector_version", {});
  step("connector_version", { version: ver.parsed?.version || ver.text.slice(0, 80) });

  const net = await callTool("choose_network", { choice: "testnet" });
  step("choose_network", { note: (net.text || "").slice(0, 120) });

  // Tipjar path — may ask for address; still validates routing
  const tip = await callTool("l1_tipjar_chat_deploy", {});
  step("l1_tipjar_chat_deploy", {
    note: tip.isError ? "error-ok-needs-args" : "ok",
    snippet: tip.text.slice(0, 160),
  });

  const aon = await callTool("l1_aon_create_campaign", {});
  step("l1_aon_create_campaign", {
    note: aon.isError || /owner|address|need|required/i.test(aon.text) ? "prompts-for-owner" : "ok",
    snippet: aon.text.slice(0, 160),
  });

  const lock = await callTool("l1_lockbox_chat_deploy", {});
  step("l1_lockbox_chat_deploy", { snippet: lock.text.slice(0, 120) });

  for (const path of ["/privacy", "/terms", "/support", "/health", "/brand/logo.svg"]) {
    const r = await fetch(ORIGIN + path);
    if (!r.ok) throw new Error(`${path} -> ${r.status}`);
    const ct = r.headers.get("content-type") || "";
    step(`GET ${path}`, { status: r.status, contentType: ct.split(";")[0] });
  }

  out.ok = true;
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
} catch (e) {
  out.error = String(e?.stack || e);
  console.error(JSON.stringify(out, null, 2));
  process.exit(1);
}
