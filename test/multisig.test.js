'use strict';
// m-of-n multi-signature payers: account derivation, witness parsing, client signing, co-signing, facilitator checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const { tx, u } = require('@cityofzion/neon-js');
const neo = require('../src/neo');
const exact = require('../src/exact');

const { NET, newKey, payer, facilitator, merchant, mockChain } = require('./helpers');

// MainNet block 14,987,694: getnextblockvalidators (in the order the node returned them) and the header's
// `nextconsensus`, the 5-of-7 BFT address Neo derives from them with sorted keys.
const MAINNET_VALIDATORS = [
  '0239a37436652f41b3b802ca44cbcb7d65d3aa0b88c9a0380243bdbe1aaa5cb35b',
  '0362087e1f9ae6e7d0c1d05bbd17a724e0d5f92662e766980e47a5194d22c8fa80',
  '036eaee5b856e29a030307630bbaf0a63534c011af1c2c96782d36ebfb37d2ebb0',
  '029b46bf20b19fb3da1a4591bac09acd86c460ae29cb74c7634d658702205ec2f7',
  '02a93d383ad82bb2b85943c83fbb297321bb37fcca1f8c1eb189ffd2b67466d58a',
  '03b209fd4f53a7170ea4444e0cb0a6bb6a53c2bd016926989cf85f9b0fba17a70c',
  '03d9e8b16bd9b22d3345d6d4cde31be1c3e1d161532e3d0ccecb95ece2eb58336e',
];
const MAINNET_NEXTCONSENSUS = 'NXZSaAQyqS8aF9t9MPJSUffiK15f1eiwWc';

const [k1, k2, k3] = [newKey(), newKey(), newKey()];
const team = neo.multisigAccount(2, [k1, k2, k3]); // holds all three keys
const teamPub = (holders) => neo.multisigAccount(2, [k1, k2, k3].map((k) => (holders.includes(k) ? k : k.publicKey)));

const reqs = (sponsored, over = {}) => ({
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
const chain = (extra = {}) => mockChain({ balances: { [team.scriptHash]: 10n ** 9n, [payer.scriptHash]: 10n ** 9n, [facilitator.scriptHash]: 10n ** 9n }, ...extra });

const txOf = (p) => tx.Transaction.deserialize(neo.base64ToHex(p.payload.transaction));
const withTx = (p, t) => ({ ...p, payload: { transaction: neo.hexToBase64(t.serialize(true)) } });
const msgOf = (t) => t.getMessageForSigning(894710606);
const sigsOf = (t) => neo.signaturesFromInvocationScript(t.witnesses[t.witnesses.length - 1].invocationScript.toBigEndian());
function setSigs(p, sigs) {
  const t = txOf(p);
  t.witnesses[t.witnesses.length - 1].invocationScript = u.HexString.fromHex(neo.invocationScriptFromSignatures(sigs));
  return withTx(p, t);
}

test('multisigAccount matches the address Neo derives (MainNet validators -> nextconsensus)', () => {
  const acc = neo.multisigAccount(5, [...MAINNET_VALIDATORS].reverse());
  assert.equal(acc.address, MAINNET_NEXTCONSENSUS);
  assert.deepEqual(neo.multisigAccount(5, MAINNET_VALIDATORS).publicKeys, acc.publicKeys); // input order does not matter
  assert.deepEqual(neo.parseMultisigVerificationScript(acc.verificationScript), { threshold: 5, publicKeys: acc.publicKeys });
});

test('multisigAccount rejects bad parameters and duplicate keys', () => {
  assert.throws(() => neo.multisigAccount(0, [k1]), /bad multi-sig/);
  assert.throws(() => neo.multisigAccount(3, [k1, k2]), /bad multi-sig/);
  assert.throws(() => neo.multisigAccount(1, [k1, k1.publicKey]), /duplicate/);
  assert.throws(() => neo.multisigAccount(1, ['05' + k1.publicKey.slice(2)]), /compressed public key/);
});

test('parseMultisigVerificationScript accepts only the canonical m-of-n script', () => {
  const s = team.verificationScript;
  assert.ok(neo.parseMultisigVerificationScript(s));
  assert.equal(neo.parseMultisigVerificationScript(k1.verificationScript), null); // single-sig
  assert.equal(neo.parseMultisigVerificationScript(s.replace(/419ed0dc3a$/, '4156e7b327')), null); // CheckSig syscall
  assert.deepEqual(neo.parseMultisigVerificationScript('13' + s.slice(2)).threshold, 3); // 3-of-3 is valid
  assert.equal(neo.parseMultisigVerificationScript('14' + s.slice(2)), null); // 4-of-3
  assert.equal(neo.parseMultisigVerificationScript('0002' + s.slice(2)), null); // PUSHINT8 2 instead of PUSH2
  assert.equal(neo.parseMultisigVerificationScript(s.slice(0, -12) + '12' + '419ed0dc3a'), null); // n = 2, 3 keys
  assert.equal(neo.parseMultisigVerificationScript(s + '00'), null);
});

test('signatures round-trip through an invocation script', () => {
  const sigs = ['11'.repeat(64), '22'.repeat(64)];
  assert.deepEqual(neo.signaturesFromInvocationScript(neo.invocationScriptFromSignatures(sigs)), sigs);
  assert.equal(neo.signaturesFromInvocationScript(''), null);
  assert.equal(neo.signaturesFromInvocationScript('0c40' + '11'.repeat(63)), null);
});

test('2-of-3 payer, payer pays fees: build, verify, settle', async () => {
  const c = chain();
  const p = await exact.createPaymentPayload(reqs(false), team, { rpcUrl: 'mock' });
  assert.equal(sigsOf(txOf(p)).length, 2);
  const v = await exact.verifyPayment(p, reqs(false), ctx);
  assert.equal(v.isValid, true, v.invalidReason);
  assert.equal(v.payer, team.address);
  const s = await exact.settlePayment(p, reqs(false), ctx);
  assert.equal(s.success, true, s.errorReason);
  assert.equal(c.lastTx.signers[0].account.toBigEndian(), team.scriptHash);
});

test('2-of-3 payer, sponsored by the facilitator', async () => {
  const c = chain();
  const p = await exact.createPaymentPayload(reqs(true), team, { rpcUrl: 'mock' });
  const s = await exact.settlePayment(p, reqs(true), ctx);
  assert.equal(s.success, true, s.errorReason);
  assert.equal(c.lastTx.signers[0].account.toBigEndian(), facilitator.scriptHash);
  assert.equal(c.lastTx.signers[1].account.toBigEndian(), team.scriptHash);
});

test('partial signing, then a co-signer completes the payment', async () => {
  chain();
  const alice = teamPub([k1]);
  assert.equal(alice.address, team.address);
  await assert.rejects(exact.createPaymentPayload(reqs(true), alice, { rpcUrl: 'mock' }), /needs 2 signatures/);
  const half = await exact.createPaymentPayload(reqs(true), alice, { rpcUrl: 'mock', partial: true });
  assert.equal((await exact.verifyPayment(half, reqs(true), ctx)).invalidReason, 'invalid_exact_neo_payload_signature');
  const full = await exact.cosignPaymentPayload(half, teamPub([k3]), [k3]);
  assert.deepEqual(sigsOf(txOf(full)).length, 2);
  const s = await exact.settlePayment(full, reqs(true), ctx);
  assert.equal(s.success, true, s.errorReason);
  // co-signing again with a member who already signed changes nothing
  assert.equal((await exact.cosignPaymentPayload(full, team, [k1])).payload.transaction, full.payload.transaction);
});

test('co-signer refuses a transaction that is not the accepted payment', async () => {
  chain();
  const half = await exact.createPaymentPayload(reqs(false), teamPub([k1]), { rpcUrl: 'mock', partial: true });
  const t = txOf(half);
  t.script = u.HexString.fromHex(neo.transferScript(neo.ASSETS.GAS, team.scriptHash, newKey().scriptHash, 100000n));
  await assert.rejects(exact.cosignPaymentPayload(withTx(half, t), team, [k2]), /not the accepted payment: to/);
  const bigger = { ...half, accepted: { ...half.accepted, amount: '100001' } };
  await assert.rejects(exact.cosignPaymentPayload(bigger, team, [k2]), /amount/);
  await assert.rejects(exact.cosignPaymentPayload(half, neo.multisigAccount(2, [k1, k2]), [k2]), /not paid from multi-sig/);
  await assert.rejects(exact.cosignPaymentPayload(half, team, [payer]), /not a member/);
});

test('facilitator rejects bad multi-sig witnesses', async () => {
  chain();
  const p = await exact.createPaymentPayload(reqs(false), team, { rpcUrl: 'mock' });
  const t = txOf(p);
  const [s1, s2] = sigsOf(t);
  const reason = async (q, c = ctx) => (await exact.verifyPayment(q, reqs(false), c)).invalidReason;
  // signatures out of key order: CheckMultisig would fail on chain
  assert.equal(await reason(setSigs(p, [s2, s1])), 'invalid_exact_neo_payload_signature');
  // the same member twice
  assert.equal(await reason(setSigs(p, [s1, s1])), 'invalid_exact_neo_payload_signature');
  // one signature short, one too many
  assert.equal(await reason(setSigs(p, [s1])), 'invalid_exact_neo_payload_signature');
  const s3 = k3.sign(msgOf(t));
  assert.equal(await reason(setSigs(p, [s1, s2, s3])), 'invalid_exact_neo_payload_signature');
  // a signature from a non-member
  assert.equal(await reason(setSigs(p, [s1, payer.sign(msgOf(t))])), 'invalid_exact_neo_payload_signature');
  // 2-of-17 is over the default maxPayerKeys (16)
  const big = neo.multisigAccount(2, [k1, k2, ...Array.from({ length: 15 }, newKey)]);
  chain({ balances: { [big.scriptHash]: 10n ** 9n } });
  const pb = await exact.createPaymentPayload(reqs(false), big, { rpcUrl: 'mock' });
  assert.equal(await reason(pb), 'invalid_exact_neo_payload_witness');
  assert.equal(await reason(pb, { ...ctx, limits: { maxPayerKeys: 17 } }), undefined);
});

test('verifyMultisig follows CheckMultisig: ordered, distinct keys, exactly m signatures', () => {
  const msg = 'ab'.repeat(32);
  const keys = team.publicKeys;
  const signer = (pub) => [k1, k2, k3].find((k) => k.publicKey === pub);
  const [a, b, c] = keys.map((pub) => signer(pub).sign(msg));
  assert.equal(neo.verifyMultisig(msg, [a, b], keys, 2), true);
  assert.equal(neo.verifyMultisig(msg, [a, c], keys, 2), true);
  assert.equal(neo.verifyMultisig(msg, [b, c], keys, 2), true);
  assert.equal(neo.verifyMultisig(msg, [c, a], keys, 2), false);
  assert.equal(neo.verifyMultisig(msg, [a, b, c], keys, 2), false);
  assert.equal(neo.verifyMultisig(msg, [a], keys, 2), false);
});
