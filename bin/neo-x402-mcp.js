#!/usr/bin/env node
'use strict';
// MCP stdio server: lets an AI agent pay x402-priced HTTP APIs on Neo N3, within hard spending limits.
//
// Environment:
//   NEO_X402_WIF         payer key (WIF). Or NEO_X402_KEY_FILE: path to a JSON file with a "wif" field.
//   NEO_X402_MAX         per-request caps, e.g. "GAS=0.01,fUSDT=0.05" (required)
//   NEO_X402_BUDGET      total budget for this server's lifetime, e.g. "GAS=0.5" (default: one request's cap)
//   NEO_X402_RPC_MAINNET / NEO_X402_RPC_TESTNET   optional RPC overrides
//
// Example (Claude Code):
//   claude mcp add neo-x402 -e NEO_X402_KEY_FILE=/path/key.json -e NEO_X402_MAX=GAS=0.01 -e NEO_X402_BUDGET=GAS=0.2 \
//     -- node /path/neo-x402/bin/neo-x402-mcp.js
const fs = require('node:fs');
const readline = require('node:readline');
const neo = require('../src/neo');
const { createMcpServer, parseLimits } = require('../src/mcp');

function loadKey() {
  if (process.env.NEO_X402_WIF) return neo.keyFromWif(process.env.NEO_X402_WIF);
  const file = process.env.NEO_X402_KEY_FILE;
  if (!file) throw new Error('set NEO_X402_WIF or NEO_X402_KEY_FILE');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!j.wif) throw new Error(`${file} has no "wif" field`);
  return neo.keyFromWif(j.wif);
}

function main() {
  const rpcUrls = {};
  if (process.env.NEO_X402_RPC_MAINNET) rpcUrls['neo:860833102'] = process.env.NEO_X402_RPC_MAINNET;
  if (process.env.NEO_X402_RPC_TESTNET) rpcUrls['neo:894710606'] = process.env.NEO_X402_RPC_TESTNET;
  const server = createMcpServer({
    key: loadKey(),
    maxPerRequest: parseLimits(process.env.NEO_X402_MAX),
    budget: parseLimits(process.env.NEO_X402_BUDGET),
    rpcUrls,
  });
  // stdout carries protocol messages only; diagnostics go to stderr.
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
      return;
    }
    const res = await server.handle(msg);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  });
  process.stderr.write('neo-x402 MCP server ready (stdio)\n');
}

try { main(); } catch (e) { process.stderr.write(`neo-x402-mcp: ${e.message}\n`); process.exit(1); }
