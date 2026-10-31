/**
 * Resolve template bytecode for fund/spend — ALWAYS rebound to the declared params
 * so we never fund a demo template or a differently-parameterized script by accident.
 */
import { getTemplate } from "./templates.js";
import {
  loadSilArtifact,
  rebindTipjarOwnerPkh,
  rebindLockbox,
  rebindSoftCapJar,
  rebindTimeoutVaultKeys,
  rebindEscrowParties,
  rebindAoNPledge,
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
  /** Lockbox */
  unlockAtMs?: number | bigint;
  /** SoftCap / AoN */
  goalSompi?: number | bigint | string;
  deadlineMs?: number | bigint | string;
  /** TimeoutVault */
  recipientXonlyHex?: string;
  senderXonlyHex?: string;
  timeoutMs?: number | bigint;
  /** Escrow */
  arbiterAddress?: string;
  arbiterPkhHex?: string;
  buyerXonlyHex?: string;
  sellerXonlyHex?: string;
  /** AoN pledge */
  backerPkhHex?: string;
  backerAddress?: string;
  campaignTagHex?: string;
  networkId: string;
};

function netOf(networkId: string): "mainnet" | "testnet-10" {
  return networkId.includes("mainnet") && !networkId.includes("test") ? "mainnet" : "testnet-10";
}

function requireOwnerPkh(args: ResolveFundArgs, label: string): string {
  if (args.ownerPkhHex?.trim()) return args.ownerPkhHex.replace(/^0x/, "").toLowerCase();
  if (args.ownerAddress?.trim()) return ownerPkhFromP2pkAddress(args.ownerAddress);
  throw new SafetyError(
    `${label} needs your receive address (ownerAddress) so the funded address matches the contract you created — never a demo template.`,
  );
}

export function resolveTemplateBytecodeForFund(args: ResolveFundArgs): {
  loaded?: LoadedArtifact;
  bytecode: Uint8Array;
  bytecodeHex: string;
  p2shAddress: string;
  ownerPkhHex?: string;
  rebound: boolean;
  boundParams?: Record<string, string>;
} {
  const net = netOf(args.networkId);

  let loaded: LoadedArtifact | undefined;
  let bytecode: Uint8Array;
  let rebound = false;
  let ownerPkhHex: string | undefined = args.ownerPkhHex?.replace(/^0x/, "").toLowerCase();
  const boundParams: Record<string, string> = {};

  if (args.templateId) {
    loaded = getTemplate(args.templateId).loadedExample;
    bytecode = loaded.bytecode;

    if (args.templateId === "tipjar") {
      ownerPkhHex = requireOwnerPkh(args, "tipjar");
      loaded = rebindTipjarOwnerPkh(loaded, ownerPkhHex);
      rebound = true;
      boundParams.ownerPkhHex = ownerPkhHex;
    } else if (args.templateId === "lockbox") {
      ownerPkhHex = requireOwnerPkh(args, "lockbox");
      if (args.unlockAtMs == null) {
        throw new SafetyError(
          "lockbox fund/prepare requires unlockAtMs (the exact unlock time you already showed). " +
            "Never omit it — a new default time would create a different address.",
        );
      }
      const unlockAt = BigInt(args.unlockAtMs);
      loaded = rebindLockbox(loaded, { ownerPkhHex, unlockAt });
      rebound = true;
      boundParams.ownerPkhHex = ownerPkhHex;
      boundParams.unlockAtMs = unlockAt.toString();
    } else if (args.templateId === "softcap") {
      ownerPkhHex = requireOwnerPkh(args, "tip_goal_jar");
      if (args.goalSompi == null || args.deadlineMs == null) {
        throw new SafetyError(
          "tip goal jar (softcap) requires goalSompi and deadlineMs matching the contract you created.",
        );
      }
      loaded = rebindSoftCapJar(loaded, {
        ownerPkhHex,
        goalSompi: BigInt(args.goalSompi),
        deadline: BigInt(args.deadlineMs),
      });
      rebound = true;
      boundParams.ownerPkhHex = ownerPkhHex;
      boundParams.goalSompi = String(args.goalSompi);
      boundParams.deadlineMs = String(args.deadlineMs);
    } else if (args.templateId === "aon_pledge") {
      ownerPkhHex = requireOwnerPkh(args, "aon_pledge");
      const backer =
        args.backerPkhHex?.replace(/^0x/, "").toLowerCase() ||
        (args.backerAddress ? ownerPkhFromP2pkAddress(args.backerAddress) : undefined);
      if (!backer) {
        throw new SafetyError("aon_pledge requires backerAddress or backerPkhHex (the backer who can reclaim).");
      }
      if (!args.campaignTagHex?.trim()) {
        throw new SafetyError("aon_pledge requires campaignTagHex (shared 32-byte hex id for this campaign).");
      }
      if (args.goalSompi == null || args.deadlineMs == null) {
        throw new SafetyError("aon_pledge requires goalSompi and deadlineMs matching the campaign.");
      }
      const tag = args.campaignTagHex.replace(/^0x/, "").toLowerCase();
      loaded = rebindAoNPledge(loaded, {
        ownerPkhHex,
        backerPkhHex: backer,
        campaignTagHex: tag,
        goalSompi: BigInt(args.goalSompi),
        deadline: BigInt(args.deadlineMs),
      });
      rebound = true;
      boundParams.ownerPkhHex = ownerPkhHex;
      boundParams.backerPkhHex = backer;
      boundParams.campaignTagHex = tag;
      boundParams.goalSompi = String(args.goalSompi);
      boundParams.deadlineMs = String(args.deadlineMs);
    } else if (args.templateId === "timeout_vault") {
      if (!args.recipientXonlyHex || !args.senderXonlyHex) {
        throw new SafetyError(
          "timeout_vault fund/prepare requires recipientXonlyHex and senderXonlyHex matching the vault you created.",
        );
      }
      loaded = rebindTimeoutVaultKeys(loaded, {
        recipientXonlyHex: args.recipientXonlyHex.replace(/^0x/, "").toLowerCase(),
        senderXonlyHex: args.senderXonlyHex.replace(/^0x/, "").toLowerCase(),
      });
      rebound = true;
      boundParams.recipientXonlyHex = args.recipientXonlyHex.replace(/^0x/, "").toLowerCase();
      boundParams.senderXonlyHex = args.senderXonlyHex.replace(/^0x/, "").toLowerCase();
    } else if (args.templateId === "escrow") {
      const arbiter =
        args.arbiterPkhHex?.replace(/^0x/, "").toLowerCase() ||
        (args.arbiterAddress
          ? ownerPkhFromP2pkAddress(args.arbiterAddress)
          : ownerPkhHex || (args.ownerAddress ? ownerPkhFromP2pkAddress(args.ownerAddress) : undefined));
      if (!arbiter || !args.buyerXonlyHex || !args.sellerXonlyHex) {
        throw new SafetyError(
          "escrow fund/prepare requires arbiter (address or pkh) + buyerXonlyHex + sellerXonlyHex matching the escrow you created.",
        );
      }
      loaded = rebindEscrowParties(loaded, {
        arbiterPkhHex: arbiter,
        buyerXonlyHex: args.buyerXonlyHex.replace(/^0x/, "").toLowerCase(),
        sellerXonlyHex: args.sellerXonlyHex.replace(/^0x/, "").toLowerCase(),
      });
      rebound = true;
      ownerPkhHex = arbiter;
      boundParams.arbiterPkhHex = arbiter;
      boundParams.buyerXonlyHex = args.buyerXonlyHex.replace(/^0x/, "").toLowerCase();
      boundParams.sellerXonlyHex = args.sellerXonlyHex.replace(/^0x/, "").toLowerCase();
    }

    bytecode = loaded.bytecode;
  } else if (args.artifact) {
    loaded = loadSilArtifact(args.artifact, args.contractName);
    bytecode = loaded.bytecode;
  } else if (args.bytecodeHex) {
    bytecode = coerceBytecode(args.bytecodeHex);
  } else {
    throw new SafetyError("Provide templateId, artifact, or bytecodeHex");
  }

  const addr = p2shAddress(bytecode, net);
  assertP2shMatches(addr, args.expectedP2shAddress, "contract address");
  const bytecodeHex = [...bytecode].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { loaded, bytecode, bytecodeHex, p2shAddress: addr, ownerPkhHex, rebound, boundParams };
}
