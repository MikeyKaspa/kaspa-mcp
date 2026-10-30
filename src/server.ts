import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getNetwork, listNetworks, DEFAULT_EVM_TESTNET, NETWORKS } from "./networks.js";
import { backendFor } from "./backends/registry.js";
import { compileSolidityAsync } from "./backends/compile.js";
import { SAFETY_BANNER, SafetyError, redactSecrets } from "./safety.js";
import type { CompileResult, TextJson } from "./types.js";

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

export function createKaspaMcpServer(): McpServer {
  const server = new McpServer({
    name: "kaspa-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "list_networks",
    {
      description:
        "List Kaspa-ecosystem networks this connector knows about (Kasplex/Igra EVM, Kaspa L1 reads, covenant/vProgs stubs). Filter optional.",
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
        prefer === "covenant"
          ? "- Native L1 covenants (Silverscript) are consensus-live but tooling is pre-audit — good for learning, careful with real funds."
          : "- **Best for agents today:** Solidity on Kasplex or Igra testnets (EVM). Compile → faucet → deploy → call with this connector.",
        "",
        "### EVM L2 ideas (Kasplex / Igra)",
        `- Simple ${theme} contract on ${DEFAULT_EVM_TESTNET}`,
        "- ERC-20 / ERC-721 themed around Kaspa culture (testnet first)",
        "- Read-only dashboards using get_balance + read_contract",
        `- Networks ready: ${evm.map((n) => n.id).join(", ")}`,
        "",
        "### Native L1 covenant ideas (when you opt into Silverscript)",
        "- Vaults, time-locks, escrow-like UTXO flows (Toccata)",
        "- KCC-20 style assets (standard Final; implementations vary)",
        "- NOT yet: general shared-state DeFi like Uniswap (UTXO covenants are sequential per state coin)",
        "",
        "### Roadmap (do not promise users these work in this connector yet)",
        "- vProgs based ZK apps — roadmap stub only",
        "",
        "Suggested next tools: list_networks → compile_solidity → faucet_info → deploy_contract (testnet).",
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
        const compiled = await compileSolidityAsync(source, { contractName });
        const key = cacheKey ?? compiled.contractName;
        compiledCache.set(key, compiled);
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
        "Deploy compiled Solidity to an EVM Kaspa network. TESTNET: optional ephemeral privateKey (never stored). MAINNET: rejected — use prepare_deploy + wallet sign + send_raw_transaction.",
      inputSchema: {
        network: z.string().default(DEFAULT_EVM_TESTNET),
        source: z.string().optional().describe("Solidity source (compiled if cacheKey not set)"),
        cacheKey: z.string().optional(),
        contractName: z.string().optional(),
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
        const backend = backendFor(network);
        if (!backend.deploy || !backend.compile) {
          throw new SafetyError(`Network ${network.id} does not support EVM deploy`);
        }
        let compiled: CompileResult | undefined = args.cacheKey
          ? compiledCache.get(args.cacheKey)
          : undefined;
        if (!compiled && args.source) {
          compiled = await backend.compile(network, args.source, {
            contractName: args.contractName,
          });
        }
        if (!compiled) throw new Error("Provide source or a valid cacheKey from compile_solidity");
        const result = await backend.deploy(network, compiled, {
          ctorArgs: args.constructorArgs,
          privateKey: args.privateKey,
          signedRawTx: args.signedRawTx,
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
      description: "Build an unsigned deploy transaction (safe on mainnet). User signs externally.",
      inputSchema: {
        network: z.string(),
        source: z.string().optional(),
        cacheKey: z.string().optional(),
        contractName: z.string().optional(),
        constructorArgs: z.array(z.unknown()).optional(),
        fromAddress: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const network = getNetwork(args.network);
        const backend = backendFor(network);
        if (!backend.prepareDeploy || !backend.compile) {
          throw new SafetyError(`Network ${network.id} cannot prepare EVM deploys`);
        }
        let compiled = args.cacheKey ? compiledCache.get(args.cacheKey) : undefined;
        if (!compiled && args.source) {
          compiled = await backend.compile(network, args.source, {
            contractName: args.contractName,
          });
        }
        if (!compiled) throw new Error("Provide source or cacheKey");
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
        const network = getNetwork(nid);
        const backend = backendFor(network);
        if (!backend.sendRawTransaction) throw new SafetyError("send_raw_transaction not supported");
        return ok(await backend.sendRawTransaction(network, rawTx));
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
| EVM (Kasplex, Igra) | Implemented |
| L1 read (api.kaspa.org) | Implemented |
| Covenants (Silverscript) | Stub — Toccata live, tooling pre-audit |
| vProgs | Roadmap stub |

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
