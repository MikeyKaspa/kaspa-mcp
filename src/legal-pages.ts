/**
 * Public legal / support HTML for connector directories (privacy, terms, support).
 * Served at /privacy, /terms, /support on Worker and Node.
 */
const BASE = "https://kaspa-mcp.kaspa-mcp.workers.dev";
const REPO = "https://github.com/MikeyKaspa/kaspa-mcp";
const YEAR = "2026";

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title} · kaspa-mcp</title>
<style>
  :root { color-scheme: light dark; --fg:#0f172a; --muted:#475569; --bg:#f8fafc; --card:#fff; --accent:#0891b2; --border:#e2e8f0; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e2e8f0; --muted:#94a3b8; --bg:#0b1220; --card:#111827; --accent:#22d3ee; --border:#1f2937; }
  }
  body { margin:0; font:16px/1.55 system-ui,sans-serif; background:var(--bg); color:var(--fg); }
  main { max-width:42rem; margin:0 auto; padding:2rem 1.25rem 4rem; }
  h1 { font-size:1.6rem; margin:0 0 .5rem; }
  h2 { font-size:1.1rem; margin:1.75rem 0 .5rem; }
  p,li { color:var(--muted); }
  a { color:var(--accent); }
  .card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:1.25rem 1.4rem; }
  nav { display:flex; gap:1rem; flex-wrap:wrap; margin:1rem 0 1.5rem; font-size:.9rem; }
  footer { margin-top:2rem; font-size:.85rem; color:var(--muted); }
</style>
</head>
<body>
<main>
<nav>
  <a href="/privacy">Privacy</a>
  <a href="/terms">Terms</a>
  <a href="/support">Support</a>
  <a href="${REPO}">GitHub</a>
</nav>
<div class="card">
${body}
</div>
<footer>kaspa-mcp · MIT · ${YEAR} · <a href="${BASE}/mcp">MCP endpoint</a></footer>
</main>
</body>
</html>`;
}

export function privacyHtml(): string {
  return page(
    "Privacy Policy",
    `
<h1>Privacy Policy</h1>
<p><strong>Effective date:</strong> 30 October 2026 · Version 1.0</p>
<p>This policy describes how the <strong>kaspa-mcp</strong> public connector
(<code>${BASE}</code>, open source at <a href="${REPO}">${REPO}</a>) handles information when you connect an AI assistant to it.</p>

<h2>1. Who we are</h2>
<p>kaspa-mcp is an open-source Model Context Protocol (MCP) server. The shared demo Worker is operated for community use. Self-hosted copies are operated by whoever deploys them — this policy covers the shared public demo unless your self-host publishes a different policy.</p>

<h2>2. What the service does</h2>
<p>The connector lets an AI assistant read public Kaspa network data, prepare unsigned transactions, and (on self-host with your consent) optionally auto-sign with a key you store on <em>your</em> deployment. The shared demo is keyless: it does not accept or store mainnet private keys.</p>

<h2>3. Data we process</h2>
<ul>
<li><strong>Request metadata:</strong> IP address (for rate limiting via Cloudflare), timestamps, tool names, and error codes.</li>
<li><strong>Tool inputs you send:</strong> addresses, amounts, network choice, contract parameters, and similar fields needed to prepare or look up transactions. Do not send seed phrases or mainnet private keys.</li>
<li><strong>Short-lived sessions:</strong> unsigned transaction payloads for tap-to-approve pages may be stored in Workers KV with a short TTL (about 15 minutes), then expire.</li>
<li><strong>Optional demo key header:</strong> if you set <code>X-Kaspa-Demo-Key</code>, it is used only as a rate-limit bucket identifier.</li>
</ul>

<h2>4. What we do not collect</h2>
<ul>
<li>Account passwords or Internet Identity-style credentials (the shared demo is open; no sign-in).</li>
<li>Mainnet private keys, mnemonics, or keystores (rejected by the connector).</li>
<li>Conversation history from your AI app beyond what the assistant includes in a tool call.</li>
<li>Advertising profiles or sale of personal data to third parties.</li>
</ul>

<h2>5. Third parties</h2>
<p>Requests may pass through Cloudflare (hosting and rate limiting) and public Kaspa REST/RPC endpoints you or the defaults configure. Those providers process connection data under their own policies. Explorers linked in responses are third-party sites.</p>

<h2>6. Retention</h2>
<p>Rate-limit counters are ephemeral. Sign/campaign/page KV entries expire by TTL or when overwritten. Cloudflare and edge logs follow Cloudflare's retention. We do not build long-term user profiles from chat content.</p>

<h2>7. Self-host</h2>
<p>If you deploy your own copy, you are the operator: keys in your secrets, your logs, your privacy obligations. The shared demo never receives your self-host spending key.</p>

<h2>8. Contact</h2>
<p>Questions or data requests: open a GitHub issue on <a href="${REPO}/issues">${REPO}/issues</a> with <code>privacy</code> in the title, or see <a href="/support">Support</a>.</p>
`,
  );
}

export function termsHtml(): string {
  return page(
    "Terms of Use",
    `
<h1>Terms of Use</h1>
<p><strong>Effective date:</strong> 30 October 2026 · Version 1.0</p>
<p>By using the kaspa-mcp shared demo or connecting an AI assistant to it, you agree to these terms.</p>

<h2>1. The service</h2>
<p>kaspa-mcp is free, open-source software (MIT License) that exposes MCP tools for Kaspa L1 SilverScript templates and related Kaspa-ecosystem networks. The shared Worker is a convenience demo with rate limits. It is provided <strong>as is</strong>, without warranty.</p>

<h2>2. Experimental / unaudited</h2>
<p>L1 covenant templates and prepare helpers are <strong>experimental and not security-audited</strong>. Funding or spending on-chain covenants — especially on mainnet — can result in permanent loss of funds. You alone are responsible for reviewing transactions before approving them in your wallet.</p>

<h2>3. Non-custodial</h2>
<p>The shared demo does not hold user funds or mainnet keys. Tap-to-approve flows show a summary derived from transaction bytes; your wallet signs. Self-host spending wallets keep keys on your infrastructure only.</p>

<h2>4. Acceptable use</h2>
<ul>
<li>Do not attempt to abuse rate limits, disrupt the service, or exploit others.</li>
<li>Do not submit malware or attempt to use the connector to steal keys or funds.</li>
<li>Comply with laws applicable to you. Cryptocurrency activity may be restricted where you live.</li>
</ul>

<h2>5. AI assistants</h2>
<p>Your AI provider (for example Claude, Cursor, or Grok Bot) processes prompts under its own terms. Tool calls they send to this connector are treated as actions you authorized through that assistant. Prefer reviewing destructive tool confirmations before allowing them.</p>

<h2>6. No financial advice</h2>
<p>Nothing from this connector is investment, legal, or tax advice.</p>

<h2>7. Limitation of liability</h2>
<p>To the fullest extent permitted by law, operators of the shared demo are not liable for lost funds, downtime, incorrect tool output, or third-party wallet/RPC failures. The MIT license disclaimer also applies to the software.</p>

<h2>8. Changes</h2>
<p>Terms may be updated in the GitHub repository; continued use of the shared demo after publication constitutes acceptance of the updated terms.</p>

<h2>9. Contact</h2>
<p>See <a href="/support">Support</a> or <a href="${REPO}/issues">GitHub issues</a>.</p>
`,
  );
}

export function supportHtml(): string {
  return page(
    "Support",
    `
<h1>Support</h1>
<p>Help for the kaspa-mcp connector (shared demo and self-host).</p>

<h2>Quick links</h2>
<ul>
<li>MCP endpoint: <a href="${BASE}/mcp"><code>${BASE}/mcp</code></a></li>
<li>Health: <a href="${BASE}/health"><code>/health</code></a></li>
<li>Source &amp; docs: <a href="${REPO}">${REPO}</a></li>
<li>Testnet faucet (TN10): <a href="https://faucet-tn10.kaspanet.io/">faucet-tn10.kaspanet.io</a></li>
<li>Privacy: <a href="/privacy">/privacy</a> · Terms: <a href="/terms">/terms</a></li>
</ul>

<h2>Common issues</h2>
<ul>
<li><strong>Rate limited / Error 1027:</strong> shared free Worker daily or per-minute caps. Self-host with the Deploy to Cloudflare button or <code>self_host</code> tool.</li>
<li><strong>Compile failed on Worker:</strong> Solidity compile is not available on the shared Worker. Self-host with Node, or pass bytecode + ABI to prepare/deploy tools.</li>
<li><strong>Need a txid:</strong> after tap-to-approve, ask the assistant to call <code>l1_check_session</code> / <code>l1_confirm_tx</code> — you should not need to paste a transaction ID.</li>
<li><strong>Mainnet warning:</strong> expected. Prefer testnet-10 until you understand the UNAUDITED risk.</li>
</ul>

<h2>Report a bug or security issue</h2>
<p>Open a GitHub issue at <a href="${REPO}/issues">${REPO}/issues</a>. For security reports, put <code>security</code> in the title and never include private keys or seed phrases. See also <a href="${REPO}/blob/main/SECURITY.md">SECURITY.md</a>.</p>

<h2>Contact</h2>
<p>Maintainer contact is via GitHub issues on the repository above. There is no phone support and no guarantee of response time for the free shared demo.</p>
`,
  );
}

export type LegalPath = "/privacy" | "/terms" | "/support";

export function handleLegalHttp(request: Request): Response | null {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  let html: string | null = null;
  if (path === "/privacy") html = privacyHtml();
  else if (path === "/terms") html = termsHtml();
  else if (path === "/support") html = supportHtml();
  else return null;
  return new Response(request.method === "HEAD" ? null : html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
