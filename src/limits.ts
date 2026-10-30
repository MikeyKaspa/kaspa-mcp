/** Shared input limits for the public MCP surface (DoS / zod memory guards). */
export const MAX_SOURCE_CHARS = 100_000;
export const MAX_RAW_TX_CHARS = 50_000;
export const MAX_ABI_ITEMS = 500;
export const MAX_CTOR_ARGS = 32;
export const MAX_CALL_ARGS = 32;
export const MAX_MCP_BODY_BYTES = 512_000;
export const MAX_COMPILE_CACHE = 32;
export const MAX_CACHE_KEY_CHARS = 128;
export const MAX_ADDRESS_CHARS = 128;
export const MAX_DEMO_KEY_CHARS = 128;

export function assertSourceSize(source: string): void {
  if (source.length > MAX_SOURCE_CHARS) {
    throw new Error(`source exceeds ${MAX_SOURCE_CHARS} characters`);
  }
}

export function assertRawTxShape(rawTx: string): void {
  const t = rawTx.trim();
  if (t.length > MAX_RAW_TX_CHARS) {
    throw new Error(`rawTx exceeds ${MAX_RAW_TX_CHARS} characters`);
  }
  if (!/^0x[0-9a-fA-F]+$/.test(t) || t.length < 4 || t.length % 2 !== 0) {
    throw new Error("rawTx must be 0x-prefixed even-length hex");
  }
}
