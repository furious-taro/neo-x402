'use strict';
// Live end-to-end run on Neo N3 TestNet with real transactions.
//   node scripts/e2e-testnet.js keys.json [sponsored|direct|fund-facilitator]
// keys.json: { "payer": "<WIF>", "facilitator": "<WIF>", "merchant": "<N3 address>" } (TestNet keys only)
// The payer needs TestNet GAS (https://n3t5wish.ngd.network). For `sponsored`, the facilitator needs a little GAS too:
// `fund-facilitator` sends it 2 GAS from the payer using this library (a direct x402 payment to the facilitator).
const fs = require('node:fs');
const http = require('node:http');
const neo = require('../src/neo');
const x = require('../src/http');

const NET = 'neo:894710606';
const [file, mode = 'sponsored'] = process.argv.slice(2);
const k = JSON.parse(fs.readFileSync(file, 'utf8'));
const payer = neo.keyFromWif(k.payer);
const fac = neo.keyFromWif(k.facilitator);
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));

(async () => {
  const bal = async (h) => (await neo.rpc(neo.NETWORKS[NET].rpc, 'invokefunction', [neo.ASSETS.GAS, 'balanceOf', [{ type: 'Hash160', value: '0x' + h }]])).stack[0].value;
  const sponsored = mode === 'sponsored';
  const payTo = mode === 'fund-facilitator' ? fac.address : k.merchant;
  const amount = mode === 'fund-facilitator' ? '200000000' : '100000'; // 2 GAS / 0.001 GAS
  console.log(`mode=${mode} payer=${payer.address} (${await bal(payer.scriptHash)}) facilitator=${fac.address} (${await bal(fac.scriptHash)}) payTo=${payTo}`);

  const requirement = {
    scheme: 'exact', network: NET, amount, asset: neo.ASSETS.GAS, payTo, maxTimeoutSeconds: 60,
    extra: sponsored ? { feePayer: fac.address, feePayerKey: fac.publicKey } : {},
  };
  const facServer = x.createFacilitatorServer(x.localFacilitator({ feePayerWif: k.facilitator }));
  const facUrl = await listen(facServer);
  const gate = x.paywall({ accepts: [requirement], facilitator: x.remoteFacilitator(facUrl), resource: { description: 'neo-x402 testnet demo' } });
  const api = http.createServer((req, res) => gate(req, res, () => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('paid content\n'); }));
  const apiUrl = await listen(api);

  const t0 = Date.now();
  const pfetch = x.payingFetch(payer, { maxAmount: { [neo.ASSETS.GAS]: BigInt(amount) } });
  const res = await pfetch(apiUrl + '/demo');
  const receipt = x.decodePaymentResponse(res);
  console.log('status', res.status, JSON.stringify(await res.text()), `in ${Date.now() - t0} ms`);
  console.log('receipt', JSON.stringify(receipt));
  if (receipt && receipt.transaction) console.log(`explorer: https://dora.coz.io/transaction/neo3/testnet_t5/${receipt.transaction}`);
  console.log(`after: payer ${await bal(payer.scriptHash)} facilitator ${await bal(fac.scriptHash)}`);
  facServer.close();
  api.close();
  process.exit(res.status === 200 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
