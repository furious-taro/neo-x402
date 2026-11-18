# neo-x402

Pay-per-request HTTP APIs on **Neo N3**. This is an implementation of the [x402](https://github.com/coinbase/x402) v2
protocol (`HTTP 402 Payment Required`) for GAS and any NEP-17 token, with optional **fee sponsorship** by the facilitator.

A server puts a price on a route. A client (a script, a wallet or an AI agent) gets `402` with the price, signs a Neo
transfer, retries, and gets the response once the transfer is in a block. There are no accounts, API keys or invoices,
and nothing is custodial: the payment goes straight from the payer to `payTo`.

```
client ──GET /data──────────────────────────────▶ resource server
       ◀─402 PAYMENT-REQUIRED (0.001 GAS → N…)──
       signs GAS.transfer(payer, payTo, 0.001)
       ──GET /data + PAYMENT-SIGNATURE─────────▶ ──/settle──▶ facilitator ──sendrawtransaction──▶ Neo N3
       ◀─200 + PAYMENT-RESPONSE (tx hash)──────── ◀─────────── (waits for the block, ~3 s)
```

## Why it fits Neo N3

- **Fee sponsorship needs no contract.** A Neo transaction can have several signers, each with its own witness scope.
  The facilitator is signer 0 (the `sender`, who pays the fees) with scope **`None`**. That signature authorizes no
  `CheckWitness` anywhere, so it can't move the facilitator's own assets. The payer is the second signer with
  `CalledByEntry`, which authorizes exactly the one `transfer` the entry script calls. Payers don't need to hold GAS
  for fees.
- **Finality takes one block.** dBFT finalizes each block, so the server can settle before it serves, with no
  confirmation-depth guesswork.
- **The checks are strict.** The facilitator rebuilds the expected transfer script from the price and compares bytes.
  It also checks signer scopes, rejects every transaction attribute, verifies the payer's signature for the right
  network magic, bounds `validUntilBlock`, simulates the transfer, checks fees against `calculatenetworkfee` and caps
  what it sponsors.

The scheme specification is in [`spec/scheme_exact_neo.md`](spec/scheme_exact_neo.md), written in the format of the
other chains' `exact` specs in the x402 repository. Networks use the
[CAIP-2 `neo` namespace](https://namespaces.chainagnostic.org/neo/caip2): `neo:860833102` (MainNet) and `neo:894710606` (TestNet).

## Install

```bash
git clone https://github.com/furious-taro/neo-x402 && cd neo-x402 && npm install && npm test
```

Node 18 or newer. The only dependency is `@cityofzion/neon-js`, used for transaction encoding. Signing and
signature checks use `node:crypto` (ECDSA P-256 / SHA-256).

## Charge for a route (resource server)

Works with plain `node:http`, Express or Connect (`(req, res, next)` middleware):

```js
const express = require('express');
const { paywall, localFacilitator, ASSETS } = require('neo-x402');

const app = express();
app.get('/weather', paywall({
  accepts: [{
    scheme: 'exact',
    network: 'neo:860833102',            // MainNet
    asset: ASSETS.GAS,                   // or any NEP-17 contract hash
    amount: '100000',                    // 0.001 GAS (8 decimals)
    payTo: 'N...your address...',
    maxTimeoutSeconds: 60,
  }],
  facilitator: localFacilitator(),       // relays client-paid transactions; see below to sponsor fees
  resource: { description: 'Current weather' },
}), (req, res) => res.json({ temp: 21, paidBy: req.x402.payer, tx: req.x402.transaction }));
app.listen(3000);
```

### Charge in a token other than GAS

`asset` can be any NEP-17 contract. `amount` is always in the token's atomic units, so use the token's own decimals
(`toAtomic` does the conversion with integers only and refuses extra decimal places). Fees are still GAS, paid by the
payer or by a sponsoring facilitator.

```js
const { TOKENS, toAtomic } = require('neo-x402');

accepts: [{
  scheme: 'exact',
  network: 'neo:860833102',
  asset: TOKENS.fUSDT.hash,              // 0xcd48b160c1bbc9d74997b803b9a7ad50a4bef020
  amount: String(toAtomic('0.25', TOKENS.fUSDT.decimals)), // '250000' (fUSDT has 6 decimals)
  payTo: 'N...your address...',
  maxTimeoutSeconds: 60,
  extra: { decimals: 6 },                // optional; client and facilitator check it against decimals()
}]
```

`TOKENS` lists GAS, NEO, bNEO, fUSDT and FLM with hashes and decimals read from MainNet. The others are MainNet
deployments; any other NEP-17 hash works the same way. For a token, the client and the facilitator both:
- require the contract to declare `NEP-17` in its manifest, and `extra.decimals` (if given) to equal `decimals()`;
- compare the signed script byte for byte with `asset.transfer(payer, payTo, amount, null)`. On a mismatch the result's
  `detail` names the field that differs (asset, from, to or amount);
- require the simulated run to emit `Transfer(payer, payTo, amount)` from the asset contract. `true` from `transfer`
  is not enough, so a token that skims a fee on transfer is refused.

A facilitator can also restrict what it accepts with `localFacilitator({ assets: [ASSETS.GAS, TOKENS.fUSDT.hash] })`.

To **sponsor fees**, give the facilitator a GAS-funded key and advertise it in `extra`:

```js
const fac = localFacilitator({ feePayerWif: process.env.FEE_PAYER_WIF });
// in each requirement:
extra: { feePayer: fac.feePayerKey.address, feePayerKey: fac.feePayerKey.publicKey }
```

## Pay automatically (client / agent)

```js
const { payingFetch, keyFromWif, decodePaymentResponse, ASSETS } = require('neo-x402');

const pay = payingFetch(keyFromWif(process.env.PAYER_WIF), {
  maxAmount: { [ASSETS.GAS]: 1_000_000n },   // hard cap per request: 0.01 GAS
});
const res = await pay('https://api.example.com/weather');
console.log(await res.json(), decodePaymentResponse(res));
```

`maxAmount` is required. The client only pays `exact` requirements on `neo:*` networks whose asset has a cap, and only
up to that cap.

### Pay from a multi-sig account (team or DAO wallet)

A standard m-of-n Neo account can pay too. `multisigAccount` derives the same address Neo wallets show for those keys
and that threshold (keys are sorted the way Neo sorts them; checked against MainNet's validator address).

```js
const { multisigAccount, keyFromWif, payingFetch, createPaymentPayload, cosignPaymentPayload, ASSETS } = require('neo-x402');

// all signing keys in one place (for example an agent holding 2 of a 2-of-3):
const team = multisigAccount(2, [keyFromWif(WIF_A), keyFromWif(WIF_B), PUBKEY_C]);
const pay = payingFetch(team, { maxAmount: { [ASSETS.GAS]: 1_000_000n } });

// or keys held by different people: sign what you hold, pass the payload on, the others co-sign
const alice = multisigAccount(2, [keyFromWif(WIF_A), PUBKEY_B, PUBKEY_C]);
const half = await createPaymentPayload(requirements, alice, { partial: true });
const bob = multisigAccount(2, [PUBKEY_A, keyFromWif(WIF_B), PUBKEY_C]);
const full = await cosignPaymentPayload(half, bob, bob.signers); // send `full` in PAYMENT-SIGNATURE
```

`cosignPaymentPayload` refuses to sign unless the transaction is exactly the payment in `accepted` (asset, payer,
payTo, amount) paid from that multi-sig. A signer can also be any `{ publicKey, sign(messageHex) }` object, sync or
async, so a hardware or remote signer fits in.

## Let an AI agent pay (MCP server)

`bin/neo-x402-mcp.js` is a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio, with no extra
dependencies. Any MCP client (Claude Code, Claude Desktop, Cursor and others) gets three tools:

| Tool | What it does |
|---|---|
| `neo_x402_quote` | Requests a URL without paying and lists the 402 payment options, with the price in token units and whether the server would pay it. |
| `neo_x402_fetch` | Requests a URL and pays a Neo N3 `exact` option if it is within the limits, then returns status, body and the settlement receipt (tx hash). |
| `neo_x402_status` | Shows the payer address, the limits and every payment made so far. |

Spending is bounded twice, and both limits are enforced before anything is signed: a **per-request cap** per token
(`NEO_X402_MAX`) and a **total budget** per token for the server's lifetime (`NEO_X402_BUDGET`, default one request's
cap). A price above either limit is not signed; the tool returns the 402 terms and the reason instead. A payment counts
as spent as soon as it is signed. Tokens without a cap are never paid.

```bash
claude mcp add neo-x402 \
  -e NEO_X402_KEY_FILE=/path/to/payer.json \
  -e NEO_X402_MAX="GAS=0.01,fUSDT=0.05" \
  -e NEO_X402_BUDGET="GAS=0.5,fUSDT=1" \
  -- node /path/to/neo-x402/bin/neo-x402-mcp.js
```

The key file is JSON with a `wif` field (or pass `NEO_X402_WIF`). Limits take token symbols from `TOKENS` in decimal
units, or a script hash with atomic units (`0x...=1000`). `NEO_X402_RPC_MAINNET` / `NEO_X402_RPC_TESTNET` override
the RPC nodes. Use a dedicated payer key holding only what you are willing to spend.

## Run a facilitator as a service

```js
const { createFacilitatorServer, localFacilitator } = require('neo-x402');
createFacilitatorServer(localFacilitator({ feePayerWif: process.env.FEE_PAYER_WIF })).listen(8402);
// GET /supported, POST /verify, POST /settle  (x402 v2 facilitator API)
```

Resource servers then use `remoteFacilitator('http://host:8402')`.

## Tests

`npm test` runs 56 tests against a fake Neo node, plus real HTTP sockets for the transport tests.
- **Multi-sig payers** (`test/multisig.test.js`): the address derived from MainNet's 7 validator keys equals the
  block header's `nextconsensus`; 2-of-3 payments direct and sponsored; partial signing plus co-signing; a co-signer
  refusing a changed recipient, amount or payer; signatures out of key order, the same member twice, one short, one
  extra and from a non-member; the `maxPayerKeys` cap; non-canonical scripts.
- **Happy paths:** sponsored and direct payments, and a full client → paywall → facilitator round trip.
- **Tokens** (`test/token.test.js`, fake node with fUSDT and bNEO metadata from MainNet): a sponsored fUSDT payment;
  the asset hash swapped in the signed script (fUSDT → bNEO) and a fUSDT payment relabelled as GAS; payTo and amount
  swaps with the field named in `detail`; wrong `extra.decimals`; non-NEP-17 and unknown contracts; a fee-on-transfer
  simulation; a settled log whose Transfer comes from another contract; a direct token payment where the payer only
  needs GAS for fees; the facilitator asset allowlist; `toAtomic`/`fromAtomic`; and an HTTP server offering GAS or
  fUSDT paid by a client capped only in fUSDT.
- **Rejections:** paying someone else, paying less, a different asset, appended opcodes, a `Global` payer scope, a
  widened fee-payer scope, fees over the cap or under the minimum, expired or too-long validity, attributes, a
  signature for another network, a witness from the wrong key, the facilitator as payer, and a pre-filled fee-payer
  witness.
- **MCP server** (`test/mcp.test.js`): handshake and tool list, in process and over the real stdio binary; a
  quote that does not pay; a paid fetch with receipt and spend tracking; refusal above the per-request cap and
  above the remaining budget; limit parsing; non-http URLs.
- **Edge cases:** insufficient funds, a FAULTed execution, client spending caps, and a replayed `PAYMENT-SIGNATURE`.

`npm run probe -- <rpc> <funded address>` checks things against a live node without spending anything:
- the node accepts the two-signer sponsored encoding (`calculatenetworkfee`)
- the canonical transfer simulates to `HALT true`
- the current fees

On MainNet (block 14,984,829) a sponsored GAS transfer is 245 bytes, costs 0.00215925 GAS system fee and needs
0.00073108 GAS network fee.

`npm run probe:token -- <asset> <holder> [atomic amount] [rpc]` does the same for a token, read-only. On MainNet at
block 14,985,614 a 0.25 fUSDT transfer from an existing holder simulated to `HALT true`, emitted the expected Transfer
event and cost 0.00437101 GAS system fee, inside the default sponsorship cap of 0.02 GAS.

`npm run probe:multisig [rpc]` asks a real node for the network fee of single-sig and m-of-n payers, alone and
sponsored, read-only. MainNet, sponsored: single-sig 0.00073108, 2-of-3 0.0014143, 3-of-5 0.0020971, 5-of-7
0.00279358 GAS.

`npm run e2e -- keys.json [direct|sponsored|fund-facilitator]` runs real payments on TestNet. Get TestNet GAS at
https://n3t5wish.ngd.network (GitHub login and reCAPTCHA, so a person has to do it).

## Status and limits

- Version 0.4. Token and multi-sig payments are tested against a fake node and probed read-only on MainNet; no real
  payment has been settled on chain yet. The payer must be a standard single-sig or m-of-n multi-sig account;
  contract wallets (a deployed `verify` method) are not supported yet.
- Sponsor risk: a payer who empties its balance between the facilitator's last simulation and block inclusion makes
  the transaction FAULT, and the sponsor pays that one transaction's fee (about 0.003 GAS). Rate-limit per payer if
  that matters to you.
- A token contract can be upgraded by its owner. The checks above run on every `/verify` and `/settle`, but they
  can't tell you whether you trust the token itself. Use the `assets` allowlist for anything that matters.
- No security audit yet. Read `src/exact.js` (about 300 lines) before using it with real value.

## License

Apache-2.0
