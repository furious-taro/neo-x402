'use strict';
const neo = require('./neo');
const exact = require('./exact');
const http = require('./http');
const mcp = require('./mcp');

module.exports = {
  // networks, assets, keys
  NETWORKS: neo.NETWORKS,
  ASSETS: neo.ASSETS,
  TOKENS: neo.TOKENS,
  toAtomic: neo.toAtomic,
  fromAtomic: neo.fromAtomic,
  keyFromWif: neo.keyFromWif,
  multisigAccount: neo.multisigAccount,
  // scheme
  createPaymentPayload: exact.createPaymentPayload,
  cosignPaymentPayload: exact.cosignPaymentPayload,
  verifyPayment: exact.verifyPayment,
  settlePayment: exact.settlePayment,
  DEFAULT_LIMITS: exact.DEFAULT_LIMITS,
  // HTTP transport
  paywall: http.paywall,
  payingFetch: http.payingFetch,
  decodePaymentResponse: http.decodePaymentResponse,
  localFacilitator: http.localFacilitator,
  remoteFacilitator: http.remoteFacilitator,
  createFacilitatorServer: http.createFacilitatorServer,
  // agents (MCP)
  createMcpServer: mcp.createMcpServer,
  parseLimits: mcp.parseLimits,
};
