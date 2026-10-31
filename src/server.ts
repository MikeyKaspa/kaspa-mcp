import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getNetwork, listNetworks, DEFAULT_EVM_TESTNET, NETWORKS } from "./networks.js";
import { backendFor } from "./backends/registry.js";
import { compileSolidityAsync } from "./backends/compile.js";
import { SAFETY_BANNER, SafetyError, normalizeTestnetPrivateKey, redactSecrets } from "./safety.js";
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
import { loadSilArtifact, entryOf } from "./l1/artifact.js";
import { deriveP2shAddress } from "./l1/p2sh.js";
import { prepareFund, prepareSpend, KASWARE_HINT } from "./l1/prepare.js";
import { L1_UNAUDITED_WARNING, kaspaWasmAvailable } from "./l1/kaspa-sdk.js";
import { attachTapToApprove, utxoApiBaseFor, kaspaNetworkFor, contractLabelFor } from "./sign/attach.js";
import { compileSilverscript, isSilvercAvailable, silvercCompileHint } from "./l1/compile.js";
import { coerceBytecode } from "./l1/artifact.js";
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
  return {
    content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
  };
}
function err(e: unknown): TextJson {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: redactSecrets(msg) }], isError: true };
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
  const server = new McpServer({
    name: "kaspa-mcp",
    version: "0.1.0",
  });

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
        "- **Primary today:** Kaspa L1 SilverScript on testnet-10 (Toccata). Templates: TipJar, TimeoutVault, Escrow.",
        prefer === "evm"
          ? "- EVM secondary: Solidity on Kasplex/Igra when you need familiar Solidity tooling."
          : "- Prefer L1 covenants unless the user explicitly wants EVM.",
        "",
        "### Native L1 SilverScript (primary)",
        `- ${theme} as a P2SH covenant on kaspa-l1-testnet-10`,
        "- Tools: silverscript_templates → l1_derive_p2sh → l1_prepare_fund → KasWare signPskt → l1_prepare_spend",
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
        network: z.string().default(DEFAULT_EVM_TESTNET),
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
        const network = getNetwork(args.network);
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
        return ok({ safety: SAFETY_BANNER, ...result });
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
        network: z.string(),
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
        const network = getNetwork(args.network);
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
        return ok({ safety: SAFETY_BANNER, prepared, abi: compiled.abi, contractName: compiled.contractName, tapToApprove });
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
        network: z.string(),
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
        const network = getNetwork(nid);
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
      description: "Prepare an unsigned state-changing contract call.",
      inputSchema: {
        network: z.string(),
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
        const network = getNetwork(a.network);
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
        return ok({ safety: SAFETY_BANNER, prepared, tapToApprove });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "send_raw_transaction",
    {
      description: "Broadcast a user-signed raw transaction to an EVM network.",
      inputSchema: { network: z.string(), rawTx: z.string() },
    },
    async ({ network: nid, rawTx }) => {
      try {
        assertRawTxShape(rawTx);
        const network = getNetwork(nid);
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
      inputSchema: { network: z.string(), address: z.string() },
    },
    async ({ network: nid, address }) => {
      try {
        const network = getNetwork(nid);
        return ok(await backendFor(network).getBalance(network, address));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "get_tx",
    {
      description: "Fetch a transaction by hash on EVM or Kaspa L1.",
      inputSchema: { network: z.string(), hash: z.string() },
    },
    async ({ network: nid, hash }) => {
      try {
        const network = getNetwork(nid);
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
      inputSchema: { network: z.string() },
    },
    async ({ network: nid }) => {
      try {
        const n = getNetwork(nid);
        if (!n.isTestnet) {
          return ok({
            network: n.id,
            message: "Mainnet has no faucet. Bridging/buying KAS costs real money — out of scope for this $0 connector.",
          });
        }
        return ok({
          network: n.id,
          faucetUrl: n.faucetUrl ?? null,
          notes: n.faucetNotes ?? "See network docs.",
          cost: "$0 testnet tokens only",
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
        network: z.enum(["kaspa-l1-mainnet", "kaspa-l1-testnet-10"]).default("kaspa-l1-mainnet"),
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
      inputSchema: { network: z.string() },
    },
    async ({ network: nid }) => {
      try {
        const n = getNetwork(nid);
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
      description: "Derive Kaspa P2SH address from SilverScript redeem bytecode (testnet-10 or mainnet id). Requires kaspa-wasm (Node self-host); not on Cloudflare Workers. UNAUDITED / use at own risk.",
      inputSchema: {
        bytecodeHex: z.string().optional(),
        artifact: z.unknown().optional(),
        templateId: z.string().optional().describe("tipjar | timeout_vault | escrow"),
        contractName: z.string().optional(),
        network: z.string().default("kaspa-l1-testnet-10"),
      },
    },
    async ({ bytecodeHex, artifact, templateId, contractName, network: nid }) => {
      try {
        const network = getNetwork(nid);
        let bc: Uint8Array;
        if (templateId) {
          bc = getTemplate(templateId).loadedExample.bytecode;
        } else if (artifact) {
          bc = loadSilArtifact(artifact, contractName).bytecode;
        } else if (bytecodeHex) {
          bc = coerceBytecode(bytecodeHex);
        } else {
          throw new Error("Provide templateId, artifact, or bytecodeHex");
        }
        const net =
          network.id.includes("mainnet") && !network.isTestnet ? "mainnet" : "testnet-10";
        const derived = await deriveP2shAddress(bc, net);
        return ok({ safety: SAFETY_BANNER, warning: L1_UNAUDITED_WARNING, networkId: network.id, ...derived, walletHint: KASWARE_HINT });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "l1_prepare_fund",
    {
      description:
        "Build fund tx for a P2SH covenant. Default: unsigned SafeJSON + tapToApprove. With autoSignBroadcast=true on self-host with a spending wallet, signs+broadcasts (testnet default; mainnet needs KASPA_SPENDING_MAINNET=1). Shared demo never auto-signs. UNAUDITED.",
      inputSchema: {
        network: z.string().default("kaspa-l1-testnet-10"),
        fromAddress: z.string().optional().describe("Required unless autoSignBroadcast (then spending wallet address is used)"),
        amountSompi: z.union([z.string(), z.number()]),
        priorityFeeSompi: z.union([z.string(), z.number()]).optional(),
        bytecodeHex: z.string().optional(),
        artifact: z.unknown().optional(),
        contractName: z.string().optional(),
        templateId: z.string().optional(),
        autoSignBroadcast: z.boolean().optional().describe("Self-host spending wallet: sign+broadcast. Ignored/refused on shared demo."),
      },
    },
    async (a) => {
      try {
        const network = getNetwork(a.network);
        let loadedBc: Uint8Array;
        let loaded;
        if (a.templateId) {
          loaded = getTemplate(a.templateId).loadedExample;
          loadedBc = loaded.bytecode;
        } else if (a.artifact) {
          loaded = loadSilArtifact(a.artifact, a.contractName);
          loadedBc = loaded.bytecode;
        } else if (a.bytecodeHex) {
          loadedBc = coerceBytecode(a.bytecodeHex);
        } else throw new Error("Provide templateId, artifact, or bytecodeHex");
        const bytecodeHex = [...loadedBc].map((b) => b.toString(16).padStart(2, "0")).join("");
        const l1Build = {
          buildInBrowser: true as const,
          kaspaNetwork: kaspaNetworkFor(network.id, network.isTestnet),
          utxoApiBase: utxoApiBaseFor(network.id, network.isTestnet),
          bytecodeHex,
          fromAddress: a.fromAddress,
          amountSompi: String(a.amountSompi),
          priorityFeeSompi: a.priorityFeeSompi != null ? String(a.priorityFeeSompi) : undefined,
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
            tapToApprove,
            note: "Open tapToApprove.url — the page builds the fund tx with kaspa-wasm (static asset) and signs via KasWare signPskt→pushTx.",
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
        const tapToApprove = await attachTapToApprove("l1-fund", network.id, {
          safeJson: prepared.safeJson,
          signInputs: prepared.kasware.signInputs,
          l1Build,
          meta: {
            p2shAddress: prepared.p2shAddress,
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
    "l1_prepare_spend",
    {
      description:
        "Prepare/spend a P2SH covenant UTXO. Default: prepare + tapToApprove. autoSignBroadcast uses self-host spending wallet (fills $sig/$pk). Chat privateKey still TESTNET-only ephemeral; preferred path is spending wallet. Shared demo never auto-signs. UNAUDITED.",
      inputSchema: {
        network: z.string().default("kaspa-l1-testnet-10"),
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
        const network = getNetwork(a.network);
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
            note: "Open tapToApprove.url — page builds spend with kaspa-wasm. SilverScript unlock needs a signer harness or Node prepareSpend; KasWare signPskt alone cannot fill covenant unlocks (use pushTx on pre-filled).",
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
        network: z.string().default("kaspa-l1-testnet-10"),
        mainAddress: z
          .string()
          .describe("Locked withdraw destination (your main/cold kaspatest:/kaspa: address). Required."),
        persist: z.boolean().optional().describe("Must be true/omitted — key file persist is mandatory."),
      },
    },
    async (a) => {
      try {
        const network = getNetwork(a.network);
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
      inputSchema: { network: z.string().default("kaspa-l1-testnet-10") },
    },
    async (a) => {
      try {
        const network = getNetwork(a.network);
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
        network: z.string().default("kaspa-l1-testnet-10"),
        priorityFeeSompi: z.union([z.string(), z.number()]).optional(),
      },
    },
    async (a) => {
      try {
        const network = getNetwork(a.network);
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
        network: z.string().default("kaspa-l1-testnet-10"),
        amountSompi: z.union([z.string(), z.number()]).default("100000000").describe("Fund amount (default 1 tKAS)"),
        priorityFeeSompi: z.union([z.string(), z.number()]).optional(),
      },
    },
    async (a) => {
      try {
        if (isSharedPublicDemo()) {
          throw new SafetyError("l1_tipjar_chat_deploy refused on shared demo — self-host");
        }
        const network = getNetwork(a.network);
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
          next: "Wait for P2SH UTXO, then l1_prepare_spend autoSignBroadcast entry withdraw (args [null,null]) to spending address or mainAddress. Or spending_wallet_withdraw_all.",
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

  return server;
}
