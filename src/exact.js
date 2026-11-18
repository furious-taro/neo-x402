'use strict';
// x402 v2 `exact` scheme on Neo N3: client payload construction, facilitator verify and settle.
const crypto = require('node:crypto');
const { tx, u, wallet } = require('@cityofzion/neon-js');
const neo = require('./neo');

const { Transaction, WitnessScope } = tx;

const DEFAULT_LIMITS = {
  // Ceilings a sponsoring facilitator will pay per payment, in GAS fractions (1 GAS = 1e8).
  maxSystemFee: 2_000_000n, // 0.02 GAS
  maxNetworkFee: 1_000_000n, // 0.01 GAS
  // Extra blocks tolerated on validUntilBlock beyond ceil(maxTimeoutSeconds / blockTime).
  validUntilSlackBlocks: 2,
  // Largest multi-sig payer accepted (n keys). Verification cost grows with n; the transaction size cap bounds it too.
  maxPayerKeys: 16,
};

const fail = (invalidReason, payer) => ({ isValid: false, invalidReason, ...(payer ? { payer } : {}) });
// RPC wants scope names ('None', 'CalledByEntry'), not the numeric flags
const signersJson = (signers) => signers.map((s) => ({ account: '0x' + s.account, scopes: WitnessScope[s.scopes] }));
const blocksFor = (seconds, msPerBlock) => Math.ceil((Number(seconds) * 1000) / (msPerBlock || 15000));

async function networkInfo(rpcUrl) {
  const v = await neo.rpc(rpcUrl, 'getversion');
  return { magic: v.protocol.network, msPerBlock: v.protocol.msperblock, maxIncrement: v.protocol.maxvaliduntilblockincrement };
}

function readRequirements(req) {
  if (!req || req.scheme !== 'exact') throw Object.assign(new Error('unsupported scheme'), { code: 'invalid_scheme' });
  const net = neo.parseNetwork(req.network);
  if (!/^[1-9][0-9]*$/.test(String(req.amount))) throw Object.assign(new Error('bad amount'), { code: 'invalid_payment_requirements' });
  return {
    net,
    amount: BigInt(req.amount),
    asset: neo.normHash(req.asset),
    payTo: neo.addressToHash(req.payTo),
    feePayer: req.extra && req.extra.feePayer ? neo.addressToHash(req.extra.feePayer) : null,
    feePayerKey: req.extra && req.extra.feePayerKey ? String(req.extra.feePayerKey).toLowerCase() : null,
    decimals: readDecimals(req.extra),
    maxTimeoutSeconds: Number(req.maxTimeoutSeconds) || 60,
  };
}

function readDecimals(extra) {
  if (!extra || extra.decimals === undefined) return null;
  if (!Number.isInteger(extra.decimals) || extra.decimals < 0 || extra.decimals > 32) {
    throw Object.assign(new Error('bad extra.decimals'), { code: 'invalid_payment_requirements' });
  }
  return extra.decimals;
}

/**
 * The asset must be a deployed contract that declares NEP-17, and if the requirements state `extra.decimals`
 * it must equal what the contract's `decimals()` returns. Returns an error code, or null when the asset is fine.
 */
async function checkAsset(url, asset, decimals) {
  let state;
  try {
    state = await neo.rpc(url, 'getcontractstate', ['0x' + asset]);
  } catch (e) {
    if (e instanceof neo.RpcError) return 'invalid_exact_neo_asset_not_nep17'; // unknown contract
    throw e;
  }
  const standards = (state && state.manifest && state.manifest.supportedstandards) || [];
  if (!standards.includes('NEP-17')) return 'invalid_exact_neo_asset_not_nep17';
  if (decimals !== null) {
    const d = await neo.rpc(url, 'invokefunction', ['0x' + asset, 'decimals', []]);
    if (d.state !== 'HALT' || !d.stack[0] || String(d.stack[0].value) !== String(decimals)) return 'invalid_exact_neo_asset_decimals_mismatch';
  }
  return null;
}

// Says which field of a non-canonical transfer script differs from what the requirements ask for.
function scriptMismatch(scriptHex, want) {
  const got = neo.parseTransferScript(scriptHex);
  if (!got) return 'not a canonical NEP-17 transfer script';
  const diffs = [];
  if (got.asset !== want.asset) diffs.push(`asset 0x${got.asset} != 0x${want.asset}`);
  if (got.from !== want.from) diffs.push(`from 0x${got.from} != payer 0x${want.from}`);
  if (got.to !== want.to) diffs.push(`to 0x${got.to} != payTo 0x${want.to}`);
  if (got.amount !== want.amount) diffs.push(`amount ${got.amount} != ${want.amount}`);
  return diffs.join('; ');
}

// ---------------------------------------------------------------- client

/**
 * Build and sign a `exact` PaymentPayload for one PaymentRequirements entry.
 * @param {object} requirements x402 PaymentRequirements (scheme "exact", network "neo:<magic>")
 * @param {object} key result of neo.keyFromWif(), or neo.multisigAccount(m, members) for an m-of-n payer
 * @param {object} opts { rpcUrl, resource, partial } (partial: multi-sig only, allow fewer than m signatures)
 */
async function createPaymentPayload(requirements, key, { rpcUrl, resource, partial = false } = {}) {
  const r = readRequirements(requirements);
  const url = rpcUrl || r.net.rpc;
  if (!url) throw new Error(`no RPC endpoint known for ${requirements.network}`);
  const info = await networkInfo(url);
  if (info.magic !== r.net.magic) throw new Error(`RPC is on network ${info.magic}, requirements ask for ${r.net.magic}`);
  const assetProblem = await checkAsset(url, r.asset, r.decimals);
  if (assetProblem) throw Object.assign(new Error(`refusing to pay with asset 0x${r.asset}: ${assetProblem}`), { code: assetProblem });

  const script = neo.transferScript(r.asset, key.scriptHash, r.payTo, r.amount);
  const signers = [];
  const witnesses = [];
  if (r.feePayer) {
    if (!r.feePayerKey) throw new Error('requirements.extra.feePayerKey missing for a sponsored payment');
    const feeVerif = `0c21${r.feePayerKey}4156e7b327`;
    if (neo.normHash(wallet.getScriptHashFromVerificationScript(feeVerif)) !== r.feePayer) {
      throw new Error('extra.feePayerKey does not match extra.feePayer');
    }
    signers.push({ account: r.feePayer, scopes: WitnessScope.None });
    witnesses.push({ invocationScript: '', verificationScript: feeVerif });
  }
  signers.push({ account: key.scriptHash, scopes: WitnessScope.CalledByEntry });
  witnesses.push({ invocationScript: '', verificationScript: key.verificationScript });

  const sim = await neo.rpc(url, 'invokescript', [neo.hexToBase64(script), signersJson(signers)]);
  if (sim.state !== 'HALT') throw new Error(`transfer simulation faulted: ${sim.exception}`);
  if (!sim.stack || !sim.stack[0] || sim.stack[0].value !== true) throw new Error('transfer simulation returned false (insufficient balance?)');
  if (!hasTransfer(sim.notifications, r.asset, key.scriptHash, r.payTo, r.amount)) throw new Error('transfer simulation did not emit the expected Transfer event');

  const height = (await neo.rpc(url, 'getblockcount')) - 1;
  const t = new Transaction({
    version: 0,
    nonce: crypto.randomBytes(4).readUInt32LE(0),
    systemFee: sim.gasconsumed,
    networkFee: 0,
    validUntilBlock: height + blocksFor(r.maxTimeoutSeconds, info.msPerBlock),
    signers,
    attributes: [],
    witnesses,
    script,
  });
  const fee = await neo.rpc(url, 'calculatenetworkfee', [neo.hexToBase64(t.serialize(true))]);
  t.networkFee = u.BigInteger.fromNumber(fee.networkfee);

  const msg = t.getMessageForSigning(r.net.magic);
  let invocation;
  if (isMultisig(key)) {
    // sign with the members we hold, in key order; with `partial`, fewer than the threshold is allowed and the
    // other members add theirs with cosignPaymentPayload
    const sigs = await multisigSignatures(key, msg, key.signers, []);
    if (sigs.length < key.threshold && !partial) {
      throw new Error(`multi-sig payer needs ${key.threshold} signatures, holds keys for ${sigs.length} (pass { partial: true } and cosign)`);
    }
    invocation = neo.invocationScriptFromSignatures(sigs.map((x) => x.sig));
  } else {
    invocation = neo.invocationScriptFromSignature(await key.sign(msg));
  }
  t.witnesses[t.witnesses.length - 1].invocationScript = u.HexString.fromHex(invocation);

  return {
    x402Version: 2,
    ...(resource ? { resource } : {}),
    accepted: requirements,
    payload: { transaction: neo.hexToBase64(t.serialize(true)) },
  };
}

const isMultisig = (key) => key && Number.isInteger(key.threshold) && Array.isArray(key.publicKeys);

// Collects signatures from `signers` (members of the multi-sig `account`) on top of `existing` ({ index, sig }),
// stopping at the threshold. Returns them sorted by key index, the order CheckMultisig needs.
async function multisigSignatures(account, msg, signers, existing) {
  const have = new Map(existing.map((x) => [x.index, x.sig]));
  for (const s of signers || []) {
    if (have.size >= account.threshold) break;
    const index = account.publicKeys.indexOf(String(s.publicKey).toLowerCase());
    if (index < 0) throw new Error(`key ${s.publicKey} is not a member of multi-sig ${account.address}`);
    if (have.has(index)) continue;
    const sig = await s.sign(msg);
    if (!neo.verifySignature(msg, sig, account.publicKeys[index])) throw new Error(`signer ${s.publicKey} returned a bad signature`);
    have.set(index, sig);
  }
  return [...have.entries()].sort((a, b) => a[0] - b[0]).map(([index, sig]) => ({ index, sig }));
}

/**
 * Adds one or more members' signatures to a partially signed multi-sig payment (createPaymentPayload with
 * { partial: true }). Before signing, checks that the transaction is exactly the payment `accepted` describes, paid
 * from `account`: a co-signer never signs a script it has not checked.
 * @param {object} paymentPayload partially signed payload
 * @param {object} account neo.multisigAccount(...) for the payer
 * @param {object[]} signers keyFromWif() results (or { publicKey, sign(msgHex) }) of members adding signatures
 */
async function cosignPaymentPayload(paymentPayload, account, signers) {
  if (!isMultisig(account)) throw new Error('cosignPaymentPayload needs a multisigAccount');
  const r = readRequirements(paymentPayload.accepted);
  const t = Transaction.deserialize(neo.base64ToHex(paymentPayload.payload.transaction));
  const w = t.witnesses[t.witnesses.length - 1];
  const payerSigner = t.signers[t.signers.length - 1];
  if (neo.normHash(payerSigner.account.toBigEndian()) !== account.scriptHash || w.verificationScript.toBigEndian() !== account.verificationScript) {
    throw new Error(`payload is not paid from multi-sig ${account.address}`);
  }
  if (payerSigner.scopes !== WitnessScope.CalledByEntry) throw new Error('payer signer scope must be CalledByEntry');
  if (t.script.toBigEndian() !== neo.transferScript(r.asset, account.scriptHash, r.payTo, r.amount)) {
    throw new Error(`transaction script is not the accepted payment: ${scriptMismatch(t.script.toBigEndian(), { asset: r.asset, from: account.scriptHash, to: r.payTo, amount: r.amount })}`);
  }
  if (t.attributes.length !== 0) throw new Error('unexpected transaction attributes');
  const msg = t.getMessageForSigning(r.net.magic);
  // existing signatures: map each to the key it verifies against (they are in key order)
  const prior = neo.signaturesFromInvocationScript(w.invocationScript.toBigEndian()) || [];
  const existing = [];
  let j = 0;
  for (const sig of prior) {
    while (j < account.publicKeys.length && !neo.verifySignature(msg, sig, account.publicKeys[j])) j++;
    if (j === account.publicKeys.length) throw new Error('payload carries a signature that does not verify');
    existing.push({ index: j++, sig });
  }
  const sigs = await multisigSignatures(account, msg, signers, existing);
  w.invocationScript = u.HexString.fromHex(neo.invocationScriptFromSignatures(sigs.map((x) => x.sig)));
  return { ...paymentPayload, payload: { transaction: neo.hexToBase64(t.serialize(true)) } };
}

// ------------------------------------------------------------ facilitator

const SAME_FIELDS = ['scheme', 'network', 'amount', 'asset', 'payTo'];

/**
 * Offline + on-chain checks shared by /verify and /settle. Never writes state.
 * @param {object} paymentPayload
 * @param {object} requirements
 * @param {object} ctx { rpcUrl, feePayerKey (neo.keyFromWif result, required to sponsor), limits }
 * @returns {Promise<{isValid:boolean, invalidReason?:string, payer?:string, _tx?:Transaction}>}
 */
async function verifyPayment(paymentPayload, requirements, ctx = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(ctx.limits || {}) };
  // 1. protocol
  if (!paymentPayload || paymentPayload.x402Version !== 2) return fail('invalid_x402_version');
  const acc = paymentPayload.accepted || {};
  for (const f of SAME_FIELDS) if (String(acc[f]) !== String(requirements[f])) return fail(f === 'network' ? 'invalid_network' : f === 'scheme' ? 'invalid_scheme' : 'invalid_exact_neo_payload_accepted_mismatch');
  let r;
  try {
    r = readRequirements(requirements);
  } catch (e) {
    return fail(e.code || 'invalid_payment_requirements');
  }
  const facilitator = ctx.feePayerKey || null;
  if (r.feePayer && (!facilitator || facilitator.scriptHash !== r.feePayer)) return fail('invalid_exact_neo_fee_payer_unknown');
  // optional allowlist: a facilitator (especially a sponsoring one) may only accept tokens it knows
  if (ctx.assets && !ctx.assets.map(neo.normHash).includes(r.asset)) return fail('invalid_exact_neo_asset_not_supported');

  // 2. decode, canonical form only
  const raw = paymentPayload.payload && paymentPayload.payload.transaction;
  if (typeof raw !== 'string' || raw.length > 4096) return fail('invalid_exact_neo_payload_transaction');
  const hex = neo.base64ToHex(raw);
  let t;
  try {
    t = Transaction.deserialize(hex);
  } catch {
    return fail('invalid_exact_neo_payload_transaction');
  }
  if (t.serialize(true) !== hex) return fail('invalid_exact_neo_payload_transaction');
  if (t.version !== 0) return fail('invalid_exact_neo_payload_transaction');
  if (t.attributes.length !== 0) return fail('invalid_exact_neo_payload_attributes');

  // 3. signers
  const expectSigners = r.feePayer ? 2 : 1;
  if (t.signers.length !== expectSigners || t.witnesses.length !== expectSigners) return fail('invalid_exact_neo_payload_signers');
  const payerSigner = t.signers[expectSigners - 1];
  const payerHash = neo.normHash(payerSigner.account.toBigEndian());
  const payer = neo.hashToAddress(payerHash);
  if (payerSigner.scopes !== WitnessScope.CalledByEntry) return fail('invalid_exact_neo_payload_signer_scope', payer);
  if (facilitator && payerHash === facilitator.scriptHash) return fail('invalid_exact_neo_payload_payer_is_facilitator', payer);
  if (r.feePayer) {
    const s0 = t.signers[0];
    if (neo.normHash(s0.account.toBigEndian()) !== r.feePayer) return fail('invalid_exact_neo_payload_signers', payer);
    if (s0.scopes !== WitnessScope.None) return fail('invalid_exact_neo_payload_fee_payer_scope', payer);
    const w0 = t.witnesses[0];
    if (w0.invocationScript.toBigEndian() !== '') return fail('invalid_exact_neo_payload_fee_payer_witness', payer);
    const v0 = w0.verificationScript.toBigEndian();
    if (v0 !== '' && v0 !== facilitator.verificationScript) return fail('invalid_exact_neo_payload_fee_payer_witness', payer);
  }

  // 4. script: exactly asset.transfer(payer, payTo, amount, null)
  const script = t.script.toBigEndian();
  if (script !== neo.transferScript(r.asset, payerHash, r.payTo, r.amount)) {
    return { ...fail('invalid_exact_neo_payload_script', payer), detail: scriptMismatch(script, { asset: r.asset, from: payerHash, to: r.payTo, amount: r.amount }) };
  }

  // 5. payer witness: standard single-sig or m-of-n multi-sig account, valid signature(s) for this network
  const w = t.witnesses[expectSigners - 1];
  const vscript = w.verificationScript.toBigEndian();
  const iscript = w.invocationScript.toBigEndian();
  const msg = t.getMessageForSigning(r.net.magic);
  const pub = neo.publicKeyFromVerificationScript(vscript);
  if (pub) {
    const sig = neo.signatureFromInvocationScript(iscript);
    if (!sig) return fail('invalid_exact_neo_payload_witness', payer);
    if (wallet.getScriptHashFromPublicKey(pub) !== payerHash) return fail('invalid_exact_neo_payload_witness', payer);
    if (!neo.verifySignature(msg, sig, pub)) return fail('invalid_exact_neo_payload_signature', payer);
  } else {
    const ms = neo.parseMultisigVerificationScript(vscript);
    if (!ms || ms.publicKeys.length > limits.maxPayerKeys) return fail('invalid_exact_neo_payload_witness', payer);
    if (neo.normHash(wallet.getScriptHashFromVerificationScript(vscript)) !== payerHash) return fail('invalid_exact_neo_payload_witness', payer);
    const sigs = neo.signaturesFromInvocationScript(iscript);
    if (!sigs || sigs.length !== ms.threshold) return fail('invalid_exact_neo_payload_signature', payer);
    if (!neo.verifyMultisig(msg, sigs, ms.publicKeys, ms.threshold)) return fail('invalid_exact_neo_payload_signature', payer);
  }

  // 6. fee ceilings when we pay them
  const sysFee = BigInt(t.systemFee.toString());
  const netFee = BigInt(t.networkFee.toString());
  if (r.feePayer && (sysFee > limits.maxSystemFee || netFee > limits.maxNetworkFee)) return fail('invalid_exact_neo_payload_fee_exceeds_maximum', payer);

  // 7. chain state
  const url = ctx.rpcUrl || r.net.rpc;
  try {
    const info = await networkInfo(url);
    if (info.magic !== r.net.magic) return fail('invalid_network', payer);
    const height = (await neo.rpc(url, 'getblockcount')) - 1;
    const maxVub = height + blocksFor(r.maxTimeoutSeconds, info.msPerBlock) + limits.validUntilSlackBlocks;
    if (t.validUntilBlock <= height) return fail('invalid_exact_neo_payload_expired', payer);
    if (t.validUntilBlock > maxVub) return fail('invalid_exact_neo_payload_valid_until_too_far', payer);

    const seen = await neo.rpc(url, 'getrawtransaction', ['0x' + t.hash(), true]).catch(() => null);
    if (seen) return fail('invalid_exact_neo_payload_already_used', payer);

    const assetProblem = await checkAsset(url, r.asset, r.decimals);
    if (assetProblem) return fail(assetProblem, payer);

    const sim = await neo.rpc(url, 'invokescript', [neo.hexToBase64(script), signersJson(t.signers.map((s) => ({ account: neo.normHash(s.account.toBigEndian()), scopes: s.scopes })))]);
    if (sim.state !== 'HALT' || !sim.stack[0] || sim.stack[0].value !== true) return fail('insufficient_funds', payer);
    // `transfer` returning true is not enough for an arbitrary token: the simulated run must emit
    // Transfer(payer, payTo, amount) from the asset contract (catches fee-on-transfer or non-conforming tokens)
    if (!hasTransfer(sim.notifications, r.asset, payerHash, r.payTo, r.amount)) return fail('invalid_exact_neo_transfer_not_simulated', payer);
    if (BigInt(sim.gasconsumed) > sysFee) return fail('invalid_exact_neo_payload_system_fee_too_low', payer);

    // network fee must cover verification; compute with the final fee-payer verification script in place
    const probe = Transaction.deserialize(hex);
    if (r.feePayer) probe.witnesses[0].verificationScript = u.HexString.fromHex(facilitator.verificationScript);
    const need = await neo.rpc(url, 'calculatenetworkfee', [neo.hexToBase64(probe.serialize(true))]);
    if (BigInt(need.networkfee) > netFee) return fail('invalid_exact_neo_payload_network_fee_too_low', payer);

    // whoever pays the fees needs the GAS for them (and for the amount, if the asset is GAS and they are the payer)
    const feeHolder = r.feePayer || payerHash;
    let needGas = sysFee + netFee;
    if (!r.feePayer && r.asset === neo.normHash(neo.ASSETS.GAS)) needGas += r.amount;
    const bal = await neo.rpc(url, 'invokefunction', [neo.ASSETS.GAS, 'balanceOf', [{ type: 'Hash160', value: '0x' + feeHolder }]]);
    if (BigInt(bal.stack[0].value) < needGas) return fail(r.feePayer ? 'invalid_exact_neo_fee_payer_insufficient_gas' : 'insufficient_funds', payer);
  } catch (e) {
    return { ...fail('invalid_exact_neo_rpc_unavailable', payer), detail: String((e && e.message) || e) };
  }
  return { isValid: true, payer, _tx: t };
}

const inFlight = new Set();

/** Re-verifies, co-signs as fee payer if sponsored, broadcasts and waits for the block. */
async function settlePayment(paymentPayload, requirements, ctx = {}) {
  const network = requirements && requirements.network;
  const v = await verifyPayment(paymentPayload, requirements, ctx);
  if (!v.isValid) return { success: false, errorReason: v.invalidReason, payer: v.payer, transaction: '', network };
  const t = v._tx;
  const r = readRequirements(requirements);
  const hash = '0x' + t.hash();
  if (inFlight.has(hash)) return { success: false, errorReason: 'invalid_exact_neo_payload_already_used', payer: v.payer, transaction: '', network };
  inFlight.add(hash);
  try {
    if (r.feePayer) {
      const fk = ctx.feePayerKey;
      const sig = fk.sign(t.getMessageForSigning(r.net.magic));
      t.witnesses[0].invocationScript = u.HexString.fromHex(neo.invocationScriptFromSignature(sig));
      t.witnesses[0].verificationScript = u.HexString.fromHex(fk.verificationScript);
    }
    const url = ctx.rpcUrl || r.net.rpc;
    try {
      await neo.rpc(url, 'sendrawtransaction', [neo.hexToBase64(t.serialize(true))]);
    } catch (e) {
      return { success: false, errorReason: 'invalid_exact_neo_transaction_rejected', payer: v.payer, transaction: '', network, detail: String(e.message || e) };
    }
    const deadline = Date.now() + (ctx.confirmTimeoutMs || (r.maxTimeoutSeconds + 30) * 1000);
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, ctx.pollMs || 1000));
      const log = await neo.rpc(url, 'getapplicationlog', [hash]).catch(() => null);
      if (!log) continue;
      const ex = log.executions && log.executions[0];
      if (!ex || ex.vmstate !== 'HALT') return { success: false, errorReason: 'invalid_exact_neo_transaction_failed', payer: v.payer, transaction: hash, network };
      if (!hasTransfer(ex.notifications, r.asset, neo.addressToHash(v.payer), r.payTo, r.amount)) {
        return { success: false, errorReason: 'invalid_exact_neo_transfer_not_found', payer: v.payer, transaction: hash, network };
      }
      return { success: true, payer: v.payer, transaction: hash, network, amount: String(r.amount) };
    }
    return { success: false, errorReason: 'settlement_pending', payer: v.payer, transaction: hash, network };
  } finally {
    inFlight.delete(hash);
  }
}

function hasTransfer(notifications, asset, from, to, amount) {
  const le = (h) => Buffer.from(h, 'hex').reverse().toString('base64');
  return (notifications || []).some((n) => {
    if (neo.normHash(n.contract) !== asset || n.eventname !== 'Transfer') return false;
    const [a, b, c] = (n.state && n.state.value) || [];
    return a && b && c && a.value === le(from) && b.value === le(to) && String(c.value) === String(amount);
  });
}

module.exports = { createPaymentPayload, cosignPaymentPayload, verifyPayment, settlePayment, readRequirements, checkAsset, hasTransfer, DEFAULT_LIMITS };
