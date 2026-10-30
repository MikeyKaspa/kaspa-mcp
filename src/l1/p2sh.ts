import { loadKaspa } from "./kaspa-sdk.js";
import { coerceBytecode } from "./artifact.js";
import { bytesToHex } from "./script.js";

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
  const kaspa = await loadKaspa();
  const bc = coerceBytecode(bytecode);
  const spk = kaspa.payToScriptHashScript(bc);
  const addr = kaspa.addressFromScriptPublicKey(spk, network);
  if (!addr) throw new Error("addressFromScriptPublicKey returned empty");
  return {
    network,
    address: addr.toString(),
    scriptPublicKey: { version: spk.version, script: String(spk.script) },
    bytecodeHex: bytesToHex(bc),
  };
}
