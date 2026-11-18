# Changelog

## 0.3.0 (2026-11-18)

AI agents can pay through MCP.

- `bin/neo-x402-mcp.js`: a Model Context Protocol server over stdio (no new dependencies) with the tools
  `neo_x402_quote`, `neo_x402_fetch` and `neo_x402_status`.
- Two spending limits checked before signing: a per-request cap per token (`NEO_X402_MAX`) and a lifetime budget per
  token (`NEO_X402_BUDGET`). Refusals return the 402 terms with the reason.
- `createMcpServer` and `parseLimits` exported for embedding in other transports.
- Tests: 39 -> 46 (`test/mcp.test.js`), including a round trip through the real stdio binary.

## 0.2.0 (2026-11-17)

Any NEP-17 token, not just GAS.

- `TOKENS`: GAS, NEO, bNEO, fUSDT and FLM with hashes and decimals read from MainNet (`getcontractstate`, `symbol`,
  `decimals`).
- `toAtomic` / `fromAtomic`: decimal string ↔ atomic units with integers only; extra decimal places are an error.
- Optional `extra.decimals` in requirements, checked against the contract's `decimals()` by client and facilitator.
- Client and facilitator require `asset` to be a deployed contract declaring `NEP-17`.
- Client and facilitator require the simulated transfer to emit `Transfer(payer, payTo, amount)` from `asset`, so a
  token that returns `true` but moves less (fee-on-transfer) is refused.
- `invalid_exact_neo_payload_script` now carries a `detail` naming the differing field (asset, from, to, amount).
- `localFacilitator({ assets })`: optional allowlist of accepted token hashes.
- `scripts/probe-token.js` (`npm run probe:token`): read-only MainNet check of a token transfer. fUSDT: HALT, expected
  event, 0.00437101 GAS system fee.
- Tests: 26 → 39 (`test/token.test.js`). The fake node now derives Transfer events from the transaction script.

## 0.1.0

x402 v2 `exact` scheme on Neo N3 with fee sponsorship.
