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
      headline: "Get your own free Kaspa connector — then I can deploy without approval popups",
      plainEnglish:
        "The shared public connector never holds keys, so every send needs your tap. Your own free Cloudflare copy can hold a tiny spending wallet on YOUR account only — then you say “build me a tip jar” and it just does it. Start on testnet (free test KAS).",
      youDo: [
        "1. Make a free Cloudflare account (dash.cloudflare.com) if you do not have one.",
        "2. Primary (zero install): open the Deploy to Cloudflare link below — no Node/npm/git needed. Or use the Cloudflare dashboard to create a Worker from this repo.",
        "3. In the Cloudflare dashboard → your Worker → Settings → Variables: add MCP_PUBLIC=false, and (optional) paste secrets there — private key slot for the spending wallet comes next with me.",
        "4. Copy your connector link (…workers.dev/mcp).",
        "5. In Claude: add that connector link, then turn on Always allow for it.",
        "6. Tell me your testnet receive address (kaspatest:q…) — leftovers can ONLY go back to that locked address; contract owners are set to your address where the template allows.",
        "7. Fund once from the free testnet faucet: https://faucet-tn10.kaspanet.io/",
      ],
      iDo: [
        "Walk you through dashboard or advanced CLI steps.",
        "Create the spending wallet locked to YOUR address (withdrawals only to that address).",
        "Set contract owners to your address on templates that support it.",
        "Build from chat once funded.",
      ],
      primaryPath: "zero_install_cloudflare",
      deployToCloudflareUrl:
        "https://deploy.workers.cloudflare.com/?url=https://github.com/MikeyKaspa/kaspa-mcp",
      faucetUrl: "https://faucet-tn10.kaspanet.io/",
      faucetNote: "Get free test KAS here first: https://faucet-tn10.kaspanet.io/ — paste your kaspatest: address.",
      beforeYouStart: [
        "Free Cloudflare account",
        "A Kaspa wallet address you control on testnet (kaspatest:q…)",
        "Free test KAS from https://faucet-tn10.kaspanet.io/",
        "About 2 minutes",
      ],
      tipAlwaysAllow:
        "In Claude, after adding your connector link, enable Always allow for this connector so you are not asked to approve every tool call.",
      askUser: "Open the Deploy to Cloudflare link when ready — say “deployed” with your connector link. Ask for “advanced CLI” only if you want Node on your computer.",
      next: 'self_host({ step: "deploy", platform: "cloudflare" })',
      liveStatus,
      advancedNodeOnly:
        "Only if you want a local/CLI setup: Node 20+ and git — npm create kaspa-mcp@latest or git clone + npm run selfhost:setup. Skip this unless you asked for advanced.",
      oneCommandDeployAdvanced: code(`
# Advanced only (needs Node + git on your computer):
npm create kaspa-mcp@latest
`),
      spendingWalletNote:
        "Spending wallet withdraws ONLY to your locked receive address. Crowdfund/tipjar/lockbox owners are set to your address on the public or self-host flow.",
      trapToAvoid:
        "After Deploy to Cloudflare, set MCP_PUBLIC=false on your Worker so it is your private copy. Then create the spending wallet locked to your address.",
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
      title: "Deploy your free copy on Cloudflare (zero install first)",
      humanSteps: [
        "Primary: open Deploy to Cloudflare (no Node/npm/git). After deploy, in Worker Settings → Variables set MCP_PUBLIC=false.",
        "Then add your connector link in Claude and enable Always allow.",
        "Tell me your kaspatest: address — I lock the spending wallet so leftovers only return to you; contract owners use your address where allowed.",
        "Faucet for free test KAS: https://faucet-tn10.kaspanet.io/",
        "Advanced (optional): CLI with Node — only if you ask.",
      ],
      oneClickPrimary:
        "https://deploy.workers.cloudflare.com/?url=https://github.com/MikeyKaspa/kaspa-mcp",
      oneClickKeylessOnly:
        "https://deploy.workers.cloudflare.com/?url=https://github.com/MikeyKaspa/kaspa-mcp",
      oneClickNote:
        "Zero-install Deploy button. Afterward set MCP_PUBLIC=false in the dashboard, then spending_wallet_create on your copy for no-popup deploys.",
      faucetUrl: "https://faucet-tn10.kaspanet.io/",
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
        "Open the TN10 faucet and paste that spending address (or send a little test KAS from your main wallet).",
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
