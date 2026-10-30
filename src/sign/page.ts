/** HTML shell for /sign/:id (strict CSP; assets from same origin).
 * script-src includes 'unsafe-eval' because official kaspa-wasm web glue
 * uses new Function (wasm-bindgen); wasm-unsafe-eval alone is not enough.
 */
import type { SignSession } from "./types.js";

export function signCsp(nonce: string): string {
  return (
    "default-src 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' 'nonce-" +
    nonce +
    "'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://api-tn10.kaspa.org https://api.kaspa.org wss://electron-10.kaspa.blue https://electron-10.kaspa.blue; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"
  );
}
/** @deprecated use signCsp(nonce) */
export const SIGN_CSP = signCsp("static");

export function signPageHtml(id: string, session?: SignSession | null, nonce?: string): string {
  const n = nonce || "";
  const safeId = id.replace(/[^a-zA-Z0-9]/g, "");
  const boot =
    session == null
      ? "null"
      : JSON.stringify({
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
          summary: null,
        }).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Approve Kaspa tx</title>
<link rel="stylesheet" href="/sign/app.css"/>
</head>
<body>
<main class="wrap">
  <h1>Tap to approve</h1>
  <p class="sub">Wallet signs on your device. This page never sees your keys. L1 txs are built in-browser with kaspa-wasm.</p>
  <div id="warn" class="warn" hidden></div>
  <div id="status" class="status">Loading…</div>
  <dl id="summary" class="summary"></dl>
  <div class="actions">
    <button id="connect" type="button" disabled>Connect wallet</button>
    <button id="approve" type="button" disabled>Approve</button>
  </div>
  <pre id="result" class="result" hidden></pre>
  <p class="fine">KasWare: requestAccounts → signPskt → pushTx. Fund builds here via createTransactions.</p>
</main>
<script nonce="${n}">window.__SIGN_ID__=${JSON.stringify(safeId)};window.__SIGN_BOOTSTRAP__=${boot};</script>
<script type="module" nonce="${n}" src="/sign/app.js"></script>
</body>
</html>`;
}

export const SIGN_CSS = ":root { color-scheme: dark light; --bg:#0b1220; --card:#121a2b; --fg:#e8eefc; --muted:#9aa8c7; --accent:#49eacb; --danger:#ff6b7a; --btn:#1e2a44; }\n@media (prefers-color-scheme: light) {\n  :root { --bg:#f4f7fb; --card:#fff; --fg:#102038; --muted:#5a6b88; --btn:#e8eef8; }\n}\n* { box-sizing: border-box; }\nbody { margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:var(--bg); color:var(--fg); }\n.wrap { max-width: 28rem; margin: 0 auto; padding: 1.25rem; }\nh1 { font-size: 1.35rem; margin: 0 0 .35rem; }\n.sub, .fine { color: var(--muted); font-size: .85rem; }\n.warn { background: #3a1520; color: #ffc9d0; border: 1px solid var(--danger); padding: .75rem; border-radius: .5rem; margin: .75rem 0; font-size: .9rem; }\n.status { margin: 1rem 0; font-weight: 600; }\n.summary { background: var(--card); border-radius: .75rem; padding: .75rem 1rem; margin: 0 0 1rem; }\n.summary dt { color: var(--muted); font-size: .75rem; margin-top: .55rem; }\n.summary dd { margin: .1rem 0 0; font-size: .95rem; word-break: break-all; }\n.actions { display: flex; gap: .5rem; flex-wrap: wrap; }\nbutton { flex: 1; min-width: 8rem; padding: .85rem 1rem; border-radius: .65rem; border: 0; background: var(--btn); color: var(--fg); font-weight: 700; font-size: 1rem; }\nbutton:disabled { opacity: .45; }\n#approve { background: var(--accent); color: #06261f; }\n.result { background: var(--card); padding: .75rem; border-radius: .5rem; overflow: auto; font-size: .8rem; }\na { color: var(--accent); }\n";

export const SIGN_APP_JS = "(function () {\n  var id = window.__SIGN_ID__;\n  var statusEl = document.getElementById(\"status\");\n  var warnEl = document.getElementById(\"warn\");\n  var summaryEl = document.getElementById(\"summary\");\n  var resultEl = document.getElementById(\"result\");\n  var connectBtn = document.getElementById(\"connect\");\n  var approveBtn = document.getElementById(\"approve\");\n\n  function status(t) { statusEl.textContent = t; }\n  function escapeHtml(s) {\n    return String(s).replace(/[&<>\"']/g, function (c) {\n      return ({ \"&\": \"&amp;\", \"<\": \"&lt;\", \">\": \"&gt;\", '\"': \"&quot;\", \"'\": \"&#39;\" })[c];\n    });\n  }\n  function detectL1() {\n    if (window.kasware) return { name: \"KasWare\", api: \"kasware\" };\n    if (window.kastle) return { name: \"Kastle\", api: \"kastle\" };\n    return null;\n  }\n  function renderSummary(derived) {\n    summaryEl.innerHTML = (derived.lines || []).map(function (l) {\n      return \"<dt>\" + escapeHtml(l.label) + \"</dt><dd>\" + escapeHtml(l.value) + \"</dd>\";\n    }).join(\"\");\n    if (derived.warnings && derived.warnings.length) {\n      warnEl.hidden = false;\n      warnEl.textContent = derived.warnings.join(\" \");\n    }\n    status(derived.title || \"Ready\");\n  }\n\n  var session = null;\n  var built = null;\n\n  function fetchBody() {\n    if (window.__SIGN_BOOTSTRAP__ && window.__SIGN_BOOTSTRAP__.session) {\n      return Promise.resolve(window.__SIGN_BOOTSTRAP__);\n    }\n    return fetch(\"/api/sign/\" + id).then(function (res) {\n      return res.text().then(function (text) {\n        var body;\n        try { body = JSON.parse(text); } catch (e) {\n          throw new Error(\"Bad /api/sign response: \" + text.slice(0, 80));\n        }\n        if (!res.ok) throw new Error(body.error || (\"HTTP \" + res.status));\n        return body;\n      });\n    });\n  }\n\n  function load() {\n    return fetchBody().then(function (body) {\n      if (body.error) throw new Error(body.error);\n      session = body.session;\n      if (!session) throw new Error(\"Unknown or expired sign session\");\n      if (session.l1Build && session.l1Build.buildInBrowser) {\n        status(\"Building transaction in browser (kaspa-wasm)\u2026\");\n        return import(\"/sign/l1-build.js\").then(function (mod) {\n          var p =\n            session.kind === \"l1-fund\"\n              ? mod.buildFundTx(session.l1Build)\n              : mod.buildSpendTx(session.l1Build);\n          return p.then(function (b) {\n            built = b;\n            var title =\n              session.kind === \"l1-fund\"\n                ? \"Fund covenant on \" + session.networkLabel\n                : \"Spend covenant on \" + session.networkLabel;\n            var json = b.signedSafeJson || b.safeJson;\n            var derived = mod.summarizeBuiltSafeJson(json, {\n              title: title,\n              networkLabel: session.networkLabel,\n              isMainnet: session.isMainnet,\n            });\n            if (b.p2shAddress) derived.lines.unshift({ label: \"P2SH\", value: b.p2shAddress });\n            if (b.mode === \"unsigned_needs_unlock\") {\n              derived.warnings = (derived.warnings || []).concat([b.note || \"Unlock not filled\"]);\n            }\n            renderSummary(derived);\n            connectBtn.disabled = false;\n          });\n        });\n      }\n      if (body.summary) renderSummary(body.summary);\n      built = {\n        safeJson: session.safeJson,\n        signedSafeJson: session.signedSafeJson,\n        signInputs: session.signInputs,\n      };\n      connectBtn.disabled = false;\n    });\n  }\n\n  function connect() {\n    if (!session) return Promise.resolve();\n    if (session.kind === \"l1-fund\" || session.kind === \"l1-spend\") {\n      var w = detectL1();\n      if (!w) return Promise.reject(new Error(\"Install KasWare or open in KasWare/Kastle in-app browser\"));\n      if (w.api === \"kasware\") {\n        return window.kasware.requestAccounts().then(function (accounts) {\n          return window.kasware.getNetwork().catch(function () { return \"\"; }).then(function (net) {\n            status(\"Connected KasWare: \" + (accounts[0] || \"\") + \" \u00b7 \" + net);\n            approveBtn.disabled = false;\n          });\n        });\n      }\n      var p = typeof window.kastle.connect === \"function\" ? window.kastle.connect() : Promise.resolve();\n      return p.then(function () {\n        status(\"Connected Kastle\");\n        approveBtn.disabled = false;\n      });\n    }\n    if (!window.ethereum) return Promise.reject(new Error(\"No injected EVM wallet\"));\n    return window.ethereum.request({ method: \"eth_requestAccounts\" }).then(function () {\n      status(\"Connected EVM wallet\");\n      approveBtn.disabled = false;\n    });\n  }\n\n  function approveL1() {\n    var w = detectL1();\n    if (!w) return Promise.reject(new Error(\"No L1 wallet\"));\n    var signed = built && built.signedSafeJson;\n    if (signed) {\n      if (w.api === \"kasware\") return window.kasware.pushTx(signed);\n      if (window.kastle && window.kastle.signAndBroadcastTx) {\n        return Promise.resolve(window.kastle.getNetwork ? window.kastle.getNetwork() : session.networkId).then(\n          function (net) { return window.kastle.signAndBroadcastTx(net, signed); },\n        );\n      }\n    }\n    var json = built && built.safeJson;\n    if (!json) return Promise.reject(new Error(\"Missing SafeJSON \u2014 build failed\"));\n    if (w.api === \"kasware\") {\n      var opts =\n        built.signInputs && built.signInputs.length ? { signInputs: built.signInputs } : undefined;\n      return window.kasware.signPskt({ txJsonString: json, options: opts }).then(function (s) {\n        return window.kasware.pushTx(s);\n      });\n    }\n    return Promise.resolve(window.kastle.getNetwork ? window.kastle.getNetwork() : \"testnet-10\").then(\n      function (net) {\n        if (typeof window.kastle.signAndBroadcastTx === \"function\") {\n          return window.kastle.signAndBroadcastTx(net, json);\n        }\n        throw new Error(\"Unsupported Kastle API\");\n      },\n    );\n  }\n\n  function approveEvm() {\n    if (!window.ethereum || !session.evm) return Promise.reject(new Error(\"No EVM session\"));\n    var tx = {\n      to: session.evm.to || undefined,\n      data: session.evm.data,\n      value:\n        session.evm.value && session.evm.value !== \"0\"\n          ? \"0x\" + BigInt(session.evm.value).toString(16)\n          : undefined,\n      gas: session.evm.gasLimit ? \"0x\" + BigInt(session.evm.gasLimit).toString(16) : undefined,\n      gasPrice: session.evm.gasPrice ? \"0x\" + BigInt(session.evm.gasPrice).toString(16) : undefined,\n    };\n    return window.ethereum.request({ method: \"eth_sendTransaction\", params: [tx] });\n  }\n\n  function approve() {\n    status(\"Approve in your wallet\u2026\");\n    var p = session.kind === \"l1-fund\" || session.kind === \"l1-spend\" ? approveL1() : approveEvm();\n    return p.then(function (txid) {\n      return fetch(\"/api/sign/\" + id + \"/explorer?txid=\" + encodeURIComponent(txid))\n        .then(function (r) { return r.json(); })\n        .then(function (body) {\n          var exp = body.url || String(txid);\n          status(\"Submitted\");\n          resultEl.hidden = false;\n          resultEl.innerHTML =\n            \"txid: \" +\n            escapeHtml(txid) +\n            \"<br/><a href=\\\"\" +\n            escapeHtml(exp) +\n            \"\\\" target=\\\"_blank\\\" rel=\\\"noopener\\\">Open explorer</a>\";\n        });\n    });\n  }\n\n  connectBtn.addEventListener(\"click\", function () {\n    connect().catch(function (e) { status(\"Connect failed: \" + (e && e.message || e)); });\n  });\n  approveBtn.addEventListener(\"click\", function () {\n    approve().catch(function (e) { status(\"Approve failed: \" + (e && e.message || e)); });\n  });\n  load().catch(function (e) { status(\"Load failed: \" + (e && e.message || e)); });\n})();\n";
