import type { NetworkInfo } from "./types.js";

/**
 * Official / publicly documented endpoints only.
 * Sources (verified 2026-10-30 from this box where noted):
 * - Kasplex: https://docs-kasplex.gitbook.io/l2-network/build/network-information
 * - Igra: https://igra-labs.gitbook.io/igralabs-docs/quickstart/network-info
 * - Kaspa L1 API: https://api.kaspa.org
 * - Toccata / Silverscript / vProgs: https://docs.kaspa.org/toccata , https://kasstacker.org/status/
 */
export const NETWORKS: Record<string, NetworkInfo> = {
  "local-anvil": {
    id: "local-anvil",
    displayName: "Local Anvil (Kasplex-shaped demo)",
    kind: "evm",
    isTestnet: true,
    chainId: 167012,
    rpcUrl: process.env.LOCAL_ANVIL_RPC ?? "http://127.0.0.1:8545",
    nativeCurrency: { name: "Demo KAS", symbol: "KAS", decimals: 18 },
    faucetNotes: "Anvil prefunded accounts — $0 local demo only. Not a public network.",
    docsUrl: "https://book.getfoundry.sh/anvil/",
    maturity: "experimental",
    minGasPriceWei: "1000000000",
    notes: "Use for offline e2e when Kasplex faucets are dry. Prefer --fork-url https://rpc.kasplextest.xyz when reachable.",
  },

  "kasplex-testnet": {
    id: "kasplex-testnet",
    displayName: "Kasplex Network Testnet",
    kind: "evm",
    isTestnet: true,
    chainId: 167012,
    rpcUrl: "https://rpc.kasplextest.xyz",
    explorerUrl: "https://explorer.testnet.kasplextest.xyz",
    nativeCurrency: { name: "Bridged Kas", symbol: "KAS", decimals: 18 },
    faucetUrl: "https://faucet-tn10.kaspanet.io/",
    faucetNotes:
      "Official Kasplex L2 faucets (faucet.kasplextest.xyz / app.kaspafinance.io) are often down or empty. Recommended $0 path: (1) claim L1 tKAS at https://faucet-tn10.kaspanet.io/ then (2) bridge to Kasplex testnet via the official Kurve-Test bridge https://kasbridge-tn10evm.kaspafoundation.org/ (destination Kasplex, paste your EVM address). Community mirror https://app.kaspafinance.io/faucets may work when queues are available.",
    docsUrl: "https://docs-kasplex.gitbook.io/l2-network/build/network-information",
    maturity: "active",
    minGasPriceWei: "2000000000000", // 2000 gwei per Kasplex docs
    notes: "zkEVM L2 on Kaspa. eth_chainId verified 0x28c64 (167012) from build box.",
  },
  "kasplex-mainnet": {
    id: "kasplex-mainnet",
    displayName: "Kasplex Network Mainnet",
    kind: "evm",
    isTestnet: false,
    chainId: 202555,
    rpcUrl: "https://evmrpc.kasplex.org",
    explorerUrl: "https://explorer.kasplex.org",
    nativeCurrency: { name: "Bridged Kas", symbol: "KAS", decimals: 18 },
    docsUrl: "https://docs-kasplex.gitbook.io/l2-network/build/network-information",
    maturity: "active",
    minGasPriceWei: "2000000000000",
    notes: "Real value. Writes are unsigned-tx only in this connector. eth_chainId verified 0x3173b (202555).",
  },
  "igra-galleon-testnet": {
    id: "igra-galleon-testnet",
    displayName: "IGRA Galleon Testnet",
    kind: "evm",
    isTestnet: true,
    chainId: 38836,
    rpcUrl: "https://galleon-testnet.igralabs.com:8545",
    explorerUrl: "https://explorer.galleon-testnet.igralabs.com",
    nativeCurrency: { name: "iKAS", symbol: "iKAS", decimals: 18 },
    faucetUrl: "https://faucet.igralabs.com",
    faucetNotes:
      "Official Igra faucet API (EIP-191 challenge + PoW, no captcha): https://faucet.igralabs.com/docs — 0.1 iKAS / 24h. Free.",
    docsUrl: "https://igra-labs.gitbook.io/igralabs-docs/quickstart/network-info",
    maturity: "active",
    minGasPriceWei: "2000000000000", // ~2000 gwei testnet
    notes:
      "EVM L2 on Kaspa. Official RPC documented; some environments block :8545 TLS. Prefer Kasplex for e2e if Igra RPC unreachable.",
  },
  "igra-mainnet": {
    id: "igra-mainnet",
    displayName: "Igra Mainnet",
    kind: "evm",
    isTestnet: false,
    chainId: 38833,
    rpcUrl: "https://rpc.igralabs.com:8545",
    explorerUrl: "https://explorer.igralabs.com",
    nativeCurrency: { name: "iKAS", symbol: "iKAS", decimals: 18 },
    docsUrl: "https://igra-labs.gitbook.io/igralabs-docs/quickstart/network-info",
    maturity: "active",
    minGasPriceWei: "1100000000000", // 1100 gwei recommended
    notes: "Real value. Unsigned-tx only. Bridging KAS→iKAS has minimums (not free).",
  },
  "kaspa-l1-mainnet": {
    id: "kaspa-l1-mainnet",
    displayName: "Kaspa L1 Mainnet (read + future covenants)",
    kind: "l1-read",
    isTestnet: false,
    rpcUrl: "https://api.kaspa.org",
    explorerUrl: "https://explorer.kaspa.org",
    nativeCurrency: { name: "Kaspa", symbol: "KAS", decimals: 8 },
    docsUrl: "https://docs.kaspa.org/toccata",
    maturity: "production",
    notes:
      "Public REST API for reads. Toccata covenants are consensus-live (2026-06-30); Silverscript authoring is pre-audit — covenant deploy backend is stubbed until tooling is production-ready.",
  },
  "kaspa-l1-testnet-10": {
    id: "kaspa-l1-testnet-10",
    displayName: "Kaspa L1 Testnet-10 (read + future covenants)",
    kind: "l1-read",
    isTestnet: true,
    rpcUrl: "https://api-tn10.kaspa.org",
    explorerUrl: "https://explorer-tn10.kaspa.org",
    nativeCurrency: { name: "Kaspa Testnet", symbol: "TKAS", decimals: 8 },
    faucetUrl: "https://faucet-tn10.kaspanet.io",
    faucetNotes: "Official Kaspa testnet faucet for tKAS (L1). Free.",
    docsUrl: "https://docs.kaspa.org/toccata",
    maturity: "production",
    notes: "L1 testnet reads via public API. Covenant backend stubbed.",
  },
  "kaspa-covenants-mainnet": {
    id: "kaspa-covenants-mainnet",
    displayName: "Kaspa L1 Covenants (Silverscript) — stub",
    kind: "covenant",
    isTestnet: false,
    explorerUrl: "https://explorer.kaspa.org",
    nativeCurrency: { name: "Kaspa", symbol: "KAS", decimals: 8 },
    docsUrl: "https://docs.kaspa.org/programmability/covenants",
    maturity: "pre-audit",
    notes:
      "Toccata active since 2026-06-30. Silverscript v1.0.0 tagged (pre-audit). Backend interface ready; full compile/deploy tools land when silverc integration is audited enough for a public connector.",
  },
  "kaspa-vprogs": {
    id: "kaspa-vprogs",
    displayName: "Kaspa vProgs — roadmap stub",
    kind: "vprogs",
    isTestnet: true,
    nativeCurrency: { name: "Kaspa", symbol: "KAS", decimals: 8 },
    docsUrl: "https://docs.kaspa.org/toccata",
    maturity: "roadmap",
    notes:
      "vProgs/CDAG still roadmap (kaspanet/vprogs, no stable external API as of 2026-10). Placeholder network so the registry can grow without breaking clients.",
  },
};

export function getNetwork(id: string): NetworkInfo {
  const n = NETWORKS[id];
  if (!n) {
    throw new Error(
      `Unknown network "${id}". Use list_networks. Known: ${Object.keys(NETWORKS).join(", ")}`,
    );
  }
  return n;
}

export function listNetworks(filter?: { kind?: string; testnetOnly?: boolean }): NetworkInfo[] {
  return Object.values(NETWORKS).filter((n) => {
    if (filter?.kind && n.kind !== filter.kind) return false;
    if (filter?.testnetOnly && !n.isTestnet) return false;
    return true;
  });
}

export const DEFAULT_EVM_TESTNET = "kasplex-testnet";
