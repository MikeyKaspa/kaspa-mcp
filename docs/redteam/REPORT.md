# kaspa-redteam results (Phase 2 templates)

Source: https://redteam.kasperolabs.com `/api/scan` (library **0.9.0**, judge rusty-kaspa **2.1.0**).  
Date: 2026-10-30 America/Phoenix. Local `cargo install kaspa-redteam` blocked (needs libclang; apt mirror down).

| Template | Findings | Attacks survived | Skipped | Notes |
|----------|----------|------------------|---------|-------|
| tipjar | **0** | 2 | 27 | honest withdraw path explored |
| timeout_vault | **0** | 2 | 27 | transfer path explored |
| escrow | **0** | 2 | 27 | spend path explored |

Raw JSON: `tipjar.json`, `timeout_vault.json`, `escrow.json`, `SUMMARY.json`.

This is a **pass on this review library**, not a full audit. Mainnet write helpers stay gated (`KASPA_L1_MAINNET_WRITES`) until Michael explicitly enables after review.
