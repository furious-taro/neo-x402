'use strict';
// MCP server: protocol handshake, quote, paid fetch within limits, refusal above cap and above budget.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { wallet } = require('@cityofzion/neon-js');
const neo = require('../src/neo');
const x = require('../src/http');
const { createMcpServer, parseLimits } = require('../src/mcp');
const { NET, payer, facilitator, merchant, mockChain, facilitatorPrivateKey } = require('./helpers');

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

async function paidApi(t, amount = '100000') {
  const chain = mockChain();
  const local = x.localFacilitator({ feePayerWif: wallet.getWIFFromPrivateKey(facilitatorPrivateKey) });
  const accepts = [{
    scheme: 'exact', network: NET, amount, asset: neo.ASSETS.GAS, payTo: merchant.address, maxTimeoutSeconds: 60,
    extra: { feePayer: facilitator.address, feePayerKey: facilitator.publicKey },
  }];
  const gate = x.paywall({ accepts, facilitator: local, resource: { description: 'weather' } });
  const api = http.createServer((req, res) => gate(req, res, () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"temp":21}'); }));
  const url = await listen(api);
  t.after(() => api.close());
  return { chain, url };
}

const call = (srv, name, args, id = 1) => srv.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('parseLimits: symbols in decimal units, raw hashes in atomic units', () => {
  const l = parseLimits('GAS=0.01, fUSDT=0.05,0x48c40d4666f93408be1bef038b6722404d9a4c2a=7');
  assert.equal(l[neo.normHash(neo.ASSETS.GAS)], 1000000n);
  assert.equal(l[neo.normHash(neo.TOKENS.fUSDT.hash)], 50000n);
  assert.equal(l['48c40d4666f93408be1bef038b6722404d9a4c2a'], 7n);
  assert.throws(() => parseLimits('DOGE=1'), /unknown token/);
  assert.throws(() => parseLimits('GAS=0.000000001'), /./); // more decimals than GAS has
  assert.throws(() => parseLimits('GAS'), /bad limit/);
});

test('handshake and tool list', async () => {
  const srv = createMcpServer({ key: payer, maxPerRequest: parseLimits('GAS=0.01') });
  const init = await srv.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  assert.equal(init.result.serverInfo.name, 'neo-x402');
  assert.ok(init.result.capabilities.tools);
  assert.equal(await srv.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await srv.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['neo_x402_quote', 'neo_x402_fetch', 'neo_x402_status']);
  const bad = await srv.handle({ jsonrpc: '2.0', id: 2, method: 'nope' });
  assert.equal(bad.error.code, -32601);
});

test('quote shows the price and does not pay', async (t) => {
  const { chain, url } = await paidApi(t);
  const srv = createMcpServer({ key: payer, maxPerRequest: parseLimits('GAS=0.001') });
  const r = (await call(srv, 'neo_x402_quote', { url: url + '/weather' })).result.structuredContent;
  assert.equal(r.status, 402);
  assert.equal(r.options[0].price, '0.001 GAS');
  assert.equal(r.options[0].wouldPay, true);
  assert.equal(chain.sent.length, 0);
});

test('fetch pays within limits, returns body and receipt, and tracks spend', async (t) => {
  const { chain, url } = await paidApi(t);
  const srv = createMcpServer({ key: payer, maxPerRequest: parseLimits('GAS=0.001'), budget: parseLimits('GAS=0.0015') });
  const r = (await call(srv, 'neo_x402_fetch', { url: url + '/weather' })).result.structuredContent;
  assert.equal(r.status, 200);
  assert.equal(r.body, '{"temp":21}');
  assert.equal(r.payment.price, '0.001 GAS');
  assert.equal(r.payment.receipt.success, true);
  assert.equal(chain.sent.length, 1);

  // second request would exceed the 0.0015 GAS budget: not signed, terms returned
  const r2 = (await call(srv, 'neo_x402_fetch', { url: url + '/weather' }, 2)).result.structuredContent;
  assert.equal(r2.status, 402);
  assert.equal(r2.payment, undefined);
  assert.equal(r2.notPaid[0].reason, 'price above the remaining budget');
  assert.equal(chain.sent.length, 1);

  const s = (await call(srv, 'neo_x402_status', {}, 3)).result.structuredContent;
  assert.equal(s.payer, payer.address);
  assert.equal(s.limits[0].spent, '0.001 GAS');
  assert.equal(s.payments.length, 1);
});

test('fetch refuses a price above the per-request cap', async (t) => {
  const { chain, url } = await paidApi(t, '200000');
  const srv = createMcpServer({ key: payer, maxPerRequest: parseLimits('GAS=0.001'), budget: parseLimits('GAS=1') });
  const r = (await call(srv, 'neo_x402_fetch', { url })).result.structuredContent;
  assert.equal(r.status, 402);
  assert.equal(r.notPaid[0].reason, 'price above the per-request cap');
  assert.equal(chain.sent.length, 0);
});

test('non-http URLs are rejected as a tool error', async () => {
  const srv = createMcpServer({ key: payer, maxPerRequest: parseLimits('GAS=0.001') });
  const r = (await call(srv, 'neo_x402_fetch', { url: 'file:///etc/passwd' })).result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /http/);
});

test('stdio binary answers initialize and tools/list', async () => {
  const bin = path.join(__dirname, '..', 'bin', 'neo-x402-mcp.js');
  const child = spawn(process.execPath, [bin], {
    env: { ...process.env, NEO_X402_WIF: wallet.getWIFFromPrivateKey(facilitatorPrivateKey), NEO_X402_MAX: 'GAS=0.01' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  let buf = '';
  const done = new Promise((resolve) => {
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
      if (lines.length >= 2) resolve();
    });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  await done;
  child.kill();
  assert.equal(lines[0].id, 1);
  assert.equal(lines[0].result.serverInfo.name, 'neo-x402');
  assert.equal(lines[1].id, 2);
  assert.equal(lines[1].result.tools.length, 3);
});
