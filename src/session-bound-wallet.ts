/**
 * Remember the Quick-start (or volunteered) P2PK address for this MCP client
 * so later tools default to it — no copy/paste for newbies.
 */
type KvLike = {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  get(key: string): Promise<string | null>;
};

export type BoundWallet = {
  address: string;
  networkId: string;
  kaspaNetwork: "testnet-10" | "mainnet";
  setAt: string;
  source: "quick_start_bind" | "explicit" | "imported";
  clientKey: string;
};

type Store = {
  kv: KvLike | null;
  memory: Map<string, BoundWallet>;
  clientKey: string;
};

function store(): Store {
  const g = globalThis as { __kaspaBoundWallet?: Store };
  if (!g.__kaspaBoundWallet) {
    g.__kaspaBoundWallet = { kv: null, memory: new Map(), clientKey: "local" };
  }
  return g.__kaspaBoundWallet;
}

const KV_TTL_SEC = 60 * 60 * 24 * 30;

export function setBoundWalletKv(kv: KvLike | null): void {
  store().kv = kv;
}

export function setBoundWalletClientKey(clientKey: string): void {
  store().clientKey = clientKey || "local";
}

function memKey(clientKey: string, kaspaNetwork: string): string {
  return `${clientKey}|${kaspaNetwork}`;
}

function kvKey(clientKey: string, kaspaNetwork: string): string {
  return `bound-wallet:${clientKey}:${kaspaNetwork}`;
}

export function clearBoundWalletMemory(): void {
  store().memory.clear();
}

export async function setSessionBoundWallet(
  opts: {
    address: string;
    networkId: string;
    kaspaNetwork: "testnet-10" | "mainnet";
    source?: BoundWallet["source"];
    clientKey?: string;
  },
): Promise<BoundWallet> {
  const s = store();
  const clientKey = opts.clientKey || s.clientKey || "local";
  const rec: BoundWallet = {
    address: opts.address.trim(),
    networkId: opts.networkId,
    kaspaNetwork: opts.kaspaNetwork,
    setAt: new Date().toISOString(),
    source: opts.source || "quick_start_bind",
    clientKey,
  };
  s.memory.set(memKey(clientKey, opts.kaspaNetwork), rec);
  if (s.kv) {
    await s.kv.put(kvKey(clientKey, opts.kaspaNetwork), JSON.stringify(rec), {
      expirationTtl: KV_TTL_SEC,
    });
  }
  return rec;
}

export async function getSessionBoundWallet(
  kaspaNetwork: "testnet-10" | "mainnet",
  clientKey?: string,
): Promise<BoundWallet | null> {
  const s = store();
  const key = clientKey || s.clientKey || "local";
  const mk = memKey(key, kaspaNetwork);
  if (s.memory.has(mk)) return s.memory.get(mk)!;
  if (!s.kv) return null;
  try {
    const raw = await s.kv.get(kvKey(key, kaspaNetwork));
    if (!raw) return null;
    const rec = JSON.parse(raw) as BoundWallet;
    s.memory.set(mk, rec);
    return rec;
  } catch {
    return null;
  }
}

/** Prefer explicit address, else session-bound Quick-start address. */
export async function resolveWorkingAddress(opts: {
  explicit?: string | null;
  kaspaNetwork: "testnet-10" | "mainnet";
  clientKey?: string;
}): Promise<{ address: string; source: "explicit" | "session_bound" } | null> {
  const ex = opts.explicit?.trim();
  if (ex) return { address: ex, source: "explicit" };
  const bound = await getSessionBoundWallet(opts.kaspaNetwork, opts.clientKey);
  if (bound?.address) return { address: bound.address, source: "session_bound" };
  return null;
}
