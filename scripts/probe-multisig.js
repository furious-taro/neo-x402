#!/usr/bin/env node
'use strict';
// Read-only MainNet check for multi-sig payers: asks a real node what network fee an m-of-n payer's payment costs,
// alone and with a sponsoring fee payer, so facilitators can set maxNetworkFee. Nothing is signed for broadcast.
// Usage: node scripts/probe-multisig.js [rpcUrl]
const crypto = require('node:crypto');
const { tx, u, wallet } = require('@cityofzion/neon-js');
const neo = require('../src/neo');
const { DEFAULT_LIMITS } = require('../src/exact');

const url = process.argv[2] || neo.NETWORKS['neo:860833102'].rpc;
const newKey = () => neo.keyFromWif(wallet.getWIFFromPrivateKey(wallet.generatePrivateKey()));

async function fee(account, sponsor) {
  const merchant = newKey();
  const signers = [];
  const witnesses = [];
  if (sponsor) {
    signers.push({ account: sponsor.scriptHash, scopes: tx.WitnessScope.None });
    witnesses.push({ invocationScript: '', verificationScript: sponsor.verificationScript });
  }
  signers.push({ account: account.scriptHash, scopes: tx.WitnessScope.CalledByEntry });
  witnesses.push({ invocationScript: '', verificationScript: account.verificationScript });
  const height = (await neo.rpc(url, 'getblockcount')) - 1;
  const t = new tx.Transaction({
    version: 0,
    nonce: crypto.randomBytes(4).readUInt32LE(0),
    systemFee: 0,
    networkFee: 0,
    validUntilBlock: height + 20,
    signers,
    attributes: [],
    witnesses,
    script: neo.transferScript(neo.ASSETS.GAS, account.scriptHash, merchant.scriptHash, 100000n),
  });
  const r = await neo.rpc(url, 'calculatenetworkfee', [neo.hexToBase64(t.serialize(true))]);
  return BigInt(r.networkfee);
}

(async () => {
  const sponsor = newKey();
  const rows = [];
  for (const [m, n] of [[1, 1], [1, 2], [2, 3], [3, 5], [5, 7]]) {
    const keys = Array.from({ length: n }, newKey);
    const account = n === 1 ? keys[0] : neo.multisigAccount(m, keys);
    const alone = await fee(account, null);
    const sponsored = await fee(account, sponsor);
    rows.push({ payer: n === 1 ? 'single-sig' : `${m}-of-${n}`, networkFee: neo.fromAtomic(alone, 8), sponsoredNetworkFee: neo.fromAtomic(sponsored, 8), underDefaultSponsorCap: sponsored <= DEFAULT_LIMITS.maxNetworkFee });
  }
  console.table(rows);
  console.log(`default maxNetworkFee for a sponsoring facilitator: ${neo.fromAtomic(DEFAULT_LIMITS.maxNetworkFee, 8)} GAS`);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
