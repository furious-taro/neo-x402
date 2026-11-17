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
3. **Client** builds the transfer script (canonical form below), simulates it with `invokescript`, sets
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
    "feePayerKey": "03…33-byte compressed public key…"
  }
}
```

- `asset`: NEP-17 contract script hash, `0x` + 40 hex (big-endian, as shown by explorers). GAS is
  `0xd2a4cff31913016155e38e474a2c06d08be276cf`, NEO is `0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5`.
- `amount`: atomic units (GAS has 8 decimals, so `100000` = 0.001 GAS).
- `payTo`: a Neo N3 address.
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
may be in the script.

## Facilitator Verification Rules (MUST)

1. **Protocol**: `x402Version` is 2. `accepted` matches the requirements on `scheme`, `network`, `amount`, `asset`, `payTo`.
2. **Encoding**: the transaction deserializes and re-serializes to the same bytes, `version` is 0, there are **no
   attributes**, at most 4096 bytes base64.
3. **Signers**: exactly 2 (sponsored) or 1 (direct). Sponsored: signer 0 is `extra.feePayer` with scope `None`, its
   witness has an empty invocation script and an empty or matching verification script. The last signer is the payer
   with scope exactly `CalledByEntry` (no rules, contracts or groups). The payer is not the facilitator.
4. **Script**: equals the canonical transfer script for (`asset`, payer, `payTo`, `amount`).
5. **Payer witness**: a standard single-signature verification script (`PUSHDATA1 <33-byte key> SYSCALL CheckSig`) that
   hashes to the payer, and an invocation script holding one 64-byte signature that verifies against
   `network_magic || tx_hash` for the requirement's network. Contract-based and multi-signature payers are out of scope
   for this version.
6. **Validity window**: `height < validUntilBlock <= height + ceil(maxTimeoutSeconds / blockTime) + slack` (slack ≤ 2 blocks).
7. **Not seen**: `getrawtransaction(hash)` finds nothing (no replay of a settled payment).
8. **Simulation**: `invokescript` with the transaction's script and signers ends in `HALT` with `true` on the stack,
   and `gasconsumed <= systemFee`.
9. **Fees**: `networkFee >= calculatenetworkfee` (computed with the fee payer's real verification script in place).
   The fee holder (fee payer when sponsored, else the payer) holds at least `systemFee + networkFee` GAS, plus
   `amount` when it is also the payer and the asset is GAS.

### Facilitator Safety

- The fee payer's witness scope is `None`, enforced by rule 3, so the facilitator signs nothing but fees.
- The facilitator MUST cap what it sponsors. The reference implementation's defaults are `systemFee <= 0.02 GAS` and
  `networkFee <= 0.01 GAS` (a GAS transfer costs about 0.0022 + 0.0007 GAS on MainNet).
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
`fee_payer_insufficient_gas`, `payload_accepted_mismatch`, `transaction_rejected`, `transaction_failed`,
`transfer_not_found`, `rpc_unavailable`.
