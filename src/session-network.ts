/**
 * Session network preference: AI must ask "Testnet or mainnet?" before build/deploy.
 * Preference lives in-process (Worker isolate / Node process) for the MCP session.
 */
import { getNetwork, DEFAULT_EVM_TESTNET } from "./networks.js";
import { L1_UNAUDITED_WARNING } from "./l1/kaspa-sdk.js";
import type { NetworkInfo } from "./types.js";

export const DEFAULT_L1_TESTNET = "kaspa-l1-testnet-10";
export const DEFAULT_L1_MAINNET = "kaspa-l1-mainnet";

export type NetworkChoice = "testnet" | "mainnet";

export type SessionNetworkPreference = {
  choice: NetworkChoice;
  l1NetworkId: string;
  evmNetworkId: string;
  setAt: string;
  mainnetWarningShown: boolean;
};

type Store = { preference: SessionNetworkPreference | null };

function store(): Store {
  const g = globalThis as { __kaspaNetworkSession?: Store };
  if (!g.__kaspaNetworkSession) g.__kaspaNetworkSession = { preference: null };
  return g.__kaspaNetworkSession;
}

/** Reset (tests). */
export function clearSessionNetworkPreference(): void {
  store().preference = null;
}

export function getSessionNetworkPreference(): SessionNetworkPreference | null {
  return store().preference;
}

export function setSessionNetworkChoice(choice: NetworkChoice): SessionNetworkPreference {
  const pref: SessionNetworkPreference = {
    choice,
    l1NetworkId: choice === "testnet" ? DEFAULT_L1_TESTNET : DEFAULT_L1_MAINNET,
    evmNetworkId: choice === "testnet" ? DEFAULT_EVM_TESTNET : "kasplex-mainnet",
    setAt: new Date().toISOString(),
    mainnetWarningShown: choice === "mainnet",
  };
  store().preference = pref;
  return pref;
}

export const ASK_NETWORK_PROMPT =
  "Before we build or deploy anything: **Testnet or mainnet?** " +
  "Testnet (TN10 / Kasplex testnet) is free and safe for experiments. " +
  "Mainnet uses real KAS — UNAUDITED / use at your own risk. " +
  "After the user answers, call choose_network({ choice: \"testnet\" | \"mainnet\" }).";

export type NetworkResolveOk = {
  ok: true;
  network: NetworkInfo;
  source: "explicit" | "session" | "safe_fallback";
  choice: NetworkChoice;
  mainnetWarning?: string;
};

export type NetworkResolveAsk = {
  ok: false;
  needUserChoice: true;
  askUser: string;
  options: {
    testnet: { l1: string; evm: string; note: string };
    mainnet: { l1: string; evm: string; warning: string };
  };
  hint: string;
};

export type NetworkResolveResult = NetworkResolveOk | NetworkResolveAsk;

export type ResolveKind = "l1" | "evm" | "any";

/**
 * Resolve network for a write/build/deploy tool.
 * - Explicit id wins.
 * - Else session preference.
 * - Else ask the user (do not silently write).
 * `allowSafeFallback` only for read-only helpers that must keep working.
 */
export function resolveNetwork(opts: {
  explicit?: string;
  kind?: ResolveKind;
  /** When true and no preference, use testnet fallback instead of ask. */
  allowSafeFallback?: boolean;
}): NetworkResolveResult {
  const kind = opts.kind ?? "any";

  if (opts.explicit?.trim()) {
    const network = getNetwork(opts.explicit.trim());
    const choice: NetworkChoice = network.isTestnet ? "testnet" : "mainnet";
    return {
      ok: true,
      network,
      source: "explicit",
      choice,
      mainnetWarning: network.isTestnet
        ? undefined
        : `⚠️ MAINNET SELECTED — ${L1_UNAUDITED_WARNING}`,
    };
  }

  const pref = getSessionNetworkPreference();
  if (pref) {
    const id =
      kind === "evm" ? pref.evmNetworkId : kind === "l1" ? pref.l1NetworkId : pref.l1NetworkId;
    // For kind "any", prefer L1 id when that's what agents usually mean for this connector;
    // EVM tools pass kind: "evm".
    const network = getNetwork(kind === "evm" ? pref.evmNetworkId : kind === "l1" ? pref.l1NetworkId : id);
    return {
      ok: true,
      network,
      source: "session",
      choice: pref.choice,
      mainnetWarning: pref.choice === "mainnet" ? `⚠️ MAINNET — ${L1_UNAUDITED_WARNING}` : undefined,
    };
  }

  if (opts.allowSafeFallback) {
    const id = kind === "evm" ? DEFAULT_EVM_TESTNET : DEFAULT_L1_TESTNET;
    return {
      ok: true,
      network: getNetwork(id),
      source: "safe_fallback",
      choice: "testnet",
    };
  }

  return {
    ok: false,
    needUserChoice: true,
    askUser: ASK_NETWORK_PROMPT,
    options: {
      testnet: {
        l1: DEFAULT_L1_TESTNET,
        evm: DEFAULT_EVM_TESTNET,
        note: "Free faucet tokens. Preferred for all experiments.",
      },
      mainnet: {
        l1: DEFAULT_L1_MAINNET,
        evm: "kasplex-mainnet",
        warning: L1_UNAUDITED_WARNING,
      },
    },
    hint: "Ask the user, then call choose_network({ choice: \"testnet\" | \"mainnet\" }) or pass network= explicitly.",
  };
}

export const MCP_NETWORK_INSTRUCTIONS = `
## Network choice (required before build/deploy)
BEFORE any compile-for-deploy, prepare_deploy, deploy_contract, l1_prepare_fund, l1_prepare_spend, l1_tipjar_chat_deploy, or spending_wallet auto-sign:
1. Ask the user: **Testnet or mainnet?**
2. Call choose_network({ choice: "testnet" | "mainnet" }) to remember the answer for this session.
3. On mainnet selection, show the UNAUDITED / USE AT YOUR OWN RISK warning and confirm they understand.
4. If they have not chosen yet and a write tool returns needUserChoice, stop and ask — do not guess mainnet.
5. Testnet (kaspa-l1-testnet-10 / kasplex-testnet) is the safe default when they are unsure.
Read-only tools (list_networks, get_balance, l1_blockdag_info, faucet_info) may use testnet safely without asking.
`.trim();
