'use strict';
// A Model Context Protocol (MCP) server that lets an AI agent call x402-priced HTTP APIs and pay on Neo N3.
// Transport-free core: createMcpServer(...).handle(message) -> response | null. bin/neo-x402-mcp.js wires it to stdio.
//
// Spending is bounded twice: a per-request cap per token, and a total budget per token for the server's lifetime.
// A request whose price is above either limit is not signed; the tool returns the 402 terms instead.
const neo = require('./neo');
const http = require('./http');

const PROTOCOL_VERSION = '2025-06-18';
const MAX_BODY_CHARS = 20000;

// "GAS=0.01,fUSDT=0.05" or "0xd2a4...=1000000" (a raw hash takes atomic units) -> { <hash>: <atomic bigint> }
function parseLimits(spec) {
  const out = {};
  if (!spec) return out;
  for (const part of String(spec).split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^([^=\s]+)\s*=\s*(\S+)$/.exec(part);
    if (!m) throw new Error(`bad limit "${part}" (expected SYMBOL=amount)`);
    const [, name, amount] = m;
    const token = neo.TOKENS[name] || Object.values(neo.TOKENS).find((t) => t.symbol.toLowerCase() === name.toLowerCase());
    if (token) out[neo.normHash(token.hash)] = neo.toAtomic(amount, token.decimals);
    else if (/^(0x)?[0-9a-fA-F]{40}$/.test(name) && /^[0-9]+$/.test(amount)) out[neo.normHash(name)] = BigInt(amount);
    else throw new Error(`unknown token "${name}" (use a symbol from TOKENS or a script hash with atomic units)`);
  }
  return out;
}

function describeAmount(asset, atomic) {
  const token = Object.values(neo.TOKENS).find((t) => neo.normHash(t.hash) === neo.normHash(asset));
  return token ? `${neo.fromAtomic(atomic, token.decimals)} ${token.symbol}` : `${atomic} atomic units of 0x${neo.normHash(asset)}`;
}

const TOOLS = [
  {
    name: 'neo_x402_quote',
    description:
      'Request a URL without paying. If it answers 402 Payment Required, returns the payment options (network, token, ' +
      'price, payTo) and whether this server would pay them under its limits. Use before neo_x402_fetch to see the price.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http(s) URL' }, method: { type: 'string', default: 'GET' } },
      required: ['url'],
    },
  },
  {
    name: 'neo_x402_fetch',
    description:
      'Request a URL and, if it answers 402 Payment Required with a Neo N3 "exact" option within the configured per-request ' +
      'cap and remaining budget, sign the payment and retry. Returns the HTTP status, the response body (truncated) and the ' +
      'settlement receipt with the transaction hash.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL' },
        method: { type: 'string', default: 'GET' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        body: { type: 'string', description: 'request body for POST/PUT' },
      },
      required: ['url'],
    },
  },
  {
    name: 'neo_x402_status',
    description: 'Show the paying address, per-request caps, total budget, and what has been spent so far.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function createMcpServer({ key, maxPerRequest, budget, rpcUrls = {}, fetchImpl = fetch, name = 'neo-x402', version = '0.3.0' }) {
  if (!key) throw new Error('createMcpServer needs a payer key');
  const caps = { ...maxPerRequest };
  const totals = { ...budget };
  if (!Object.keys(caps).length) throw new Error('set at least one per-request cap (e.g. GAS=0.01)');
  for (const h of Object.keys(caps)) if (totals[h] === undefined) totals[h] = caps[h]; // default budget = one request
  const spent = Object.fromEntries(Object.keys(caps).map((h) => [h, 0n]));
  const payments = [];

  const remaining = (h) => totals[h] - spent[h];
  const allowed = () => {
    const m = {};
    for (const h of Object.keys(caps)) {
      const r = remaining(h);
      const lim = caps[h] < r ? caps[h] : r;
      if (lim > 0n) m[h] = lim;
    }
    return m;
  };

  function checkUrl(url) {
    let u;
    try { u = new URL(url); } catch { throw new Error('url must be an absolute http(s) URL'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('url must be http(s)');
    return u.toString();
  }

  async function readRequired(res) {
    try {
      const h = res.headers.get('payment-required');
      return h ? http.unb64json(h) : await res.clone().json();
    } catch { return null; }
  }

  function summarize(required) {
    const lim = allowed();
    return (required?.accepts || []).map((a) => {
      const isNeo = a.scheme === 'exact' && /^neo:/.test(a.network || '');
      let wouldPay = false, reason = 'not a Neo N3 exact option';
      if (isNeo) {
        const h = neo.normHash(a.asset);
        if (caps[h] === undefined) reason = 'token not in the configured caps';
        else if (BigInt(a.amount) > caps[h]) reason = 'price above the per-request cap';
        else if (lim[h] === undefined || BigInt(a.amount) > lim[h]) reason = 'price above the remaining budget';
        else { wouldPay = true; reason = 'within limits'; }
      }
      return {
        network: a.network, scheme: a.scheme, payTo: a.payTo, asset: a.asset, amount: a.amount,
        price: isNeo ? describeAmount(a.asset, BigInt(a.amount)) : undefined, wouldPay, reason,
      };
    });
  }

  async function bodyText(res) {
    const t = await res.text();
    return t.length > MAX_BODY_CHARS ? t.slice(0, MAX_BODY_CHARS) + `\n[truncated ${t.length - MAX_BODY_CHARS} chars]` : t;
  }

  const tools = {
    async neo_x402_quote({ url, method = 'GET' }) {
      const res = await fetchImpl(checkUrl(url), { method });
      if (res.status !== 402) return { status: res.status, paymentRequired: false };
      const required = await readRequired(res);
      return { status: 402, paymentRequired: true, resource: required?.resource, options: summarize(required) };
    },

    async neo_x402_fetch({ url, method = 'GET', headers, body }) {
      const target = checkUrl(url);
      let paid = null;
      const pfetch = http.payingFetch(key, {
        maxAmount: allowed(), rpcUrls, fetchImpl,
        onPayment: (req) => {
          // Count the payment as spent once it is signed: the signature is a bearer instrument from here on.
          const h = neo.normHash(req.asset);
          spent[h] += BigInt(req.amount);
          paid = req;
        },
      });
      const res = await pfetch(target, { method, headers, body });
      const out = { status: res.status };
      if (paid) {
        const receipt = http.decodePaymentResponse(res);
        out.payment = { network: paid.network, payTo: paid.payTo, price: describeAmount(paid.asset, BigInt(paid.amount)), receipt };
        payments.push({ url: target, ...out.payment, at: new Date().toISOString() });
      } else if (res.status === 402) {
        out.notPaid = summarize(await readRequired(res));
      }
      out.body = await bodyText(res);
      return out;
    },

    async neo_x402_status() {
      return {
        payer: key.address,
        limits: Object.keys(caps).map((h) => ({
          asset: '0x' + h,
          perRequest: describeAmount(h, caps[h]),
          budget: describeAmount(h, totals[h]),
          spent: describeAmount(h, spent[h]),
        })),
        payments,
      };
    },
  };

  async function handle(msg) {
    const reply = (result) => (msg.id === undefined ? null : { jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => (msg.id === undefined ? null : { jsonrpc: '2.0', id: msg.id, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'invalid request');
    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: msg.params?.protocolVersion || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const fn = tools[msg.params?.name];
        if (!fn) return fail(-32602, `unknown tool: ${msg.params?.name}`);
        try {
          const result = await fn(msg.params.arguments || {});
          return reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result });
        } catch (e) {
          return reply({ content: [{ type: 'text', text: `error: ${e.message}` }], isError: true });
        }
      }
      default:
        if (msg.method.startsWith('notifications/')) return null;
        return fail(-32601, `method not found: ${msg.method}`);
    }
  }

  return { handle, tools: TOOLS, spent, payments };
}

module.exports = { createMcpServer, parseLimits, TOOLS };
