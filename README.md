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

## Run a facilitator as a service

```js
const { createFacilitatorServer, localFacilitator } = require('neo-x402');
createFacilitatorServer(localFacilitator({ feePayerWif: process.env.FEE_PAYER_WIF })).listen(8402);
// GET /supported, POST /verify, POST /settle  (x402 v2 facilitator API)
```

Resource servers then use `remoteFacilitator('http://host:8402')`.

## Tests

`npm test` runs 26 tests against a fake Neo node, plus real HTTP sockets for the transport tests.
- **Happy paths:** sponsored and direct payments, and a full client → paywall → facilitator round trip.
- **Rejections:** paying someone else, paying less, a different asset, appended opcodes, a `Global` payer scope, a
  widened fee-payer scope, fees over the cap or under the minimum, expired or too-long validity, attributes, a
  signature for another network, a witness from the wrong key, the facilitator as payer, and a pre-filled fee-payer
  witness.
- **Edge cases:** insufficient funds, a FAULTed execution, client spending caps, and a replayed `PAYMENT-SIGNATURE`.

`npm run probe -- <rpc> <funded address>` checks things against a live node without spending anything:
- the node accepts the two-signer sponsored encoding (`calculatenetworkfee`)
- the canonical transfer simulates to `HALT true`
- the current fees

On MainNet (block 14,984,829) a sponsored GAS transfer is 245 bytes, costs 0.00215925 GAS system fee and needs
0.00073108 GAS network fee.

`npm run e2e -- keys.json [direct|sponsored|fund-facilitator]` runs real payments on TestNet. Get TestNet GAS at
https://n3t5wish.ngd.network.

## Status and limits

- Version 0.1. The payer must be a standard single-signature account. Multi-sig and contract wallets are not
  supported yet.
- Sponsor risk: a payer who empties its balance between the facilitator's last simulation and block inclusion makes
  the transaction FAULT, and the sponsor pays that one transaction's fee (about 0.003 GAS). Rate-limit per payer if
  that matters to you.
- No security audit yet. Read `src/exact.js` (about 250 lines) before using it with real value.

## License

Apache-2.0
