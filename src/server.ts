import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getNetwork, listNetworks, DEFAULT_EVM_TESTNET, DEFAULT_L1_TESTNET, NETWORKS } from "./networks.js";
import {
  resolveNetwork,
  setSessionNetworkChoice,
  getSessionNetworkPreference,
  hydrateSessionNetworkPreference,
  MCP_NETWORK_INSTRUCTIONS,
  ASK_NETWORK_PROMPT,
  type NetworkChoice,
} from "./session-network.js";
import { runSelfHostGuide } from "./self-host.js";
import { confirmTransaction, explorerTxUrl } from "./l1/confirm.js";
import { estimateFees } from "./l1/fee.js";
import { setNodeConfig, getNodeConfig, defaultRestBases, applyNodeConfigFromEnv } from "./endpoints.js";
import { createContractPage } from "./contract-page.js";
import {
  createCampaignPage,
  getCampaignPage,
  computeCampaignStatus,
  upsertCampaignPledge,
} from "./campaign-page.js";
import { privateKeyToXonly } from "./l1/pure/sign.js";
import { bytesToHex } from "./l1/script.js";
import { backendFor } from "./backends/registry.js";
import { compileSolidityAsync } from "./backends/compile.js";
import { SAFETY_BANNER, SafetyError, normalizeTestnetPrivateKey, redactSecrets } from "./safety.js";
import {
  BUILD_TIPJAR_PUBLIC_GUIDE,
  NO_POPUP_PATH_PLAIN,
  TAP_APPROVE_NOTE,
  WALLET_TAP_APPROVE,
  faucetPasteSteps,
  TN10_FAUCET_URL,
  readyNotOnChain,
  NEVER_MANUAL_SEND,
  WITHDRAW_PUBLIC_GUIDE,
  zeroBalanceFundOffer,
} from "./ux-copy.js";
import type { CompileResult, TextJson } from "./types.js";
import {
  MAX_ABI_ITEMS,
  MAX_CACHE_KEY_CHARS,
  MAX_CALL_ARGS,
  MAX_COMPILE_CACHE,
  MAX_CTOR_ARGS,
  assertRawTxShape,
  assertSourceSize,
} from "./limits.js";
import { listTemplates, getTemplate } from "./l1/templates.js";
import { loadSilArtifact, entryOf, rebindLockbox, rebindSoftCapJar } from "./l1/artifact.js";
import { deriveP2shAddress } from "./l1/p2sh.js";
import { prepareFund, prepareSpend, KASWARE_HINT } from "./l1/prepare.js";
import { L1_UNAUDITED_WARNING, kaspaWasmAvailable } from "./l1/kaspa-sdk.js";
import { attachTapToApprove, utxoApiBaseFor, kaspaNetworkFor, contractLabelFor, getSignContext } from "./sign/attach.js";
import { explorerFor } from "./sign/summary.js";
import { compileSilverscript, isSilvercAvailable, silvercCompileHint } from "./l1/compile.js";
import { coerceBytecode } from "./l1/artifact.js";
import { resolveTemplateBytecodeForFund } from "./l1/resolve-template-bytecode.js";
import { connectorVersion, checkAgainstLatest, scheduleLatestCheck, rememberLatestCheck, versionNoteIfBehind } from "./version.js";
import { createAoNCampaign, addAoNPledge, AON_POLICY } from "./crowdfund.js";
import {
  createSpendingWallet,
  spendingWalletStatus,
  isSharedPublicDemo,
  ownerPkhHex,
  addressForKey,
  assertCanAutoSign,
  assertReviewedTemplate,
  refuseKeyExport,
  refuseCapChangeViaChat,
  REVIEWED_TEMPLATE_IDS,
} from "./spending-wallet.js";
import { autoFundCovenant, autoSpendCovenant, spendingWalletWithdrawAll, balanceSompi } from "./l1/auto-sign.js";

function ok(data: unknown): TextJson {
  let payload: unknown = data;
  // Self-hosters only: attach a soft note when this copy is behind latest (never auto-update).
  if (
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data) &&
    !isSharedPublicDemo()
  ) {
    const note = versionNoteIfBehind();
    if (note && !("versionNote" in (data as object))) {
      payload = { ...(data as Record<string, unknown>), ...note };
    }
  }
  return {
    content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }],
  };
}
function err(e: unknown): TextJson {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: redactSecrets(msg) }], isError: true };
}

/** If resolveNetwork says ask the user, return that payload; else null. */
function needNetworkChoicePayload(resolved: ReturnType<typeof resolveNetwork>): TextJson | null {
  if (resolved.ok) return null;
  return ok({ safety: SAFETY_BANNER, ...resolved });
}

const compiledCache = new Map<string, CompileResult>();

function cacheCompiled(key: string, compiled: CompileResult): void {
  if (key.length > MAX_CACHE_KEY_CHARS) {
    throw new Error(`cacheKey exceeds ${MAX_CACHE_KEY_CHARS} characters`);
  }
  if (compiledCache.size >= MAX_COMPILE_CACHE && !compiledCache.has(key)) {
    const oldest = compiledCache.keys().next().value;
    if (oldest !== undefined) compiledCache.delete(oldest);
  }
  compiledCache.set(key, compiled);
}

function compiledFromBytecode(args: {
  bytecode?: string;
  abi?: unknown[];
  contractName?: string;
}): CompileResult | undefined {
  if (!args.bytecode || !args.abi) return undefined;
  if (args.abi.length > MAX_ABI_ITEMS) throw new Error(`abi exceeds ${MAX_ABI_ITEMS} items`);
  const bc = args.bytecode.trim();
  if (!/^0x[0-9a-fA-F]*$/.test(bc) || bc.length < 4 || bc.length % 2 !== 0) {
    throw new Error("bytecode must be 0x-prefixed even-length hex");
  }
  return {
    contractName: args.contractName ?? "Contract",
    abi: args.abi,
    bytecode: bc as `0x${string}`,
    compiler: "precompiled",
  };
}

export function createKaspaMcpServer(): McpServer {
  scheduleLatestCheck();
  const server = new McpServer(
    {
      name: "kaspa-mcp",
      version: "0.2.0",
    },
    {
      instructions:
        `${SAFETY_BANNER}\n\n${L1_UNAUDITED_WARNING}\n\n${MCP_NETWORK_INSTRUCTIONS}\n\n` +
        `CROWDFUND / FUNDRAISER / KICKSTARTER / "raise money" / all-or-nothing → ALWAYS call l1_aon_create_campaign ` +
        `(NOT tipjar, NOT TipGoalJar/softcap, NOT silverscript_compile, NOT l1_derive_p2sh). ` +
        `It uses a prebuilt artifact + rebind on the public connector — no local silverc. ` +
        `Pass ownerAddress = the user's kaspatest: address, goalSompi (1 test KAS = 100000000), optional deadlineMs. ` +
        `Return sharePage.url to the user. Track with campaign_status. After prepare, poll l1_check_session — do NOT ask the user for a txid.\n\n` +
        `TipGoalJar (softcap) is NOT a crowdfund (no auto-refund). Only use when the user wants a tip/goal jar.\n\n` +
        `For everyday users who want chat-deploy without popups: guide them with self_host ` +
        `(Cloudflare Deploy button / dashboard first; Node only if they ask), then spending_wallet_create on THEIR copy. Shared demo is keyless.\n\n` +
        `${BUILD_TIPJAR_PUBLIC_GUIDE}\n\n` +
        `${WITHDRAW_PUBLIC_GUIDE}\n\n` +
        `${NEVER_MANUAL_SEND}\n\n` +
        `Wallets for tap-to-approve: ${WALLET_TAP_APPROVE.plain} ${NO_POPUP_PATH_PLAIN}`,
    },
  );

  server.registerTool(
    "list_networks",
    {
      description:
        "List networks. Primary: Kaspa L1 SilverScript (testnet-10). Secondary: Kasplex/Igra EVM. vProgs stub.",
      inputSchema: {
        kind: z.enum(["evm", "covenant", "vprogs", "l1-read"]).optional(),
        testnetOnly: z.boolean().optional(),
      },
    },
    async ({ kind, testnetOnly }) => {
      try {
        return ok({
          safety: SAFETY_BANNER,
          defaultEvmTestnet: DEFAULT_EVM_TESTNET,
          networks: listNetworks({ kind, testnetOnly }),
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "kaspa_network_info",
    {
      description: "Detailed info for one network id (RPC, chainId, faucet, maturity, docs).",
      inputSchema: { network: z.string() },
    },
    async ({ network }) => {
      try {
        return ok({ safety: SAFETY_BANNER, network: getNetwork(network) });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "kaspa_ideas",
    {
      description:
        "Brainstorm build ideas on Kaspa for a theme. Uses network maturity so suggestions stay honest (EVM L2 vs covenants vs roadmap).",
      inputSchema: {
        theme: z.string().describe("What the user wants to build, e.g. 'escrow', 'meme token', 'vault'"),
        prefer: z.enum(["evm", "covenant", "either"]).optional(),
      },
    },
    async ({ theme, prefer }) => {
      const evm = listNetworks({ kind: "evm", testnetOnly: true });
      const text = [
        SAFETY_BANNER,
        "",
        `Theme: ${theme}`,
        "",
        "## Realistic paths today",
        "- **Primary today:** Kaspa L1 SilverScript on testnet-10 (Toccata). Crowdfund → l1_aon_create_campaign. Also TipJar, TimeoutVault, Escrow, TipGoalJar.",
        prefer === "evm"
          ? "- EVM secondary: Solidity on Kasplex/Igra when you need familiar Solidity tooling."
          : "- Prefer L1 covenants unless the user explicitly wants EVM.",
        "",
        "### Native L1 SilverScript (primary)",
        `- ${theme} as a P2SH covenant on kaspa-l1-testnet-10`,
        "- Tools: silverscript_templates → faucet_info → l1_prepare_fund → open tapToApprove (KasWare/Kastle/Kaspire) — or self_host for no popups",
        "- Compile: self-host silverc, or paste artifact (Workers cannot compile)",
        "- Pre-audit — run kaspa-redteam before mainnet value. Mainnet writes gated.",
        "- KCC-20: upcoming (not shipped in this connector yet)",
        "",
        "### EVM L2 (Kasplex / Igra) — secondary",
        `- Simple ${theme} contract on ${DEFAULT_EVM_TESTNET}`,
        `- Networks: ${evm.map((n) => n.id).join(", ")}`,
        "",
        "### Roadmap",
        "- vProgs — stub only",
        "",
        "Suggested: silverscript_templates → faucet_info(kaspa-l1-testnet-10) → l1_prepare_fund.",
      ].join("\n");
      return ok(text);
    },
  );

  server.registerTool(
    "compile_solidity",
    {
      description: "Compile Solidity source with solc-js (Node: local package; Workers: official binaries.soliditylang.org CDN). Returns ABI + bytecode.",
      inputSchema: {
        source: z.string(),
        contractName: z.string().optional(),
        cacheKey: z.string().optional().describe("Optional key to reuse bytecode in later deploy_contract"),
      },
    },
    async ({ source, contractName, cacheKey }) => {
      try {
        assertSourceSize(source);
        const compiled = await compileSolidityAsync(source, { contractName });
        const key = cacheKey ?? compiled.contractName;
        cacheCompiled(key, compiled);
        return ok({ ...compiled, cacheKey: key, safety: SAFETY_BANNER });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "deploy_contract",
    {
      description:
        "Deploy compiled Solidity to an EVM Kaspa network. TESTNET: optional ephemeral privateKey (never stored). MAINNET: rejected — use prepare_deploy + wallet sign + send_raw_transaction. Prefer source/cacheKey, or pass bytecode+abi (Worker-safe when solc eval is unavailable). signedRawTx alone broadcasts without compiling.",
      inputSchema: {
        network: z
          .string()
          .optional()
          .describe("EVM network id. Omit only after choose_network; otherwise you will be asked Testnet or mainnet?"),
        source: z.string().optional().describe("Solidity source (compiled if cacheKey/bytecode not set)"),
        cacheKey: z.string().optional(),
        contractName: z.string().optional(),
        bytecode: z.string().optional().describe("Precompiled creation bytecode (0x-hex)"),
        abi: z.array(z.unknown()).optional().describe("ABI JSON array paired with bytecode"),
        constructorArgs: z.array(z.unknown()).optional(),
        privateKey: z
          .string()
          .optional()
          .describe("TESTNET ONLY. 0x-hex. Ephemeral per call. Never stored."),
        signedRawTx: z.string().optional().describe("Pre-signed raw tx (any network)"),
      },
    },
    async (args) => {
      try {
        const resolved = resolveNetwork({ explicit: args.network, kind: "evm" });
        const ask = needNetworkChoicePayload(resolved);
        if (ask) return ask;
        if (!resolved.ok) return err("network resolve failed");
        const network = resolved.network;
        // Reject mainnet keys before any compile / RPC work.
        const privateKey = normalizeTestnetPrivateKey(network, args.privateKey);
        if (args.constructorArgs && args.constructorArgs.length > MAX_CTOR_ARGS) {
          throw new Error(`constructorArgs exceeds ${MAX_CTOR_ARGS} items`);
        }
        if (args.signedRawTx) assertRawTxShape(args.signedRawTx);

        const backend = backendFor(network);
        if (!backend.deploy) {
          throw new SafetyError(`Network ${network.id} does not support EVM deploy`);
        }

        // signedRawTx path: broadcast only (no compile required).
        if (args.signedRawTx && !args.source && !args.cacheKey && !args.bytecode) {
          if (!backend.sendRawTransaction) throw new SafetyError("send_raw_transaction not supported");
          const sent = await backend.sendRawTransaction(network, args.signedRawTx.trim());
          return ok({
            safety: SAFETY_BANNER,
            txHash: sent.hash,
            explorerTxUrl: sent.explorerUrl,
            networkId: network.id,
            note: "Broadcast signedRawTx. Contract address is in the receipt — use get_tx.",
          });
        }

        if (!backend.compile && !args.bytecode) {
          throw new SafetyError(`Network ${network.id} does not support EVM deploy`);
        }
        let compiled: CompileResult | undefined = args.cacheKey
          ? compiledCache.get(args.cacheKey)
          : undefined;
        if (!compiled) compiled = compiledFromBytecode(args);
        if (!compiled && args.source) {
          assertSourceSize(args.source);
          if (!backend.compile) throw new SafetyError(`Network ${network.id} cannot compile`);
          compiled = await backend.compile(network, args.source, {
            contractName: args.contractName,
          });
        }
        if (!compiled) throw new Error("Provide source, bytecode+abi, or a valid cacheKey from compile_solidity");
        const result = await backend.deploy(network, compiled, {
          ctorArgs: args.constructorArgs,
          privateKey,
          signedRawTx: args.signedRawTx?.trim(),
        });
        return ok({
          safety: SAFETY_BANNER,
          ...(resolved.mainnetWarning ? { mainnetWarning: resolved.mainnetWarning } : {}),
          networkSource: resolved.source,
          ...result,
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "prepare_deploy",
    {
      description:
        "Build an unsigned deploy transaction (safe on mainnet). User signs externally. Accepts source, cacheKey, or bytecode+abi.",
      inputSchema: {
        network: z
          .string()
          .optional()
          .describe("EVM network id. Call choose_network first if omitted."),
        source: z.string().optional(),
        cacheKey: z.string().optional(),
        contractName: z.string().optional(),
        bytecode: z.string().optional(),
        abi: z.array(z.unknown()).optional(),
        constructorArgs: z.array(z.unknown()).optional(),
        fromAddress: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const resolved = resolveNetwork({ explicit: args.network, kind: "evm" });
        const ask = needNetworkChoicePayload(resolved);
        if (ask) return ask;
        if (!resolved.ok) return err("network resolve failed");
        const network = resolved.network;
        const backend = backendFor(network);
        if (!backend.prepareDeploy) {
          throw new SafetyError(`Network ${network.id} cannot prepare EVM deploys`);
        }
        if (args.constructorArgs && args.constructorArgs.length > MAX_CTOR_ARGS) {
          throw new Error(`constructorArgs exceeds ${MAX_CTOR_ARGS} items`);
        }
        let compiled = args.cacheKey ? compiledCache.get(args.cacheKey) : undefined;
        if (!compiled) compiled = compiledFromBytecode(args);
        if (!compiled && args.source) {
          assertSourceSize(args.source);
          if (!backend.compile) throw new SafetyError(`Network ${network.id} cannot compile`);
          compiled = await backend.compile(network, args.source, {
            contractName: args.contractName,
          });
        }
        if (!compiled) throw new Error("Provide source, bytecode+abi, or cacheKey");
        const prepared = await backend.prepareDeploy(
          network,
          compiled,
          args.constructorArgs,
          args.fromAddress,
        );
        const tapToApprove = await attachTapToApprove("evm-deploy", network.id, {
          evm: {
            chainId: prepared.chainId ?? network.chainId ?? 0,
            to: prepared.to ?? null,
            data: prepared.data,
            value: prepared.value ?? "0",
            gasLimit: prepared.gasLimit,
            gasPrice: prepared.gasPrice,
            nonce: prepared.nonce,
          },
          meta: { contractName: compiled.contractName },
        });
        return ok({
          safety: SAFETY_BANNER,
          ...(resolved.mainnetWarning ? { mainnetWarning: resolved.mainnetWarning } : {}),
          networkSource: resolved.source,
          prepared,
          abi: compiled.abi,
          contractName: compiled.contractName,
          tapToApprove,
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "read_contract",
    {
      description: "eth_call / read a view function on an EVM contract.",
      inputSchema: {
        network: z.string().optional().describe("Defaults to session or " + DEFAULT_EVM_TESTNET + ""),
        address: z.string(),
        abi: z.array(z.unknown()),
        functionName: z.string(),
        args: z.array(z.unknown()).optional(),
      },
    },
    async ({ network: nid, address, abi, functionName, args }) => {
      try {
        if (abi.length > MAX_ABI_ITEMS) throw new Error(`abi exceeds ${MAX_ABI_ITEMS} items`);
        if (args && args.length > MAX_CALL_ARGS) throw new Error(`args exceeds ${MAX_CALL_ARGS} items`);
        const resolved = resolveNetwork({ explicit: nid, kind: "evm", allowSafeFallback: true });
        if (!resolved.ok) return ok({ safety: SAFETY_BANNER, ...resolved });
        const network = resolved.network;
        const backend = backendFor(network);
        if (!backend.readContract) throw new SafetyError("read_contract not supported on this network");
        return ok(await backend.readContract(network, address, abi, functionName, args ?? []));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "prepare_call",
    {
      description: "Prepare an unsigned state-changing contract call. Ask Testnet or mainnet? via choose_network first if network omitted.",
      inputSchema: {
        network: z.string().optional().describe("EVM network id; omit only after choose_network"),
        address: z.string(),
        abi: z.array(z.unknown()),
        functionName: z.string(),
        args: z.array(z.unknown()).optional(),
        valueWei: z.string().optional(),
        fromAddress: z.string().optional(),
      },
    },
    async (a) => {
      try {
        if (a.abi.length > MAX_ABI_ITEMS) throw new Error(`abi exceeds ${MAX_ABI_ITEMS} items`);
        if (a.args && a.args.length > MAX_CALL_ARGS) throw new Error(`args exceeds ${MAX_CALL_ARGS} items`);
        const resolved = resolveNetwork({ explicit: a.network, kind: "evm" });
        const ask = needNetworkChoicePayload(resolved);
        if (ask) return ask;
        if (!resolved.ok) return err("network resolve failed");
        const network = resolved.network;
        const backend = backendFor(network);
        if (!backend.prepareCall) throw new SafetyError("prepare_call not supported");
        const prepared = await backend.prepareCall(
          network,
          a.address,
          a.abi,
          a.functionName,
          a.args ?? [],
          a.valueWei ?? "0",
          a.fromAddress,
        );
        const tapToApprove = await attachTapToApprove("evm-call", network.id, {
          evm: {
            chainId: prepared.chainId ?? network.chainId ?? 0,
            to: prepared.to ?? a.address,
            data: prepared.data,
            value: prepared.value ?? a.valueWei ?? "0",
            gasLimit: prepared.gasLimit,
            gasPrice: prepared.gasPrice,
            nonce: prepared.nonce,
          },
        });
        return ok({
          safety: SAFETY_BANNER,
          ...(resolved.mainnetWarning ? { mainnetWarning: resolved.mainnetWarning } : {}),
          networkSource: resolved.source,
          prepared,
          tapToApprove,
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "send_raw_transaction",
    {
      description: "Broadcast a user-signed raw transaction to an EVM network.",
      inputSchema: {
        network: z.string().optional().describe("EVM network; choose_network first if omitted"),
        rawTx: z.string(),
      },
    },
    async ({ network: nid, rawTx }) => {
      try {
        assertRawTxShape(rawTx);
        const resolved = resolveNetwork({ explicit: nid, kind: "evm" });
        const ask = needNetworkChoicePayload(resolved);
        if (ask) return ask;
        if (!resolved.ok) return err("network resolve failed");
        const network = resolved.network;
        const backend = backendFor(network);
        if (!backend.sendRawTransaction) throw new SafetyError("send_raw_transaction not supported");
        return ok(await backend.sendRawTransaction(network, rawTx.trim()));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "get_balance",
    {
      description: "Native balance on EVM (Kasplex/Igra) or Kaspa L1 (sompi via api.kaspa.org).",
      inputSchema: {
        network: z.string().optional().describe("Defaults to session preference or testnet"),
        address: z.string(),
      },
    },
    async ({ network: nid, address }) => {
      try {
        const resolved = resolveNetwork({ explicit: nid, kind: "any", allowSafeFallback: true });
        if (!resolved.ok) return ok({ safety: SAFETY_BANNER, ...resolved });
        const network = resolved.network;
        const bal = await backendFor(network).getBalance(network, address);
        const sompi = BigInt(
          (bal as { balanceSompi?: string; balanceWei?: string }).balanceSompi ??
            (bal as { balanceWei?: string }).balanceWei ??
            (bal as { balance?: string | number }).balance ??
            0,
        );
        // kaspatest:p… / kaspa:p… are script-hash (P2SH)
        const p2shLike = /:p[a-z0-9]{50,}$/i.test(address);
        if (sompi === 0n && p2shLike) {
          return ok({
            safety: SAFETY_BANNER,
            ...bal,
            balanceSompi: "0",
            ...zeroBalanceFundOffer(address),
          });
        }
        return ok({ safety: SAFETY_BANNER, ...bal, funded: sompi > 0n });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "get_tx",
    {
      description: "Fetch a transaction by hash on EVM or Kaspa L1.",
      inputSchema: {
        network: z.string().optional().describe("Defaults to session preference or testnet"),
        hash: z.string(),
      },
    },
    async ({ network: nid, hash }) => {
      try {
        const resolved = resolveNetwork({ explicit: nid, kind: "any", allowSafeFallback: true });
        if (!resolved.ok) return ok({ safety: SAFETY_BANNER, ...resolved });
        const network = resolved.network;
        const result = await backendFor(network).getTx(network, hash);
        // strip bulky raw from default response noise but keep status
        const { raw: _raw, ...rest } = result;
        return ok(rest);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "faucet_info",
    {
      description: "How to get free testnet funds for a network. Does not claim (captcha/PoW may apply). $0 only.",
      inputSchema: {
        network: z.string().optional().describe("Defaults to kaspa-l1-testnet-10"),
      },
    },
    async ({ network: nid }) => {
      try {
        const resolved = resolveNetwork({ explicit: nid, kind: "l1", allowSafeFallback: true });
        if (!resolved.ok) return ok({ safety: SAFETY_BANNER, ...resolved });
        const n = resolved.network;
        if (!n.isTestnet) {
          return ok({
            network: n.id,
            message: "Mainnet has no faucet. Bridging/buying KAS costs real money — out of scope for this $0 connector.",
          });
        }
        const isL1Tn10 = n.id === "kaspa-l1-testnet-10" || n.id === "kaspa-testnet-10";
        return ok({
          network: n.id,
          faucetUrl: n.faucetUrl ?? (isL1Tn10 ? TN10_FAUCET_URL : null),
          notes: n.faucetNotes ?? "See network docs.",
          cost: "$0 testnet tokens only",
          ...(isL1Tn10 ? faucetPasteSteps() : {}),
          tellUser:
            isL1Tn10
              ? `No testnet KAS yet? Open ${TN10_FAUCET_URL} → paste your kaspatest: address → request free test KAS. (Official Kaspa wiki faucet; this bot never auto-drips.)`
              : undefined,
          walletsForApprove: WALLET_TAP_APPROVE,
          noPopupPath: NO_POPUP_PATH_PLAIN,
          igraApi:
            n.id === "igra-galleon-testnet"
              ? {
                  docs: "https://faucet.igralabs.com/docs",
                  status: "GET https://faucet.igralabs.com/api/testnet/status",
                  challenge: "POST /api/testnet/challenge {address}",
                  drip: "POST /api/testnet/drip {address,signature,challenge,nonce}",
                  amount: "0.1 iKAS / 24h",
                }
              : undefined,
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "l1_blockdag_info",
    {
      description: "Kaspa L1 blockDAG summary from public api.kaspa.org (or tn10).",
      inputSchema: {
        network: z.enum(["kaspa-l1-mainnet", "kaspa-l1-testnet-10"]).default("kaspa-l1-testnet-10"),
      },
    },
    async ({ network: nid }) => {
      try {
        const n = getNetwork(nid);
        const base = n.rpcUrl!.replace(/\/$/, "");
        const res = await fetch(`${base}/info/blockdag`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return ok(await res.json());
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "verify_rpc",
    {
      description: "Ping an EVM network eth_chainId and compare to the registry (health check).",
      inputSchema: {
        network: z.string().optional().describe("Defaults to kasplex-testnet"),
      },
    },
    async ({ network: nid }) => {
      try {
        const resolved = resolveNetwork({ explicit: nid, kind: "evm", allowSafeFallback: true });
        if (!resolved.ok) return ok({ safety: SAFETY_BANNER, ...resolved });
        const n = resolved.network;
        if (n.kind !== "evm" || !n.rpcUrl) throw new Error("verify_rpc is for EVM networks with rpcUrl");
        const res = await fetch(n.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
        });
        const body = (await res.json()) as { result?: string; error?: unknown };
        const reported = body.result ? parseInt(body.result, 16) : null;
        return ok({
          network: n.id,
          expectedChainId: n.chainId,
          reportedChainId: reported,
          ok: reported === n.chainId,
          rpcUrl: n.rpcUrl,
        });
      } catch (e) {
        return err(e);
      }
    },
  );


  server.registerTool(
    "silverscript_templates",
    {
      description:
        "List L1 SilverScript templates (TipJar, TimeoutVault, Escrow) with source + pinned example artifacts (silverc v1.0.0). Shared demo: use these or paste your own artifact — no in-Worker compile. UNAUDITED / use at own risk.",
      inputSchema: { id: z.string().optional().describe("Optional template id for full detail") },
    },
    async ({ id }) => {
      try {
        if (id) {
          const t = getTemplate(id);
          return ok({
            safety: SAFETY_BANNER,
            template: {
              id: t.id,
              title: t.title,
              description: t.description,
              recommendedEntry: t.recommendedEntry,
              source: t.source,
              exampleMeta: t.exampleMeta,
              exampleArtifact: t.exampleArtifact,
              entries: t.loadedExample.entries,
              bytecodeHex: t.loadedExample.bytecodeHex,
            },
            kcc20: "Upcoming — not shipped in this connector yet.",
            compileHint: silvercCompileHint(),
            walletHint: KASWARE_HINT,
            wallets: WALLET_TAP_APPROVE,
            noPopupPath: NO_POPUP_PATH_PLAIN,
            plainEnglish:
              "Ready-made contracts. On the public demo you approve once in a compatible wallet; on your own copy the bot can deploy with no popups.",
          });
        }
        return ok({
          safety: SAFETY_BANNER,
          templates: listTemplates().map((t) => ({
            id: t.id,
            title: t.title,
            description: t.description,
            recommendedEntry: t.recommendedEntry,
            exampleP2shTestnet10: t.exampleMeta.exampleP2shTestnet10,
            entries: Object.keys(t.loadedExample.entries),
          })),
          kcc20: "Upcoming — not shipped yet.",
          warning: L1_UNAUDITED_WARNING,
          compileHint: silvercCompileHint(),
          walletHint: KASWARE_HINT,
          wallets: WALLET_TAP_APPROVE,
          noPopupPath: NO_POPUP_PATH_PLAIN,
          buildTipJarHint:
            "User said build a tip jar? Ask Testnet/mainnet, then offer tap-to-approve OR self_host (no popups). Call faucet_info if they need free tKAS.",
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "silverscript_load_artifact",
    {
      description: "Validate a SilAbiArtifact JSON (from silverc or a pinned template) and return bytecode, entries, template hash. UNAUDITED / use at own risk.",
      inputSchema: {
        artifact: z.unknown().optional(),
        templateId: z.string().optional().describe("tipjar | timeout_vault | escrow"),
        contractName: z.string().optional(),
      },
    },
    async ({ artifact, templateId, contractName }) => {
      try {
        const loaded = templateId
          ? getTemplate(templateId).loadedExample
          : loadSilArtifact(artifact, contractName);
        return ok({
          safety: SAFETY_BANNER,
          contractName: loaded.contractName,
          bytecodeHex: loaded.bytecodeHex,
          templateHashHex: loaded.templateHashHex,
          entries: loaded.entries,
          compilerVersion: loaded.artifact.compiler_version,
          schemaVersion: loaded.artifact.schema_version,
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "silverscript_compile",
    {
      description:
        "SELF-HOST ONLY: compile .sil with silverc binary (SILVERC_PATH). Disabled on Cloudflare Workers — use templates or paste artifact. UNAUDITED / use at own risk.",
      inputSchema: {
        source: z.string(),
        constructorArgs: z.array(z.unknown()).optional(),
      },
    },
    async ({ source, constructorArgs }) => {
      try {
        assertSourceSize(source);
        if (!isSilvercAvailable()) {
          throw new Error(silvercCompileHint());
        }
        if (constructorArgs && constructorArgs.length > MAX_CTOR_ARGS) {
          throw new Error(`constructorArgs exceeds ${MAX_CTOR_ARGS}`);
        }
        const loaded = compileSilverscript({ source, constructorArgs });
        return ok({
          safety: SAFETY_BANNER,
          contractName: loaded.contractName,
          bytecodeHex: loaded.bytecodeHex,
          templateHashHex: loaded.templateHashHex,
          entries: loaded.entries,
          artifact: loaded.artifact,
          note: "Pin this artifact; use l1_derive_p2sh → l1_prepare_fund → wallet sign.",
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "l1_derive_p2sh",
    {
      description:
        "Derive P2SH for tipjar/vault/escrow (pass ownerAddress). For crowdfund/fundraiser/aon_pledge this tool REDIRECTS you to l1_aon_create_campaign — do not compile. TipGoalJar/softcap redirects to l1_prepare_fund.",
      inputSchema: {
        bytecodeHex: z.string().optional(),
        artifact: z.unknown().optional(),
        templateId: z.string().optional().describe("tipjar | timeout_vault | escrow"),
        contractName: z.string().optional(),
        ownerAddress: z.string().optional().describe("Required for tipjar — your kaspatest:q… receive address"),
        ownerPkhHex: z.string().optional(),
        network: z.string().default("kaspa-l1-testnet-10"),
      },
    },
    async ({ bytecodeHex, artifact, templateId, contractName, ownerAddress, ownerPkhHex, network: nid }) => {
      try {
        const tid = (templateId || "").toLowerCase();
        if (
          tid === "aon_pledge" ||
          tid === "aon" ||
          tid === "crowdfund" ||
          tid === "fundraiser" ||
          tid === "kickstarter"
        ) {
          return ok({
            safety: SAFETY_BANNER,
            redirect: "l1_aon_create_campaign",
            tellUser:
              "For crowdfund / fundraiser / all-or-nothing, call l1_aon_create_campaign with the user's ownerAddress + goal. It returns a share page — no compile needed on the public connector.",
            next: 'l1_aon_create_campaign({ ownerAddress, goalSompi, deadlineMs?, network: "kaspa-l1-testnet-10" })',
          });
        }
        if (tid === "softcap" || tid === "tipgoal" || tid === "tip_goal_jar") {
          return ok({
            safety: SAFETY_BANNER,
            redirect: "l1_prepare_fund",
            tellUser:
              "TipGoalJar is not a crowdfund (no auto-refund). Use l1_prepare_fund with templateId softcap + ownerAddress + goalSompi + deadlineMs. For refundable crowdfund use l1_aon_create_campaign.",
            next: 'l1_prepare_fund({ templateId: "softcap", fromAddress, ownerAddress, goalSompi, deadlineMs, amountSompi })',
          });
        }
        const network = getNetwork(nid);
        const resolvedBc = resolveTemplateBytecodeForFund({
          templateId,
          artifact,
          contractName,
          bytecodeHex,
          ownerAddress,
          ownerPkhHex,
          networkId: network.id,
        });
        return ok({
          safety: SAFETY_BANNER,
          networkId: network.id,
          address: resolvedBc.p2shAddress,
          p2shAddress: resolvedBc.p2shAddress,
          bytecodeHex: resolvedBc.bytecodeHex,
          ownerAddress,
          ownerPkhHex: resolvedBc.ownerPkhHex,
          rebound: resolvedBc.rebound,
          ...readyNotOnChain({ p2shAddress: resolvedBc.p2shAddress, templateId }),
          walletHint: KASWARE_HINT,
          neverManualSend: NEVER_MANUAL_SEND,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/aon_pledge|campaignTag|backer|goalSompi|deadline/i.test(msg)) {
          return ok({
            safety: SAFETY_BANNER,
            redirect: "l1_aon_create_campaign",
            tellUser:
              "That looks like a crowdfund setup. Call l1_aon_create_campaign (prebuilt + rebind — no silverc on the public connector).",
            detail: msg,
          });
        }
        return err(e);
      }
    },
  );

  server.registerTool(
    "l1_prepare_fund",
    {
      description:
        "Prepare a ONE-TAP fund link (public demo OK). Always returns tapToApprove.url — never tell users to send manually. " +
        "ALWAYS rebinds the template to the exact owner/params you pass so the funded address matches what you showed the user. " +
        "Pass expectedP2shAddress whenever you already showed an address — mismatch refuses. " +
        "lockbox requires unlockAtMs; tip goal jar / aon_pledge require goalSompi+deadlineMs; escrow requires parties. UNAUDITED.",
      inputSchema: {
        network: z
          .string()
          .optional()
          .describe("L1 network id. Omit only after choose_network — otherwise ask Testnet or mainnet?"),
        fromAddress: z.string().optional().describe("Required unless autoSignBroadcast (then spending wallet address is used)"),
        amountSompi: z.union([z.string(), z.number()]),
        priorityFeeSompi: z.union([z.string(), z.number()]).optional(),
        bytecodeHex: z.string().optional(),
        artifact: z.unknown().optional(),
        contractName: z.string().optional(),
        templateId: z.string().optional(),
        ownerAddress: z
          .string()
          .optional()
          .describe("TipJar owner P2PK address (kaspatest:q…). Defaults to fromAddress. Required for tipjar binding."),
        ownerPkhHex: z.string().optional().describe("Optional explicit TipJar ownerPkh (32-byte hex)"),
        expectedP2shAddress: z
          .string()
          .optional()
          .describe("If you already showed the user an address, pass it here — fund refuses on mismatch"),
        unlockAtMs: z.union([z.string(), z.number()]).optional().describe("lockbox: exact unlock time (unix ms) you already showed"),
        goalSompi: z.union([z.string(), z.number()]).optional().describe("tip goal jar / aon_pledge: goal in sompi (1 test KAS = 100000000)"),
        deadlineMs: z.union([z.string(), z.number()]).optional().describe("tip goal jar / aon_pledge: deadline unix ms"),
        backerAddress: z.string().optional().describe("aon_pledge: backer receive address"),
        backerPkhHex: z.string().optional(),
        campaignTagHex: z.string().optional().describe("aon_pledge: shared 32-byte hex campaign id"),
        recipientXonlyHex: z.string().optional(),
        senderXonlyHex: z.string().optional(),
        arbiterAddress: z.string().optional(),
        buyerXonlyHex: z.string().optional(),
        sellerXonlyHex: z.string().optional(),
        autoSignBroadcast: z.boolean().optional().describe("Self-host spending wallet: sign+broadcast. Ignored/refused on shared demo."),
      },
    },
    async (a) => {
      try {
        const resolved = resolveNetwork({ explicit: a.network, kind: "l1" });
        const ask = needNetworkChoicePayload(resolved);
        if (ask) return ask;
        if (!resolved.ok) return err("network resolve failed");
        const network = resolved.network;
        const ownerAddress = a.ownerAddress?.trim() || a.fromAddress?.trim();
        const resolvedBc = resolveTemplateBytecodeForFund({
          templateId: a.templateId,
          artifact: a.artifact,
          contractName: a.contractName,
          bytecodeHex: a.bytecodeHex,
          ownerAddress,
          ownerPkhHex: a.ownerPkhHex,
          expectedP2shAddress: a.expectedP2shAddress,
          unlockAtMs: a.unlockAtMs != null ? BigInt(a.unlockAtMs as string | number) : undefined,
          goalSompi: a.goalSompi != null ? BigInt(a.goalSompi as string | number) : undefined,
          deadlineMs: a.deadlineMs != null ? BigInt(a.deadlineMs as string | number) : undefined,
          backerAddress: a.backerAddress,
          backerPkhHex: a.backerPkhHex,
          campaignTagHex: a.campaignTagHex,
          recipientXonlyHex: a.recipientXonlyHex,
          senderXonlyHex: a.senderXonlyHex,
          arbiterAddress: a.arbiterAddress,
          buyerXonlyHex: a.buyerXonlyHex,
          sellerXonlyHex: a.sellerXonlyHex,
          networkId: network.id,
        });
        const loaded = resolvedBc.loaded;
        const loadedBc = resolvedBc.bytecode;
        const bytecodeHex = resolvedBc.bytecodeHex;
        const p2shAddress = resolvedBc.p2shAddress;
        const l1Build = {
          buildInBrowser: true as const,
          kaspaNetwork: kaspaNetworkFor(network.id, network.isTestnet),
          utxoApiBase: utxoApiBaseFor(network.id, network.isTestnet),
          bytecodeHex,
          fromAddress: a.fromAddress,
          amountSompi: String(a.amountSompi),
          priorityFeeSompi: a.priorityFeeSompi != null ? String(a.priorityFeeSompi) : undefined,
          expectedP2shAddress: p2shAddress,
        };
        if (a.autoSignBroadcast) {
          if (isSharedPublicDemo()) {
            throw new SafetyError("autoSignBroadcast refused on shared demo — self-host + spending_wallet_create");
          }
          if (!a.templateId) {
            throw new SafetyError(
              "autoSignBroadcast fund requires templateId from the reviewed allowlist: " +
                REVIEWED_TEMPLATE_IDS.join(", "),
            );
          }
          assertReviewedTemplate(a.templateId);
          const result = await autoFundCovenant({
            network,
            bytecode: loadedBc,
            amountSompi: BigInt(a.amountSompi),
            priorityFeeSompi: a.priorityFeeSompi != null ? BigInt(a.priorityFeeSompi) : undefined,
            templateId: a.templateId,
          });
          return ok({
            safety: SAFETY_BANNER,
            warning: L1_UNAUDITED_WARNING,
            mode: "spending_wallet_broadcast",
            ...result,
            tapToApproveOptional: "Still available via prepare without autoSignBroadcast",
          });
        }
        // Prefer browser-build session so shared Worker works without Node wasm.
        const useNode = await kaspaWasmAvailable();
        if (!useNode) {
          const tapToApprove = await attachTapToApprove("l1-fund", network.id, {
            l1Build,
            meta: {
              templateId: a.templateId,
              contractName: contractLabelFor(a.templateId, a.contractName),
              p2shAddress,
              expectedP2shAddress: p2shAddress,
              ownerAddress,
              ownerPkhHex: resolvedBc.ownerPkhHex,
              rebound: resolvedBc.rebound,
            },
          });
          if (!tapToApprove) {
            throw new Error("Sign session store unavailable — cannot return tapToApprove link");
          }
          return ok({
            safety: SAFETY_BANNER,
            warning: L1_UNAUDITED_WARNING,
            mode: "browser_build",
            networkId: network.id,
            kaspaNetwork: l1Build.kaspaNetwork,
            amountSompi: String(a.amountSompi),
            fromAddress: a.fromAddress,
            ownerAddress,
            p2shAddress,
            rebound: resolvedBc.rebound,
            tapToApprove,
            ...readyNotOnChain({ p2shAddress, tapToApproveUrl: tapToApprove.url, templateId: a.templateId }),
            note: TAP_APPROVE_NOTE,
            wallets: WALLET_TAP_APPROVE,
            noPopupPath: NO_POPUP_PATH_PLAIN,
            neverManualSend: NEVER_MANUAL_SEND,
          });
        }
        if (!a.fromAddress) throw new Error("fromAddress required unless autoSignBroadcast");
        const prepared = await prepareFund({
          network,
          bytecode: loadedBc,
          fromAddress: a.fromAddress,
          amountSompi: BigInt(a.amountSompi),
          priorityFeeSompi: a.priorityFeeSompi != null ? BigInt(a.priorityFeeSompi) : undefined,
        });
        if (prepared.p2shAddress !== p2shAddress) {
          throw new SafetyError(
            `Prepared P2SH ${prepared.p2shAddress} !== rebound ${p2shAddress} — refusing`,
          );
        }
        const tapToApprove = await attachTapToApprove("l1-fund", network.id, {
          safeJson: prepared.safeJson,
          signInputs: prepared.kasware.signInputs,
          l1Build,
          meta: {
            p2shAddress,
            expectedP2shAddress: p2shAddress,
            templateId: a.templateId,
            contractName: contractLabelFor(a.templateId, a.contractName),
            ownerAddress,
            ownerPkhHex: resolvedBc.ownerPkhHex,
            rebound: resolvedBc.rebound,
          },
        });
        return ok({
          safety: SAFETY_BANNER,
          ...prepared,
          p2shAddress,
          ownerAddress,
          rebound: resolvedBc.rebound,
          tapToApprove,
          ...readyNotOnChain({ p2shAddress, tapToApproveUrl: tapToApprove?.url, templateId: a.templateId }),
          neverManualSend: NEVER_MANUAL_SEND,
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "l1_prepare_spend",
    {
      description:
        "Prepare a ONE-TAP withdraw/spend link for a P2SH covenant. Works on the PUBLIC demo via tapToApprove (/sign page wraps the unlock for KasWare/Kastle/Kaspire). " +
        "If the jar has 0 balance, call l1_prepare_fund first — never tell users to send manually. autoSignBroadcast = self-host spending wallet only. UNAUDITED.",
      inputSchema: {
        network: z.string().optional().describe("L1 network; choose_network first if omitted"),
        entry: z.string(),
        args: z.array(z.unknown()),
        destinationAddress: z.string(),
        utxo: z.object({
          transactionId: z.string(),
          index: z.number(),
          amountSompi: z.union([z.string(), z.number()]),
          scriptPublicKey: z.object({ version: z.number(), script: z.string() }),
        }),
        artifact: z.unknown().optional(),
        bytecodeHex: z.string().optional(),
        contractName: z.string().optional(),
        templateId: z.string().optional(),
        feeSompi: z.union([z.string(), z.number()]).optional(),
        outputAmountSompi: z.union([z.string(), z.number()]).optional(),
        privateKey: z.string().optional().describe("TESTNET ONLY ephemeral. Prefer spending wallet + autoSignBroadcast."),
        autoSignBroadcast: z.boolean().optional().describe("Self-host spending wallet sign+broadcast"),
      },
    },
    async (a) => {
      try {
        const resolved = resolveNetwork({ explicit: a.network, kind: "l1" });
        const ask = needNetworkChoicePayload(resolved);
        if (ask) return ask;
        if (!resolved.ok) return err("network resolve failed");
        const network = resolved.network;
        if (a.privateKey && !network.isTestnet) {
          throw new Error("privateKey rejected on mainnet L1");
        }
        let loaded;
        if (a.templateId) loaded = getTemplate(a.templateId).loadedExample;
        else if (a.artifact) loaded = loadSilArtifact(a.artifact, a.contractName);
        else if (a.bytecodeHex) {
          throw new Error("bytecodeHex alone lacks ABI entries — pass artifact or templateId");
        } else throw new Error("Provide templateId or artifact");
        const entry = entryOf(loaded, a.entry);
        const bytecodeHex = [...loaded.bytecode].map((b) => b.toString(16).padStart(2, "0")).join("");
        const l1Build = {
          buildInBrowser: true as const,
          kaspaNetwork: kaspaNetworkFor(network.id, network.isTestnet),
          utxoApiBase: utxoApiBaseFor(network.id, network.isTestnet),
          bytecodeHex,
          entryName: a.entry,
          dispatchTag: entry.dispatch_tag,
          entryParams: entry.params,
          args: a.args,
          destinationAddress: a.destinationAddress,
          feeSompi: a.feeSompi != null ? String(a.feeSompi) : "300000",
          outputAmountSompi: a.outputAmountSompi != null ? String(a.outputAmountSompi) : undefined,
          p2shUtxo: {
            outpoint: { transactionId: a.utxo.transactionId, index: a.utxo.index },
            amount: String(a.utxo.amountSompi),
            scriptPublicKey: a.utxo.scriptPublicKey,
          },
        };
        if (a.autoSignBroadcast) {
          if (isSharedPublicDemo()) {
            throw new SafetyError("autoSignBroadcast refused on shared demo — self-host + spending_wallet_create");
          }
          const result = await autoSpendCovenant({
            network,
            loaded,
            entryName: a.entry,
            args: a.args,
            destinationAddress: a.destinationAddress,
            feeSompi: a.feeSompi != null ? BigInt(a.feeSompi) : undefined,
            outputAmountSompi: a.outputAmountSompi != null ? BigInt(a.outputAmountSompi) : undefined,
            p2shUtxo: {
              outpoint: { transactionId: a.utxo.transactionId, index: a.utxo.index },
              amount: BigInt(a.utxo.amountSompi),
              scriptPublicKey: a.utxo.scriptPublicKey,
            },
          });
          return ok({
            safety: SAFETY_BANNER,
            warning: L1_UNAUDITED_WARNING,
            mode: "spending_wallet_broadcast",
            ...result,
          });
        }
        const useNode = await kaspaWasmAvailable();
        if (!useNode) {
          const tapToApprove = await attachTapToApprove("l1-spend", network.id, {
            l1Build,
            meta: {
              entry: a.entry,
              templateId: a.templateId,
              contractName: contractLabelFor(a.templateId, a.contractName),
            },
          });
          if (!tapToApprove) throw new Error("Sign session store unavailable");
          return ok({
            safety: SAFETY_BANNER,
            warning: L1_UNAUDITED_WARNING,
            mode: "browser_build",
            networkId: network.id,
            entry: a.entry,
            tapToApprove,
            note: TAP_APPROVE_NOTE + " For covenant unlocks the page fills the script then broadcasts; KasWare-only signPskt cannot invent unlock args.",
            wallets: WALLET_TAP_APPROVE,
            noPopupPath: NO_POPUP_PATH_PLAIN,
          });
        }
        const prepared = await prepareSpend({
          network,
          loaded,
          entryName: a.entry,
          args: a.args,
          destinationAddress: a.destinationAddress,
          feeSompi: a.feeSompi != null ? BigInt(a.feeSompi) : undefined,
          outputAmountSompi: a.outputAmountSompi != null ? BigInt(a.outputAmountSompi) : undefined,
          privateKeyHex: a.privateKey,
          p2shUtxo: {
            outpoint: { transactionId: a.utxo.transactionId, index: a.utxo.index },
            amount: BigInt(a.utxo.amountSompi),
            scriptPublicKey: a.utxo.scriptPublicKey,
          },
        });
        const tapToApprove = await attachTapToApprove("l1-spend", network.id, {
          safeJson: prepared.safeJson,
          signedSafeJson: prepared.signedSafeJson,
          signInputs: prepared.kasware.signInputs,
          l1Build,
          meta: {
            p2shAddress: prepared.p2shAddress,
            entry: a.entry,
            templateId: a.templateId,
            contractName: contractLabelFor(a.templateId, a.contractName),
          },
        });
        return ok({ safety: SAFETY_BANNER, ...prepared, tapToApprove });
      } catch (e) {
        return err(e);
      }
    },
  );




  server.registerTool(
    "spending_wallet_create",
    {
      description:
        "SELF-HOST ONLY. Create a fresh dedicated Kaspa spending wallet for chat-deploy. " +
        "REQUIRES mainAddress (your cold/main wallet) — the only destination withdraw_all may use. " +
        "Node: key written to local file (not echoed). Cloudflare Worker: one-shot privateKeyHex + wrangler secret put steps. " +
        "Refused on shared demo. Never accepts a pasted main-wallet key/seed.",
      inputSchema: {
        network: z.string().optional().describe("L1 network; choose_network first if omitted (testnet recommended)"),
        mainAddress: z
          .string()
          .describe("Locked withdraw destination (your main/cold kaspatest:/kaspa: address). Required."),
        persist: z.boolean().optional().describe("Must be true/omitted — key file persist is mandatory."),
      },
    },
    async (a) => {
      try {
        const resolved = resolveNetwork({ explicit: a.network, kind: "l1" });
        const ask = needNetworkChoicePayload(resolved);
        if (ask) return ask;
        if (!resolved.ok) return err("network resolve failed");
        const network = resolved.network;
        if (!a.mainAddress?.trim()) {
          throw new SafetyError("mainAddress is required (locked withdraw_all destination)");
        }
        const created = await createSpendingWallet({
          network,
          mainAddress: a.mainAddress,
          persist: a.persist,
        });
        // Deliberately omit privateKeyHex from MCP response (bomb-proof).
        return ok({
          safety: SAFETY_BANNER,
          warning: created.warning,
          address: created.address,
          mainAddress: created.mainAddress,
          networkId: created.networkId,
          persistedTo: created.persistedTo,
          registryPath: created.registryPath,
          // Worker one-shot only — omitted when file-persisted (Node)
          ...(created.privateKeyHex ? { privateKeyHex: created.privateKeyHex } : {}),
          backupHint: created.backupHint,
          wranglerHint: created.wranglerHint,
          setupSteps: created.setupSteps,
          allowlist: [...REVIEWED_TEMPLATE_IDS],
          nextSteps: [
            `Fund ${created.address} on ${network.isTestnet ? "TN10" : "mainnet (≤ cap)"}`,
            created.backupHint,
            "Then: l1_tipjar_chat_deploy or autoSignBroadcast with reviewed templateId",
            "withdraw_all → locked mainAddress only",
          ],
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "spending_wallet_status",
    {
      description:
        "Show spending wallet config (address, mainAddress, caps, covenant count). Never returns the private key.",
      inputSchema: { network: z.string().optional().describe("Defaults to session or TN10") },
    },
    async (a) => {
      try {
        const resolved = resolveNetwork({ explicit: a.network, kind: "l1", allowSafeFallback: true });
        if (!resolved.ok) return ok({ safety: SAFETY_BANNER, ...resolved });
        const network = resolved.network;
        const status = await spendingWalletStatus(network);
        let balanceSompiStr: string | undefined;
        if (status.address) {
          try {
            balanceSompiStr = (await balanceSompi(network, status.address)).toString();
          } catch {
            balanceSompiStr = undefined;
          }
        }
        return ok({ safety: SAFETY_BANNER, ...status, balanceSompi: balanceSompiStr });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "spending_wallet_withdraw_all",
    {
      description:
        "SELF-HOST ONLY. Sweep the entire spending wallet balance to the locked mainAddress set at creation. " +
        "No destination parameter (prompt-injection cannot redirect). Caps still apply on mainnet.",
      inputSchema: {
        network: z.string().optional().describe("L1 network; choose_network first if omitted"),
        priorityFeeSompi: z.union([z.string(), z.number()]).optional(),
      },
    },
    async (a) => {
      try {
        const resolved = resolveNetwork({ explicit: a.network, kind: "l1" });
        const ask = needNetworkChoicePayload(resolved);
        if (ask) return ask;
        if (!resolved.ok) return err("network resolve failed");
        const network = resolved.network;
        const result = await spendingWalletWithdrawAll({
          network,
          priorityFeeSompi: a.priorityFeeSompi != null ? BigInt(a.priorityFeeSompi) : undefined,
        });
        return ok({
          safety: SAFETY_BANNER,
          warning: L1_UNAUDITED_WARNING,
          mode: "spending_wallet_withdraw_all",
          ...result,
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "spending_wallet_export_key",
    {
      description:
        "Always refused. Exists so agents/prompt-injection attempting to export the spending key get a clear denial.",
      inputSchema: { confirm: z.string().optional() },
    },
    async () => {
      try {
        refuseKeyExport();
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "spending_wallet_set_limits",
    {
      description:
        "Always refused. Caps are deploy-time env only (not raisable via chat).",
      inputSchema: {
        maxKas: z.union([z.string(), z.number()]).optional(),
        maxTxKas: z.union([z.string(), z.number()]).optional(),
      },
    },
    async () => {
      try {
        refuseCapChangeViaChat();
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "l1_tipjar_chat_deploy",
    {
      description:
        "SELF-HOST ONLY. Chat-deploy reviewed TipJar with spending wallet as owner: compile (silverc or Worker rebind) → fund P2SH → registry. " +
        "No wallet popup. Requires spending_wallet_create({ mainAddress }) + funded address. Pure-JS signer works on free Cloudflare Workers.",
      inputSchema: {
        network: z.string().optional().describe("L1 network; choose_network first if omitted"),
        amountSompi: z.union([z.string(), z.number()]).default("100000000").describe("Fund amount (default 1 tKAS)"),
        priorityFeeSompi: z.union([z.string(), z.number()]).optional(),
      },
    },
    async (a) => {
      try {
        if (isSharedPublicDemo()) {
          return ok({
            safety: SAFETY_BANNER,
            warning: L1_UNAUDITED_WARNING,
            refused: true,
            reason: "shared_demo_keyless",
            plainEnglish:
              "This public connector never holds keys, so it cannot deploy a tip jar by itself. Pick one path:",
            paths: {
              tapToApprove: {
                title: "Approve once in your wallet (this connector)",
                walletsThatWork: WALLET_TAP_APPROVE.worksNow,
                walletsNotYet: WALLET_TAP_APPROVE.notYet,
                nextTools: [
                  "choose_network({ choice: \"testnet\" })",
                  "faucet_info if they need free tKAS",
                  "l1_prepare_fund({ templateId: \"tipjar\", fromAddress, amountSompi }) → open tapToApprove.url",
                ],
              },
              noPopups: {
                title: "No approvals — their own free copy",
                next: "Call self_host({ step: \"start\" }) and walk them through Cloudflare + spending wallet, then retry l1_tipjar_chat_deploy on THEIR /mcp URL.",
              },
            },
            faucet: faucetPasteSteps(),
            askUser:
              "Do you want a one-tap approve link (KasWare / Kastle / Kaspire), or should I help you set up your own copy so I can deploy with no popups?",
          });
        }
        const resolved = resolveNetwork({ explicit: a.network, kind: "l1" });
        const ask = needNetworkChoicePayload(resolved);
        if (ask) return ask;
        if (!resolved.ok) return err("network resolve failed");
        const network = resolved.network;
        const key = assertCanAutoSign(network);
        const ownerAddress = await addressForKey(key.hex, network);
        const pkhHex = await ownerPkhHex(key.hex);
        const tipjar = getTemplate("tipjar");
        let loaded;
        if (isSilvercAvailable()) {
          const pkh = Array.from(Buffer.from(pkhHex, "hex"));
          loaded = compileSilverscript({
            source: tipjar.source,
            constructorArgs: [{ kind: "bytes", value: pkh }],
          });
        } else {
          // Worker / no silverc: rebind bundled TipJar demo bytecode (byte-identical to silverc).
          const { rebindTipjarOwnerPkh } = await import("./l1/artifact.js");
          loaded = rebindTipjarOwnerPkh(tipjar.loadedExample, pkhHex);
        }
        const funded = await autoFundCovenant({
          network,
          bytecode: loaded.bytecode,
          amountSompi: BigInt(a.amountSompi),
          priorityFeeSompi: a.priorityFeeSompi != null ? BigInt(a.priorityFeeSompi) : undefined,
          templateId: "tipjar",
        });
        const page = await createContractPage({
          networkId: network.id,
          templateId: "tipjar",
          contractName: loaded.contractName,
          p2shAddress: funded.p2shAddress,
          fundTxid: funded.txid,
          explorer: funded.explorer,
          title: "TipJar",
          blurb: "Anyone can tip this address. The owner can withdraw with their key.",
        });
        return ok({
          safety: SAFETY_BANNER,
          warning: L1_UNAUDITED_WARNING,
          mode: "spending_wallet_tipjar_deploy",
          ownerAddress,
          ownerPkhHex: pkhHex,
          artifact: loaded.artifact,
          contractName: loaded.contractName,
          bytecodeHex: loaded.bytecodeHex,
          ...funded,
          sharePage: { url: page.url, id: page.record.id },
          next: "Share sharePage.url. Wait for P2SH UTXO, then l1_prepare_spend autoSignBroadcast entry withdraw (args [null,null]) to spending address or mainAddress. Or spending_wallet_withdraw_all.",
        });
      } catch (e) {
        return err(e);
      }
    },
  );


  server.registerTool(
    "choose_network",
    {
      description:
        "REQUIRED EARLY: remember Testnet or mainnet for this session before any build/deploy/prepare. " +
        "Ask the user 'Testnet or mainnet?' then call this. Mainnet responses include the UNAUDITED warning.",
      inputSchema: {
        choice: z.enum(["testnet", "mainnet"]).describe("User's explicit choice"),
      },
    },
    async ({ choice }) => {
      try {
        const pref = await setSessionNetworkChoice(choice as NetworkChoice);
        return ok({
          safety: SAFETY_BANNER,
          remembered: true,
          ...pref,
          l1: getNetwork(pref.l1NetworkId),
          evm: getNetwork(pref.evmNetworkId),
          ...(choice === "mainnet"
            ? {
                mainnetWarning: L1_UNAUDITED_WARNING,
                confirmWithUser:
                  "Mainnet uses real KAS. Confirm the user accepts UNAUDITED / USE AT YOUR OWN RISK before deploying or funding.",
              }
            : {
                note: "Testnet selected — safe for experiments. Use faucet_info for free tKAS.",
              }),
          next: "Proceed with templates / prepare / deploy on the remembered networks. Pass network= explicitly to override.",
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "network_preference",
    {
      description: "Show the session network choice (testnet/mainnet) if set. Does not change it.",
      inputSchema: {},
    },
    async () => {
      try {
        const pref = getSessionNetworkPreference();
        if (!pref) {
          return ok({
            safety: SAFETY_BANNER,
            set: false,
            askUser: ASK_NETWORK_PROMPT,
            hint: "Call choose_network after the user answers.",
          });
        }
        return ok({ safety: SAFETY_BANNER, set: true, ...pref });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "self_host",
    {
      description:
        "Guided step-by-step wizard for everyday users to launch THEIR own Kaspa connector " +
        "(free Cloudflare or local), set the spending-wallet secret, fund, and verify. " +
        "Copy-paste commands in code blocks. Shared demo stays keyless — secrets only on the user's copy.",
      inputSchema: {
        step: z
          .enum(["start", "deploy", "create_wallet", "set_secret", "fund", "verify", "connect", "status", "own_node", "update"])
          .optional()
          .describe("Wizard step (default start)"),
        platform: z.enum(["cloudflare", "local"]).optional(),
        mainAddress: z.string().optional().describe("User main/cold kaspatest: or kaspa: address for withdraw_all lock"),
        workerUrl: z.string().optional().describe("User's MCP URL after deploy"),
      },
    },
    async (a) => {
      try {
        return ok(await runSelfHostGuide(a));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "l1_confirm_tx",
    {
      description:
        "Poll public REST until a Kaspa L1 tx is accepted (or timed out). " +
        "Use after submit to avoid orphan/reject-but-landed races. Returns tn10.kaspa.stream / explorer link.",
      inputSchema: {
        txid: z.string(),
        network: z
          .enum(["kaspa-l1-testnet-10", "kaspa-l1-mainnet", "testnet-10", "mainnet"])
          .optional()
          .describe("Defaults to session or TN10"),
        timeoutMs: z.number().optional(),
      },
    },
    async (a) => {
      try {
        const raw = a.network;
        let netId: "testnet-10" | "mainnet" = "testnet-10";
        if (raw === "kaspa-l1-mainnet" || raw === "mainnet") netId = "mainnet";
        else if (raw === "kaspa-l1-testnet-10" || raw === "testnet-10") netId = "testnet-10";
        else {
          const resolved = resolveNetwork({ explicit: undefined, kind: "l1", allowSafeFallback: true });
          if (resolved.ok) netId = resolved.network.isTestnet ? "testnet-10" : "mainnet";
        }
        if (netId === "mainnet") {
          // still allow confirm on mainnet reads
        }
        const conf = await confirmTransaction(netId, a.txid, {
          timeoutMs: a.timeoutMs,
        });
        return ok({
          safety: SAFETY_BANNER,
          ...(netId === "mainnet" ? { mainnetWarning: L1_UNAUDITED_WARNING } : {}),
          ...conf,
          explorer: conf.explorer || explorerTxUrl(netId, conf.txid),
        });
      } catch (e) {
        return err(e);
      }
    },
  );



  server.registerTool(
    "estimate_fee",
    {
      description: "Live L1 fee/mass estimate from REST /info/fee-estimate (failover across configured nodes).",
      inputSchema: {
        network: z.enum(["kaspa-l1-testnet-10", "kaspa-l1-mainnet", "testnet-10", "mainnet"]).optional(),
      },
    },
    async (a) => {
      try {
        let netId: "testnet-10" | "mainnet" = "testnet-10";
        if (a.network === "kaspa-l1-mainnet" || a.network === "mainnet") netId = "mainnet";
        else if (a.network === "kaspa-l1-testnet-10" || a.network === "testnet-10") netId = "testnet-10";
        else {
          const resolved = resolveNetwork({ kind: "l1", allowSafeFallback: true });
          if (resolved.ok) netId = resolved.network.isTestnet ? "testnet-10" : "mainnet";
        }
        const est = await estimateFees(netId);
        return ok({
          safety: SAFETY_BANNER,
          ...(netId === "mainnet" ? { mainnetWarning: L1_UNAUDITED_WARNING } : {}),
          ...est,
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "configure_node",
    {
      description:
        "SELF-HOST: set your own REST (and optional wRPC) so UTXO/submit do not depend on a single public API. " +
        "Pass restBases like https://your-vps:8000. Public community APIs remain as failover unless you omit them by only listing yours and accepting outages when yours is down.",
      inputSchema: {
        restBases: z.array(z.string()).optional().describe("REST bases, tried first"),
        wrpcUrl: z.string().optional().describe("Optional wss:// your rusty-kaspa node"),
        reset: z.boolean().optional().describe("Clear custom config"),
      },
    },
    async (a) => {
      try {
        if (isSharedPublicDemo()) {
          throw new SafetyError(
            "configure_node refused on shared demo. Self-host, then set KASPA_REST_URLS or call configure_node on YOUR Worker.",
          );
        }
        if (a.reset) {
          setNodeConfig({});
          applyNodeConfigFromEnv();
        } else {
          setNodeConfig({ restBases: a.restBases, wrpcUrl: a.wrpcUrl });
        }
        return ok({
          safety: SAFETY_BANNER,
          configured: getNodeConfig(),
          defaults: defaultRestBases(),
          hint:
            "Run your own indexer REST (kaspa-ng/kaspa-rest-server) + rusty-kaspa for mainnet independence. " +
            "Env: KASPA_REST_URLS=https://you:8000 KASPA_RPC_URL=wss://you:17110",
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "create_contract_page",
    {
      description:
        "Create a one-tap simple share page for a P2SH contract (address + blurb + copy button). Returns /page/<id> URL.",
      inputSchema: {
        p2shAddress: z.string(),
        network: z.string().optional(),
        templateId: z.string().optional(),
        contractName: z.string().optional(),
        fundTxid: z.string().optional(),
        explorer: z.string().optional(),
        title: z.string().optional(),
        blurb: z.string().optional(),
      },
    },
    async (a) => {
      try {
        const resolved = resolveNetwork({ explicit: a.network, kind: "l1", allowSafeFallback: true });
        if (!resolved.ok) return ok({ safety: SAFETY_BANNER, ...resolved });
        const page = await createContractPage({
          networkId: resolved.network.id,
          templateId: a.templateId,
          contractName: a.contractName,
          p2shAddress: a.p2shAddress,
          fundTxid: a.fundTxid,
          explorer: a.explorer,
          title: a.title,
          blurb: a.blurb,
        });
        return ok({ safety: SAFETY_BANNER, sharePage: { url: page.url, id: page.record.id }, record: page.record });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "l1_vault_chat_deploy",
    {
      description:
        "SELF-HOST ONLY. Chat-deploy TimeoutVault with spending wallet as sender (and optional recipient x-only). " +
        "Worker path rebinds bundled artifact (byte-identical to silverc). No popup.",
      inputSchema: {
        network: z.string().optional(),
        amountSompi: z.union([z.string(), z.number()]).default("100000000"),
        recipientXonlyHex: z
          .string()
          .optional()
          .describe("32-byte x-only recipient pubkey hex; default = spending wallet (self-vault)"),
        priorityFeeSompi: z.union([z.string(), z.number()]).optional(),
      },
    },
    async (a) => {
      try {
        if (isSharedPublicDemo()) {
          return ok({
            safety: SAFETY_BANNER,
            warning: L1_UNAUDITED_WARNING,
            refused: true,
            reason: "shared_demo_keyless",
            plainEnglish:
              "This public connector never holds keys, so chat-deploy without popups needs YOUR own copy.",
            paths: {
              tapToApprove: {
                title: "Approve once in your wallet (this connector)",
                walletsThatWork: WALLET_TAP_APPROVE.worksNow,
                walletsNotYet: WALLET_TAP_APPROVE.notYet,
              },
              noPopups: {
                title: "No approvals — their own free copy",
                next: "Call self_host({ step: \"start\" }) then retry this tool on THEIR /mcp URL.",
              },
            },
            faucet: faucetPasteSteps(),
            askUser:
              "One-tap approve (KasWare / Kastle / Kaspire), or set up your own copy for no popups?",
          });
        }
        const resolved = resolveNetwork({ explicit: a.network, kind: "l1" });
        const ask = needNetworkChoicePayload(resolved);
        if (ask) return ask;
        if (!resolved.ok) return err("network resolve failed");
        const network = resolved.network;
        const key = assertCanAutoSign(network);
        const senderX = bytesToHex(privateKeyToXonly(key.hex));
        const recipientX = (a.recipientXonlyHex || senderX).replace(/^0x/, "").toLowerCase();
        const vault = getTemplate("timeout_vault");
        let loaded;
        if (isSilvercAvailable()) {
          loaded = compileSilverscript({
            source: vault.source,
            constructorArgs: [
              { kind: "bytes", value: Array.from(Buffer.from(senderX, "hex")) },
              { kind: "bytes", value: Array.from(Buffer.from(recipientX, "hex")) },
              { kind: "int", value: 4_000_000_000_000 },
            ],
          });
        } else {
          const { rebindTimeoutVaultKeys } = await import("./l1/artifact.js");
          loaded = rebindTimeoutVaultKeys(vault.loadedExample, {
            senderXonlyHex: senderX,
            recipientXonlyHex: recipientX,
          });
        }
        const funded = await autoFundCovenant({
          network,
          bytecode: loaded.bytecode,
          amountSompi: BigInt(a.amountSompi),
          priorityFeeSompi: a.priorityFeeSompi != null ? BigInt(a.priorityFeeSompi) : undefined,
          templateId: "timeout_vault",
        });
        const page = await createContractPage({
          networkId: network.id,
          templateId: "timeout_vault",
          contractName: loaded.contractName,
          p2shAddress: funded.p2shAddress,
          fundTxid: funded.txid,
          explorer: funded.explorer,
          title: "TimeoutVault",
          blurb: "Recipient can claim anytime; sender reclaims after timeout.",
        });
        return ok({
          safety: SAFETY_BANNER,
          warning: L1_UNAUDITED_WARNING,
          mode: "spending_wallet_vault_deploy",
          senderXonlyHex: senderX,
          recipientXonlyHex: recipientX,
          artifact: loaded.artifact,
          contractName: loaded.contractName,
          bytecodeHex: loaded.bytecodeHex,
          ...funded,
          sharePage: { url: page.url, id: page.record.id },
          next: "Recipient: l1_prepare_spend entry transfer. Sender after timeout: entry timeout.",
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "l1_escrow_chat_deploy",
    {
      description:
        "SELF-HOST ONLY. Chat-deploy Escrow with spending wallet as arbiter. " +
        "Buyer/seller default to the spending wallet x-only pubkey (self-test); pass both for a real third-party escrow. No popup.",
      inputSchema: {
        network: z.string().optional(),
        amountSompi: z.union([z.string(), z.number()]).default("100000000"),
        buyerXonlyHex: z
          .string()
          .optional()
          .describe("Buyer 32-byte x-only pubkey hex (default: spending wallet)"),
        sellerXonlyHex: z
          .string()
          .optional()
          .describe("Seller 32-byte x-only pubkey hex (default: spending wallet)"),
        priorityFeeSompi: z.union([z.string(), z.number()]).optional(),
      },
    },
    async (a) => {
      try {
        if (isSharedPublicDemo()) {
          return ok({
            safety: SAFETY_BANNER,
            warning: L1_UNAUDITED_WARNING,
            refused: true,
            reason: "shared_demo_keyless",
            plainEnglish:
              "This public connector never holds keys, so chat-deploy without popups needs YOUR own copy.",
            paths: {
              tapToApprove: {
                title: "Approve once in your wallet (this connector)",
                walletsThatWork: WALLET_TAP_APPROVE.worksNow,
                walletsNotYet: WALLET_TAP_APPROVE.notYet,
              },
              noPopups: {
                title: "No approvals — their own free copy",
                next: "Call self_host({ step: \"start\" }) then retry this tool on THEIR /mcp URL.",
              },
            },
            faucet: faucetPasteSteps(),
            askUser:
              "One-tap approve (KasWare / Kastle / Kaspire), or set up your own copy for no popups?",
          });
        }
        const resolved = resolveNetwork({ explicit: a.network, kind: "l1" });
        const ask = needNetworkChoicePayload(resolved);
        if (ask) return ask;
        if (!resolved.ok) return err("network resolve failed");
        const network = resolved.network;
        const key = assertCanAutoSign(network);
        const arbiterPkh = await ownerPkhHex(key.hex);
        const selfX = bytesToHex(privateKeyToXonly(key.hex));
        const buyer = (a.buyerXonlyHex || selfX).replace(/^0x/, "").toLowerCase();
        const seller = (a.sellerXonlyHex || selfX).replace(/^0x/, "").toLowerCase();
        const esc = getTemplate("escrow");
        let loaded;
        if (isSilvercAvailable()) {
          loaded = compileSilverscript({
            source: esc.source,
            constructorArgs: [
              { kind: "bytes", value: Array.from(Buffer.from(arbiterPkh, "hex")) },
              { kind: "bytes", value: Array.from(Buffer.from(buyer, "hex")) },
              { kind: "bytes", value: Array.from(Buffer.from(seller, "hex")) },
            ],
          });
        } else {
          const { rebindEscrowParties } = await import("./l1/artifact.js");
          loaded = rebindEscrowParties(esc.loadedExample, {
            arbiterPkhHex: arbiterPkh,
            buyerXonlyHex: buyer,
            sellerXonlyHex: seller,
          });
        }
        const funded = await autoFundCovenant({
          network,
          bytecode: loaded.bytecode,
          amountSompi: BigInt(a.amountSompi),
          priorityFeeSompi: a.priorityFeeSompi != null ? BigInt(a.priorityFeeSompi) : undefined,
          templateId: "escrow",
        });
        const page = await createContractPage({
          networkId: network.id,
          templateId: "escrow",
          contractName: loaded.contractName,
          p2shAddress: funded.p2shAddress,
          fundTxid: funded.txid,
          explorer: funded.explorer,
          title: "Escrow",
          blurb: "Arbiter can release funds to buyer or seller.",
        });
        return ok({
          safety: SAFETY_BANNER,
          warning: L1_UNAUDITED_WARNING,
          mode: "spending_wallet_escrow_deploy",
          arbiterPkhHex: arbiterPkh,
          buyerXonlyHex: buyer,
          sellerXonlyHex: seller,
          artifact: loaded.artifact,
          contractName: loaded.contractName,
          bytecodeHex: loaded.bytecodeHex,
          ...funded,
          sharePage: { url: page.url, id: page.record.id },
          next: "Arbiter spends with entry spend; fee must match script minerFee (300000 sompi).",
        });
      } catch (e) {
        return err(e);
      }
    },
  );


  // Resources for brainstorming  // Resources for brainstorming / docs
  server.registerResource(
    "overview",
    "kaspa-mcp://docs/overview",
    {
      description: "What this connector is, safety model, and how to build on Kaspa with an AI agent",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "kaspa-mcp://docs/overview",
          mimeType: "text/markdown",
          text: `# Kaspa MCP — build on Kaspa with your agent

${SAFETY_BANNER}

## What you can do
1. Brainstorm with \`kaspa_ideas\`
2. \`list_networks\` / \`kaspa_network_info\`
3. \`compile_solidity\` → \`faucet_info\` → \`deploy_contract\` (testnet)
4. \`read_contract\` / \`prepare_call\` / \`send_raw_transaction\`
5. Kaspa L1 reads: \`l1_blockdag_info\`, \`get_balance\` on kaspa-l1-*

## Backends
| Kind | Status |
|------|--------|
| L1 SilverScript (primary) | Templates + artifact load + prepare fund/spend (testnet); compile self-host only |
| EVM (Kasplex, Igra) | Secondary — Solidity path |
| L1 read | Implemented |
| vProgs | Roadmap stub |
| KCC-20 | Upcoming (not shipped) |

## Cost
Public RPCs + free testnet faucets only. No paid APIs. Hosting on Cloudflare Workers free tier is $0 until you leave free limits.
`,
        },
      ],
    }),
  );

  server.registerResource(
    "safety",
    "kaspa-mcp://docs/safety",
    { description: "Non-custodial security model", mimeType: "text/markdown" },
    async () => ({
      contents: [
        {
          uri: "kaspa-mcp://docs/safety",
          mimeType: "text/markdown",
          text: `# Safety model\n\n${SAFETY_BANNER}\n\n${L1_UNAUDITED_WARNING}\n\n- Shared demo: no key persistence\n- Self-host spending wallet: dedicated key in env/file on YOUR deployment only\n- Never paste a main wallet seed into chat\n- Mainnet chat privateKey always rejected; spending wallet mainnet needs KASPA_SPENDING_MAINNET=1 + balance cap\n- Tap-to-approve remains the default non-custodial path\n`,
        },
      ],
    }),
  );

  server.registerResource(
    "networks",
    "kaspa-mcp://docs/networks",
    { description: "Network registry dump", mimeType: "application/json" },
    async () => ({
      contents: [
        {
          uri: "kaspa-mcp://docs/networks",
          mimeType: "application/json",
          text: JSON.stringify(NETWORKS, null, 2),
        },
      ],
    }),
  );

  server.registerPrompt(
    "build_on_kaspa",
    {
      description: "Coach the agent to brainstorm then build on Kaspa using this connector",
      argsSchema: {
        goal: z.string().describe("User's build goal"),
      },
    },
    async ({ goal }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Help me build on Kaspa: ${goal}\n\n` +
              `Use kaspa-mcp tools. Start with kaspa_ideas and list_networks. ` +
              `Prefer Kasplex testnet for Solidity. Never ask me for a mainnet private key. ` +
              `Explain covenant vs EVM honestly. Keep everything $0 (testnet faucets / public RPCs).`,
          },
        },
      ],
    }),
  );


  server.registerTool(
    "connector_version",
    {
      description:
        "Show this connector's version and whether a newer GitHub release/main exists. " +
        "Self-hosters who are behind should call self_host({ step: \"update\" }). Never auto-updates.",
      inputSchema: {
        checkLatest: z.boolean().optional().describe("If true (default), check GitHub for newer release/main"),
      },
    },
    async (a) => {
      try {
        const ver = connectorVersion();
        const check =
          a.checkLatest === false
            ? { current: ver.version, behind: false as const }
            : await checkAgainstLatest();
        if (a.checkLatest !== false) rememberLatestCheck(check);
        return ok({
          safety: SAFETY_BANNER,
          ...ver,
          latestCheck: check,
          message: check.message || (check.behind ? undefined : "You're up to date"),
          update:
            check.behind
              ? { step: "self_host", args: { step: "update" }, neverAutoUpdate: true }
              : undefined,
        });
      } catch (e) {
        return err(e);
      }
    },
  );


  server.registerTool(
    "l1_aon_create_campaign",
    {
      description:
        "START A CROWDFUND / FUNDRAISER / KICKSTARTER / raise-money campaign (refundable all-or-nothing). Use this — not tipjar, TipGoalJar, softcap, or compile. Prebuilt artifact + rebind; works on the public connector with the users ownerAddress. Returns sharePage.url (live pledge tracker) + campaignTag. Goal in test KAS: 1 test KAS = 100000000 sompi units.",
      inputSchema: {
        ownerAddress: z.string().describe("Creator testnet/mainnet receive address"),
        goalSompi: z.union([z.string(), z.number()]).describe("Goal in sompi (1 test KAS = 100000000)"),
        deadlineMs: z.union([z.string(), z.number()]).optional().describe("Unix ms deadline; default now+7d"),
        network: z.string().optional(),
      },
    },
    async (a) => {
      try {
        const resolved = resolveNetwork({ explicit: a.network, kind: "l1" });
        const ask = needNetworkChoicePayload(resolved);
        if (ask) return ask;
        if (!resolved.ok) return err("network resolve failed");
        const c = createAoNCampaign({
          ownerAddress: a.ownerAddress,
          goalSompi: a.goalSompi,
          deadlineMs: a.deadlineMs,
          network: resolved.network.isTestnet ? "testnet-10" : "mainnet",
        });
        const page = await createCampaignPage({
          networkId: resolved.network.id,
          ownerAddress: a.ownerAddress,
          ownerPkhHex: c.ownerPkhHex,
          campaignTagHex: c.campaignTagHex,
          goalSompi: c.goalSompi,
          deadlineMs: c.deadlineMs,
          title: "All-or-nothing crowdfund",
        });
        return ok({
          safety: SAFETY_BANNER,
          policy: AON_POLICY,
          campaign: c,
          sharePage: { url: page.url, id: page.record.id },
          tellUser:
            "Campaign created. Share sharePage.url — backers can pledge one-tap from the page. Or add pledges with l1_aon_add_pledge. Track progress with campaign_status.",
          next: "Share sharePage.url or l1_aon_add_pledge / campaign_status",
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "l1_aon_add_pledge",
    {
      description:
        "Add a backer pledge address to an all-or-nothing campaign and prepare a one-tap fund link for that backer.",
      inputSchema: {
        ownerAddress: z.string(),
        backerAddress: z.string(),
        campaignTagHex: z.string(),
        goalSompi: z.union([z.string(), z.number()]),
        deadlineMs: z.union([z.string(), z.number()]),
        amountSompi: z.union([z.string(), z.number()]).default("100000000"),
        network: z.string().optional(),
        fromAddress: z.string().optional().describe("Wallet funding the pledge; defaults to backerAddress"),
        campaignPageId: z.string().optional().describe("Optional campaign share page id to register this pledge on the tracker"),
      },
    },
    async (a) => {
      try {
        const resolved = resolveNetwork({ explicit: a.network, kind: "l1" });
        const ask = needNetworkChoicePayload(resolved);
        if (ask) return ask;
        if (!resolved.ok) return err("network resolve failed");
        const network = resolved.network;
        const c = createAoNCampaign({
          ownerAddress: a.ownerAddress,
          goalSompi: a.goalSompi,
          deadlineMs: a.deadlineMs,
          network: network.isTestnet ? "testnet-10" : "mainnet",
        });
        c.campaignTagHex = a.campaignTagHex.replace(/^0x/, "").toLowerCase();
        const pledge = addAoNPledge(c, a.backerAddress);
        if (a.campaignPageId) {
          await upsertCampaignPledge(a.campaignPageId, {
            backerAddress: a.backerAddress,
            backerPkhHex: pledge.backerPkhHex,
            p2shAddress: pledge.p2shAddress,
          });
        }
        const fromAddress = a.fromAddress?.trim() || a.backerAddress.trim();
        // Build fund link via existing prepare path
        const resolvedBc = resolveTemplateBytecodeForFund({
          templateId: "aon_pledge",
          ownerAddress: a.ownerAddress,
          backerAddress: a.backerAddress,
          campaignTagHex: c.campaignTagHex,
          goalSompi: a.goalSompi,
          deadlineMs: a.deadlineMs,
          expectedP2shAddress: pledge.p2shAddress,
          networkId: network.id,
        });
        const l1Build = {
          buildInBrowser: true as const,
          kaspaNetwork: kaspaNetworkFor(network.id, network.isTestnet),
          utxoApiBase: utxoApiBaseFor(network.id, network.isTestnet),
          fromAddress,
          amountSompi: String(a.amountSompi),
          bytecodeHex: resolvedBc.bytecodeHex,
          expectedP2shAddress: pledge.p2shAddress,
          destinationAddress: pledge.p2shAddress,
        };
        const tapToApprove = await attachTapToApprove("l1-fund", network.id, {
          l1Build,
          meta: {
            templateId: "aon_pledge",
            contractName: "AoNPledge",
            p2shAddress: pledge.p2shAddress,
            expectedP2shAddress: pledge.p2shAddress,
            campaignTagHex: c.campaignTagHex,
            goalSompi: String(a.goalSompi),
            deadlineMs: String(a.deadlineMs),
            backerAddress: a.backerAddress,
          },
        });
        const page = await createContractPage({
          networkId: network.id,
          templateId: "aon_pledge",
          contractName: "AoNPledge",
          p2shAddress: pledge.p2shAddress,
          title: "Crowdfund pledge",
          blurb: `All-or-nothing pledge. Goal ${a.goalSompi} sompi. Deadline ${a.deadlineMs}. Backer reclaim after deadline if goal missed.`,
        });
        return ok({
          safety: SAFETY_BANNER,
          warning: L1_UNAUDITED_WARNING,
          policy: AON_POLICY,
          pledge,
          campaignTagHex: c.campaignTagHex,
          goalSompi: String(a.goalSompi),
          deadlineMs: String(a.deadlineMs),
          tapToApprove,
          sharePage: { url: page.url, id: page.record.id },
          tellUser:
            "Ready — not on chain until funded. Open the one-tap link to fund this backer's pledge address. Do not say it is live yet.",
        });
      } catch (e) {
        return err(e);
      }
    },
  );


  server.registerTool(
    "l1_check_session",
    {
      description:
        "Poll a one-tap /sign session after prepare. Returns pending or submitted + txid/explorer when the user approved. Do NOT ask the user to paste a transaction ID — call this instead.",
      inputSchema: {
        sessionId: z.string().describe("tapToApprove.id from prepare_fund / prepare_spend / aon pledge"),
      },
    },
    async (a) => {
      try {
        const ctx = getSignContext();
        if (!ctx) return err("Sign session store unavailable");
        const id = a.sessionId.replace(/^.*\//, "").trim();
        const session = await ctx.store.get(id);
        if (!session) {
          return ok({
            status: "unknown",
            tellUser: "Session not found or expired. Ask them to open the approve link again if needed.",
          });
        }
        const submitted = Boolean(session.submittedTxid);
        return ok({
          status: submitted ? "submitted" : "pending",
          sessionId: session.id,
          kind: session.kind,
          submittedTxid: session.submittedTxid || null,
          submittedAt: session.submittedAt || null,
          explorerUrl: session.submittedTxid
            ? explorerFor(session.networkId, session.submittedTxid)
            : null,
          expiresAt: session.expiresAt,
          networkId: session.networkId,
          meta: session.meta || {},
          tellUser: submitted
            ? `Confirmed on chain path — tx ${session.submittedTxid}`
            : "Still waiting for wallet approval. Keep the approve link handy; poll again shortly.",
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "campaign_status",
    {
      description:
        "Live all-or-nothing crowdfund status: raised vs goal, deadline countdown, status (open/goal_met/claimed/refunding), and pledge list from chain (REST failover). Pass campaignPageId from l1_aon_create_campaign sharePage.id.",
      inputSchema: {
        campaignPageId: z.string().describe("Campaign share page id"),
      },
    },
    async (a) => {
      try {
        const rec = await getCampaignPage(a.campaignPageId);
        if (!rec) return err("Campaign page not found or expired");
        const status = await computeCampaignStatus(rec);
        return ok({
          safety: SAFETY_BANNER,
          status,
          sharePath: status.sharePath,
          tellUser: `Raised ${status.raisedKas} / ${status.goalKas} · ${status.statusLabel} · ${status.pledgeCount} pledges`,
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "l1_lockbox_chat_deploy",
    {
      description:
        "SELF-HOST ONLY. Chat-deploy Lockbox (time-locked savings): anyone funds; owner withdraws only after unlockAt (unix ms). " +
        "Default unlock = now+1h on testnet. Worker rebind is byte-identical to silverc. No popup.",
      inputSchema: {
        network: z.string().optional(),
        amountSompi: z.union([z.string(), z.number()]).default("100000000"),
        unlockAtMs: z
          .union([z.string(), z.number()])
          .optional()
          .describe("Unix ms unlock time (≥ 500000000000). Default: now + 1 hour"),
        unlockInMs: z
          .union([z.string(), z.number()])
          .optional()
          .describe("Alternative: unlock this many ms from now (default 3600000)"),
        priorityFeeSompi: z.union([z.string(), z.number()]).optional(),
      },
    },
    async (a) => {
      try {
        if (isSharedPublicDemo()) {
          return ok({
            safety: SAFETY_BANNER,
            warning: L1_UNAUDITED_WARNING,
            refused: true,
            reason: "shared_demo_keyless",
            plainEnglish: "Lockbox chat-deploy needs YOUR own copy (self_host). On the public demo use l1_prepare_fund with templateId lockbox + ownerAddress.",
            askUser: "Set up your own copy for no-popup lockbox, or prepare a tap-to-approve fund link?",
          });
        }
        const resolved = resolveNetwork({ explicit: a.network, kind: "l1" });
        const ask = needNetworkChoicePayload(resolved);
        if (ask) return ask;
        if (!resolved.ok) return err("network resolve failed");
        const network = resolved.network;
        const key = assertCanAutoSign(network);
        const pkh = await ownerPkhHex(key.hex);
        const unlockAt = a.unlockAtMs != null
          ? BigInt(a.unlockAtMs)
          : BigInt(Date.now() + Number(a.unlockInMs ?? 3_600_000));
        const tpl = getTemplate("lockbox");
        let loaded;
        if (isSilvercAvailable()) {
          loaded = compileSilverscript({
            source: tpl.source,
            constructorArgs: [
              { kind: "bytes", value: Array.from(Buffer.from(pkh, "hex")) },
              { kind: "int", value: Number(unlockAt) },
            ],
          });
        } else {
          loaded = rebindLockbox(tpl.loadedExample, { ownerPkhHex: pkh, unlockAt });
        }
        const funded = await autoFundCovenant({
          network,
          bytecode: loaded.bytecode,
          amountSompi: BigInt(a.amountSompi),
          priorityFeeSompi: a.priorityFeeSompi != null ? BigInt(a.priorityFeeSompi) : undefined,
          templateId: "lockbox",
        });
        const page = await createContractPage({
          networkId: network.id,
          templateId: "lockbox",
          contractName: loaded.contractName,
          p2shAddress: funded.p2shAddress,
          fundTxid: funded.txid,
          explorer: funded.explorer,
          title: "Lockbox",
          blurb: `Time-locked savings. Owner can withdraw only after ${unlockAt} (unix ms).`,
        });
        return ok({
          safety: SAFETY_BANNER,
          warning: L1_UNAUDITED_WARNING,
          mode: "spending_wallet_lockbox_deploy",
          ownerPkhHex: pkh,
          unlockAtMs: unlockAt.toString(),
          ...funded,
          sharePage: { url: page.url, id: page.record.id },
          next: "After unlockAt, l1_prepare_spend entry withdraw (or autoSignBroadcast on self-host).",
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "l1_softcap_chat_deploy",
    {
      description:
        "SELF-HOST ONLY. Chat-deploy TipGoalJar (NOT a crowdfund — backers are NOT refunded). Owner claims early only if THIS UTXO ≥ goal; after deadline owner may close. " +
        "For refundable all-or-nothing crowdfunding use aon_pledge. Default goal 1 test KAS, deadline now+7d.",
      inputSchema: {
        network: z.string().optional(),
        amountSompi: z.union([z.string(), z.number()]).default("100000000"),
        goalSompi: z.union([z.string(), z.number()]).default("100000000").describe("Soft cap in sompi (must fit 4-byte silverc encoding, ≲42 KAS)"),
        deadlineMs: z.union([z.string(), z.number()]).optional().describe("Unix ms deadline; default now+7d"),
        priorityFeeSompi: z.union([z.string(), z.number()]).optional(),
      },
    },
    async (a) => {
      try {
        if (isSharedPublicDemo()) {
          return ok({
            safety: SAFETY_BANNER,
            warning: L1_UNAUDITED_WARNING,
            refused: true,
            reason: "shared_demo_keyless",
            plainEnglish:
              "Tip goal jar is not a crowdfund (backers are not refunded). On the public connector I prepare a one-tap fund link — tell me your testnet address and goal.",
            nextTool: {
              name: "l1_prepare_fund",
              argsHint:
                '{ templateId: "softcap", fromAddress, ownerAddress, goalSompi, deadlineMs, amountSompi } → open tapToApprove.url',
            },
            betterCrowdfund: "For refundable all-or-nothing crowdfunding use aon_pledge.",
          });
        }
        const resolved = resolveNetwork({ explicit: a.network, kind: "l1" });
        const ask = needNetworkChoicePayload(resolved);
        if (ask) return ask;
        if (!resolved.ok) return err("network resolve failed");
        const network = resolved.network;
        const key = assertCanAutoSign(network);
        const pkh = await ownerPkhHex(key.hex);
        const goal = BigInt(a.goalSompi);
        const deadline = a.deadlineMs != null ? BigInt(a.deadlineMs) : BigInt(Date.now() + 7 * 86_400_000);
        const tpl = getTemplate("softcap");
        let loaded;
        if (isSilvercAvailable()) {
          loaded = compileSilverscript({
            source: tpl.source,
            constructorArgs: [
              { kind: "bytes", value: Array.from(Buffer.from(pkh, "hex")) },
              { kind: "int", value: Number(goal) },
              { kind: "int", value: Number(deadline) },
            ],
          });
        } else {
          loaded = rebindSoftCapJar(tpl.loadedExample, {
            ownerPkhHex: pkh,
            goalSompi: goal,
            deadline,
          });
        }
        const funded = await autoFundCovenant({
          network,
          bytecode: loaded.bytecode,
          amountSompi: BigInt(a.amountSompi),
          priorityFeeSompi: a.priorityFeeSompi != null ? BigInt(a.priorityFeeSompi) : undefined,
          templateId: "softcap",
        });
        const page = await createContractPage({
          networkId: network.id,
          templateId: "softcap",
          contractName: loaded.contractName,
          p2shAddress: funded.p2shAddress,
          fundTxid: funded.txid,
          explorer: funded.explorer,
          title: "TipGoalJar",
          blurb: `Soft-cap jar. Claim if ≥ ${goal} sompi; after deadline owner may close. Contributors are not auto-refunded.`,
        });
        return ok({
          safety: SAFETY_BANNER,
          warning: L1_UNAUDITED_WARNING,
          mode: "spending_wallet_tip_goal_deploy",
          ownerPkhHex: pkh,
          goalSompi: goal.toString(),
          deadlineMs: deadline.toString(),
          contributorNote: "Contributors are NOT auto-refunded — each UTXO is independent.",
          ...funded,
          sharePage: { url: page.url, id: page.record.id },
          next: "Owner: entry claim (if ≥ goal) or entry close after deadline.",
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  return server;
}
