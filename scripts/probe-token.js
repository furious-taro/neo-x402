'use strict';
// Live, read-only check of a NEP-17 token for the `exact` scheme (nothing is signed or sent):
//  - the contract declares NEP-17 and reports its decimals
//  - the canonical sponsored transfer from a holder simulates to HALT/true and emits the Transfer event
//    the facilitator requires, and the system fee it costs
// usage: node scripts/probe-token.js <asset hash> <holder script hash or address> [atomic amount] [rpc]
const { wallet } = require('@cityofzion/neon-js');
const neo = require('../src/neo');
const exact = require('../src/exact');

const [assetArg, holderArg, amountArg, rpcArg] = process.argv.slice(2);
if (!assetArg || !holderArg) {
  console.error('usage: node scripts/probe-token.js <asset hash> <holder hash|address> [atomic amount] [rpc]');
  process.exit(2);
}
const RPC = rpcArg || 'https://mainnet1.neo.coz.io:443';
const asset = neo.normHash(assetArg);
const holder = /^N/.test(holderArg) ? neo.addressToHash(holderArg) : neo.normHash(holderArg);
const amount = BigInt(amountArg || '1');

(async () => {
  const height = (await neo.rpc(RPC, 'getblockcount')) - 1;
  const state = await neo.rpc(RPC, 'getcontractstate', ['0x' + asset]);
  const dec = await neo.rpc(RPC, 'invokefunction', ['0x' + asset, 'decimals', []]);
  const sym = await neo.rpc(RPC, 'invokefunction', ['0x' + asset, 'symbol', []]);
  const decimals = Number(dec.stack[0].value);
  console.log(`block ${height}: ${Buffer.from(sym.stack[0].value, 'base64')} decimals=${decimals} standards=${JSON.stringify(state.manifest.supportedstandards)}`);
  console.log('checkAsset:', (await exact.checkAsset(RPC, asset, decimals)) || 'ok');

  const fac = neo.keyFromWif(wallet.getWIFFromPrivateKey(wallet.generatePrivateKey()));
  const payTo = neo.keyFromWif(wallet.getWIFFromPrivateKey(wallet.generatePrivateKey()));
  const script = neo.transferScript(asset, holder, payTo.scriptHash, amount);
  const signers = [{ account: '0x' + fac.scriptHash, scopes: 'None' }, { account: '0x' + holder, scopes: 'CalledByEntry' }];
  const sim = await neo.rpc(RPC, 'invokescript', [neo.hexToBase64(script), signers]);
  console.log(`simulate transfer of ${neo.fromAtomic(amount, decimals)}: ${sim.state} ${JSON.stringify(sim.stack)} gasconsumed=${sim.gasconsumed} ${sim.exception || ''}`);
  console.log('expected Transfer event emitted:', exact.hasTransfer(sim.notifications, asset, holder, payTo.scriptHash, amount));
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
