'use strict';
// Live checks against Neo N3 TestNet, no funds needed:
//  - the node accepts our 2-signer sponsored transaction encoding (calculatenetworkfee parses it)
//  - the canonical transfer script simulates (HALT, true) from a funded account
//  - real fee numbers for setting DEFAULT_LIMITS
const { tx, wallet } = require('@cityofzion/neon-js');
const neo = require('../src/neo');

const RPC = process.argv[2] || 'https://testnet1.neo.coz.io:443';

(async () => {
  const height = (await neo.rpc(RPC, 'getblockcount')) - 1;
  // find a recent transaction sender with GAS to simulate from
  let rich = process.argv[3] ? { address: process.argv[3], hash: neo.addressToHash(process.argv[3]), gas: '?' } : null;
  for (let h = height; h > height - 2000 && !rich; h--) {
    const b = await neo.rpc(RPC, 'getblock', [h, true]);
    for (const t of b.tx) {
      const hash = neo.addressToHash(t.sender);
      const bal = await neo.rpc(RPC, 'invokefunction', [neo.ASSETS.GAS, 'balanceOf', [{ type: 'Hash160', value: '0x' + hash }]]);
      if (BigInt(bal.stack[0].value) > 10n ** 8n) { rich = { address: t.sender, hash, gas: bal.stack[0].value }; break; }
    }
  }
  console.log('height', height, 'funded account', rich && rich.address, rich && rich.gas);

  const fac = neo.keyFromWif(wallet.getWIFFromPrivateKey(wallet.generatePrivateKey()));
  const payTo = neo.keyFromWif(wallet.getWIFFromPrivateKey(wallet.generatePrivateKey()));
  const script = neo.transferScript(neo.ASSETS.GAS, rich.hash, payTo.scriptHash, 100000n);
  const signers = [{ account: fac.scriptHash, scopes: tx.WitnessScope.None }, { account: rich.hash, scopes: tx.WitnessScope.CalledByEntry }];
  const sim = await neo.rpc(RPC, 'invokescript', [neo.hexToBase64(script), signers.map((s) => ({ account: '0x' + s.account, scopes: s.scopes === 0 ? 'None' : 'CalledByEntry' }))]);
  console.log('simulate transfer:', sim.state, JSON.stringify(sim.stack), 'gasconsumed', sim.gasconsumed, sim.exception || '');

  // the payer is a standard account whose key we don't hold: use a dummy key's verification script for sizing
  const dummy = neo.keyFromWif(wallet.getWIFFromPrivateKey(wallet.generatePrivateKey()));
  const t = new tx.Transaction({
    version: 0, nonce: 1, systemFee: sim.gasconsumed, networkFee: 0, validUntilBlock: height + 20,
    signers: [{ account: fac.scriptHash, scopes: tx.WitnessScope.None }, { account: dummy.scriptHash, scopes: tx.WitnessScope.CalledByEntry }],
    attributes: [],
    witnesses: [{ invocationScript: '', verificationScript: fac.verificationScript }, { invocationScript: '', verificationScript: dummy.verificationScript }],
    script: neo.transferScript(neo.ASSETS.GAS, dummy.scriptHash, payTo.scriptHash, 100000n),
  });
  const fee2 = await neo.rpc(RPC, 'calculatenetworkfee', [neo.hexToBase64(t.serialize(true))]);
  console.log('2-signer tx size', t.size, 'networkfee', fee2.networkfee);
  const t1 = new tx.Transaction({ ...t.export(), signers: [t.signers[1]], witnesses: [t.witnesses[1]] });
  const fee1 = await neo.rpc(RPC, 'calculatenetworkfee', [neo.hexToBase64(t1.serialize(true))]);
  console.log('1-signer tx size', t1.size, 'networkfee', fee1.networkfee);
  const pol = await neo.rpc(RPC, 'invokefunction', ['0xcc5e4edd9f5f8dba8bb65734541df7a1c081c67b', 'getFeePerByte', []]);
  console.log('feePerByte', pol.stack[0].value);
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
