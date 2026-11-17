'use strict';
// Exercises createPaymentPayload's live RPC calls (getversion, invokescript with named scopes, getblockcount,
// calculatenetworkfee) on a real node with a throwaway, unfunded key. Only the `invokescript` simulation is redirected
// to a funded address (same transfer, same scopes), so it passes without funds. Nothing is broadcast.
//   node scripts/probe-verify.js <rpc> <funded address> <network id>
const { wallet } = require('@cityofzion/neon-js');
const neo = require('../src/neo');
const exact = require('../src/exact');

const [rpcUrl, funded, network] = process.argv.slice(2);
(async () => {
  const fac = neo.keyFromWif(wallet.getWIFFromPrivateKey(wallet.generatePrivateKey()));
  const payer = neo.keyFromWif(wallet.getWIFFromPrivateKey(wallet.generatePrivateKey()));
  const fundedHash = neo.addressToHash(funded);
  const realRpc = neo.rpc;
  const calls = [];
  neo.rpc = async (url, method, params) => {
    calls.push(method);
    if (method === 'invokescript') {
      const script = neo.transferScript(neo.ASSETS.GAS, fundedHash, fac.scriptHash, 100000n);
      const signers = params[1].map((s) => (s.account === '0x' + payer.scriptHash ? { ...s, account: '0x' + fundedHash } : s));
      console.log('invokescript signers sent:', JSON.stringify(signers));
      return realRpc(url, method, [neo.hexToBase64(script), signers]);
    }
    return realRpc(url, method, params);
  };
  const req = {
    scheme: 'exact', network, amount: '100000', asset: neo.ASSETS.GAS, payTo: fac.address, maxTimeoutSeconds: 60,
    extra: { feePayer: fac.address, feePayerKey: fac.publicKey },
  };
  const p = await exact.createPaymentPayload(req, payer, { rpcUrl });
  const { tx } = require('@cityofzion/neon-js');
  const t = tx.Transaction.deserialize(neo.base64ToHex(p.payload.transaction));
  console.log('live calls:', calls.join(', '));
  console.log(`payload: ${t.size} bytes, systemFee ${t.systemFee}, networkFee ${t.networkFee}, validUntilBlock ${t.validUntilBlock}`);
  // verify runs its offline checks fully (the payer's own simulation would then fail for lack of funds)
  const v = await exact.verifyPayment(p, req, { rpcUrl, feePayerKey: fac });
  console.log('verify with redirected simulation:', v.isValid, v.invalidReason || '', v.detail || '');
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
