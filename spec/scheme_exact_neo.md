# Scheme: `exact` on `Neo N3`

## Versions supported

- ❌ `v1`
- ✅ `v2`

## Supported Networks

[CAIP-2](https://namespaces.chainagnostic.org/neo/caip2) identifiers (`neo:` + decimal network magic):

- `neo:860833102`: Neo N3 MainNet
- `neo:894710606`: Neo N3 TestNet (T5)

## Summary

The client signs a complete Neo N3 transaction whose only effect is one NEP-17 `transfer` from the payer to `payTo`.
The facilitator checks it, optionally co-signs it as the **fee payer**, broadcasts it and waits for the block.

Neo N3 transactions natively support several signers, each with its own witness scope. The first signer is the
`sender` and pays the system and network fees. That gives fee sponsorship without any wrapper contract:

| Signer | Account | Scope | Role |
|---|---|---|---|
| 0 (sponsored only) | facilitator (`extra.feePayer`) | `None` | pays fees; its witness authorizes nothing else |
| last | payer | `CalledByEntry` | authorizes the transfer called directly by the entry script, and nothing deeper |

A `None`-scoped witness satisfies no `CheckWitness` call, so the facilitator's signature cannot move its own assets
or authorize any contract call. Its only exposure is the fees, and those are capped (see Facilitator Safety).

Without `extra.feePayer` the payer is the only signer and pays its own fees; the facilitator just relays.

## Protocol Flow

1. **Client** requests a resource.
2. **Resource server** answers `402` with a `PAYMENT-REQUIRED` header listing `exact` requirements on a `neo:*` network.
3. **Client** checks `asset` (rule 8 below), builds the transfer script (canonical form below), simulates it with
   `invokescript` and checks the simulated `Transfer` event (rule 9), sets
   `systemFee` = simulated `gasconsumed`, `validUntilBlock` = `height + ceil(maxTimeoutSeconds / blockTime)`, fills
   `networkFee` from `calculatenetworkfee`, signs `network_magic (uint32 LE) || tx_hash` and leaves the fee payer's
   invocation script empty.
4. **Client** retries with `PAYMENT-SIGNATURE` carrying the base64 `PaymentPayload`.
5. **Resource server** forwards it to the facilitator's `/settle` (or `/verify`, then `/settle`).
6. **Facilitator** runs every check below, adds its own witness in slot 0 if sponsoring, calls `sendrawtransaction`,
   then polls `getapplicationlog` until the transaction is in a block (Neo N3 has single-block finality).
7. **Resource server** serves the resource with a `PAYMENT-RESPONSE` header.

## `PaymentRequirements`

```json
{
  "scheme": "exact",
  "network": "neo:894710606",
  "amount": "100000",
  "asset": "0xd2a4cff31913016155e38e474a2c06d08be276cf",
  "payTo": "NZxYiL6H8mC3HPcRBV3UhdfGQDJsz21Z9g",
  "maxTimeoutSeconds": 60,
  "extra": {
    "feePayer": "NTWHmAuUcCBBXQTXfFtAmG5K2ER6ebpQz2",
    "feePayerKey": "03…33-byte compressed public key…",
    "decimals": 8
  }
}
```

- `asset`: script hash of any NEP-17 contract, `0x` + 40 hex (big-endian, as shown by explorers). The native tokens
  have the same hash on every network: GAS is `0xd2a4cff31913016155e38e474a2c06d08be276cf` (8 decimals), NEO is
  `0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5` (0 decimals). Deployed tokens differ per network; on MainNet, for
  example, fUSDT is `0xcd48b160c1bbc9d74997b803b9a7ad50a4bef020` (6 decimals) and bNEO is
  `0x48c40d4666f93408be1bef038b6722404d9a4c2a` (8 decimals).
- `amount`: atomic units of `asset`, i.e. the human amount × 10^`decimals()` of that contract (`100000` = 0.001 GAS,
  `250000` = 0.25 fUSDT). Conversions MUST use integer arithmetic.
- `payTo`: a Neo N3 address.
- `extra.decimals` (optional): the asset's decimals, for display. When present, client and facilitator MUST check it
  equals the contract's `decimals()` and refuse the payment otherwise. The binding value is always `amount`.
- `extra.feePayer` / `extra.feePayerKey`: present when the facilitator sponsors fees. The key lets the client size the
  network fee for the fee payer's verification script; the client MUST check that it hashes to `feePayer`.

## `PaymentPayload.payload`

```json
{ "transaction": "<base64 of the serialized transaction, witnesses included>" }
```

### Canonical transfer script

The script MUST be byte-for-byte what `ScriptBuilder.EmitDynamicCall(asset, "transfer", CallFlags.All, from, to, amount, null)`
produces (this layout is what C# `ScriptBuilder` emits; the reference implementation builds it with `neon-js`
`sc.createScript`, and other SDKs should be checked against a test vector before use):

```
PUSHNULL                      ; data
PUSHINT* amount               ; minimal integer encoding
PUSHDATA1 20 <to   LE>
PUSHDATA1 20 <from LE>
PUSH4 PACK
PUSH15                        ; CallFlags.All
PUSHDATA1 8 "transfer"
PUSHDATA1 20 <asset LE>
SYSCALL System.Contract.Call
```

The facilitator rebuilds this script from the requirements and the payer's script hash and compares bytes. Nothing else
may be in the script. Because `asset`, `to` and `amount` are all in these bytes, the comparison binds the signed
transaction to the stated asset, `payTo` and amount; a payload signed for one token can't be presented as payment in
another.

## Facilitator Verification Rules (MUST)

1. **Protocol**: `x402Version` is 2. `accepted` matches the requirements on `scheme`, `network`, `amount`, `asset`, `payTo`.
2. **Encoding**: the transaction deserializes and re-serializes to the same bytes, `version` is 0, there are **no
   attributes**, at most 4096 bytes base64.
3. **Signers**: exactly 2 (sponsored) or 1 (direct). Sponsored: signer 0 is `extra.feePayer` with scope `None`, its
   witness has an empty invocation script and an empty or matching verification script. The last signer is the payer
   with scope exactly `CalledByEntry` (no rules, contracts or groups). The payer is not the facilitator.
4. **Script**: equals the canonical transfer script for (`asset`, payer, `payTo`, `amount`).
5. **Payer witness**: the verification script hashes to the payer and is one of:
   - a standard single-signature script (`PUSHDATA1 <33-byte key> SYSCALL System.Crypto.CheckSig`), with an
     invocation script holding one 64-byte signature that verifies against `network_magic || tx_hash` for the
     requirement's network; or
   - a standard m-of-n multi-signature script (`PUSH m`, n × `PUSHDATA1 <33-byte key>`, `PUSH n`,
     `SYSCALL System.Crypto.CheckMultisig`, canonical encoding, 1 ≤ m ≤ n), with an invocation script holding exactly
     m 64-byte signatures, each verifying against a distinct key in key order (the rule `CheckMultisig` applies on
     chain). A facilitator MAY cap n (reference implementation: 16).

   Contract-based payers (deployed contracts with a `verify` method) are out of scope for this version.
6. **Validity window**: `height < validUntilBlock <= height + ceil(maxTimeoutSeconds / blockTime) + slack` (slack ≤ 2 blocks).
7. **Not seen**: `getrawtransaction(hash)` finds nothing (no replay of a settled payment).
8. **Asset**: `getcontractstate(asset)` finds a contract whose manifest lists `NEP-17` in `supportedstandards`, and
   if `extra.decimals` is present, `decimals()` returns that value. A facilitator MAY additionally restrict `asset` to
   an allowlist (`invalid_exact_neo_asset_not_supported`).
9. **Simulation**: `invokescript` with the transaction's script and signers ends in `HALT` with `true` on the stack,
   its notifications include `Transfer(from = payer, to = payTo, amount)` emitted by `asset`, and
   `gasconsumed <= systemFee`. The event check matters for tokens other than GAS: a non-conforming or fee-on-transfer
   contract can return `true` while moving less than `amount`.
10. **Fees**: `networkFee >= calculatenetworkfee` (computed with the fee payer's real verification script in place).
   The fee holder (fee payer when sponsored, else the payer) holds at least `systemFee + networkFee` GAS, plus
   `amount` when it is also the payer and the asset is GAS.

### Facilitator Safety

- The fee payer's witness scope is `None`, enforced by rule 3, so the facilitator signs nothing but fees.
- The facilitator MUST cap what it sponsors. The reference implementation's defaults are `systemFee <= 0.02 GAS` and
  `networkFee <= 0.01 GAS` (on MainNet a GAS transfer costs about 0.0022 + 0.0007 GAS; an fUSDT transfer simulated
  at 0.0044 GAS system fee). Token contracts can cost more and can be upgraded, so a sponsoring facilitator should
  allowlist the assets it sponsors.
- A multi-signature payer costs more to verify. Network fees measured on MainNet with `calculatenetworkfee`
  (block 14,987,7xx), sponsored: single-sig 0.00073108, 2-of-3 0.0014143, 3-of-5 0.0020971, 5-of-7 0.00279358 GAS,
  all under the 0.01 GAS default cap.
- `/settle` re-runs every check right before broadcasting and MUST NOT rely on an earlier `/verify`.
- The facilitator rejects concurrent settlement of the same transaction hash.
- Known residual risk: a payer who drains its balance between `/settle`'s simulation and block inclusion makes the
  transaction FAULT, and the sponsor still pays that transaction's fees (≈ 0.003 GAS). Facilitators may rate-limit per
  payer.

## Settlement

1. Re-verify (all rules above).
2. Sponsored: sign `network_magic || tx_hash` with the fee payer key and set witness 0
   (`PUSHDATA1 64 <sig>` / fee payer verification script).
3. `sendrawtransaction`.
4. Poll `getapplicationlog(hash)`. Success needs `vmstate == HALT` and a `Transfer(from = payer, to = payTo, amount)`
   notification from `asset`. On timeout return `errorReason: "settlement_pending"` with the hash.

`SettlementResponse`:

```json
{
  "success": true,
  "transaction": "0x<64 hex tx hash>",
  "network": "neo:894710606",
  "payer": "NcF7UhR6f8BqR9gh9KXeUQ5ShZgBjQGi9Q",
  "amount": "100000"
}
```

## Error codes

`invalid_x402_version`, `invalid_scheme`, `invalid_network`, `insufficient_funds`, and scheme-specific
`invalid_exact_neo_*`: `payload_transaction`, `payload_attributes`, `payload_signers`, `payload_signer_scope`,
`payload_fee_payer_scope`, `payload_fee_payer_witness`, `payload_payer_is_facilitator`, `payload_script`,
`payload_witness`, `payload_signature`, `payload_expired`, `payload_valid_until_too_far`, `payload_already_used`,
`payload_system_fee_too_low`, `payload_network_fee_too_low`, `payload_fee_exceeds_maximum`, `fee_payer_unknown`,
`fee_payer_insufficient_gas`, `payload_accepted_mismatch`, `asset_not_nep17`, `asset_decimals_mismatch`,
`asset_not_supported`, `transfer_not_simulated`, `transaction_rejected`, `transaction_failed`, `transfer_not_found`,
`rpc_unavailable`.

`invalid_exact_neo_payload_script` responses MAY carry a `detail` string naming the differing field, e.g.
`asset 0x48c4…4c2a != 0xcd48…f020`.
