/**
 * MCP tool annotations (title + read/write hints) for directory clients.
 * Clients use these for confirmation UX; they are not a security boundary.
 */

export type KaspaToolAnnotations = {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint?: boolean;
};

export const TOOL_ANNOTATIONS: Record<string, KaspaToolAnnotations> = {
  list_networks: { title: "List networks", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  kaspa_network_info: { title: "Network details", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  kaspa_ideas: { title: "Brainstorm Kaspa build ideas", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  compile_solidity: { title: "Compile Solidity", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  deploy_contract: { title: "Deploy EVM contract", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  prepare_deploy: { title: "Prepare unsigned EVM deploy", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  read_contract: { title: "Read EVM contract", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  prepare_call: { title: "Prepare unsigned EVM call", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  send_raw_transaction: { title: "Broadcast signed raw transaction", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  get_balance: { title: "Get balance", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  get_tx: { title: "Get transaction", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  faucet_info: { title: "Faucet info", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  l1_blockdag_info: { title: "Kaspa L1 blockDAG info", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  verify_rpc: { title: "Verify RPC health", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  silverscript_templates: { title: "List SilverScript templates", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  silverscript_load_artifact: { title: "Load SilverScript artifact", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  silverscript_compile: { title: "Compile SilverScript", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  l1_derive_p2sh: { title: "Derive L1 P2SH address", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  l1_prepare_fund: { title: "Prepare L1 fund (unsigned)", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  l1_prepare_spend: { title: "Prepare L1 spend (unsigned)", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  spending_wallet_create: { title: "Create spending wallet", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  spending_wallet_status: { title: "Spending wallet status", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  spending_wallet_withdraw_all: { title: "Withdraw spending wallet", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  spending_wallet_export_key: { title: "Export spending wallet key", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  spending_wallet_set_limits: { title: "Set spending wallet limits", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  l1_tipjar_chat_deploy: { title: "Deploy TipJar", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  choose_network: { title: "Choose testnet or mainnet", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  network_preference: { title: "Show network preference", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  self_host: { title: "Self-host wizard", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  l1_confirm_tx: { title: "Confirm L1 transaction", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  estimate_fee: { title: "Estimate fee", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  configure_node: { title: "Configure node endpoints", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  create_contract_page: { title: "Create share page", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  l1_vault_chat_deploy: { title: "Deploy TimeoutVault", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  l1_escrow_chat_deploy: { title: "Deploy Escrow", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  connector_version: { title: "Connector version", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  l1_aon_create_campaign: { title: "Create all-or-nothing crowdfund", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  l1_aon_add_pledge: { title: "Add crowdfund pledge", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  l1_check_session: { title: "Check sign session", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  campaign_status: { title: "Crowdfund campaign status", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  l1_lockbox_chat_deploy: { title: "Deploy Lockbox", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  l1_softcap_chat_deploy: { title: "Deploy TipGoalJar", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
};

/** Expected tool names — keep in sync with server.registerTool calls. */
export const EXPECTED_TOOL_NAMES = Object.keys(TOOL_ANNOTATIONS) as string[];

