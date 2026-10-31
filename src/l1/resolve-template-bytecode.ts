/**
 * Resolve template bytecode for fund/spend — ALWAYS rebound to the declared owner
 * so we never fund the demo TipJar/Lockbox/SoftCap by accident.
 */
import { getTemplate } from "./templates.js";
import {
  loadSilArtifact,
  rebindTipjarOwnerPkh,
  rebindLockbox,
  rebindSoftCapJar,
  type LoadedArtifact,
  coerceBytecode,
} from "./artifact.js";
import { ownerPkhFromP2pkAddress, assertP2shMatches } from "./owner-pkh.js";
import { p2shAddress } from "./pure/sign.js";
import { SafetyError } from "../safety.js";

export type ResolveFundArgs = {
  templateId?: string;
  artifact?: unknown;
  contractName?: string;
  bytecodeHex?: string;
  ownerAddress?: string;
  ownerPkhHex?: string;
  expectedP2shAddress?: string;
  /** Lockbox / SoftCapJar */
  unlockAtMs?: number | bigint;
  goalSompi?: number | bigint;
  deadlineMs?: number | bigint;
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
    const needsOwner =
      args.templateId === "tipjar" ||
      args.templateId === "lockbox" ||
      args.templateId === "softcap";
    if (needsOwner) {
      if (!ownerPkhHex) {
        if (!args.ownerAddress?.trim()) {
          throw new SafetyError(
            `${args.templateId} fund/prepare requires ownerAddress (your kaspatest:q… receive address) ` +
              "or ownerPkhHex so we bind the contract to YOU — never the demo template.",
          );
        }
        ownerPkhHex = ownerPkhFromP2pkAddress(args.ownerAddress);
      }
      if (args.templateId === "tipjar") {
        loaded = rebindTipjarOwnerPkh(loaded, ownerPkhHex);
      } else if (args.templateId === "lockbox") {
        const unlockAt = args.unlockAtMs ?? Date.now() + 3_600_000;
        loaded = rebindLockbox(loaded, { ownerPkhHex, unlockAt });
      } else if (args.templateId === "softcap") {
        const goalSompi = args.goalSompi ?? 100_000_000;
        const deadline = args.deadlineMs ?? Date.now() + 7 * 86_400_000;
        loaded = rebindSoftCapJar(loaded, { ownerPkhHex, goalSompi, deadline });
      }
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
  assertP2shMatches(addr, args.expectedP2shAddress, "contract P2SH");
  const bytecodeHex = [...bytecode].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { loaded, bytecode, bytecodeHex, p2shAddress: addr, ownerPkhHex, rebound };
}
