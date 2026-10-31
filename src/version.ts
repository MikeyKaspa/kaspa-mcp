/**
 * Connector version + optional "behind latest" hint for self-hosters.
 * Never auto-updates user copies.
 */

const PKG_VERSION = "0.2.0";

/** Set at build/deploy via wrangler vars or process.env; git short sha when available. */
export function connectorVersion(): {
  version: string;
  gitSha?: string;
  buildTime?: string;
} {
  return {
    version: process.env.KASPA_MCP_VERSION?.trim() || PKG_VERSION,
    gitSha: process.env.KASPA_MCP_GIT_SHA?.trim() || undefined,
    buildTime: process.env.KASPA_MCP_BUILD_TIME?.trim() || undefined,
  };
}

export type LatestCheck = {
  current: string;
  latest?: string;
  behind: boolean;
  latestUrl?: string;
  updateHint?: string;
  checkedAt?: string;
  error?: string;
};

const GITHUB_LATEST =
  "https://api.github.com/repos/MikeyKaspa/kaspa-mcp/releases/latest";
const GITHUB_COMMITS =
  "https://api.github.com/repos/MikeyKaspa/kaspa-mcp/commits/main";

function parseSemver(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function semverLess(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i]! < pb[i]!) return true;
    if (pa[i]! > pb[i]!) return false;
  }
  return false;
}

/**
 * Compare running version to GitHub latest release (fallback: main HEAD sha).
 * Network optional — returns behind:false on failure so tools stay usable.
 */
export async function checkAgainstLatest(opts?: {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<LatestCheck> {
  const cur = connectorVersion();
  const fetchImpl = opts?.fetchImpl || fetch;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), opts?.timeoutMs ?? 4000);
  try {
    const res = await fetchImpl(GITHUB_LATEST, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "kaspa-mcp-version-check" },
      signal: ac.signal,
    });
    if (res.status === 404) {
      const c = await fetchImpl(GITHUB_COMMITS, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "kaspa-mcp-version-check" },
        signal: ac.signal,
      });
      if (!c.ok) {
        return { current: cur.version, behind: false, error: `commits HTTP ${c.status}` };
      }
      const cj = (await c.json()) as { sha?: string };
      const latestSha = (cj.sha || "").slice(0, 7);
      const behind = Boolean(cur.gitSha && latestSha && cur.gitSha !== latestSha);
      return {
        current: cur.version,
        latest: latestSha ? `main@${latestSha}` : undefined,
        behind,
        latestUrl: "https://github.com/MikeyKaspa/kaspa-mcp",
        updateHint: behind
          ? 'Call self_host({ step: "update" }) for copy-paste update steps (secrets preserved). Never auto-updates.'
          : undefined,
        checkedAt: new Date().toISOString(),
      };
    }
    if (!res.ok) {
      return { current: cur.version, behind: false, error: `releases HTTP ${res.status}` };
    }
    const j = (await res.json()) as { tag_name?: string; html_url?: string };
    const latest = j.tag_name || "";
    const behind = latest ? semverLess(cur.version, latest) : false;
    return {
      current: cur.version,
      latest: latest || undefined,
      behind,
      latestUrl: j.html_url || "https://github.com/MikeyKaspa/kaspa-mcp/releases",
      updateHint: behind
        ? 'Your copy is behind. Call self_host({ step: "update" }) for safe copy-paste update steps. Secrets/KV are preserved. Never auto-updates.'
        : undefined,
      checkedAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      current: cur.version,
      behind: false,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(t);
  }
}

/** In-memory latest-check cache so tool responses can note behind without hammering GitHub. */
let cachedLatest: { at: number; result: LatestCheck } | null = null;
const CACHE_MS = 60 * 60 * 1000;

export function getCachedLatestCheck(): LatestCheck | null {
  if (!cachedLatest) return null;
  if (Date.now() - cachedLatest.at > CACHE_MS) return null;
  return cachedLatest.result;
}

export function rememberLatestCheck(result: LatestCheck): void {
  cachedLatest = { at: Date.now(), result };
}

/** Fire-and-forget refresh (safe on Workers; ignores failures). */
export function scheduleLatestCheck(): void {
  if (getCachedLatestCheck()) return;
  void checkAgainstLatest()
    .then((r) => rememberLatestCheck(r))
    .catch(() => undefined);
}

/**
 * Shape merged into tool JSON when a self-hosted copy is behind.
 * Shared demo / missing cache → undefined (no note).
 */
export function versionNoteIfBehind():
  | {
      versionNote: {
        behind: true;
        current: string;
        latest?: string;
        message: string;
        update: { tool: "self_host"; args: { step: "update" }; neverAutoUpdate: true };
      };
    }
  | undefined {
  const c = getCachedLatestCheck();
  if (!c?.behind) return undefined;
  return {
    versionNote: {
      behind: true,
      current: c.current,
      latest: c.latest,
      message:
        c.updateHint ||
        'Your copy is behind. Call self_host({ step: "update" }) (secrets preserved). Never auto-updates.',
      update: { tool: "self_host", args: { step: "update" }, neverAutoUpdate: true },
    },
  };
}

