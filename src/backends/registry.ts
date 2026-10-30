import type { NetworkInfo } from "../types.js";
import type { KaspaBackend } from "./types.js";
import { EvmBackend } from "./evm.js";
import { CovenantBackend } from "./covenant.js";
import { VProgsBackend } from "./vprogs.js";
import { L1ReadBackend } from "./l1read.js";

const backends: KaspaBackend[] = [
  new EvmBackend(),
  new L1ReadBackend(),
  new CovenantBackend(),
  new VProgsBackend(),
];

export function backendFor(network: NetworkInfo): KaspaBackend {
  const b = backends.find((x) => x.supports(network));
  if (!b) {
    throw new Error(`No backend registered for network ${network.id} (kind=${network.kind})`);
  }
  return b;
}

export function allBackends(): KaspaBackend[] {
  return backends;
}
