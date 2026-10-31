/**
 * Guided self_host wizard — everyday-user steps for launching their own copy.
 * Never prints or invents private keys; shared demo stays keyless.
 *
 * Design goal: a brand-new user can go from "nothing" to chat-deploy on testnet
 * with as few human actions as possible. Unavoidable: Cloudflare signup (or
 * local Node), one Kaspa address they control, and one funding send (faucet).
 */
import { isSharedPublicDemo, spendingWalletStatus } from "./spending-wallet.js";
import { getNetwork } from "./networks.js";
import { SAFETY_BANNER } from "./safety.js";
import { L1_UNAUDITED_WARNING } from "./l1/kaspa-sdk.js";

export type SelfHostStep =
  | "start"
  | "deploy"
  | "create_wallet"
  | "set_secret"
  | "fund"
  | "verify"
  | "connect"
  | "status"
  | "own_node"
  | "update";

export type SelfHostPlatform = "cloudflare" | "local";

export type SelfHostArgs = {
  step?: SelfHostStep;
  platform?: SelfHostPlatform;
  mainAddress?: string;
  workerUrl?: string;
};

function code(block: string): string {
  return "```bash\n" + block.trim() + "\n```";
}

const KNOWN_STEPS: SelfHostStep[] = [
  "start",
  "deploy",
  "connect",
  "create_wallet",
  "set_secret",
  "fund",
  "verify",
  "status",
  "own_node",
  "update",
];

export async function runSelfHostGuide(args: SelfHostArgs): Promise<Record<string, unknown>> {
  const step: SelfHostStep = args.step ?? "start";
  const platform: SelfHostPlatform = args.platform ?? "cloudflare";
  const shared = isSharedPublicDemo();
  const base = {
    safety: SAFETY_BANNER,
    warning: L1_UNAUDITED_WARNING,
    sharedDemo: shared,
    step,
    platform,
    note: shared
      ? "You are on the shared public demo (keyless — safe for everyone). This guide sets up YOUR own free copy so the bot can deploy without approval popups. Secrets never go on the shared demo."
      : "You are on your own copy. Finish any remaining steps below; spending-wallet tools work here.",
  };

  if (step === "start" || step === "status") {
    let liveStatus: unknown;
    if (!shared) {
      try {
        liveStatus = await spendingWalletStatus(getNetwork("kaspa-l1-testnet-10"));
      } catch {
        liveStatus = undefined;
      }
    }
    return {
      ...base,
      headline: "Get your own Kaspa connector (free) — then chat-deploy with no popups",
      plainEnglish: [
        "The public connector never holds keys, so every deploy needs your approval tap.",
        "Your own copy can hold a tiny capped spending wallet on YOUR Cloudflare account only — then you say “build me a tip jar” and it just does it.",
        "Testnet first (free play money). Mainnet only when you say so, with a clear warning.",
      ],
      beforeYouStart: [
        "A free Cloudflare account (dash.cloudflare.com — email signup).",
        "Any Kaspa wallet address you control for testnet (kaspatest:…). Kaspium / KasWare / etc. — this is only where leftovers can be withdrawn.",
        "About 2 minutes, and one free faucet top-up later.",
      ],
      humanActionCount: {
        unavoidable: [
          "Cloudflare signup (once)",
          "Paste your kaspatest: address once",
          "Fund spending address once from the free faucet (or a friend)",
          "Paste your new /mcp URL into Claude / Cursor once",
        ],
        botHandles: [
          "Deploy Worker (via one-command script or copy-paste)",
          "Create spending wallet",
          "Remember testnet vs mainnet",
          "Build + deploy contracts from chat",
        ],
      },
      askUser:
        "Do you want phone-friendly hosting (Cloudflare, recommended) or run on your own computer (local Node)?",
      next: {
        cloudflare: 'Call self_host({ step: "deploy", platform: "cloudflare" })',
        local: 'Call self_host({ step: "deploy", platform: "local" })',
      },
      liveStatus,
      overviewSteps: [
        "0. Get a free Cloudflare account + a kaspatest: address (wallet app).",
        "1. Deploy your copy (one command below — or the Deploy button for keyless-only).",
        "2. Point your AI at YOUR …/mcp URL (replace the public one).",
        "3. Answer: Testnet or mainnet? → choose_network.",
        "4. spending_wallet_create with your main kaspatest: address.",
        "5. Lock the one-shot key into YOUR Cloudflare secret (one copy-paste).",
        "6. Fund the spending address from the TN10 faucet.",
        "7. Verify, then say “build me a tip jar”.",
        "Later: connector_version → if behind, self_host({ step: \"update\" }) (secrets/KV preserved; never auto).",
      ],
      trapToAvoid:
        "The big blue “Deploy to Cloudflare” button alone gives a keyless copy (tap-to-approve only). For no-popup chat-deploy you must use wrangler.selfhost.toml or npm run selfhost:setup.",
    };
  }

  if (step === "deploy") {
    if (platform === "local") {
      return {
        ...base,
        title: "Run on your computer (Node 20+)",
        humanSteps: [
          "Open a terminal.",
          "Copy-paste the block below.",
          "When you see MCP: http://127.0.0.1:8787/mcp, tell your AI that URL.",
        ],
        commands: code(`
git clone https://github.com/MikeyKaspa/kaspa-mcp
cd kaspa-mcp
npm install
npm test
npm start
# MCP URL → http://127.0.0.1:8787/mcp
`),
        next: 'Call self_host({ step: "connect", platform: "local", workerUrl: "http://127.0.0.1:8787/mcp" })',
      };
    }
    return {
      ...base,
      title: "Deploy your free copy on Cloudflare (no-popup ready)",
      humanSteps: [
        "Recommended (one command after Cloudflare login): clone once, then npm run selfhost:setup — it deploys the self-host Worker and prints your /mcp URL.",
        "Or copy-paste the short commands below.",
        "Avoid the generic “Deploy to Cloudflare” button if you want no-popup deploys — that button installs the keyless public config.",
      ],
      oneClickKeylessOnly:
        "https://deploy.workers.cloudflare.com/?url=https://github.com/MikeyKaspa/kaspa-mcp",
      oneClickNote:
        "Keyless only (tap-to-approve). For chat-deploy without popups use the commands / selfhost:setup below.",
      commands: code(`
git clone https://github.com/MikeyKaspa/kaspa-mcp
cd kaspa-mcp
npm install
npx wrangler login
npm run selfhost:setup
# or: npx wrangler deploy -c wrangler.selfhost.toml
# Note the https://….workers.dev URL — your MCP URL is that + /mcp
`),
      tip: "Stay on Cloudflare’s free plan. workers.dev is enough — no custom domain.",
      next: 'After deploy, call self_host({ step: "connect", platform: "cloudflare", workerUrl: "https://<your-worker>.workers.dev/mcp" })',
    };
  }

  if (step === "connect") {
    const url =
      args.workerUrl?.trim() ||
      (platform === "local"
        ? "http://127.0.0.1:8787/mcp"
        : "https://<your-worker>.workers.dev/mcp");
    return {
      ...base,
      title: "Point your AI at YOUR connector",
      mcpUrl: url,
      humanSteps: [
        "In Claude / Cursor / Grok Bot, add or replace the MCP connector.",
        "Paste the URL below (Streamable HTTP / no sign-in).",
        "Remove or disable the public shared demo URL so tools hit YOUR copy.",
        "Then continue with create_wallet.",
      ],
      pasteThisUrl: url,
      claudeHint: "Settings → Connectors → Add custom connector → paste URL → No sign-in",
      cursorHint: "Settings → MCP → Add server → URL / Streamable HTTP → paste URL",
      next: 'Call self_host({ step: "create_wallet", mainAddress: "kaspatest:YOUR_MAIN_ADDRESS" })',
      needFromUser:
        "Your main/cold TN10 address (kaspatest:…) — the only place withdraw_all can send. If you don’t have one yet: install Kaspium or KasWare, create a testnet wallet, copy the address.",
    };
  }

  if (step === "create_wallet") {
    const main = args.mainAddress?.trim();
    if (!main) {
      return {
        ...base,
        title: "Create a dedicated spending wallet",
        needFromUser:
          "Paste your main TN10 address (kaspatest:…). This locks withdrawals so a bad prompt cannot redirect funds.",
        askUser: "What is your main kaspatest: address?",
        next: 'Call self_host({ step: "create_wallet", mainAddress: "kaspatest:…" }) or spending_wallet_create({ mainAddress }) on YOUR Worker.',
        refusedOnSharedDemo: shared,
      };
    }
    if (shared) {
      return {
        ...base,
        title: "Create spending wallet — on YOUR copy only",
        error:
          "The shared public demo refuses spending_wallet_create (keyless by design). Finish deploy + connect to YOUR Worker URL, then retry create_wallet there.",
        onYourWorker: `Call spending_wallet_create({ mainAddress: "${main}" }) against your self-host /mcp URL.`,
        next: 'self_host({ step: "set_secret" }) after create returns the one-shot key on Cloudflare.',
      };
    }
    return {
      ...base,
      title: "Ready to create",
      instruction:
        "Call spending_wallet_create now with the mainAddress below. On Cloudflare you get a one-shot privateKeyHex — use it only for the next secret step; never paste it into the shared demo or a public chat.",
      mainAddress: main,
      toolCall: {
        name: "spending_wallet_create",
        arguments: { mainAddress: main, network: "kaspa-l1-testnet-10" },
      },
      next: 'After create: self_host({ step: "set_secret" })',
    };
  }

  if (step === "set_secret") {
    return {
      ...base,
      title: "Lock the spending key into YOUR Cloudflare secret",
      plainEnglish:
        "This is the one scary-looking step. You are saving the key on YOUR Cloudflare account only — not in chat history afterward, and never on the shared demo.",
      humanSteps: [
        "Copy the one-shot privateKeyHex from spending_wallet_create (Cloudflare path).",
        "In your kaspa-mcp folder, run the command below (stdin so the key is less likely to land in shell history).",
        "If you used npm run selfhost:setup, it may already have done this — check spending_wallet_status.",
        "Never commit the key. Never put it on the shared demo.",
      ],
      commands: code(`
# Replace 0xYOUR_KEY with the one-shot key from spending_wallet_create
# Use the same -c file you deployed with (usually wrangler.selfhost.toml)
printf '%s' '0xYOUR_KEY' | npx wrangler secret put KASPA_SPENDING_PRIVATE_KEY -c wrangler.selfhost.toml
`),
      localNote:
        "Local Node: create already wrote .kaspa-spending.key (mode 600). Skip wrangler secret put.",
      next: 'self_host({ step: "fund" })',
    };
  }

  if (step === "fund") {
    return {
      ...base,
      title: "Fund the spending address (testnet — free)",
      humanSteps: [
        "Call spending_wallet_status to see the spending address (never the key).",
        "Open the TN10 faucet and paste that spending address (or send a little tKAS from your main wallet).",
        "Wait until balance shows, then verify.",
      ],
      faucetUrl: "https://faucet-tn10.kaspanet.io/",
      toolCall: { name: "spending_wallet_status", arguments: { network: "kaspa-l1-testnet-10" } },
      next: 'self_host({ step: "verify" })',
    };
  }

  if (step === "verify") {
    let status: unknown;
    let ok = false;
    if (!shared) {
      try {
        status = await spendingWalletStatus(getNetwork("kaspa-l1-testnet-10"));
        ok = Boolean((status as { configured?: boolean }).configured);
      } catch (e) {
        status = { error: e instanceof Error ? e.message : String(e) };
      }
    }
    return {
      ...base,
      title: "Verify spending wallet",
      status,
      verified: ok,
      humanSteps: ok
        ? [
            "Spending wallet is configured on this copy.",
            "Try: choose_network({ choice: \"testnet\" }) then say “build me a tip jar” (l1_tipjar_chat_deploy).",
            "Or keep using tap-to-approve without the spending wallet.",
          ]
        : [
            shared
              ? "Still on the shared demo — connect to YOUR Worker URL and re-run verify there."
              : "Not configured yet. Finish create_wallet + set_secret + fund, then verify again.",
          ],
      next: ok
        ? 'choose_network({ choice: "testnet" }) → l1_tipjar_chat_deploy'
        : 'self_host({ step: "create_wallet" }) or set_secret / fund',
    };
  }

  if (step === "update") {
    return {
      ...base,
      title: "Update your copy to the latest release (secrets preserved)",
      plainEnglish:
        "This never runs automatically. You pull the latest code and redeploy; Cloudflare keeps your Worker secrets and KV data.",
      humanSteps: [
        "Open a terminal in your kaspa-mcp folder (the one you deployed from).",
        "Copy-paste the commands below.",
        "Confirm /health shows the new version.",
        "Spending wallet secret and SIGN_SESSIONS KV stay on YOUR account — do not re-run secret put unless you rotated keys.",
      ],
      commands: code(`
cd kaspa-mcp
git fetch origin
git pull origin main
npm install
npm test
# Redeploy the SAME config you used before (keeps name + KV binding + secrets):
npx wrangler deploy -c wrangler.selfhost.toml
# Optional: confirm
curl -s https://<your-worker>.workers.dev/health | grep version
`),
      neverAutoUpdate: true,
      tip: "If you used a custom wrangler.*.toml name, pass that -c file instead. Secrets are not in git.",
      next: 'self_host({ step: "verify" }) or spending_wallet_status',
    };
  }

  if (step === "own_node") {

    return {
      ...base,
      title: "Point at your own Kaspa node (optional)",
      plainEnglish:
        "By default the connector uses public Kaspa API servers (with automatic failover). For full independence, run kaspa-rest-server and set KASPA_REST_URLS on your Worker.",
      humanSteps: [
        "Run a kaspa-rest-server against your node.",
        "On your Worker: wrangler secret put KASPA_REST_URLS (comma-separated HTTPS URLs).",
        "Or call configure_node from chat if your copy exposes it.",
      ],
      next: 'self_host({ step: "status" })',
    };
  }

  return {
    ...base,
    error: `Unknown step "${step}"`,
    knownSteps: KNOWN_STEPS,
  };
}
