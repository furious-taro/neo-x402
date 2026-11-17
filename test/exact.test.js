'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { wallet, tx, u } = require('@cityofzion/neon-js');
const neo = require('../src/neo');
const exact = require('../src/exact');

const { NET, newKey, payer, facilitator, merchant, mockChain } = require('./helpers');

const reqs = (sponsored = true, over = {}) => ({
  scheme: 'exact',
  network: NET,
  amount: '100000',
  asset: neo.ASSETS.GAS,
  payTo: merchant.address,
  maxTimeoutSeconds: 60,
  extra: sponsored ? { feePayer: facilitator.address, feePayerKey: facilitator.publicKey } : {},
  ...over,
});
const ctx = { rpcUrl: 'mock', feePayerKey: facilitator, pollMs: 1, confirmTimeoutMs: 200 };

// Re-sign a modified transaction with the payer key (attacker controls the payer key, not the facilitator's).
function resign(payload, mutate, sponsored = true) {
  const t = tx.Transaction.deserialize(neo.base64ToHex(payload.payload.transaction));
  mutate(t);
  const sig = payer.sign(t.getMessageForSigning(894710606));
  t.witnesses[sponsored ? 1 : 0].invocationScript = u.HexString.fromHex(neo.invocationScriptFromSignature(sig));
  return { ...payload, payload: { transaction: neo.hexToBase64(t.serialize(true)) } };
}

test('sponsored payment: build, verify, settle', async () => {
  const chain = mockChain();
  const p = await exact.createPaymentPayload(reqs(), payer, { rpcUrl: 'mock' });
  const v = await exact.verifyPayment(p, reqs(), ctx);
  assert.equal(v.isValid, true, v.invalidReason + ' ' + (v.detail || ''));
  assert.equal(v.payer, payer.address);
  const s = await exact.settlePayment(p, reqs(), ctx);
  assert.equal(s.success, true, s.errorReason);
  assert.match(s.transaction, /^0x[0-9a-f]{64}$/);
  // facilitator is the sender (pays the fees) with scope None
  assert.equal(chain.lastTx.signers[0].account.toBigEndian(), facilitator.scriptHash);
  assert.equal(chain.lastTx.signers[0].scopes, tx.WitnessScope.None);
  // replaying the same payload is refused
  const again = await exact.verifyPayment(p, reqs(), ctx);
  assert.equal(again.invalidReason, 'invalid_exact_neo_payload_already_used');
});

test('non-sponsored payment: payer pays fees, facilitator only relays', async () => {
  mockChain();
  const r = reqs(false);
  const p = await exact.createPaymentPayload(r, payer, { rpcUrl: 'mock' });
  const t = tx.Transaction.deserialize(neo.base64ToHex(p.payload.transaction));
  assert.equal(t.signers.length, 1);
  const s = await exact.settlePayment(p, r, ctx);
  assert.equal(s.success, true, s.errorReason);
});

const tamper = [
  ['pays someone else', (t) => { t.script = u.HexString.fromHex(neo.transferScript(neo.ASSETS.GAS, payer.scriptHash, newKey().scriptHash, 100000n)); }, 'invalid_exact_neo_payload_script'],
  ['pays less', (t) => { t.script = u.HexString.fromHex(neo.transferScript(neo.ASSETS.GAS, payer.scriptHash, merchant.scriptHash, 99999n)); }, 'invalid_exact_neo_payload_script'],
  ['other asset', (t) => { t.script = u.HexString.fromHex(neo.transferScript(neo.ASSETS.NEO, payer.scriptHash, merchant.scriptHash, 100000n)); }, 'invalid_exact_neo_payload_script'],
  ['extra opcode appended', (t) => { t.script = u.HexString.fromHex(t.script.toBigEndian() + '40'); }, 'invalid_exact_neo_payload_script'],
  ['payer scope Global', (t) => { t.signers[1].scopes = tx.WitnessScope.Global; }, 'invalid_exact_neo_payload_signer_scope'],
  ['fee payer scope widened', (t) => { t.signers[0].scopes = tx.WitnessScope.CalledByEntry; }, 'invalid_exact_neo_payload_fee_payer_scope'],
  ['system fee above ceiling', (t) => { t.systemFee = u.BigInteger.fromNumber(500_000_000); }, 'invalid_exact_neo_payload_fee_exceeds_maximum'],
  ['network fee above ceiling', (t) => { t.networkFee = u.BigInteger.fromNumber(500_000_000); }, 'invalid_exact_neo_payload_fee_exceeds_maximum'],
  ['system fee too low', (t) => { t.systemFee = u.BigInteger.fromNumber(1); }, 'invalid_exact_neo_payload_system_fee_too_low'],
  ['network fee too low', (t) => { t.networkFee = u.BigInteger.fromNumber(1); }, 'invalid_exact_neo_payload_network_fee_too_low'],
  ['expired', (t) => { t.validUntilBlock = 1000; }, 'invalid_exact_neo_payload_expired'],
  ['valid for too long', (t) => { t.validUntilBlock = 5000; }, 'invalid_exact_neo_payload_valid_until_too_far'],
  ['attribute added', (t) => { t.attributes.push(new tx.HighPriorityAttribute()); }, ['invalid_exact_neo_payload_attributes', 'invalid_exact_neo_payload_transaction']],
];
for (const [name, mutate, reason] of tamper) {
  test(`rejects: ${name}`, async () => {
    mockChain();
    const p = await exact.createPaymentPayload(reqs(), payer, { rpcUrl: 'mock' });
    const bad = resign(p, mutate);
    const v = await exact.verifyPayment(bad, reqs(), ctx);
    assert.equal(v.isValid, false);
    if (Array.isArray(reason)) assert.ok(reason.includes(v.invalidReason), v.invalidReason);
    else assert.equal(v.invalidReason, reason, v.detail);
    const s = await exact.settlePayment(bad, reqs(), ctx);
    assert.equal(s.success, false);
  });
}

test('rejects a signature made for another network (mainnet replay)', async () => {
  mockChain();
  const p = await exact.createPaymentPayload(reqs(), payer, { rpcUrl: 'mock' });
  const t = tx.Transaction.deserialize(neo.base64ToHex(p.payload.transaction));
  t.witnesses[1].invocationScript = u.HexString.fromHex(neo.invocationScriptFromSignature(payer.sign(t.getMessageForSigning(860833102))));
  const v = await exact.verifyPayment({ ...p, payload: { transaction: neo.hexToBase64(t.serialize(true)) } }, reqs(), ctx);
  assert.equal(v.invalidReason, 'invalid_exact_neo_payload_signature');
});

test('rejects a witness from a key that is not the payer', async () => {
  mockChain();
  const p = await exact.createPaymentPayload(reqs(), payer, { rpcUrl: 'mock' });
  const t = tx.Transaction.deserialize(neo.base64ToHex(p.payload.transaction));
  const other = newKey();
  t.witnesses[1].verificationScript = u.HexString.fromHex(other.verificationScript);
  t.witnesses[1].invocationScript = u.HexString.fromHex(neo.invocationScriptFromSignature(other.sign(t.getMessageForSigning(894710606))));
  const v = await exact.verifyPayment({ ...p, payload: { transaction: neo.hexToBase64(t.serialize(true)) } }, reqs(), ctx);
  assert.equal(v.invalidReason, 'invalid_exact_neo_payload_witness');
});

test('rejects the facilitator as payer', async () => {
  mockChain();
  const p = await exact.createPaymentPayload(reqs(false), facilitator, { rpcUrl: 'mock' });
  const v = await exact.verifyPayment(p, reqs(false), ctx);
  assert.equal(v.invalidReason, 'invalid_exact_neo_payload_payer_is_facilitator');
});

test('rejects a pre-signed fee-payer slot (client cannot supply facilitator witness)', async () => {
  mockChain();
  const p = await exact.createPaymentPayload(reqs(), payer, { rpcUrl: 'mock' });
  const bad = resign(p, (t) => { t.witnesses[0].invocationScript = u.HexString.fromHex('0c40' + '00'.repeat(64)); });
  assert.equal((await exact.verifyPayment(bad, reqs(), ctx)).invalidReason, 'invalid_exact_neo_payload_fee_payer_witness');
});

test('rejects accepted/requirements mismatch and unknown fee payer', async () => {
  mockChain();
  const p = await exact.createPaymentPayload(reqs(), payer, { rpcUrl: 'mock' });
  assert.equal((await exact.verifyPayment(p, reqs(true, { amount: '200000' }), ctx)).invalidReason, 'invalid_exact_neo_payload_accepted_mismatch');
  assert.equal((await exact.verifyPayment(p, reqs(), { ...ctx, feePayerKey: newKey() })).invalidReason, 'invalid_exact_neo_fee_payer_unknown');
});

test('insufficient funds when the transfer simulation returns false', async () => {
  const chain = mockChain();
  const p = await exact.createPaymentPayload(reqs(), payer, { rpcUrl: 'mock' });
  chain.transferResult = false;
  assert.equal((await exact.verifyPayment(p, reqs(), ctx)).invalidReason, 'insufficient_funds');
});

test('non-sponsored: payer without GAS for fees is refused', async () => {
  const chain = mockChain();
  const p = await exact.createPaymentPayload(reqs(false), payer, { rpcUrl: 'mock' });
  chain.balances[payer.scriptHash] = 100000n; // covers the amount, not the fees
  assert.equal((await exact.verifyPayment(p, reqs(false), ctx)).invalidReason, 'insufficient_funds');
});

test('settle reports a faulted execution', async () => {
  const chain = mockChain();
  chain.vmstate = 'FAULT';
  const p = await exact.createPaymentPayload(reqs(), payer, { rpcUrl: 'mock' });
  const s = await exact.settlePayment(p, reqs(), ctx);
  assert.equal(s.success, false);
  assert.equal(s.errorReason, 'invalid_exact_neo_transaction_failed');
});
