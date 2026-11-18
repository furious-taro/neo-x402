# Changelog

## 0.4.0 (2026-11-18)

Multi-sig payers: a team or DAO wallet can pay per request.

- `multisigAccount(m, members)`: m-of-n account from keys and/or public keys, with keys sorted the way Neo sorts them.
  Checked against MainNet: the 7 validator keys at block 14,987,694 give the header's `nextconsensus` address
  (the unsorted order would not).
- `createPaymentPayload` signs with every member key it holds; `{ partial: true }` allows fewer than m, and
  `cosignPaymentPayload(payload, account, signers)` adds the rest after checking the transaction is exactly the
  accepted payment. Signers may be async (`{ publicKey, sign }`).
- Facilitator: accepts a canonical m-of-n payer witness with exactly m signatures that verify in key order (the
  `CheckMultisig` rule); `limits.maxPayerKeys` (default 16) caps n. Spec rule 5 updated.
- `scripts/probe-multisig.js` (`npm run probe:multisig`): real network fees from a MainNet node; up to 5-of-7 stays
  under the default 0.01 GAS sponsor cap.
- Tests: 46 -> 56 (`test/multisig.test.js`). The fake node now sizes and checks multi-sig witnesses.

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
