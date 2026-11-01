/**
 * Session network preference: AI must ask "Testnet or mainnet?" before build/deploy.
 * In-memory for the isolate + optional KV persistence across Worker isolates.
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
  clientKey?: string;
};

type KvLike = {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  get(key: string): Promise<string | null>;
};

type Store = {
  preference: SessionNetworkPreference | null;
  kv: KvLike | null;
  /** Active client key for this request (IP / demo key). */
  clientKey: string;
};

function store(): Store {
  const g = globalThis as { __kaspaNetworkSession?: Store };
  if (!g.__kaspaNetworkSession) {
    g.__kaspaNetworkSession = { preference: null, kv: null, clientKey: "local" };
  }
  return g.__kaspaNetworkSession;
}

const KV_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

export function setNetworkPreferenceKv(kv: KvLike | null): void {
  store().kv = kv;
}

export function setNetworkClientKey(clientKey: string): void {
  store().clientKey = clientKey || "local";
}

export function getNetworkClientKey(): string {
  return store().clientKey || "local";
}

function kvKey(clientKey: string): string {
  return `network-pref:${clientKey}`;
}

/** Reset in-memory (tests). Does not clear KV. */
export function clearSessionNetworkPreference(): void {
  store().preference = null;
}

export function getSessionNetworkPreference(): SessionNetworkPreference | null {
  return store().preference;
}

/** Load from KV into memory when isolate is cold. */
export async function hydrateSessionNetworkPreference(
  clientKey?: string,
): Promise<SessionNetworkPreference | null> {
  const s = store();
  const key = clientKey || s.clientKey;
  if (clientKey) s.clientKey = clientKey;
  if (s.preference && (!clientKey || s.preference.clientKey === key)) return s.preference;
  if (!s.kv) return s.preference;
  try {
    const raw = await s.kv.get(kvKey(key));
    if (!raw) return null;
    const pref = JSON.parse(raw) as SessionNetworkPreference;
    s.preference = pref;
    return pref;
  } catch {
    return null;
  }
}

export async function setSessionNetworkChoice(
  choice: NetworkChoice,
  clientKey?: string,
): Promise<SessionNetworkPreference> {
  const s = store();
  const key = clientKey || s.clientKey || "local";
  s.clientKey = key;
  const pref: SessionNetworkPreference = {
    choice,
    l1NetworkId: choice === "testnet" ? DEFAULT_L1_TESTNET : DEFAULT_L1_MAINNET,
    evmNetworkId: choice === "testnet" ? DEFAULT_EVM_TESTNET : "kasplex-mainnet",
    setAt: new Date().toISOString(),
    mainnetWarningShown: choice === "mainnet",
    clientKey: key,
  };
  s.preference = pref;
  if (s.kv) {
    await s.kv.put(kvKey(key), JSON.stringify(pref), { expirationTtl: KV_TTL_SEC });
  }
  return pref;
}

export const ASK_NETWORK_PROMPT =
  "Before we build or deploy anything: pick **Testnet** or **Mainnet** with ONE CLICK " +
  "(native buttons / choice widget — never ask the user to type the word). " +
  "Testnet: free test KAS, safe to experiment. " +
  "Mainnet: real KAS; SilverScript is UNAUDITED; Quick-start wallet capped at 50 KAS. " +
  "After they tap, call choose_network({ choice: \"testnet\" | \"mainnet\" }). " +
  "If your host has no buttons, open the chooseUrl one-tap page from the tool result.";

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

export function resolveNetwork(opts: {
  explicit?: string;
  kind?: ResolveKind;
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
      mainnetWarning: network.isTestnet ? undefined : `⚠️ MAINNET SELECTED — ${L1_UNAUDITED_WARNING}`,
    };
  }

  const pref = getSessionNetworkPreference();
  if (pref) {
    const network = getNetwork(kind === "evm" ? pref.evmNetworkId : pref.l1NetworkId);
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
        note: "Free test KAS (TN10 faucet). Safe to experiment — no real money at risk.",
      },
      mainnet: {
        l1: DEFAULT_L1_MAINNET,
        evm: "kasplex-mainnet",
        warning: `${L1_UNAUDITED_WARNING} Quick-start wallet capped at 50 KAS.`,
      },
    },
    hint: 'Show ONE-CLICK Testnet/Mainnet buttons (never type). Then choose_network({ choice }) or open chooseUrl. Pass network= to override.',
  };
}

export const MCP_NETWORK_INSTRUCTIONS = `
## Network choice (required before build/deploy) — ONE CLICK, never typed
BEFORE any compile-for-deploy, prepare_deploy, deploy_contract, l1_prepare_fund, l1_prepare_spend, l1_prepare_send, l1_tipjar_chat_deploy, l1_vault_chat_deploy, l1_escrow_chat_deploy, or spending_wallet auto-sign:
1. Present **Testnet** vs **Mainnet** as native clickable buttons/choice widgets. Keep each description visible:
   - Testnet: free test KAS, safe to experiment.
   - Mainnet: real KAS; UNAUDITED SilverScript; Quick-start 50 KAS cap.
2. NEVER ask the user to type "testnet" or "mainnet".
3. If the MCP client supports elicitation, the server may send elicitation/create (enum) — honor that UI.
4. Tool results that need a choice include a structured \`choices\` array (id, label, description) and often \`chooseUrl\` (/choose/<id> one-tap page). Render choices as buttons; if you cannot, give the user chooseUrl.
5. After they tap, call choose_network({ choice: "testnet" | "mainnet" }) (persisted across Worker isolates).
6. On mainnet, show the UNAUDITED warning. Do not guess mainnet when unset.
7. Testnet (kaspa-l1-testnet-10 / kasplex-testnet) when they are unsure.
Read-only tools may use testnet safely without asking.
For production independence: configure_node / self_host with YOUR kaspa-rest-server so submit/UTXO do not rely on a single public API.
`.trim();
