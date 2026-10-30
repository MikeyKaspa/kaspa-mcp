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
import { compileSilverscript, isSilvercAvailable, silvercCompileHint } from "./l1/compile.js";
import { coerceBytecode } from "./l1/artifact.js";

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
        return ok({ safety: SAFETY_BANNER, prepared, abi: compiled.abi, contractName: compiled.contractName });
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
        return ok({
          safety: SAFETY_BANNER,
          prepared: await backend.prepareCall(
            network,
            a.address,
            a.abi,
            a.functionName,
            a.args ?? [],
            a.valueWei ?? "0",
            a.fromAddress,
          ),
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
        "List L1 SilverScript templates (TipJar, TimeoutVault, Escrow) with source + pinned example artifacts (silverc v1.0.0). Shared demo: use these or paste your own artifact — no in-Worker compile.",
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
      description: "Validate a SilAbiArtifact JSON (from silverc or a template) and return bytecode, entries, template hash.",
      inputSchema: {
        artifact: z.unknown(),
        contractName: z.string().optional(),
      },
    },
    async ({ artifact, contractName }) => {
      try {
        const loaded = loadSilArtifact(artifact, contractName);
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
        "SELF-HOST ONLY: compile .sil with silverc binary (SILVERC_PATH). Disabled on Cloudflare Workers — use templates or paste artifact.",
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
      description: "Derive Kaspa P2SH address from SilverScript redeem bytecode (testnet-10 or mainnet id).",
      inputSchema: {
        bytecodeHex: z.string().optional(),
        artifact: z.unknown().optional(),
        contractName: z.string().optional(),
        network: z.string().default("kaspa-l1-testnet-10"),
      },
    },
    async ({ bytecodeHex, artifact, contractName, network: nid }) => {
      try {
        const network = getNetwork(nid);
        let bc: Uint8Array;
        if (artifact) {
          bc = loadSilArtifact(artifact, contractName).bytecode;
        } else if (bytecodeHex) {
          bc = coerceBytecode(bytecodeHex);
        } else {
          throw new Error("Provide artifact or bytecodeHex");
        }
        const net =
          network.id.includes("mainnet") && !network.isTestnet ? "mainnet" : "testnet-10";
        const derived = await deriveP2shAddress(bc, net);
        return ok({ safety: SAFETY_BANNER, networkId: network.id, ...derived, walletHint: KASWARE_HINT });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "l1_prepare_fund",
    {
      description:
        "Prepare funding a covenant P2SH (send KAS = deploy). Mainnet gated. Returns destination + amount skeleton for KasWare.",
      inputSchema: {
        network: z.string().default("kaspa-l1-testnet-10"),
        fromAddress: z.string(),
        amountSompi: z.union([z.string(), z.number()]),
        bytecodeHex: z.string().optional(),
        artifact: z.unknown().optional(),
        contractName: z.string().optional(),
        templateId: z.string().optional(),
      },
    },
    async (a) => {
      try {
        const network = getNetwork(a.network);
        let bc: Uint8Array;
        if (a.templateId) bc = getTemplate(a.templateId).loadedExample.bytecode;
        else if (a.artifact) bc = loadSilArtifact(a.artifact, a.contractName).bytecode;
        else if (a.bytecodeHex) bc = coerceBytecode(a.bytecodeHex);
        else throw new Error("Provide templateId, artifact, or bytecodeHex");
        const prepared = await prepareFund({
          network,
          bytecode: bc,
          fromAddress: a.fromAddress,
          amountSompi: BigInt(a.amountSompi),
        });
        return ok({ safety: SAFETY_BANNER, ...prepared });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "l1_prepare_spend",
    {
      description:
        "Prepare spending a P2SH covenant UTXO via a SilverScript entry. Pass entry args; use null/\"$sig\"/\"$pk\" with testnet privateKey to auto-sign. Mainnet gated. KasWare PSKT first.",
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
        privateKey: z.string().optional().describe("TESTNET ONLY. Hex without 0x ok for Kaspa."),
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
        entryOf(loaded, a.entry);
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
        return ok({ safety: SAFETY_BANNER, ...prepared });
      } catch (e) {
        return err(e);
      }
    },
  );


  // Resources for brainstorming / docs
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
          text: `# Safety model\n\n${SAFETY_BANNER}\n\n- No key persistence\n- Mainnet private keys rejected\n- Testnet privateKey is per-request only\n- Prefer prepare_* + external wallet for anything of value\n`,
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
