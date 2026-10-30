# Research notes (2026-10-30)

## Existing MCP / AI connectors for Kaspa

| Repo | Stars (approx) | Capabilities | Write+deploy smart contracts on Kaspa EVM? | Custodial? |
|------|----------------|--------------|--------------------------------------------|------------|
| pichukov/kaspa-mcp-server | ~10 | L1 connect, HD wallet, send, fees | No | In-memory / env wallet |
| kasanova-io/kaspa-mcp | ~3 | send_kaspa, get_transaction | No | Env mnemonic/key required |
| moldis/mcp-kaspa | ~1 | L1 RPC: blocks, UTXOs, balance | No | N/A (reads) |
| Kali123411/k402-mcp | 0 | Pay-per-call APIs; Silverscript CaaS; GPU; chain data | Covenant helpers via paid gateway, not free Kasplex Solidity deploy | Session deposit in KAS |
| PraneshASP/foundry-mcp-server | ~250 | Generic Forge deploy to any RPC | Indirectly if user sets Kasplex RPC + Foundry installed | Often env PRIVATE_KEY |

**Conclusion:** No dedicated free open-source MCP was found that is Kaspa-ecosystem-aware and implements Solidity compile→deploy→call on Kasplex/Igra with a non-custodial mainnet model and pluggable L1 covenant/vProgs backends. That is the gap this project fills.

## Native L1 timeline

- **2026-06-30:** Toccata mainnet activation — covenants, ZK verify opcodes, seqcommit (KIP-16/17/20/21).
- **2026-09-09:** Silverscript v1.0.0 — higher-level covenant language; **pre-audit**.
- **Ongoing:** Argent experimental; vProgs roadmap (kasstacker maturity = roadmap).
- **2027 (lore):** possible 100 BPS hardfork — unrelated to vProgs API stability.

Implication for architecture: ship EVM backend now; keep `CovenantBackend` / `VProgsBackend` stubs so community can extend without breaking the MCP tool surface.
