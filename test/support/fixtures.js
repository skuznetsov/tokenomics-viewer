"use strict";

const os = require("node:os");

function defaultOptions(extra = {}) {
  return {
    source: "all",
    includeArchives: true,
    home: os.homedir(),
    format: "text",
    limitFiles: Number.POSITIVE_INFINITY,
    top: 25,
    openaiContext: "short",
    output: null,
    db: null,
    webserver: false,
    host: "127.0.0.1",
    port: 0,
    progress: false,
    strictJson: false,
    paths: [],
    ...extra,
  };
}

function statsFixture(extra = {}) {
  return {
    requests: 0,
    input: 0,
    cacheCreate5m: 0,
    cacheCreate30m: 0,
    cacheCreate1h: 0,
    cacheRead: 0,
    output: 0,
    reasoningOutput: 0,
    costUsd: 0,
    reasoningCostUsd: 0,
    costsUsd: {
      input: 0,
      cacheCreate5m: 0,
      cacheCreate30m: 0,
      cacheCreate1h: 0,
      cacheRead: 0,
      output: 0,
    },
    pricedRequests: 0,
    unpricedRequests: 0,
    ...extra,
  };
}

function roundCosts(costs) {
  return Object.fromEntries(
    Object.entries(costs).map(([key, value]) => [key, Number(value.toFixed(6))]),
  );
}

function simpleUsage(input = 0, output = 0) {
  return {
    input,
    cacheCreate5m: 0,
    cacheCreate30m: 0,
    cacheCreate1h: 0,
    cacheRead: 0,
    output,
    reasoningOutput: 0,
    inputIncludesCacheRead: false,
  };
}

module.exports = {
  defaultOptions,
  roundCosts,
  simpleUsage,
  statsFixture,
};

