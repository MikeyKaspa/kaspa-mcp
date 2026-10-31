/**
 * Guided self_host wizard — everyday-user steps for launching their own copy.
 * Never prints or invents private keys; shared demo stays keyless.
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
  | "status";

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
      ? "You are on the shared public demo (keyless). This guide walks you through YOUR own Cloudflare/local copy — secrets never go on the shared demo."
      : "You are on a self-host copy. Follow the remaining steps; spending wallet tools work here.",
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
      headline: "Launch your own Kaspa connector (free Cloudflare or local)",
      whatYouGet: [
        "Your own MCP URL (no shared rate limits)",
        "Optional spending wallet so chat can deploy on testnet without wallet popups",
        "Same tools as the public demo — your secrets stay on your account only",
      ],
      askUser: "Cloudflare (phone-friendly URL) or local Node on your computer?",
      next: {
        cloudflare: "Call self_host({ step: \"deploy\", platform: \"cloudflare\" })",
        local: "Call self_host({ step: \"deploy\", platform: \"local\" })",
      },
      liveStatus,
      overviewSteps: [
        "1. Deploy your copy (Cloudflare button or wrangler / npm start)",
        "2. Point your AI at YOUR /mcp URL",
        "3. Choose testnet (recommended) via choose_network",
        "4. spending_wallet_create with your main kaspatest: address",
        "5. Set the Worker secret with the one-shot key (Cloudflare only)",
        "6. Fund the spending address from the TN10 faucet",
        "7. Verify with spending_wallet_status, then l1_tipjar_chat_deploy",
      ],
    };
  }

  if (step === "deploy") {
    if (platform === "local") {
      return {
        ...base,
        title: "Deploy locally (Node 20+)",
        humanSteps: [
          "Open a terminal on your computer.",
          "Copy-paste the commands below.",
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
      title: "Deploy on your free Cloudflare account",
      humanSteps: [
        "Easiest: open the Deploy to Cloudflare button (uses YOUR Cloudflare login).",
        "Or use the terminal commands below (also free workers.dev).",
        "Important: deploy with wrangler.selfhost.toml so you do not overwrite the public shared demo.",
      ],
      oneClick:
        "https://deploy.workers.cloudflare.com/?url=https://github.com/MikeyKaspa/kaspa-mcp",
      commands: code(`
git clone https://github.com/MikeyKaspa/kaspa-mcp
cd kaspa-mcp
npm install
npx wrangler login
npx wrangler deploy -c wrangler.selfhost.toml
# Note the workers.dev URL printed at the end
`),
      tip: "Stay on the free plan. workers.dev only — no custom domain required.",
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
      title: "Connect your AI to YOUR connector",
      mcpUrl: url,
      humanSteps: [
        "In Claude / Cursor / Grok Bot, add a custom MCP connector.",
        "Paste the MCP URL below (Streamable HTTP, no sign-in).",
        "Then come back here and continue with create_wallet.",
      ],
      pasteThisUrl: url,
      claudeHint: "Settings → Connectors → Add custom connector → paste URL → No sign-in",
      cursorHint: "Settings → MCP → Add server → URL / Streamable HTTP → paste URL",
      next: 'Call self_host({ step: "create_wallet", mainAddress: "kaspatest:YOUR_MAIN_ADDRESS" })',
      needFromUser: "Your main/cold TN10 address (kaspatest:…) — this is the only place withdraw_all can send.",
    };
  }

  if (step === "create_wallet") {
    const main = args.mainAddress?.trim();
    if (!main) {
      return {
        ...base,
        title: "Create a dedicated spending wallet",
        needFromUser:
          "Paste your main TN10 address (kaspatest:…). This locks withdraw_all so prompt-injection cannot redirect funds.",
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
          "Shared demo refuses spending_wallet_create (keyless by design). Finish deploy + connect to YOUR Worker, then retry create_wallet there.",
        onYourWorker: `Call spending_wallet_create({ mainAddress: "${main}" }) against your self-host /mcp URL.`,
        next: 'self_host({ step: "set_secret" }) after create returns the one-shot key on Cloudflare.',
      };
    }
    return {
      ...base,
      title: "Ready to create",
      instruction:
        "Call spending_wallet_create now with the mainAddress below. On Cloudflare you get a one-shot privateKeyHex — save it only for the next secret step; never paste it into the shared demo or a public chat.",
      mainAddress: main,
      toolCall: { name: "spending_wallet_create", arguments: { mainAddress: main, network: "kaspa-l1-testnet-10" } },
      next: 'After create: self_host({ step: "set_secret" })',
    };
  }

  if (step === "set_secret") {
    return {
      ...base,
      title: "Lock the spending key into YOUR Cloudflare secret",
      humanSteps: [
        "Use the one-shot privateKeyHex from spending_wallet_create (Cloudflare path).",
        "Run the command on your computer in the kaspa-mcp folder — it reads the key from stdin so it is not stored in shell history as easily.",
        "Never commit the key. Never put it on the shared demo.",
      ],
      commands: code(`
# Replace 0xYOUR_KEY with the one-shot key from spending_wallet_create
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
      title: "Fund the spending address (testnet)",
      humanSteps: [
        "Call spending_wallet_status to see the spending address (never the key).",
        "Open the TN10 faucet and paste that spending address.",
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
            "Try: choose_network({ choice: \"testnet\" }) then l1_tipjar_chat_deploy.",
            "Or keep using tap-to-approve without the spending wallet.",
          ]
        : [
            shared
              ? "Still on shared demo — connect to YOUR Worker URL and re-run verify there."
              : "Not configured yet. Finish create_wallet + set_secret + fund, then verify again.",
          ],
      next: ok
        ? "choose_network({ choice: \"testnet\" }) → l1_tipjar_chat_deploy"
        : 'self_host({ step: "create_wallet" }) or set_secret / fund',
    };
  }

  return { ...base, error: `Unknown step "${step}"`, knownSteps: ["start", "deploy", "connect", "create_wallet", "set_secret", "fund", "verify", "status"] };
}
