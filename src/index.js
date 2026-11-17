'use strict';
const neo = require('./neo');
const exact = require('./exact');
const http = require('./http');

module.exports = {
  // networks, assets, keys
  NETWORKS: neo.NETWORKS,
  ASSETS: neo.ASSETS,
  keyFromWif: neo.keyFromWif,
  // scheme
  createPaymentPayload: exact.createPaymentPayload,
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
};
