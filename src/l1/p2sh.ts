import { loadKaspa } from "./kaspa-sdk.js";
import { coerceBytecode } from "./artifact.js";
import { bytesToHex } from "./script.js";
import { p2shAddress, payToScriptHashScript } from "./pure/sign.js";

export interface P2shDerivation {
  network: string;
  address: string;
  scriptPublicKey: { version: number; script: string };
  bytecodeHex: string;
}

export async function deriveP2shAddress(
  bytecode: Uint8Array | string | number[],
  network: string,
): Promise<P2shDerivation> {
  const bc = coerceBytecode(bytecode);
  const net = network.includes("mainnet") && !network.includes("test") ? "mainnet" : "testnet-10";
  try {
    const kaspa = await loadKaspa();
    const spk = kaspa.payToScriptHashScript(bc);
    const addr = kaspa.addressFromScriptPublicKey(spk, network);
    if (!addr) throw new Error("addressFromScriptPublicKey returned empty");
    return {
      network,
      address: addr.toString(),
      scriptPublicKey: { version: spk.version, script: String(spk.script) },
      bytecodeHex: bytesToHex(bc),
    };
  } catch {
    // Cloudflare Workers / no kaspa-wasm: pure-JS path (byte-identical for standard P2SH)
    const { version, script } = payToScriptHashScript(bc);
    return {
      network,
      address: p2shAddress(bc, net),
      scriptPublicKey: { version, script },
      bytecodeHex: bytesToHex(bc),
    };
  }
}
