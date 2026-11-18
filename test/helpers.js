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

const le64 = (x) => Buffer.from(x, 'hex').reverse().toString('base64');
// Transfer(from, to, amount) notification as a node reports it, for the transfer a canonical script performs
function transferEvent(script, over = {}) {
  const p = neo.parseTransferScript(script);
  if (!p) return [];
  const amount = over.amount ?? p.amount;
  return [{
    contract: '0x' + (over.contract ? neo.normHash(over.contract) : p.asset),
    eventname: 'Transfer',
    state: { type: 'Array', value: [{ type: 'ByteString', value: le64(p.from) }, { type: 'ByteString', value: le64(p.to) }, { type: 'Integer', value: String(amount) }] },
  }];
}

// Contracts the fake node knows. fUSDT and bNEO metadata as read from MainNet.
const CONTRACTS = {
  [neo.normHash(neo.ASSETS.GAS)]: { symbol: 'GAS', decimals: 8, standards: ['NEP-17'] },
  [neo.normHash(neo.ASSETS.NEO)]: { symbol: 'NEO', decimals: 0, standards: ['NEP-17', 'NEP-27'] },
  [neo.normHash(neo.TOKENS.fUSDT.hash)]: { symbol: 'fUSDT', decimals: 6, standards: ['NEP-17'] },
  [neo.normHash(neo.TOKENS.bNEO.hash)]: { symbol: 'bNEO', decimals: 8, standards: ['NEP-17'] },
};

// ---- a fake Neo node good enough for the scheme ----
// state knobs: transferResult (bool returned by transfer), simTransfer / logTransfer ({ amount?, contract? } to
// distort the emitted Transfer event), contracts (extra/overridden contract metadata), vmstate.
function mockChain(over = {}) {
  const state = { height: 1000, balances: { [payer.scriptHash]: 10n ** 9n, [facilitator.scriptHash]: 10n ** 9n }, sent: [], logs: {}, contracts: { ...CONTRACTS }, ...over };
  neo.rpc = async (url, method, params) => {
    switch (method) {
      case 'getversion':
        return { protocol: { network: 894710606, msperblock: 3000, maxvaliduntilblockincrement: 5760 } };
      case 'getblockcount':
        return state.height + 1;
      case 'getcontractstate': {
        const c = state.contracts[neo.normHash(params[0])];
        if (!c) throw new neo.RpcError('Unknown contract');
        return { hash: params[0], manifest: { name: c.symbol, supportedstandards: c.standards } };
      }
      case 'invokescript': {
        const ok = state.transferResult ?? true;
        const notifications = ok ? transferEvent(neo.base64ToHex(params[0]), state.simTransfer) : [];
        return { state: 'HALT', gasconsumed: '215925', stack: [{ type: 'Boolean', value: ok }], notifications };
      }
      case 'calculatenetworkfee': {
        // like a real node: sized as if every witness carried its signatures (m of them for an m-of-n account),
        // plus a verification cost per signature check (n checks for a multi-sig)
        const t = tx.Transaction.deserialize(neo.base64ToHex(params[0]));
        let checks = 0;
        t.witnesses.forEach((w) => {
          const ms = neo.parseMultisigVerificationScript(w.verificationScript.toBigEndian());
          w.invocationScript = u.HexString.fromHex(('0c40' + '00'.repeat(64)).repeat(ms ? ms.threshold : 1));
          checks += ms ? ms.publicKeys.length : 1;
        });
        return { networkfee: String(20 * t.size + 35_000 * checks) }; // ~mainnet: 245-byte 2-signer tx = 73,108
      }
      case 'getrawtransaction':
        if (state.sent.includes(params[0])) return { hash: params[0] };
        throw new neo.RpcError('Unknown transaction');
      case 'invokefunction': {
        const [contract, op, args] = params;
        if (op === 'decimals') return { state: 'HALT', stack: [{ type: 'Integer', value: String(state.contracts[neo.normHash(contract)].decimals) }] };
        if (op !== 'balanceOf' || neo.normHash(contract) !== neo.normHash(neo.ASSETS.GAS)) throw new Error(`unmocked invokefunction ${op}`);
        return { state: 'HALT', stack: [{ type: 'Integer', value: String(state.balances[args[0].value.slice(2)] ?? 0n) }] };
      }
      case 'sendrawtransaction': {
        const t = tx.Transaction.deserialize(neo.base64ToHex(params[0]));
        // the node checks every witness
        t.witnesses.forEach((w, i) => {
          const msg = t.getMessageForSigning(894710606);
          const ms = neo.parseMultisigVerificationScript(w.verificationScript.toBigEndian());
          if (ms) {
            const sigs = neo.signaturesFromInvocationScript(w.invocationScript.toBigEndian());
            if (!neo.verifyMultisig(msg, sigs, ms.publicKeys, ms.threshold)) throw new neo.RpcError(`bad multi-sig witness ${i}`);
            return;
          }
          const sig = neo.signatureFromInvocationScript(w.invocationScript.toBigEndian());
          const pub = neo.publicKeyFromVerificationScript(w.verificationScript.toBigEndian());
          if (!sig || !pub || !neo.verifySignature(msg, sig, pub)) throw new neo.RpcError(`bad witness ${i}`);
        });
        const h = '0x' + t.hash();
        if (state.sent.includes(h)) throw new neo.RpcError('AlreadyExists');
        state.sent.push(h);
        state.lastTx = t;
        state.logs[h] = {
          executions: [{
            vmstate: state.vmstate || 'HALT',
            notifications: transferEvent(t.script.toBigEndian(), state.logTransfer),
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

module.exports = { facilitatorPrivateKey, NET, newKey, payer, facilitator, merchant, mockChain, CONTRACTS };
