/**
 * Per-IP rate limiting for the shared public demo Worker.
 *
 * Off by default (RATE_LIMIT_ENABLED unset/false) so self-hosters are unlimited
 * unless they opt in. On the shared demo, wrangler sets RATE_LIMIT_ENABLED=true.
 *
 * Layers (all free):
 * 1. Workers Rate Limiting binding — distributed per colo, approximate
 * 2. Cache API counter — better cross-request enforcement in one colo
 * 3. In-isolate sliding window — strict within one isolate
 *
 * Binding periods are only 10s or 60s; compile's longer window (default 5/10min)
 * uses Cache + isolate.
 *
 * Actor key: optional X-Kaspa-Demo-Key (stable behind NAT) else CF-Connecting-IP.
 * Spoofable X-Forwarded-For is NEVER trusted. Demo keys still share a secondary
 * per-IP ceiling so rotating keys cannot bypass limits.
 */

import { MAX_DEMO_KEY_CHARS } from "./limits.js";

export type RateLimitEnv = {
  RATE_LIMIT_ENABLED?: string;
  RATE_LIMIT_REQUESTS?: string;
  RATE_LIMIT_REQUESTS_PERIOD_SEC?: string;
  RATE_LIMIT_COMPILE?: string;
  RATE_LIMIT_COMPILE_PERIOD_SEC?: string;
  /** Secondary ceiling per real IP when a demo key is used (default 180/min). */
  RATE_LIMIT_IP_CEILING?: string;
  RATE_LIMIT_IP_CEILING_PERIOD_SEC?: string;
  REQUEST_RATE_LIMITER?: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
  COMPILE_RATE_LIMITER?: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
};

export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterSec: number; message: string; kind: "request" | "compile" };

const SELF_HOST_HINT =
  "Rate limit exceeded on the shared demo. Self-host for heavy use: one-click Deploy to Cloudflare in the README (own free 100k req/day), or run locally with npm start / npx (no shared limits).";

const windows = new Map<string, number[]>();

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function rateLimitEnabled(env: RateLimitEnv): boolean {
  const v = (env.RATE_LIMIT_ENABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function prune(timestamps: number[], windowMs: number, now: number): number[] {
  return timestamps.filter((t) => now - t < windowMs);
}

function isolateAllow(key: string, limit: number, periodSec: number): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const windowMs = periodSec * 1000;
  const prev = prune(windows.get(key) ?? [], windowMs, now);
  if (prev.length >= limit) {
    const oldest = prev[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
    windows.set(key, prev);
    return { ok: false, retryAfterSec };
  }
  prev.push(now);
  windows.set(key, prev);
  return { ok: true, retryAfterSec: 0 };
}

/** Cache API sliding bucket (Workers only). Fail-open if caches is unavailable (Node tests). */
async function cacheAllow(
  key: string,
  limit: number,
  periodSec: number,
): Promise<{ ok: boolean; retryAfterSec: number }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cachesApi = (globalThis as any).caches;
    if (!cachesApi?.default) return { ok: true, retryAfterSec: 0 };
    const cache = cachesApi.default as Cache;
    const ck = new Request(`https://kaspa-mcp.rate-limit/v2/${encodeURIComponent(key)}`);
    const hit = await cache.match(ck);
    const now = Date.now();
    const windowMs = periodSec * 1000;
    let timestamps: number[] = [];
    if (hit) {
      try {
        const parsed = JSON.parse(await hit.text()) as unknown;
        if (Array.isArray(parsed)) timestamps = parsed.map(Number).filter((n) => Number.isFinite(n));
      } catch {
        timestamps = [];
      }
    }
    timestamps = timestamps.filter((t) => now - t < windowMs);
    if (timestamps.length >= limit) {
      const oldest = timestamps[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
      return { ok: false, retryAfterSec };
    }
    timestamps.push(now);
    const next = new Response(JSON.stringify(timestamps), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${periodSec + 30}`,
      },
    });
    await cache.put(ck, next);
    return { ok: true, retryAfterSec: 0 };
  } catch {
    return { ok: true, retryAfterSec: 0 };
  }
}

export function _resetRateLimitStateForTests(): void {
  windows.clear();
}

async function enforceWindow(
  prefix: string,
  actor: string,
  limit: number,
  periodSec: number,
  kind: "request" | "compile",
  binding?: { limit: (opts: { key: string }) => Promise<{ success: boolean }> },
  bindingPeriodOk?: boolean,
): Promise<RateLimitResult> {
  {
    const r = isolateAllow(`${prefix}:${actor}`, limit, periodSec);
    if (!r.ok) {
      return { ok: false, kind, retryAfterSec: r.retryAfterSec, message: SELF_HOST_HINT };
    }
  }
  {
    const r = await cacheAllow(`${prefix}:${actor}`, limit, periodSec);
    if (!r.ok) {
      return { ok: false, kind, retryAfterSec: r.retryAfterSec, message: SELF_HOST_HINT };
    }
  }
  if (binding && bindingPeriodOk) {
    const { success } = await binding.limit({ key: `${prefix}:${actor}` });
    if (!success) {
      return { ok: false, kind, retryAfterSec: periodSec, message: SELF_HOST_HINT };
    }
  }
  return { ok: true };
}

export async function checkRateLimit(
  env: RateLimitEnv,
  actor: string,
  isCompile: boolean,
  realIp?: string,
): Promise<RateLimitResult> {
  if (!rateLimitEnabled(env)) return { ok: true };

  const reqLimit = parsePositiveInt(env.RATE_LIMIT_REQUESTS, 60);
  const reqPeriod = parsePositiveInt(env.RATE_LIMIT_REQUESTS_PERIOD_SEC, 60);
  const compileLimit = parsePositiveInt(env.RATE_LIMIT_COMPILE, 5);
  const compilePeriod = parsePositiveInt(env.RATE_LIMIT_COMPILE_PERIOD_SEC, 600);
  const ipCeiling = parsePositiveInt(env.RATE_LIMIT_IP_CEILING, 180);
  const ipCeilingPeriod = parsePositiveInt(env.RATE_LIMIT_IP_CEILING_PERIOD_SEC, 60);

  const key = actor || "unknown";

  // Secondary per-IP ceiling when the actor is a demo key (stops key rotation bypass).
  if (key.startsWith("demo:") && realIp && realIp !== "unknown") {
    const ceiling = await enforceWindow(
      "ipceil",
      realIp,
      ipCeiling,
      ipCeilingPeriod,
      "request",
    );
    if (!ceiling.ok) return ceiling;
  }

  const req = await enforceWindow(
    "req",
    key,
    reqLimit,
    reqPeriod,
    "request",
    env.REQUEST_RATE_LIMITER,
    reqPeriod === 10 || reqPeriod === 60,
  );
  if (!req.ok) return req;

  if (!isCompile) return { ok: true };

  // Compile binding is a 1/min floor; longer window via isolate+cache below.
  if (env.COMPILE_RATE_LIMITER) {
    const { success } = await env.COMPILE_RATE_LIMITER.limit({ key: `compile:${key}` });
    if (!success) {
      return { ok: false, kind: "compile", retryAfterSec: 60, message: SELF_HOST_HINT };
    }
  }

  return enforceWindow("compile", key, compileLimit, compilePeriod, "compile");
}

/**
 * Trusted client IP. Cloudflare sets CF-Connecting-IP; client-spoofable
 * X-Forwarded-For is intentionally ignored.
 */
export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
}

/**
 * Rate-limit actor key. Prefers optional X-Kaspa-Demo-Key (stable behind NAT /
 * rotating egress) then CF-Connecting-IP. Demo keys are still capped by a
 * secondary per-IP ceiling in checkRateLimit.
 */
export function rateLimitKey(request: Request): string {
  const demo = request.headers.get("X-Kaspa-Demo-Key")?.trim();
  if (demo && demo.length > 0 && demo.length <= MAX_DEMO_KEY_CHARS) return `demo:${demo}`;
  return clientIp(request);
}

export function peekMcpRequest(bodyText: string): { isCompile: boolean; id: unknown } {
  try {
    const parsed = JSON.parse(bodyText) as {
      id?: unknown;
      method?: string;
      params?: { name?: string };
    };
    const isCompile =
      parsed.method === "tools/call" && parsed.params?.name === "compile_solidity";
    return { isCompile, id: parsed.id ?? null };
  } catch {
    return { isCompile: false, id: null };
  }
}

export function rateLimitJsonRpcError(id: unknown, message: string, retryAfterSec: number): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message,
        data: { retryAfterSec, selfHost: true },
      },
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSec),
      },
    },
  );
}
