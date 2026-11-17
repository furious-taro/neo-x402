'use strict';
// Paying with NEP-17 tokens other than GAS. The fake node carries the MainNet metadata of fUSDT (6 decimals)
// and bNEO (8 decimals), see helpers.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { tx, u, wallet } = require('@cityofzion/neon-js');
const neo = require('../src/neo');
const exact = require('../src/exact');
const x = require('../src/http');
const { NET, newKey, payer, facilitator, facilitatorPrivateKey, merchant, mockChain } = require('./helpers');

const FUSDT = neo.TOKENS.fUSDT.hash;
const BNEO = neo.TOKENS.bNEO.hash;

const reqs = (over = {}, { sponsored = true, decimals = 6 } = {}) => ({
  scheme: 'exact',
  network: NET,
  amount: String(neo.toAtomic('0.25', 6)), // 0.25 fUSDT
  asset: FUSDT,
  payTo: merchant.address,
  maxTimeoutSeconds: 60,
  extra: {
    ...(sponsored ? { feePayer: facilitator.address, feePayerKey: facilitator.publicKey } : {}),
    ...(decimals === null ? {} : { decimals }),
  },
  ...over,
});
const ctx = { rpcUrl: 'mock', feePayerKey: facilitator, pollMs: 1, confirmTimeoutMs: 200 };

function resign(payload, mutate) {
  const t = tx.Transaction.deserialize(neo.base64ToHex(payload.payload.transaction));
  mutate(t);
  const sig = payer.sign(t.getMessageForSigning(894710606));
  t.witnesses[t.witnesses.length - 1].invocationScript = u.HexString.fromHex(neo.invocationScriptFromSignature(sig));
  return { ...payload, payload: { transaction: neo.hexToBase64(t.serialize(true)) } };
}

test('toAtomic / fromAtomic respect token decimals without floating point', () => {
  assert.equal(neo.toAtomic('0.25', 6), 250000n);
  assert.equal(neo.toAtomic('0.000001', 6), 1n);
  assert.equal(neo.toAtomic('1.50', 6), 1500000n);
  assert.equal(neo.toAtomic('0.001', 8), 100000n);
  assert.equal(neo.toAtomic('12', 0), 12n);
  assert.equal(neo.toAtomic('123456789.12345678', 8), 12345678912345678n);
  assert.throws(() => neo.toAtomic('0.0000001', 6), /decimal places/);
  assert.throws(() => neo.toAtomic('1.5', 0), /decimal places/);
  for (const bad of ['-1', '1e3', '0x10', '', '1.']) assert.throws(() => neo.toAtomic(bad, 6), bad);
  assert.equal(neo.fromAtomic(1500000n, 6), '1.5');
  assert.equal(neo.fromAtomic(1n, 6), '0.000001');
  assert.equal(neo.fromAtomic(100000n, 8), '0.001');
  assert.equal(neo.fromAtomic(7n, 0), '7');
  assert.equal(neo.fromAtomic(neo.toAtomic('98765.4321', 8), 8), '98765.4321');
});

test('parseTransferScript inverts transferScript for every integer width', () => {
  for (const amount of [1n, 16n, 17n, 255n, 250000n, 2n ** 31n, 2n ** 40n, 2n ** 100n]) {
    const s = neo.transferScript(FUSDT, payer.scriptHash, merchant.scriptHash, amount);
    assert.deepEqual(neo.parseTransferScript(s), { asset: neo.normHash(FUSDT), from: payer.scriptHash, to: merchant.scriptHash, amount });
  }
  const s = neo.transferScript(FUSDT, payer.scriptHash, merchant.scriptHash, 5n);
  assert.equal(neo.parseTransferScript(s + '40'), null);
  assert.equal(neo.parseTransferScript(s.replace('7472616e73666572', '7472616e73666573')), null); // "transfes"
});

test('fUSDT (6 decimals) sponsored payment: build, verify, settle', async () => {
  const chain = mockChain();
  const p = await exact.createPaymentPayload(reqs(), payer, { rpcUrl: 'mock' });
  const v = await exact.verifyPayment(p, reqs(), ctx);
  assert.equal(v.isValid, true, v.invalidReason + ' ' + (v.detail || ''));
  const s = await exact.settlePayment(p, reqs(), ctx);
  assert.equal(s.success, true, s.errorReason);
  assert.equal(s.amount, '250000');
  assert.deepEqual(neo.parseTransferScript(chain.lastTx.script.toBigEndian()), {
    asset: neo.normHash(FUSDT), from: payer.scriptHash, to: merchant.scriptHash, amount: 250000n,
  });
  // fees are still GAS, paid by the facilitator
  assert.equal(chain.lastTx.signers[0].account.toBigEndian(), facilitator.scriptHash);
});

test('rejects: asset hash swapped in the signed transfer (fUSDT requirement, bNEO script)', async () => {
  mockChain();
  const p = await exact.createPaymentPayload(reqs(), payer, { rpcUrl: 'mock' });
  const bad = resign(p, (t) => { t.script = u.HexString.fromHex(neo.transferScript(BNEO, payer.scriptHash, merchant.scriptHash, 250000n)); });
  const v = await exact.verifyPayment(bad, reqs(), ctx);
  assert.equal(v.invalidReason, 'invalid_exact_neo_payload_script');
  assert.match(v.detail, /^asset 0x48c40d4666f93408be1bef038b6722404d9a4c2a != 0xcd48b160c1bbc9d74997b803b9a7ad50a4bef020$/);
  assert.equal((await exact.settlePayment(bad, reqs(), ctx)).success, false);
});

test('rejects: a fUSDT payment relabelled as a GAS payment', async () => {
  mockChain();
  const p = await exact.createPaymentPayload(reqs(), payer, { rpcUrl: 'mock' });
  const gasReq = reqs({ asset: neo.ASSETS.GAS }, { decimals: 8 });
  const relabelled = { ...p, accepted: { ...p.accepted, asset: neo.ASSETS.GAS } };
  const v = await exact.verifyPayment(relabelled, gasReq, ctx);
  assert.equal(v.invalidReason, 'invalid_exact_neo_payload_script');
  assert.match(v.detail, /^asset 0xcd48b160c1bbc9d74997b803b9a7ad50a4bef020 != 0xd2a4cff31913016155e38e474a2c06d08be276cf$/);
  // and the unmodified payload does not match the GAS requirement at all
  assert.equal((await exact.verifyPayment(p, gasReq, ctx)).invalidReason, 'invalid_exact_neo_payload_accepted_mismatch');
});

test('rejects: payTo and amount swapped in a token transfer, with the field named', async () => {
  mockChain();
  const p = await exact.createPaymentPayload(reqs(), payer, { rpcUrl: 'mock' });
  const thief = newKey();
  const v1 = await exact.verifyPayment(resign(p, (t) => { t.script = u.HexString.fromHex(neo.transferScript(FUSDT, payer.scriptHash, thief.scriptHash, 250000n)); }), reqs(), ctx);
  assert.equal(v1.invalidReason, 'invalid_exact_neo_payload_script');
  assert.match(v1.detail, /^to 0x[0-9a-f]{40} != payTo 0x[0-9a-f]{40}$/);
  const v2 = await exact.verifyPayment(resign(p, (t) => { t.script = u.HexString.fromHex(neo.transferScript(FUSDT, payer.scriptHash, merchant.scriptHash, 249999n)); }), reqs(), ctx);
  assert.equal(v2.invalidReason, 'invalid_exact_neo_payload_script');
  assert.equal(v2.detail, 'amount 249999 != 250000');
});

test('extra.decimals must match the token contract', async () => {
  mockChain();
  // client refuses to sign when the server mislabels fUSDT as 8 decimals
  await assert.rejects(exact.createPaymentPayload(reqs({}, { decimals: 8 }), payer, { rpcUrl: 'mock' }), (e) => e.code === 'invalid_exact_neo_asset_decimals_mismatch');
  // facilitator refuses too
  const p = await exact.createPaymentPayload(reqs(), payer, { rpcUrl: 'mock' });
  assert.equal((await exact.verifyPayment(p, reqs({}, { decimals: 8 }), ctx)).invalidReason, 'invalid_exact_neo_asset_decimals_mismatch');
  // decimals is optional
  const p2 = await exact.createPaymentPayload(reqs({}, { decimals: null }), payer, { rpcUrl: 'mock' });
  assert.equal((await exact.verifyPayment(p2, reqs({}, { decimals: null }), ctx)).isValid, true);
  // and must be an integer when present
  assert.equal((await exact.verifyPayment(p, { ...reqs(), extra: { ...reqs().extra, decimals: '6' } }, ctx)).invalidReason, 'invalid_payment_requirements');
});

test('rejects assets that are not NEP-17 contracts', async () => {
  const notToken = '0x' + 'ab'.repeat(20);
  const chain = mockChain();
  chain.contracts[neo.normHash(notToken)] = { symbol: 'X', decimals: 0, standards: [] };
  await assert.rejects(exact.createPaymentPayload(reqs({ asset: notToken }, { decimals: null }), payer, { rpcUrl: 'mock' }), (e) => e.code === 'invalid_exact_neo_asset_not_nep17');
  // a payload built by a careless client is refused by the facilitator; an unknown contract too
  for (const asset of [notToken, '0x' + 'cd'.repeat(20)]) {
    const r = reqs({ asset }, { decimals: null });
    const p = resign(await exact.createPaymentPayload(reqs(), payer, { rpcUrl: 'mock' }), (t) => { t.script = u.HexString.fromHex(neo.transferScript(asset, payer.scriptHash, merchant.scriptHash, 250000n)); });
    const v = await exact.verifyPayment({ ...p, accepted: r }, r, ctx);
    assert.equal(v.invalidReason, 'invalid_exact_neo_asset_not_nep17', asset);
  }
});

test('rejects a token whose transfer returns true but moves less (fee-on-transfer)', async () => {
  const chain = mockChain();
  const p = await exact.createPaymentPayload(reqs(), payer, { rpcUrl: 'mock' });
  chain.simTransfer = { amount: 247500n }; // 1% skimmed
  assert.equal((await exact.verifyPayment(p, reqs(), ctx)).invalidReason, 'invalid_exact_neo_transfer_not_simulated');
  await assert.rejects(exact.createPaymentPayload(reqs(), payer, { rpcUrl: 'mock' }), /did not emit the expected Transfer/);
  chain.simTransfer = { contract: BNEO }; // event from another contract
  assert.equal((await exact.verifyPayment(p, reqs(), ctx)).invalidReason, 'invalid_exact_neo_transfer_not_simulated');
});

test('settle requires the Transfer event from the stated asset contract', async () => {
  const chain = mockChain();
  chain.logTransfer = { contract: neo.ASSETS.GAS };
  const p = await exact.createPaymentPayload(reqs(), payer, { rpcUrl: 'mock' });
  const s = await exact.settlePayment(p, reqs(), ctx);
  assert.equal(s.success, false);
  assert.equal(s.errorReason, 'invalid_exact_neo_transfer_not_found');
});

test('non-sponsored token payment: the payer needs GAS for fees only, not for the token amount', async () => {
  const chain = mockChain();
  const big = { amount: String(neo.toAtomic('500', 6)) }; // 500 fUSDT = 500,000,000 atomic units
  const r = reqs(big, { sponsored: false });
  const p = await exact.createPaymentPayload(r, payer, { rpcUrl: 'mock' });
  chain.balances[payer.scriptHash] = 10_000_000n; // 0.1 GAS: covers fees, far below 500,000,000
  const v = await exact.verifyPayment(p, r, ctx);
  assert.equal(v.isValid, true, v.invalidReason);
  // the same atomic amount in GAS would need 5 GAS on top of fees
  const g = reqs({ ...big, asset: neo.ASSETS.GAS }, { sponsored: false, decimals: 8 });
  const pg = await exact.createPaymentPayload(g, payer, { rpcUrl: 'mock' });
  assert.equal((await exact.verifyPayment(pg, g, ctx)).invalidReason, 'insufficient_funds');
});

test('facilitator asset allowlist', async () => {
  mockChain();
  const p = await exact.createPaymentPayload(reqs(), payer, { rpcUrl: 'mock' });
  assert.equal((await exact.verifyPayment(p, reqs(), { ...ctx, assets: [neo.ASSETS.GAS] })).invalidReason, 'invalid_exact_neo_asset_not_supported');
  assert.equal((await exact.verifyPayment(p, reqs(), { ...ctx, assets: [neo.ASSETS.GAS, FUSDT.toUpperCase().replace('0X', '0x')] })).isValid, true);
});

test('HTTP: server offers GAS or fUSDT, a client capped only in fUSDT pays fUSDT', async (t) => {
  const chain = mockChain();
  const extra = { feePayer: facilitator.address, feePayerKey: facilitator.publicKey };
  const accepts = [
    { scheme: 'exact', network: NET, amount: '100000', asset: neo.ASSETS.GAS, payTo: merchant.address, maxTimeoutSeconds: 60, extra: { ...extra, decimals: 8 } },
    { scheme: 'exact', network: NET, amount: '250000', asset: FUSDT, payTo: merchant.address, maxTimeoutSeconds: 60, extra: { ...extra, decimals: 6 } },
  ];
  const local = x.localFacilitator({ feePayerWif: wallet.getWIFFromPrivateKey(facilitatorPrivateKey), assets: [neo.ASSETS.GAS, FUSDT] });
  const gate = x.paywall({ accepts, facilitator: local });
  const api = http.createServer((req, res) => gate(req, res, () => res.end('ok')));
  const apiUrl = await new Promise((r) => api.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${api.address().port}`)));
  t.after(() => api.close());

  const pfetch = x.payingFetch(payer, { maxAmount: { [FUSDT]: neo.toAtomic('1', 6) } });
  const res = await pfetch(apiUrl);
  assert.equal(res.status, 200);
  assert.equal(x.decodePaymentResponse(res).amount, '250000');
  assert.equal(neo.parseTransferScript(chain.lastTx.script.toBigEndian()).asset, neo.normHash(FUSDT));
  // a cap below the price pays nothing
  const stingy = x.payingFetch(payer, { maxAmount: { [FUSDT]: neo.toAtomic('0.2', 6) } });
  assert.equal((await stingy(apiUrl)).status, 402);
});
