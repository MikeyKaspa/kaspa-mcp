/**
 * Resolve template bytecode for fund/spend — ALWAYS rebound to the declared owner
 * so we never fund the demo TipJar by accident.
 */
import { getTemplate } from "./templates.js";
import { loadSilArtifact, rebindTipjarOwnerPkh, type LoadedArtifact } from "./artifact.js";
import { coerceBytecode } from "./artifact.js";
import { ownerPkhFromP2pkAddress, assertP2shMatches } from "./owner-pkh.js";
import { p2shAddress } from "./pure/sign.js";
import { SafetyError } from "../safety.js";

export type ResolveFundArgs = {
  templateId?: string;
  artifact?: unknown;
  contractName?: string;
  bytecodeHex?: string;
  /** P2PK address whose blake2b(x-only) becomes TipJar ownerPkh */
  ownerAddress?: string;
  /** Explicit 32-byte ownerPkh hex (alternative to ownerAddress) */
  ownerPkhHex?: string;
  /** Optional: previously shown P2SH — must match after rebind */
  expectedP2shAddress?: string;
  networkId: string;
};

export function resolveTemplateBytecodeForFund(args: ResolveFundArgs): {
  loaded?: LoadedArtifact;
  bytecode: Uint8Array;
  bytecodeHex: string;
  p2shAddress: string;
  ownerPkhHex?: string;
  rebound: boolean;
} {
  const net =
    args.networkId.includes("mainnet") && !args.networkId.includes("test") ? "mainnet" : "testnet-10";

  let loaded: LoadedArtifact | undefined;
  let bytecode: Uint8Array;
  let rebound = false;
  let ownerPkhHex: string | undefined = args.ownerPkhHex?.replace(/^0x/, "").toLowerCase();

  if (args.templateId) {
    loaded = getTemplate(args.templateId).loadedExample;
    bytecode = loaded.bytecode;
    if (args.templateId === "tipjar") {
      if (!ownerPkhHex) {
        if (!args.ownerAddress?.trim()) {
          throw new SafetyError(
            "TipJar fund/prepare requires ownerAddress (your kaspatest:q… receive address) " +
              "or ownerPkhHex so we bind the jar to YOU — never the demo template.",
          );
        }
        ownerPkhHex = ownerPkhFromP2pkAddress(args.ownerAddress);
      }
      loaded = rebindTipjarOwnerPkh(loaded, ownerPkhHex);
      bytecode = loaded.bytecode;
      rebound = true;
    }
  } else if (args.artifact) {
    loaded = loadSilArtifact(args.artifact, args.contractName);
    bytecode = loaded.bytecode;
  } else if (args.bytecodeHex) {
    bytecode = coerceBytecode(args.bytecodeHex);
  } else {
    throw new SafetyError("Provide templateId, artifact, or bytecodeHex");
  }

  const addr = p2shAddress(bytecode, net);
  assertP2shMatches(addr, args.expectedP2shAddress, "TipJar P2SH");
  const bytecodeHex = [...bytecode].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { loaded, bytecode, bytecodeHex, p2shAddress: addr, ownerPkhHex, rebound };
}
