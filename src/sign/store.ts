import type { SignSession } from "./types.js";
import { SIGN_TTL_SEC } from "./types.js";

export interface SignStore {
  put(session: SignSession): Promise<void>;
  get(id: string): Promise<SignSession | null>;
}

/** In-memory store for Node / tests (TTL enforced on get). */
export function createMemorySignStore(): SignStore {
  const map = new Map<string, SignSession>();
  return {
    async put(session) {
      map.set(session.id, session);
    },
    async get(id) {
      const s = map.get(id);
      if (!s) return null;
      if (Date.now() > s.expiresAt) {
        map.delete(id);
        return null;
      }
      return s;
    },
  };
}

export interface KvLike {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  get(key: string): Promise<string | null>;
}

export function createKvSignStore(kv: KvLike): SignStore {
  return {
    async put(session) {
      await kv.put(`sign:${session.id}`, JSON.stringify(session), {
        expirationTtl: SIGN_TTL_SEC,
      });
    },
    async get(id) {
      const raw = await kv.get(`sign:${id}`);
      if (!raw) return null;
      try {
        const s = JSON.parse(raw) as SignSession;
        if (Date.now() > s.expiresAt) return null;
        return s;
      } catch {
        return null;
      }
    },
  };
}

export function newSignId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildSession(
  partial: Omit<SignSession, "id" | "createdAt" | "expiresAt"> & { id?: string },
): SignSession {
  const now = Date.now();
  return {
    ...partial,
    id: partial.id ?? newSignId(),
    createdAt: now,
    expiresAt: now + SIGN_TTL_SEC * 1000,
  };
}
