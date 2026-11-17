'use strict';
// Low-level Neo N3 helpers: networks, keys, signatures (node:crypto), JSON-RPC.
const crypto = require('node:crypto');
const { wallet, sc, u } = require('@cityofzion/neon-js');

const NETWORKS = {
  'neo:860833102': { name: 'mainnet', magic: 860833102, rpc: 'https://mainnet1.neo.coz.io:443', msPerBlock: 3000 },
  'neo:894710606': { name: 'testnet', magic: 894710606, rpc: 'https://testnet1.neo.coz.io:443', msPerBlock: 3000 },
};

// Native contract hashes (identical on every Neo N3 network).
const ASSETS = {
  GAS: '0xd2a4cff31913016155e38e474a2c06d08be276cf',
  NEO: '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5',
};

function parseNetwork(id) {
  const m = /^neo:(0|[1-9][0-9]{0,9})$/.exec(String(id));
  if (!m) throw new Error(`not a Neo CAIP-2 network id: ${id}`);
  const magic = Number(m[1]);
  if (magic > 0xffffffff) throw new Error(`network magic out of range: ${id}`);
  return { magic, ...(NETWORKS[id] || {}) };
}

// '0x'-prefixed big-endian script hash -> 40 hex chars, lowercase, no prefix.
function normHash(h) {
  const s = String(h).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(s)) throw new Error(`bad script hash: ${h}`);
  return s;
}

function addressToHash(address) {
  if (!wallet.isAddress(address)) throw new Error(`bad Neo N3 address: ${address}`);
  return wallet.getScriptHashFromAddress(address);
}
const hashToAddress = (h) => wallet.getAddressFromScriptHash(normHash(h));

// ---- keys and ECDSA P-256 / SHA-256 signatures via node:crypto ----
const SPKI_P256_COMPRESSED = Buffer.from('3039301306072a8648ce3d020106082a8648ce3d030107032200', 'hex');
const PKCS8_P256_PREFIX = Buffer.from('3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420', 'hex');

function publicKeyObject(pubHex) {
  const pub = Buffer.from(pubHex, 'hex');
  if (pub.length !== 33 || (pub[0] !== 2 && pub[0] !== 3)) throw new Error('expected a 33-byte compressed public key');
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_P256_COMPRESSED, pub]), format: 'der', type: 'spki' });
}

function privateKeyObject(privHex) {
  const d = Buffer.from(privHex, 'hex');
  if (d.length !== 32) throw new Error('expected a 32-byte private key');
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_P256_PREFIX, d]), format: 'der', type: 'pkcs8' });
}

/** Wraps a WIF (or raw hex private key) into a signer: { address, scriptHash, publicKey, verificationScript, sign(msgHex) }. */
function keyFromWif(wifOrHex) {
  const priv = wallet.isWIF(wifOrHex) ? wallet.getPrivateKeyFromWIF(wifOrHex) : wifOrHex;
  const key = privateKeyObject(priv);
  const publicKey = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' });
  // SPKI for P-256 ends with the 65-byte uncompressed point; compress it.
  const point = publicKey.subarray(publicKey.length - 65);
  const compressed = Buffer.concat([Buffer.from([point[64] & 1 ? 3 : 2]), point.subarray(1, 33)]).toString('hex');
  const verificationScript = wallet.getVerificationScriptFromPublicKey(compressed);
  const scriptHash = wallet.getScriptHashFromVerificationScript(verificationScript);
  return {
    address: wallet.getAddressFromScriptHash(scriptHash),
    scriptHash,
    publicKey: compressed,
    verificationScript,
    /** Signs sha256(message) and returns the 64-byte r||s signature as hex. */
    sign(messageHex) {
      return crypto.sign('sha256', Buffer.from(messageHex, 'hex'), { key, dsaEncoding: 'ieee-p1363' }).toString('hex');
    },
  };
}

function verifySignature(messageHex, sigHex, pubHex) {
  const sig = Buffer.from(sigHex, 'hex');
  if (sig.length !== 64) return false;
  try {
    return crypto.verify('sha256', Buffer.from(messageHex, 'hex'), { key: publicKeyObject(pubHex), dsaEncoding: 'ieee-p1363' }, sig);
  } catch {
    return false;
  }
}

// Standard single-signature contract: PUSHDATA1 <33-byte key> SYSCALL System.Crypto.CheckSig
const CHECKSIG_RE = /^0c21(0[23][0-9a-f]{64})4156e7b327$/;
function publicKeyFromVerificationScript(scriptHex) {
  const m = CHECKSIG_RE.exec(String(scriptHex).toLowerCase());
  return m ? m[1] : null;
}
// Invocation script holding one signature: PUSHDATA1 0x40 <64 bytes>
const SIG_INVOCATION_RE = /^0c40([0-9a-f]{128})$/;
function signatureFromInvocationScript(scriptHex) {
  const m = SIG_INVOCATION_RE.exec(String(scriptHex).toLowerCase());
  return m ? m[1] : null;
}
const invocationScriptFromSignature = (sigHex) => '0c40' + sigHex;

/** The only script the `exact` scheme accepts: asset.transfer(from, to, amount, null) with CallFlags.All. */
function transferScript(assetHash, fromHash, toHash, amount) {
  return sc.createScript({
    scriptHash: normHash(assetHash),
    operation: 'transfer',
    args: [
      sc.ContractParam.hash160(normHash(fromHash)),
      sc.ContractParam.hash160(normHash(toHash)),
      sc.ContractParam.integer(String(amount)),
      sc.ContractParam.any(null),
    ],
  });
}

// ---- JSON-RPC ----
class RpcError extends Error {}
async function rpc(url, method, params = [], { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    const body = await res.json();
    if (body.error) throw new RpcError(`${method}: ${body.error.message || JSON.stringify(body.error)}`);
    return body.result;
  } finally {
    clearTimeout(t);
  }
}

const hexToBase64 = (h) => Buffer.from(h, 'hex').toString('base64');
const base64ToHex = (b) => Buffer.from(b, 'base64').toString('hex');

module.exports = {
  NETWORKS, ASSETS, parseNetwork, normHash, addressToHash, hashToAddress,
  keyFromWif, verifySignature, publicKeyFromVerificationScript, signatureFromInvocationScript,
  invocationScriptFromSignature, transferScript, rpc, RpcError, hexToBase64, base64ToHex, u,
};
