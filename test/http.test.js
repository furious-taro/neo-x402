'use strict';
// End to end over real HTTP sockets: client -> resource server (paywall) -> facilitator server -> (fake) Neo node.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { wallet } = require('@cityofzion/neon-js');
const neo = require('../src/neo');
const x = require('../src/http');
const { NET, payer, facilitator, merchant, mockChain } = require('./helpers');

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

function requirement() {
  return {
    scheme: 'exact', network: NET, amount: '100000', asset: neo.ASSETS.GAS, payTo: merchant.address, maxTimeoutSeconds: 60,
    extra: { feePayer: facilitator.address, feePayerKey: facilitator.publicKey },
  };
}

test('paid request over HTTP with a remote facilitator', async (t) => {
  const chain = mockChain();
  const local = x.localFacilitator({ feePayerWif: wallet.getWIFFromPrivateKey(facilitatorPriv()) });
  const fac = x.createFacilitatorServer(local);
  const facUrl = await listen(fac);
  const gate = x.paywall({ accepts: [requirement()], facilitator: x.remoteFacilitator(facUrl), resource: { description: 'weather' } });
  const api = http.createServer((req, res) => gate(req, res, () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"temp":21}'); }));
  const apiUrl = await listen(api);
  t.after(() => { fac.close(); api.close(); });

  // unpaid: 402 with a decodable PAYMENT-REQUIRED header
  const unpaid = await fetch(apiUrl + '/weather');
  assert.equal(unpaid.status, 402);
  const pr = x.unb64json(unpaid.headers.get('payment-required'));
  assert.equal(pr.accepts[0].network, NET);

  // /supported advertises the fee payer
  const sup = await (await fetch(facUrl + '/supported')).json();
  assert.deepEqual(sup.signers['neo:*'], [facilitator.address]);

  // paying client
  const paid = [];
  const pfetch = x.payingFetch(payer, { maxAmount: { [neo.ASSETS.GAS]: 100000n }, onPayment: (r) => paid.push(r) });
  const res = await pfetch(apiUrl + '/weather');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { temp: 21 });
  const receipt = x.decodePaymentResponse(res);
  assert.equal(receipt.success, true);
  assert.equal(receipt.payer, payer.address);
  assert.equal(chain.sent.length, 1);
  assert.equal(paid.length, 1);
});

test('client refuses to pay above its cap', async (t) => {
  mockChain();
  const local = x.localFacilitator({ feePayerWif: wallet.getWIFFromPrivateKey(facilitatorPriv()) });
  const gate = x.paywall({ accepts: [requirement()], facilitator: local });
  const api = http.createServer((req, res) => gate(req, res, () => res.end('ok')));
  const apiUrl = await listen(api);
  t.after(() => api.close());
  const pfetch = x.payingFetch(payer, { maxAmount: { [neo.ASSETS.GAS]: 99999n } });
  const res = await pfetch(apiUrl);
  assert.equal(res.status, 402);
});

test('replaying a captured PAYMENT-SIGNATURE does not unlock the resource twice', async (t) => {
  mockChain();
  const local = x.localFacilitator({ feePayerWif: wallet.getWIFFromPrivateKey(facilitatorPriv()) });
  const gate = x.paywall({ accepts: [requirement()], facilitator: local });
  const api = http.createServer((req, res) => gate(req, res, () => res.end('ok')));
  const apiUrl = await listen(api);
  t.after(() => api.close());
  let captured;
  const spy = async (input, init = {}) => {
    const h = init.headers && new Headers(init.headers).get('payment-signature');
    if (h) captured = h;
    return fetch(input, init);
  };
  const pfetch = x.payingFetch(payer, { maxAmount: { [neo.ASSETS.GAS]: 100000n }, fetchImpl: spy });
  assert.equal((await pfetch(apiUrl)).status, 200);
  const replay = await fetch(apiUrl, { headers: { 'PAYMENT-SIGNATURE': captured } });
  assert.equal(replay.status, 402);
  assert.match(x.unb64json(replay.headers.get('payment-required')).error, /already_used/);
});

// helpers.js exposes the facilitator key object; rebuild its WIF from a stored private key
function facilitatorPriv() {
  return require('./helpers').facilitatorPrivateKey;
}
