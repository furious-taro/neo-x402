'use strict';
// Shared test fixtures: throwaway keys and a fake Neo N3 node (monkeypatches neo.rpc).
const { wallet, tx, u } = require('@cityofzion/neon-js');
const neo = require('../src/neo');

const NET = 'neo:894710606';
const newKey = () => neo.keyFromWif(wallet.getWIFFromPrivateKey(wallet.generatePrivateKey()));
const payer = newKey();
const facilitatorPrivateKey = wallet.generatePrivateKey();
const facilitator = neo.keyFromWif(facilitatorPrivateKey);
const merchant = newKey();

// ---- a fake Neo node good enough for the scheme ----
function mockChain(over = {}) {
  const state = { height: 1000, balances: { [payer.scriptHash]: 10n ** 9n, [facilitator.scriptHash]: 10n ** 9n }, sent: [], logs: {}, ...over };
  neo.rpc = async (url, method, params) => {
    switch (method) {
      case 'getversion':
        return { protocol: { network: 894710606, msperblock: 3000, maxvaliduntilblockincrement: 5760 } };
      case 'getblockcount':
        return state.height + 1;
      case 'invokescript':
        return { state: 'HALT', gasconsumed: '215925', stack: [{ type: 'Boolean', value: state.transferResult ?? true }] };
      case 'calculatenetworkfee': {
        // like a real node: sized as if every witness carried a 64-byte signature
        const t = tx.Transaction.deserialize(neo.base64ToHex(params[0]));
        t.witnesses.forEach((w) => { w.invocationScript = u.HexString.fromHex('0c40' + '00'.repeat(64)); });
        return { networkfee: String(20 * t.size + 35_000 * t.signers.length) }; // ~mainnet: 245-byte 2-signer tx = 73,108
      }
      case 'getrawtransaction':
        if (state.sent.includes(params[0])) return { hash: params[0] };
        throw new neo.RpcError('Unknown transaction');
      case 'invokefunction':
        return { state: 'HALT', stack: [{ type: 'Integer', value: String(state.balances[params[2][0].value.slice(2)] ?? 0n) }] };
      case 'sendrawtransaction': {
        const t = tx.Transaction.deserialize(neo.base64ToHex(params[0]));
        // the node checks every witness
        t.witnesses.forEach((w, i) => {
          const sig = neo.signatureFromInvocationScript(w.invocationScript.toBigEndian());
          const pub = neo.publicKeyFromVerificationScript(w.verificationScript.toBigEndian());
          if (!sig || !pub || !neo.verifySignature(t.getMessageForSigning(894710606), sig, pub)) throw new neo.RpcError(`bad witness ${i}`);
        });
        const h = '0x' + t.hash();
        if (state.sent.includes(h)) throw new neo.RpcError('AlreadyExists');
        state.sent.push(h);
        state.lastTx = t;
        const le = (x) => Buffer.from(x, 'hex').reverse().toString('base64');
        state.logs[h] = {
          executions: [{
            vmstate: state.vmstate || 'HALT',
            notifications: [{
              contract: neo.ASSETS.GAS,
              eventname: 'Transfer',
              state: { type: 'Array', value: [{ type: 'ByteString', value: le(payer.scriptHash) }, { type: 'ByteString', value: le(merchant.scriptHash) }, { type: 'Integer', value: '100000' }] },
            }],
          }],
        };
        return { hash: h };
      }
      case 'getapplicationlog':
        if (state.logs[params[0]]) return state.logs[params[0]];
        throw new neo.RpcError('Unknown transaction');
      default:
        throw new Error('unmocked ' + method);
    }
  };
  return state;
}

module.exports = { facilitatorPrivateKey, NET, newKey, payer, facilitator, merchant, mockChain };
