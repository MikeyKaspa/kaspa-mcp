/**
 * Multi-endpoint REST failover + optional user-owned node (self-host).
 * Avoids a single third-party SPOF for idea→deploy on mainnet.
 */
export type NetworkId = "testnet-10" | "mainnet";

export type EndpointKind = "rest" | "wrpc";

export type NodeConfig = {
  /** Preferred REST base URLs (no trailing slash), tried in order. */
  restBases?: string[];
  /** Optional wRPC URL for Node self-host tooling. */
  wrpcUrl?: string;
};

const DEFAULT_REST: Record<NetworkId, string[]> = {
  // Official community REST (best-effort, no SLA). Self-hosters should put THEIR
  // kaspa-rest-server first via KASPA_REST_URLS / configure_node — see kaspa-ng/kaspa-rest-server.
  "testnet-10": ["https://api-tn10.kaspa.org"],
  mainnet: ["https://api.kaspa.org"],
};

type Store = { config: NodeConfig };

function store(): Store {
  const g = globalThis as { __kaspaNodeConfig?: Store };
  if (!g.__kaspaNodeConfig) g.__kaspaNodeConfig = { config: {} };
  return g.__kaspaNodeConfig;
}

/** Reset (tests). */
export function clearNodeConfig(): void {
  store().config = {};
}

export function setNodeConfig(cfg: NodeConfig): NodeConfig {
  const next: NodeConfig = {
    restBases: cfg.restBases?.map((u) => u.replace(/\/$/, "")).filter(Boolean),
    wrpcUrl: cfg.wrpcUrl?.trim() || undefined,
  };
  store().config = next;
  return next;
}

export function getNodeConfig(): NodeConfig {
  return { ...store().config };
}

/** Env override (self-host): KASPA_REST_URLS=comma-separated, KASPA_RPC_URL=wss://… */
export function applyNodeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  const rest = env.KASPA_REST_URLS?.split(",").map((s) => s.trim()).filter(Boolean);
  const wrpc = env.KASPA_RPC_URL?.trim() || env.KASPA_OWN_NODE_WRPC?.trim();
  if (rest?.length || wrpc) {
    setNodeConfig({
      restBases: rest?.length ? rest : getNodeConfig().restBases,
      wrpcUrl: wrpc || getNodeConfig().wrpcUrl,
    });
  }
}

export function restBasesFor(networkId: NetworkId): string[] {
  const custom = store().config.restBases;
  if (custom?.length) {
    // User-owned first, then public fallbacks (still resilient).
    const defaults = DEFAULT_REST[networkId];
    const merged = [...custom];
    for (const d of defaults) if (!merged.includes(d)) merged.push(d);
    return merged;
  }
  return [...DEFAULT_REST[networkId]];
}

export type FetchOk = { base: string; res: Response; body: ArrayBuffer };

/**
 * GET/POST against the first healthy REST base.
 * Tries each base; skips non-2xx except when allowStatuses includes it.
 */
export async function fetchRest(
  networkId: NetworkId,
  path: string,
  init?: RequestInit & { allowStatuses?: number[]; fetchImpl?: typeof fetch },
): Promise<FetchOk> {
  const fetchImpl = init?.fetchImpl ?? fetch;
  const allow = new Set(init?.allowStatuses ?? []);
  const bases = restBasesFor(networkId);
  const errors: string[] = [];
  for (const base of bases) {
    const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
    try {
      const { fetchImpl: _f, allowStatuses: _a, ...req } = init ?? {};
      const res = await fetchImpl(url, req);
      if (res.ok || allow.has(res.status)) {
        const body = await res.arrayBuffer();
        return { base, res: new Response(body, { status: res.status, headers: res.headers }), body };
      }
      errors.push(`${base}→HTTP ${res.status}`);
    } catch (e) {
      errors.push(`${base}→${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(
    `All REST endpoints failed for ${networkId} ${path}: ${errors.join("; ") || "none"}. ` +
      `Set KASPA_REST_URLS or call configure_node with your own node.`,
  );
}

/** Convenience: JSON GET with failover. */
export async function fetchRestJson<T = unknown>(
  networkId: NetworkId,
  path: string,
  init?: RequestInit & { allowStatuses?: number[] },
): Promise<{ base: string; status: number; json: T }> {
  const { base, res } = await fetchRest(networkId, path, init);
  const json = (await res.json()) as T;
  return { base, status: res.status, json };
}

export function defaultRestBases(): typeof DEFAULT_REST {
  return {
    "testnet-10": [...DEFAULT_REST["testnet-10"]],
    mainnet: [...DEFAULT_REST.mainnet],
  };
}
