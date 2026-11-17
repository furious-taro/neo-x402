'use strict';
// x402 v2 HTTP transport for the Neo `exact` scheme: resource-server paywall, facilitator server, paying fetch.
const http = require('node:http');
const exact = require('./exact');
const neo = require('./neo');

const b64json = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const unb64json = (s) => JSON.parse(Buffer.from(String(s), 'base64').toString('utf8'));
const MATCH = ['scheme', 'network', 'amount', 'asset', 'payTo'];
const sameReq = (a, b) => MATCH.every((f) => String(a[f]) === String(b[f]));

// ------------------------------------------------------------ facilitator

/**
 * In-process facilitator. feePayerWif is optional: without it only non-sponsored payments are accepted.
 * assets is an optional allowlist of NEP-17 contract hashes; without it any NEP-17 contract is accepted.
 */
function localFacilitator({ feePayerWif, rpcUrls = {}, limits, assets } = {}) {
  const feePayerKey = feePayerWif ? neo.keyFromWif(feePayerWif) : null;
  const ctxFor = (req) => ({ feePayerKey, limits, assets, rpcUrl: rpcUrls[req && req.network] });
  return {
    feePayerKey,
    async verify(paymentPayload, paymentRequirements) {
      const { _tx, ...out } = await exact.verifyPayment(paymentPayload, paymentRequirements, ctxFor(paymentRequirements));
      return out;
    },
    settle: (paymentPayload, paymentRequirements) => exact.settlePayment(paymentPayload, paymentRequirements, ctxFor(paymentRequirements)),
    async supported() {
      const networks = Object.keys(neo.NETWORKS);
      return {
        kinds: networks.map((network) => ({ x402Version: 2, scheme: 'exact', network })),
        extensions: [],
        signers: feePayerKey ? { 'neo:*': [feePayerKey.address] } : {},
      };
    },
  };
}

/** Facilitator reached over HTTP (POST /verify, POST /settle, GET /supported). */
function remoteFacilitator(baseUrl) {
  const post = async (path, paymentPayload, paymentRequirements) => {
    const r = await fetch(new URL(path, baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
    });
    return r.json();
  };
  return {
    verify: (p, q) => post('/verify', p, q),
    settle: (p, q) => post('/settle', p, q),
    supported: async () => (await fetch(new URL('/supported', baseUrl))).json(),
  };
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** node:http server exposing a facilitator. */
function createFacilitatorServer(facilitator) {
  return http.createServer(async (req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      const path = new URL(req.url, 'http://x').pathname;
      if (req.method === 'GET' && path === '/supported') return send(200, await facilitator.supported());
      if (req.method === 'POST' && (path === '/verify' || path === '/settle')) {
        const body = JSON.parse(await readBody(req));
        if (!body || !body.paymentPayload || !body.paymentRequirements) return send(400, { error: 'paymentPayload and paymentRequirements are required' });
        return send(200, await facilitator[path.slice(1)](body.paymentPayload, body.paymentRequirements));
      }
      send(404, { error: 'not found' });
    } catch (e) {
      send(400, { error: String(e.message || e) });
    }
  });
}

// --------------------------------------------------------- resource server

/**
 * Connect/Express-style middleware: (req, res, next).
 * Settles before calling next(), so the resource is only served once the payment is in a block
 * (Neo N3 has single-block finality, about 3 s on MainNet).
 * @param {object} o { accepts: PaymentRequirements[], facilitator, resource: {url?, description?, mimeType?} }
 */
function paywall({ accepts, facilitator, resource = {} }) {
  if (!Array.isArray(accepts) || accepts.length === 0) throw new Error('paywall needs at least one PaymentRequirements');
  return async function x402Paywall(req, res, next) {
    const required = (error) => {
      const body = { x402Version: 2, error, resource: { url: resource.url || req.url, ...resource }, accepts };
      res.writeHead(402, { 'content-type': 'application/json', 'PAYMENT-REQUIRED': b64json(body) });
      res.end(JSON.stringify(body));
    };
    const header = req.headers['payment-signature'];
    if (!header) return required('PAYMENT-SIGNATURE header is required');
    let payload;
    try {
      payload = unb64json(header);
    } catch {
      return required('PAYMENT-SIGNATURE is not base64 JSON');
    }
    const requirement = accepts.find((a) => payload && payload.accepted && sameReq(a, payload.accepted));
    if (!requirement) return required('payment does not match any accepted requirement');
    let settled;
    try {
      settled = await facilitator.settle(payload, requirement);
    } catch (e) {
      return required(`facilitator error: ${e.message || e}`);
    }
    if (!settled || !settled.success) return required(`payment rejected: ${(settled && settled.errorReason) || 'unknown'}`);
    res.setHeader('PAYMENT-RESPONSE', b64json(settled));
    req.x402 = settled;
    return next();
  };
}

// ------------------------------------------------------------------ client

/**
 * Wraps fetch so that a 402 answered with a Neo `exact` requirement is paid automatically.
 * @param {object} key neo.keyFromWif(...) of the paying account
 * @param {object} o { maxAmount: { [assetHash]: bigint|string } (required: spending cap per request), rpcUrls, fetchImpl, onPayment }
 */
function payingFetch(key, { maxAmount, rpcUrls = {}, fetchImpl = fetch, onPayment } = {}) {
  if (!maxAmount || typeof maxAmount !== 'object') throw new Error('payingFetch needs maxAmount: { <asset hash>: <atomic units> }');
  const caps = Object.fromEntries(Object.entries(maxAmount).map(([k, v]) => [neo.normHash(k), BigInt(v)]));
  return async function (input, init = {}) {
    const first = await fetchImpl(input, init);
    if (first.status !== 402) return first;
    let required;
    try {
      const h = first.headers.get('payment-required');
      required = h ? unb64json(h) : await first.clone().json();
    } catch {
      return first;
    }
    const pick = (required.accepts || []).find((a) => {
      if (a.scheme !== 'exact' || !/^neo:/.test(a.network)) return false;
      const cap = caps[neo.normHash(a.asset)];
      return cap !== undefined && BigInt(a.amount) <= cap;
    });
    if (!pick) return first;
    const payload = await exact.createPaymentPayload(pick, key, { rpcUrl: rpcUrls[pick.network], resource: required.resource });
    if (onPayment) onPayment(pick);
    const headers = new Headers(init.headers || {});
    headers.set('PAYMENT-SIGNATURE', b64json(payload));
    const second = await fetchImpl(input, { ...init, headers });
    return second;
  };
}

const decodePaymentResponse = (res) => {
  const h = res.headers.get('payment-response');
  return h ? unb64json(h) : null;
};

module.exports = { localFacilitator, remoteFacilitator, createFacilitatorServer, paywall, payingFetch, decodePaymentResponse, b64json, unb64json };
