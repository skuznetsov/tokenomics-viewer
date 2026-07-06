#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const Path = require("node:path");
const readline = require("node:readline");
const { Readable } = require("node:stream");
const zlib = require("node:zlib");

const TOKENS_PER_PRICE_UNIT = 1_000_000;
const UNKNOWN_PROJECT = "(unknown project)";
const UNKNOWN_MODEL = "(unknown model)";
const UNKNOWN_EFFORT = "<unknown>";
const AGENT_CODEX = "codex";
const AGENT_CLAUDE_CODE = "claude-code";
const MAX_CENTRAL_DIRECTORY_BYTES = 256 * 1024 * 1024;

const PRICING_SOURCES = {
  openai: "https://developers.openai.com/api/docs/pricing",
  openaiGpt5: "https://developers.openai.com/api/docs/models/gpt-5",
  openaiGpt51: "https://developers.openai.com/api/docs/models/gpt-5.1",
  openaiCodex: "https://developers.openai.com/api/docs/models/gpt-5-codex",
  openaiCodexMini: "https://developers.openai.com/api/docs/models/codex-mini-latest",
  anthropic: "https://docs.anthropic.com/en/docs/about-claude/pricing",
};

// Prices are USD per 1M tokens, copied from the official pricing pages above.
const PRICING = {
  openai: {
    models: {
      "gpt-5.5": {
        short: { input: 5.00, cachedInput: 0.50, output: 30.00 },
        long: { input: 10.00, cachedInput: 1.00, output: 45.00 },
      },
      "gpt-5.5-pro": {
        short: { input: 30.00, cachedInput: null, output: 180.00 },
        long: { input: 60.00, cachedInput: null, output: 270.00 },
      },
      "gpt-5.4": {
        short: { input: 2.50, cachedInput: 0.25, output: 15.00 },
        long: { input: 5.00, cachedInput: 0.50, output: 22.50 },
      },
      "gpt-5.4-mini": {
        short: { input: 0.75, cachedInput: 0.075, output: 4.50 },
      },
      "gpt-5.4-nano": {
        short: { input: 0.20, cachedInput: 0.02, output: 1.25 },
      },
      "gpt-5.4-pro": {
        short: { input: 30.00, cachedInput: null, output: 180.00 },
        long: { input: 60.00, cachedInput: null, output: 270.00 },
      },
      "gpt-5.2": {
        short: { input: 1.75, cachedInput: 0.175, output: 14.00 },
      },
      "gpt-5.1": {
        short: { input: 1.25, cachedInput: 0.125, output: 10.00 },
      },
      "gpt-5.1-chat-latest": {
        short: { input: 1.25, cachedInput: 0.125, output: 10.00 },
      },
      "gpt-5": {
        short: { input: 1.25, cachedInput: 0.125, output: 10.00 },
      },
      "gpt-5-chat-latest": {
        short: { input: 1.25, cachedInput: 0.125, output: 10.00 },
      },
      "gpt-5-mini": {
        short: { input: 0.25, cachedInput: 0.025, output: 2.00 },
      },
      "gpt-5-nano": {
        short: { input: 0.05, cachedInput: 0.005, output: 0.40 },
      },
      "gpt-5.3-codex": {
        short: { input: 1.75, cachedInput: 0.175, output: 14.00 },
      },
      "gpt-5.2-codex": {
        short: { input: 1.75, cachedInput: 0.175, output: 14.00 },
      },
      "gpt-5.1-codex": {
        short: { input: 1.25, cachedInput: 0.125, output: 10.00 },
      },
      "gpt-5.1-codex-max": {
        short: { input: 1.25, cachedInput: 0.125, output: 10.00 },
      },
      "gpt-5-codex": {
        short: { input: 1.25, cachedInput: 0.125, output: 10.00 },
      },
      "gpt-5.1-codex-mini": {
        short: { input: 0.25, cachedInput: 0.025, output: 2.00 },
      },
      "gpt-5-codex-mini": {
        short: { input: 0.25, cachedInput: 0.025, output: 2.00 },
      },
      "codex-mini-latest": {
        short: { input: 1.50, cachedInput: 0.375, output: 6.00 },
      },
      "chat-latest": {
        short: { input: 5.00, cachedInput: 0.50, output: 30.00 },
      },
    },
  },
  anthropic: {
    models: {
      "claude-fable-5": { input: 10.00, cacheCreate5m: 12.50, cacheCreate1h: 20.00, cacheRead: 1.00, output: 50.00 },
      "claude-mythos-5": { input: 10.00, cacheCreate5m: 12.50, cacheCreate1h: 20.00, cacheRead: 1.00, output: 50.00 },
      "claude-opus-4-8": { input: 5.00, cacheCreate5m: 6.25, cacheCreate1h: 10.00, cacheRead: 0.50, output: 25.00 },
      "claude-opus-4-7": { input: 5.00, cacheCreate5m: 6.25, cacheCreate1h: 10.00, cacheRead: 0.50, output: 25.00 },
      "claude-opus-4-6": { input: 5.00, cacheCreate5m: 6.25, cacheCreate1h: 10.00, cacheRead: 0.50, output: 25.00 },
      "claude-opus-4-5": { input: 5.00, cacheCreate5m: 6.25, cacheCreate1h: 10.00, cacheRead: 0.50, output: 25.00 },
      "claude-opus-4-1": { input: 15.00, cacheCreate5m: 18.75, cacheCreate1h: 30.00, cacheRead: 1.50, output: 75.00 },
      "claude-opus-4": { input: 15.00, cacheCreate5m: 18.75, cacheCreate1h: 30.00, cacheRead: 1.50, output: 75.00 },
      "claude-sonnet-5": [
        {
          until: "2026-08-31T23:59:59.999Z",
          prices: { input: 2.00, cacheCreate5m: 2.50, cacheCreate1h: 4.00, cacheRead: 0.20, output: 10.00 },
        },
        {
          from: "2026-09-01T00:00:00.000Z",
          prices: { input: 3.00, cacheCreate5m: 3.75, cacheCreate1h: 6.00, cacheRead: 0.30, output: 15.00 },
        },
      ],
      "claude-sonnet-4-6": { input: 3.00, cacheCreate5m: 3.75, cacheCreate1h: 6.00, cacheRead: 0.30, output: 15.00 },
      "claude-sonnet-4-5": { input: 3.00, cacheCreate5m: 3.75, cacheCreate1h: 6.00, cacheRead: 0.30, output: 15.00 },
      "claude-sonnet-4": { input: 3.00, cacheCreate5m: 3.75, cacheCreate1h: 6.00, cacheRead: 0.30, output: 15.00 },
      "claude-haiku-4-5": { input: 1.00, cacheCreate5m: 1.25, cacheCreate1h: 2.00, cacheRead: 0.10, output: 5.00 },
      "claude-haiku-3-5": { input: 0.80, cacheCreate5m: 1.00, cacheCreate1h: 1.60, cacheRead: 0.08, output: 4.00 },
    },
  },
};

function newStats() {
  return {
    requests: 0,
    input: 0,
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    cacheRead: 0,
    output: 0,
    reasoningOutput: 0,
    costUsd: 0,
    reasoningCostUsd: 0,
    costsUsd: newCostBreakdown(),
    pricedRequests: 0,
    unpricedRequests: 0,
  };
}

function newCostBreakdown() {
  return {
    input: 0,
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    cacheRead: 0,
    output: 0,
  };
}

function newReport() {
  const report = {
    total: newStats(),
    daily: {},
    weekly: {},
    monthly: {},
    yearly: {},
    providers: {},
    models: {},
    providerModels: {},
    projects: {},
    projectModels: {},
    efforts: {},
    modelEfforts: {},
    rateLimits: {
      windows: {},
      daily: {},
      weekly: {},
    },
    unpricedModels: {},
    sessions: [],
    sources: {
      files: 0,
      zipFiles: 0,
      zipEntries: 0,
      parseErrors: 0,
      skippedFiles: 0,
      tokenCountSnapshots: 0,
      skippedTokenCountSnapshots: 0,
    },
  };
  Object.defineProperties(report, {
    _rateLimitSamples: {
      value: [],
      enumerable: false,
    },
    _rateLimitSequence: {
      value: 0,
      enumerable: false,
      writable: true,
    },
    _rateLimitFinalized: {
      value: false,
      enumerable: false,
      writable: true,
    },
  });
  return report;
}

function number(value) {
  return Number.isFinite(value) ? value : 0;
}

function addToStats(target, usage, cost) {
  target.requests += 1;
  target.input += usage.input;
  target.cacheCreate5m += usage.cacheCreate5m;
  target.cacheCreate1h += usage.cacheCreate1h;
  target.cacheRead += usage.cacheRead;
  target.output += usage.output;
  target.reasoningOutput += usage.reasoningOutput;
  target.costUsd += cost.known ? cost.amount : 0;
  target.reasoningCostUsd += cost.known ? cost.reasoningAmount : 0;
  addCostBreakdown(target.costsUsd, cost.breakdown);
  target.pricedRequests += cost.known ? 1 : 0;
  target.unpricedRequests += cost.known ? 0 : 1;
}

function addCostBreakdown(target, source = newCostBreakdown()) {
  target.input += number(source.input);
  target.cacheCreate5m += number(source.cacheCreate5m);
  target.cacheCreate1h += number(source.cacheCreate1h);
  target.cacheRead += number(source.cacheRead);
  target.output += number(source.output);
}

function newRateLimitStats(meta = {}) {
  return {
    agent: meta.agent || null,
    periodType: meta.periodType || null,
    period: meta.period || null,
    limitId: meta.limitId || null,
    limitName: meta.limitName || null,
    planType: meta.planType || null,
    kind: meta.kind || null,
    windowMinutes: meta.windowMinutes || null,
    samples: 0,
    increases: 0,
    resets: 0,
    outOfOrder: 0,
    ignoredNonMonotonic: 0,
    reached: 0,
    percentUsedDelta: 0,
    latestUsedPercent: null,
    latestRemainingPercent: null,
    latestAt: null,
    activeMs: 0,
    resetGapMs: 0,
    maxResetGapMs: 0,
    byEffort: {},
    byModel: {},
    byModelEffort: {},
  };
}

function newRateLimitAttribution() {
  return {
    samples: 0,
    increases: 0,
    percentUsedDelta: 0,
    activeMs: 0,
    input: 0,
    cacheRead: 0,
    output: 0,
    reasoningOutput: 0,
    costUsd: 0,
    reasoningCostUsd: 0,
  };
}

function rateLimitAttributionBucket(root, key) {
  root[key] ??= newRateLimitAttribution();
  return root[key];
}

function nestedRateLimitAttributionBucket(root, key1, key2) {
  root[key1] ??= {};
  root[key1][key2] ??= newRateLimitAttribution();
  return root[key1][key2];
}

function addRateLimitAttribution(target, deltaPercent, elapsedMs, usage, cost) {
  target.increases += 1;
  target.percentUsedDelta += deltaPercent;
  target.activeMs += Math.max(0, elapsedMs);
  target.input += usage.input;
  target.cacheRead += usage.cacheRead;
  target.output += usage.output;
  target.reasoningOutput += usage.reasoningOutput;
  target.costUsd += cost?.known ? cost.amount : 0;
  target.reasoningCostUsd += cost?.known ? cost.reasoningAmount : 0;
}

function addRateLimitSample(target) {
  target.samples += 1;
}

function rateLimitWindowKey(snapshot, kind, window) {
  const limitId = snapshot.limit_id || "unknown-limit";
  const minutes = window.window_minutes ?? "unknown";
  return `${limitId}:${kind}_${minutes}m`;
}

function normalizeAgentType(agent, provider, model) {
  const explicit = String(agent || "").trim().toLowerCase();
  if (explicit) return explicit;
  const normalizedModel = normalizeModel(model);
  if (normalizedModel.startsWith("claude-") || provider === "anthropic") return AGENT_CLAUDE_CODE;
  return AGENT_CODEX;
}

function rateLimitPeriodInfo(sample, periodType) {
  const date = new Date(sample.timestampMs);
  const period = periodType === "daily" ? dateKey(date) : weekKey(date);
  return {
    key: `${sample.agent}/${period}/${sample.key}`,
    period,
  };
}

function touchRateLimitStats(root, key, current, meta) {
  const stats = root[key] ??= newRateLimitStats(meta);
  const modelEffort = nestedRateLimitAttributionBucket(stats.byModelEffort, current.model, current.effort);
  const effortStats = rateLimitAttributionBucket(stats.byEffort, current.effort);
  const modelStats = rateLimitAttributionBucket(stats.byModel, current.model);
  addRateLimitSample(stats);
  addRateLimitSample(effortStats);
  addRateLimitSample(modelStats);
  addRateLimitSample(modelEffort);
  if (current.reached) stats.reached += 1;
  stats.latestUsedPercent = current.usedPercent;
  stats.latestRemainingPercent = Math.max(0, 100 - current.usedPercent);
  stats.latestAt = new Date(current.timestampMs).toISOString();
  return { stats, effortStats, modelStats, modelEffort };
}

function addRateLimitDelta(buckets, deltaPercent, elapsedMs, current) {
  for (const bucket of buckets) {
    bucket.stats.increases += 1;
    bucket.stats.percentUsedDelta += deltaPercent;
    bucket.stats.activeMs += Math.max(0, elapsedMs);
    addRateLimitAttribution(bucket.effortStats, deltaPercent, elapsedMs, current.usage, current.cost);
    addRateLimitAttribution(bucket.modelStats, deltaPercent, elapsedMs, current.usage, current.cost);
    addRateLimitAttribution(bucket.modelEffort, deltaPercent, elapsedMs, current.usage, current.cost);
  }
}

function addRateLimitSnapshot(report, snapshot, meta) {
  if (!snapshot) return;
  const timestampMs = meta.timestamp.getTime();
  if (!Number.isFinite(timestampMs)) return;
  const agent = normalizeAgentType(meta.agent, meta.provider, meta.model);

  for (const [kind, window] of [["primary", snapshot.primary], ["secondary", snapshot.secondary]]) {
    if (!window) continue;

    const key = rateLimitWindowKey(snapshot, kind, window);
    report._rateLimitSamples.push({
      key,
      groupKey: `${agent}/${key}`,
      sequence: report._rateLimitSequence++,
      timestampMs,
      windowMeta: {
        limitId: snapshot.limit_id || null,
        limitName: snapshot.limit_name || null,
        planType: snapshot.plan_type || null,
        kind,
        windowMinutes: window.window_minutes || null,
      },
      usedPercent: number(window.used_percent),
      resetsAt: number(window.resets_at),
      reached: Boolean(snapshot.rate_limit_reached_type),
      agent,
      effort: normalizeEffort(meta.effort),
      model: meta.model || UNKNOWN_MODEL,
      usage: normalizeUsage(meta.usage),
      cost: {
        known: Boolean(meta.cost?.known),
        amount: number(meta.cost?.amount),
        reasoningAmount: number(meta.cost?.reasoningAmount),
      },
    });
  }
  report._rateLimitFinalized = false;
}

function finalizeRateLimits(report) {
  report.rateLimits = { windows: {}, daily: {}, weekly: {} };
  const groups = new Map();
  for (const sample of report._rateLimitSamples) {
    const groupKey = sample.groupKey || sample.key;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(sample);
  }

  for (const [groupKey, samples] of groups) {
    samples.sort((a, b) => {
      const byTime = a.timestampMs - b.timestampMs;
      if (byTime !== 0) return byTime;
      return a.sequence - b.sequence;
    });

    let previous = null;
    for (const current of samples) {
      const daily = rateLimitPeriodInfo(current, "daily");
      const weekly = rateLimitPeriodInfo(current, "weekly");
      const buckets = [
        touchRateLimitStats(report.rateLimits.windows, groupKey, current, {
          ...current.windowMeta,
          agent: current.agent,
        }),
        touchRateLimitStats(report.rateLimits.daily, daily.key, current, {
          ...current.windowMeta,
          agent: current.agent,
          periodType: "daily",
          period: daily.period,
        }),
        touchRateLimitStats(report.rateLimits.weekly, weekly.key, current, {
          ...current.windowMeta,
          agent: current.agent,
          periodType: "weekly",
          period: weekly.period,
        }),
      ];

      if (!previous) {
        previous = current;
        continue;
      }

      if (current.timestampMs < previous.timestampMs) {
        for (const bucket of buckets) bucket.stats.outOfOrder += 1;
        continue;
      }

      const sameWindow = current.resetsAt === previous.resetsAt;
      if (sameWindow && current.resetsAt !== 0 && current.usedPercent < previous.usedPercent) {
        for (const bucket of buckets) bucket.stats.ignoredNonMonotonic += 1;
        continue;
      }

      const elapsedMs = current.timestampMs - previous.timestampMs;
      if (!sameWindow || current.usedPercent < previous.usedPercent) {
        for (const bucket of buckets) {
          bucket.stats.resets += 1;
        }
        if (elapsedMs > 0) {
          for (const bucket of buckets) {
            bucket.stats.resetGapMs += elapsedMs;
            bucket.stats.maxResetGapMs = Math.max(bucket.stats.maxResetGapMs, elapsedMs);
          }
        }
        previous = current;
        continue;
      }

      const deltaPercent = current.usedPercent - previous.usedPercent;
      if (deltaPercent > 0) {
        addRateLimitDelta(buckets, deltaPercent, elapsedMs, current);
      }
      previous = current;
    }
  }
  report._rateLimitFinalized = true;
}

function bucket(root, key) {
  root[key] ??= newStats();
  return root[key];
}

function nestedBucket(root, key1, key2) {
  root[key1] ??= {};
  root[key1][key2] ??= newStats();
  return root[key1][key2];
}

function isValidDate(date) {
  return date instanceof Date && !Number.isNaN(date.getTime());
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function dateKey(date) {
  if (!isValidDate(date)) return "unknown-date";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function monthKey(date) {
  if (!isValidDate(date)) return "unknown-month";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function yearKey(date) {
  if (!isValidDate(date)) return "unknown-year";
  return String(date.getFullYear());
}

function weekKey(date) {
  if (!isValidDate(date)) return "unknown-week";
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${pad2(week)}`;
}

function inferProvider(model, fallback) {
  const value = (model || "").toLowerCase();
  if (value.startsWith("claude-")) return "anthropic";
  if (value.startsWith("gpt-") || value.startsWith("o") || value === "chat-latest") return "openai";
  return fallback || "unknown";
}

function normalizeModel(model) {
  return String(model || UNKNOWN_MODEL).trim().toLowerCase();
}

function lookupAnthropicPrices(model, timestamp) {
  const normalized = normalizeModel(model);
  const names = Object.keys(PRICING.anthropic.models).sort((a, b) => b.length - a.length);
  const key = names.find((name) => normalized === name || normalized.startsWith(`${name}-`));
  if (!key) return null;

  const entry = PRICING.anthropic.models[key];
  if (!Array.isArray(entry)) return entry;

  const ts = isValidDate(timestamp) ? timestamp.getTime() : Date.now();
  for (const timed of entry) {
    const from = timed.from ? Date.parse(timed.from) : Number.NEGATIVE_INFINITY;
    const until = timed.until ? Date.parse(timed.until) : Number.POSITIVE_INFINITY;
    if (ts >= from && ts <= until) return timed.prices;
  }
  return entry[entry.length - 1].prices;
}

function lookupOpenAIPrices(model, usage, options) {
  const normalized = normalizeModel(model);
  const names = Object.keys(PRICING.openai.models).sort((a, b) => b.length - a.length);
  const key = names.find((name) => isOpenAIModelPriceMatch(normalized, name));
  if (!key) return null;
  const entry = PRICING.openai.models[key];

  const mode = options.openaiContext;
  const hasLong = Boolean(entry.long);
  let variant = "short";
  if (mode === "long" && hasLong) {
    variant = "long";
  } else if (mode === "auto" && hasLong) {
    variant = usage.contextWindow > 300_000 || usage.input > 272_000 ? "long" : "short";
  }

  return entry[variant] || entry.short;
}

function isOpenAIModelPriceMatch(normalized, priceKey) {
  if (normalized === priceKey) return true;
  const prefix = `${priceKey}-`;
  if (!normalized.startsWith(prefix)) return false;
  const suffix = normalized.slice(prefix.length);
  return /^\d{4}-\d{2}-\d{2}$/.test(suffix);
}

function calculateCost(provider, model, usage, timestamp, options) {
  const reasoningOutput = Math.min(number(usage.reasoningOutput), number(usage.output));
  if (provider === "anthropic") {
    const prices = lookupAnthropicPrices(model, timestamp);
    if (!prices) return { known: false, amount: 0, breakdown: newCostBreakdown(), reasoningAmount: 0 };
    const breakdown = {
      input: (usage.input * prices.input) / TOKENS_PER_PRICE_UNIT,
      cacheCreate5m: (usage.cacheCreate5m * prices.cacheCreate5m) / TOKENS_PER_PRICE_UNIT,
      cacheCreate1h: (usage.cacheCreate1h * prices.cacheCreate1h) / TOKENS_PER_PRICE_UNIT,
      cacheRead: (usage.cacheRead * prices.cacheRead) / TOKENS_PER_PRICE_UNIT,
      output: (usage.output * prices.output) / TOKENS_PER_PRICE_UNIT,
    };
    return {
      known: true,
      amount: sumCostBreakdown(breakdown),
      breakdown,
      reasoningAmount: (reasoningOutput * prices.output) / TOKENS_PER_PRICE_UNIT,
    };
  }

  if (provider === "openai") {
    const prices = lookupOpenAIPrices(model, usage, options);
    if (!prices) return { known: false, amount: 0, breakdown: newCostBreakdown(), reasoningAmount: 0 };
    const cachedInputPrice = prices.cachedInput ?? prices.input;
    const regularInput = Math.max(0, usage.input - usage.cacheRead);
    const breakdown = {
      input: (regularInput * prices.input) / TOKENS_PER_PRICE_UNIT,
      cacheCreate5m: 0,
      cacheCreate1h: 0,
      cacheRead: (usage.cacheRead * cachedInputPrice) / TOKENS_PER_PRICE_UNIT,
      output: (usage.output * prices.output) / TOKENS_PER_PRICE_UNIT,
    };
    return {
      known: true,
      amount: sumCostBreakdown(breakdown),
      breakdown,
      reasoningAmount: (reasoningOutput * prices.output) / TOKENS_PER_PRICE_UNIT,
    };
  }

  return { known: false, amount: 0, breakdown: newCostBreakdown(), reasoningAmount: 0 };
}

function sumCostBreakdown(breakdown) {
  return (
    number(breakdown.input) +
    number(breakdown.cacheCreate5m) +
    number(breakdown.cacheCreate1h) +
    number(breakdown.cacheRead) +
    number(breakdown.output)
  );
}

function addUsage(report, record, options) {
  const timestamp = isValidDate(record.timestamp) ? record.timestamp : new Date(NaN);
  const project = record.project || UNKNOWN_PROJECT;
  const model = record.model || UNKNOWN_MODEL;
  const provider = record.provider || inferProvider(model);
  const effort = normalizeEffort(record.effort);
  const usage = normalizeUsage(record.usage);
  const cost = calculateCost(provider, model, usage, timestamp, options);

  addToStats(report.total, usage, cost);
  addToStats(bucket(report.daily, dateKey(timestamp)), usage, cost);
  addToStats(bucket(report.weekly, weekKey(timestamp)), usage, cost);
  addToStats(bucket(report.monthly, monthKey(timestamp)), usage, cost);
  addToStats(bucket(report.yearly, yearKey(timestamp)), usage, cost);
  addToStats(bucket(report.providers, provider), usage, cost);
  addToStats(bucket(report.models, model), usage, cost);
  addToStats(bucket(report.providerModels, `${provider}/${model}`), usage, cost);
  addToStats(bucket(report.projects, project), usage, cost);
  addToStats(nestedBucket(report.projectModels, project, model), usage, cost);
  addToStats(bucket(report.efforts, effort), usage, cost);
  addToStats(nestedBucket(report.modelEfforts, model, effort), usage, cost);

  if (!cost.known) {
    const key = `${provider}/${model}`;
    report.unpricedModels[key] ??= { provider, model, requests: 0 };
    report.unpricedModels[key].requests += 1;
  }

  return { timestamp, project, model, provider, effort, usage, cost };
}

function normalizeUsage(usage) {
  const output = number(usage.output);
  const reasoningOutput = Math.min(number(usage.reasoningOutput), output);
  return {
    input: number(usage.input),
    cacheCreate5m: number(usage.cacheCreate5m),
    cacheCreate1h: number(usage.cacheCreate1h),
    cacheRead: number(usage.cacheRead),
    output,
    reasoningOutput,
    contextWindow: number(usage.contextWindow),
  };
}

function normalizeEffort(effort) {
  if (typeof effort !== "string" || effort.trim() === "") return UNKNOWN_EFFORT;
  return effort.trim().toLowerCase();
}

function usageFromCodexTokenUsage(tokenUsage, contextWindow) {
  return {
    input: number(tokenUsage.input_tokens),
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    cacheRead: number(tokenUsage.cached_input_tokens),
    output: number(tokenUsage.output_tokens),
    reasoningOutput: number(tokenUsage.reasoning_output_tokens),
    contextWindow,
  };
}

function subtractUsage(current, previous) {
  if (
    current.input < previous.input ||
    current.cacheCreate5m < previous.cacheCreate5m ||
    current.cacheCreate1h < previous.cacheCreate1h ||
    current.cacheRead < previous.cacheRead ||
    current.output < previous.output ||
    current.reasoningOutput < previous.reasoningOutput
  ) {
    return current;
  }

  return {
    input: Math.max(0, current.input - previous.input),
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    cacheRead: Math.max(0, current.cacheRead - previous.cacheRead),
    output: Math.max(0, current.output - previous.output),
    reasoningOutput: Math.max(0, current.reasoningOutput - previous.reasoningOutput),
    contextWindow: current.contextWindow,
  };
}

function hasUsageTokens(usage) {
  return (
    usage.input > 0 ||
    usage.cacheCreate5m > 0 ||
    usage.cacheCreate1h > 0 ||
    usage.cacheRead > 0 ||
    usage.output > 0 ||
    usage.reasoningOutput > 0
  );
}

function usageFromCodexInfo(info, previousTotalUsage = null) {
  const contextWindow = number(info.model_context_window);
  if (info.total_token_usage) {
    const totalUsage = usageFromCodexTokenUsage(info.total_token_usage, contextWindow);
    return {
      usage: previousTotalUsage ? subtractUsage(totalUsage, previousTotalUsage) : totalUsage,
      totalUsage,
    };
  }

  const last = info.last_token_usage || info;
  return {
    usage: usageFromCodexTokenUsage(last, contextWindow),
    totalUsage: null,
  };
}

function usageFromClaudeUsage(usage) {
  const cacheCreation = usage.cache_creation || {};
  const cacheCreate5m = number(cacheCreation.ephemeral_5m_input_tokens);
  const cacheCreate1h = number(cacheCreation.ephemeral_1h_input_tokens);
  const totalCacheCreate = number(usage.cache_creation_input_tokens);
  const outputDetails = usage.output_tokens_details || usage.output_token_details || usage.output_details || {};

  return {
    input: number(usage.input_tokens),
    cacheCreate5m,
    cacheCreate1h: cacheCreate1h || Math.max(0, totalCacheCreate - cacheCreate5m),
    cacheRead: number(usage.cache_read_input_tokens),
    output: number(usage.output_tokens),
    reasoningOutput: number(outputDetails.thinking_tokens || usage.thinking_tokens),
    contextWindow: 0,
  };
}

function effortFromCodexTurnContext(payload) {
  return normalizeEffort(
    payload?.effort ||
    payload?.collaboration_mode?.settings?.reasoning_effort
  );
}

function createLineProcessor(report, options, sourceLabel, session = null) {
  const codexState = {
    project: UNKNOWN_PROJECT,
    model: UNKNOWN_MODEL,
    provider: "openai",
    effort: UNKNOWN_EFFORT,
    totalUsage: null,
  };
  const seenClaudeRequests = new Set();

  return (line, lineNo) => {
    if (!line.trim()) return;

    let json;
    try {
      json = JSON.parse(line);
    } catch {
      report.sources.parseErrors += 1;
      if (session) session.parseErrors += 1;
      if (options.strictJson) {
        throw new Error(`Invalid JSON in ${sourceLabel}:${lineNo}`);
      }
      return;
    }

    if (session) session.records += 1;

    if (json.type === "session_meta" && json.payload) {
      codexState.project = json.payload.cwd || codexState.project;
      codexState.provider = json.payload.model_provider || codexState.provider;
      codexState.model = json.payload.model || codexState.model;
      return;
    }

    if (json.type === "turn_context" && json.payload) {
      codexState.project = json.payload.cwd || codexState.project;
      codexState.model = json.payload.model || codexState.model;
      codexState.effort = effortFromCodexTurnContext(json.payload);
      return;
    }

    if (json.type === "event_msg" && json.payload?.type === "token_count" && json.payload.info) {
      report.sources.tokenCountSnapshots += 1;
      if (session) session.tokenCountSnapshots += 1;

      const timestamp = new Date(json.timestamp);
      const codexUsage = usageFromCodexInfo(json.payload.info, codexState.totalUsage);
      if (codexUsage.totalUsage) codexState.totalUsage = codexUsage.totalUsage;
      const provider = codexState.provider || "openai";
      const model = codexState.model;
      const effort = codexState.effort;

      if (!hasUsageTokens(codexUsage.usage)) {
        addRateLimitSnapshot(report, json.payload.rate_limits, {
          agent: AGENT_CODEX,
          provider,
          model,
          effort,
          timestamp,
          usage: normalizeUsage(codexUsage.usage),
          cost: { known: true, amount: 0, reasoningAmount: 0 },
        });
        report.sources.skippedTokenCountSnapshots += 1;
        if (session) session.skippedTokenCountSnapshots += 1;
        return;
      }

      const added = addUsage(report, {
        provider,
        model,
        project: codexState.project,
        effort,
        timestamp,
        usage: codexUsage.usage,
      }, options);
      addRateLimitSnapshot(report, json.payload.rate_limits, {
        agent: AGENT_CODEX,
        provider,
        model,
        effort,
        timestamp,
        usage: added.usage,
        cost: added.cost,
      });
      if (session) addToStats(session.stats, added.usage, added.cost);
      return;
    }

    if (json.type === "assistant" && json.message?.usage) {
      const requestKey = json.requestId || json.uuid;
      if (requestKey && seenClaudeRequests.has(requestKey)) return;
      if (requestKey) seenClaudeRequests.add(requestKey);

      const model = json.message.model || UNKNOWN_MODEL;
      const added = addUsage(report, {
        provider: inferProvider(model, "anthropic"),
        model,
        project: json.cwd || UNKNOWN_PROJECT,
        effort: UNKNOWN_EFFORT,
        timestamp: new Date(json.timestamp),
        usage: usageFromClaudeUsage(json.message.usage),
      }, options);
      if (session) addToStats(session.stats, added.usage, added.cost);
    }
  };
}

async function processJsonlFile(filename, report, options) {
  report.sources.files += 1;
  const stat = await fsp.stat(filename);
  const session = startSession(report, options, {
    kind: "jsonl",
    path: filename,
    sizeBytes: stat.size,
  });
  const processor = createLineProcessor(report, options, filename, session);
  const stream = fs.createReadStream(filename, { encoding: "utf8" });
  try {
    await processLineStream(stream, processor, session);
  } finally {
    finishSession(session, options);
  }
}

async function processLineStream(stream, processor, session = null) {
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo += 1;
    if (session) session.lines += 1;
    processor(line, lineNo);
  }
}

async function processZipEntry(zipFile, entry, report, options) {
  report.sources.zipEntries += 1;
  const session = startSession(report, options, {
    kind: "zip-entry",
    path: `${zipFile}:${entry.fileName}`,
    archivePath: zipFile,
    entryName: entry.fileName,
    sizeBytes: entry.uncompressedSize,
    compressedSizeBytes: entry.compressedSize,
  });
  const stream = await openZipEntryStream(zipFile, entry);
  const processor = createLineProcessor(report, options, `${zipFile}:${entry.fileName}`, session);
  try {
    await processLineStream(stream, processor, session);
  } finally {
    finishSession(session, options);
  }
}

async function processZipFile(zipFile, report, options, limiter) {
  report.sources.zipFiles += 1;
  const stat = await fsp.stat(zipFile);
  const entries = (await listZipEntries(zipFile))
    .filter((entry) => entry.fileName.endsWith(".jsonl"))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
  logProgress(options, `[zip] ${zipFile} size=${formatBytes(stat.size)} entries=${formatInt(entries.length)}`);
  for (const entry of entries) {
    if (!limiter.take()) {
      report.sources.skippedFiles += 1;
      continue;
    }
    await processZipEntry(zipFile, entry, report, options);
  }
}

async function listZipEntries(zipFile) {
  const handle = await fsp.open(zipFile, "r");
  try {
    const stat = await handle.stat();
    const eocd = await readZipEndOfCentralDirectory(handle, stat.size);
    if (eocd.centralDirectorySize > MAX_CENTRAL_DIRECTORY_BYTES) {
      throw new Error(`Central directory too large in ${zipFile}: ${eocd.centralDirectorySize} bytes`);
    }

    const centralDirectory = await readAt(handle, eocd.centralDirectorySize, eocd.centralDirectoryOffset);
    return parseCentralDirectory(centralDirectory, eocd.entriesTotal);
  } finally {
    await handle.close();
  }
}

async function openZipEntryStream(zipFile, entry) {
  const handle = await fsp.open(zipFile, "r");
  let localHeader;
  try {
    localHeader = await readZipLocalHeader(handle, entry.localHeaderOffset);
  } finally {
    await handle.close();
  }

  if (entry.compressedSize === 0) {
    return Readable.from([]);
  }

  const compressed = fs.createReadStream(zipFile, {
    start: localHeader.dataOffset,
    end: localHeader.dataOffset + entry.compressedSize - 1,
  });

  if (entry.method === 0) return compressed;
  if (entry.method === 8) return compressed.pipe(zlib.createInflateRaw());
  throw new Error(`Unsupported zip compression method ${entry.method} for ${entry.fileName}`);
}

async function readZipEndOfCentralDirectory(handle, fileSize) {
  const scanSize = Math.min(fileSize, 22 + 0xffff);
  const scanStart = fileSize - scanSize;
  const buffer = await readAt(handle, scanSize, scanStart);

  let eocdOffsetInBuffer = -1;
  for (let pos = buffer.length - 22; pos >= 0; pos -= 1) {
    if (buffer.readUInt32LE(pos) === 0x06054b50) {
      eocdOffsetInBuffer = pos;
      break;
    }
  }

  if (eocdOffsetInBuffer < 0) {
    throw new Error("ZIP end of central directory was not found");
  }

  const eocdOffset = scanStart + eocdOffsetInBuffer;
  const commentLength = buffer.readUInt16LE(eocdOffsetInBuffer + 20);
  const expectedLength = 22 + commentLength;
  if (eocdOffsetInBuffer + expectedLength > buffer.length) {
    throw new Error("Truncated ZIP end of central directory");
  }

  const diskNumber = buffer.readUInt16LE(eocdOffsetInBuffer + 4);
  const centralDirectoryDisk = buffer.readUInt16LE(eocdOffsetInBuffer + 6);
  const entriesDisk = buffer.readUInt16LE(eocdOffsetInBuffer + 8);
  const entriesTotal = buffer.readUInt16LE(eocdOffsetInBuffer + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffsetInBuffer + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffsetInBuffer + 16);

  const needsZip64 =
    entriesDisk === 0xffff ||
    entriesTotal === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff;

  if (!needsZip64) {
    return { entriesTotal, centralDirectorySize, centralDirectoryOffset };
  }

  if (eocdOffset < 20) {
    throw new Error("ZIP64 locator is missing");
  }

  const locator = await readAt(handle, 20, eocdOffset - 20);
  if (locator.readUInt32LE(0) !== 0x07064b50) {
    throw new Error("ZIP64 locator signature was not found");
  }

  const zip64EocdOffset = readUInt64LEAsNumber(locator, 8);
  const zip64Header = await readAt(handle, 56, zip64EocdOffset);
  if (zip64Header.readUInt32LE(0) !== 0x06064b50) {
    throw new Error("ZIP64 end of central directory signature was not found");
  }

  const zip64DiskNumber = zip64Header.readUInt32LE(16);
  const zip64CentralDirectoryDisk = zip64Header.readUInt32LE(20);
  if (diskNumber !== 0xffff && diskNumber !== zip64DiskNumber) {
    throw new Error("Multi-disk ZIP archives are not supported");
  }
  if (centralDirectoryDisk !== 0xffff && centralDirectoryDisk !== zip64CentralDirectoryDisk) {
    throw new Error("Multi-disk ZIP archives are not supported");
  }

  return {
    entriesTotal: readUInt64LEAsNumber(zip64Header, 32),
    centralDirectorySize: readUInt64LEAsNumber(zip64Header, 40),
    centralDirectoryOffset: readUInt64LEAsNumber(zip64Header, 48),
  };
}

function parseCentralDirectory(buffer, expectedEntries) {
  const entries = [];
  let offset = 0;

  while (offset < buffer.length && entries.length < expectedEntries) {
    if (offset + 46 > buffer.length) {
      throw new Error("Truncated ZIP central directory entry");
    }
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Unexpected ZIP central directory signature");
    }

    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    let compressedSize = buffer.readUInt32LE(offset + 20);
    let uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    let localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const variableStart = offset + 46;
    const variableEnd = variableStart + fileNameLength + extraLength + commentLength;

    if (variableEnd > buffer.length) {
      throw new Error("Truncated ZIP central directory variable data");
    }

    const fileName = buffer.toString("utf8", variableStart, variableStart + fileNameLength);
    const extra = buffer.subarray(variableStart + fileNameLength, variableStart + fileNameLength + extraLength);

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      const zip64 = parseZip64Extra(extra, {
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
      compressedSize = zip64.compressedSize;
      uncompressedSize = zip64.uncompressedSize;
      localHeaderOffset = zip64.localHeaderOffset;
    }

    entries.push({ fileName, flags, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset = variableEnd;
  }

  return entries;
}

function parseZip64Extra(extra, values) {
  let offset = 0;
  let {
    compressedSize,
    uncompressedSize,
    localHeaderOffset,
  } = values;

  while (offset + 4 <= extra.length) {
    const headerId = extra.readUInt16LE(offset);
    const dataSize = extra.readUInt16LE(offset + 2);
    const dataStart = offset + 4;
    const dataEnd = dataStart + dataSize;
    if (dataEnd > extra.length) break;

    if (headerId === 0x0001) {
      let pos = dataStart;
      if (uncompressedSize === 0xffffffff) {
        uncompressedSize = readUInt64LEAsNumber(extra, pos);
        pos += 8;
      }
      if (compressedSize === 0xffffffff) {
        compressedSize = readUInt64LEAsNumber(extra, pos);
        pos += 8;
      }
      if (localHeaderOffset === 0xffffffff) {
        localHeaderOffset = readUInt64LEAsNumber(extra, pos);
      }
      return { compressedSize, uncompressedSize, localHeaderOffset };
    }

    offset = dataEnd;
  }

  throw new Error("ZIP64 extra field is missing required size or offset data");
}

async function readZipLocalHeader(handle, localHeaderOffset) {
  const fixed = await readAt(handle, 30, localHeaderOffset);
  if (fixed.readUInt32LE(0) !== 0x04034b50) {
    throw new Error("Unexpected ZIP local file header signature");
  }

  const fileNameLength = fixed.readUInt16LE(26);
  const extraLength = fixed.readUInt16LE(28);
  return {
    dataOffset: localHeaderOffset + 30 + fileNameLength + extraLength,
  };
}

async function readAt(handle, length, position) {
  if (length < 0 || position < 0) {
    throw new Error(`Invalid read: length=${length}, position=${position}`);
  }
  if (length === 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) {
    throw new Error(`Short read: expected ${length}, got ${bytesRead}`);
  }
  return buffer;
}

function readUInt64LEAsNumber(buffer, offset) {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`ZIP value exceeds JavaScript safe integer: ${value.toString()}`);
  }
  return Number(value);
}

async function walkFiles(root, predicate, out = []) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return out;
    throw error;
  }

  for (const entry of entries) {
    const fullPath = Path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(fullPath, predicate, out);
    } else if (entry.isFile() && predicate(fullPath)) {
      out.push(fullPath);
    }
  }
  return out;
}

async function discoverInputs(options) {
  const inputs = [];
  const home = options.home;
  const source = options.source;

  if (options.paths.length > 0) {
    for (const inputPath of options.paths) {
      await addInputPath(Path.resolve(inputPath), inputs, options.includeArchives);
    }
    return sortInputs(inputs);
  }

  if (source === "all" || source === "claude") {
    const claudeRoot = Path.join(home, ".claude", "projects");
    const files = await walkFiles(claudeRoot, (p) => p.endsWith(".jsonl"));
    inputs.push(...files.map((p) => ({ kind: "jsonl", path: p })));
  }

  if (source === "all" || source === "codex") {
    const codexRoot = Path.join(home, ".codex", "sessions");
    const files = await walkFiles(codexRoot, (p) => p.endsWith(".jsonl"));
    inputs.push(...files.map((p) => ({ kind: "jsonl", path: p })));

    if (options.includeArchives) {
      const archivesRoot = Path.join(home, ".codex", "archived_sessions");
      const archives = await walkFiles(archivesRoot, (p) => p.endsWith(".zip"));
      inputs.push(...archives.map((p) => ({ kind: "zip", path: p })));
    }
  }

  return sortInputs(inputs);
}

function sortInputs(inputs) {
  return inputs.sort((a, b) => {
    const byKind = a.kind.localeCompare(b.kind);
    if (byKind !== 0) return byKind;
    return a.path.localeCompare(b.path);
  });
}

async function addInputPath(inputPath, inputs, includeArchives) {
  const stat = await fsp.stat(inputPath);
  if (stat.isDirectory()) {
    const files = await walkFiles(inputPath, (p) => p.endsWith(".jsonl") || (includeArchives && p.endsWith(".zip")));
    for (const file of files) {
      inputs.push({ kind: file.endsWith(".zip") ? "zip" : "jsonl", path: file });
    }
  } else if (inputPath.endsWith(".zip")) {
    if (includeArchives) inputs.push({ kind: "zip", path: inputPath });
  } else if (inputPath.endsWith(".jsonl")) {
    inputs.push({ kind: "jsonl", path: inputPath });
  }
}

function createLimiter(limit) {
  let used = 0;
  return {
    take() {
      if (!Number.isFinite(limit)) return true;
      if (used >= limit) return false;
      used += 1;
      return true;
    },
  };
}

async function buildReport(options) {
  const report = newReport();
  const inputs = await discoverInputs(options);
  const limiter = createLimiter(options.limitFiles);

  for (const input of inputs) {
    if (input.kind === "jsonl") {
      if (!limiter.take()) {
        report.sources.skippedFiles += 1;
        continue;
      }
      await processJsonlFile(input.path, report, options);
    } else if (input.kind === "zip") {
      await processZipFile(input.path, report, options, limiter);
    }
  }

  finalizeRateLimits(report);
  return report;
}

function sortedEntries(data) {
  return Object.entries(data).sort((a, b) => {
    const byCost = b[1].costUsd - a[1].costUsd;
    if (byCost !== 0) return byCost;
    return b[1].input + b[1].cacheRead + b[1].output - (a[1].input + a[1].cacheRead + a[1].output);
  });
}

function formatInt(value) {
  return Math.round(value).toLocaleString("en-US");
}

function formatUsd(value) {
  return `$${value.toFixed(4)}`;
}

function formatRatio(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `${value.toFixed(2)}x`;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : 2;
  return `${size.toFixed(digits)} ${units[unit]}`;
}

function formatDurationMs(ms) {
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(3)}s`;
}

function formatHours(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0.00h";
  return `${(ms / 3_600_000).toFixed(2)}h`;
}

function percentPerHour(percent, ms) {
  const hours = ms / 3_600_000;
  return hours > 0 ? percent / hours : Number.NaN;
}

function formatPercentPerHour(percent, ms) {
  const value = percentPerHour(percent, ms);
  return Number.isFinite(value) ? `${value.toFixed(2)}pp/h` : "n/a";
}

function formatStatsLine(name, stats) {
  const unpriced = stats.unpricedRequests ? `, unpriced=${stats.unpricedRequests}` : "";
  const reasoning = stats.reasoningOutput
    ? `, reasoning_output=${formatInt(stats.reasoningOutput)}, reasoning_cost=${formatUsd(stats.reasoningCostUsd)}, reasoning_cost_share=${formatPercent(stats.reasoningCostUsd / stats.costUsd)}`
    : "";
  return `${name}: requests=${formatInt(stats.requests)}, input=${formatInt(stats.input)}, cache_create_5m=${formatInt(stats.cacheCreate5m)}, cache_create_1h=${formatInt(stats.cacheCreate1h)}, cache_read=${formatInt(stats.cacheRead)}, output=${formatInt(stats.output)}${reasoning}, cost=${formatUsd(stats.costUsd)}, cost_by_type=${formatCostBreakdown(stats.costsUsd)}${unpriced}`;
}

function formatCostBreakdown(costs) {
  return `{input:${formatUsd(costs.input)}, cache_create_5m:${formatUsd(costs.cacheCreate5m)}, cache_create_1h:${formatUsd(costs.cacheCreate1h)}, cache_read:${formatUsd(costs.cacheRead)}, output:${formatUsd(costs.output)}}`;
}

function logProgress(options, message) {
  if (!options.progress) return;
  console.log(message);
}

function startSession(report, options, meta) {
  const session = {
    ...meta,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    lines: 0,
    records: 0,
    parseErrors: 0,
    tokenCountSnapshots: 0,
    skippedTokenCountSnapshots: 0,
    stats: newStats(),
  };
  report.sessions.push(session);

  const size = meta.sizeBytes == null ? "unknown" : formatBytes(meta.sizeBytes);
  const compressed = meta.compressedSizeBytes == null ? "" : ` compressed=${formatBytes(meta.compressedSizeBytes)}`;
  logProgress(options, `[start] ${meta.path} size=${size}${compressed}`);
  session._startedNs = process.hrtime.bigint();
  return session;
}

function finishSession(session, options) {
  const elapsedNs = process.hrtime.bigint() - session._startedNs;
  delete session._startedNs;
  session.finishedAt = new Date().toISOString();
  session.durationMs = Number(elapsedNs) / 1_000_000;

  const codexSnapshots = session.tokenCountSnapshots
    ? `, token_count_snapshots=${formatInt(session.tokenCountSnapshots)}, skipped_snapshots=${formatInt(session.skippedTokenCountSnapshots)}`
    : "";
  logProgress(options, `[done] ${session.path} duration=${formatDurationMs(session.durationMs)}, lines=${formatInt(session.lines)}, records=${formatInt(session.records)}, messages=${formatInt(session.stats.requests)}${codexSnapshots}, parse_errors=${formatInt(session.parseErrors)}, ${formatStatsLine("session", session.stats)}`);
}

function printSection(title, data, top) {
  const lines = [`${title}:`];
  const entries = sortedEntries(data).slice(0, top);
  if (entries.length === 0) {
    lines.push("  (none)");
    return lines.join("\n");
  }
  for (const [name, stats] of entries) {
    lines.push(`  ${formatStatsLine(name, stats)}`);
  }
  return lines.join("\n");
}

function effortRank(name) {
  const order = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra", UNKNOWN_EFFORT];
  const index = order.indexOf(name);
  return index === -1 ? order.length : index;
}

function sortedEffortEntries(data) {
  return Object.entries(data).sort((a, b) => {
    const byRank = effortRank(a[0]) - effortRank(b[0]);
    if (byRank !== 0) return byRank;
    return b[1].costUsd - a[1].costUsd;
  });
}

function averageCost(stats) {
  return stats.requests ? stats.costUsd / stats.requests : Number.NaN;
}

function printEffortSection(title, data, top) {
  const lines = [`${title}:`];
  const entries = sortedEffortEntries(data).slice(0, top);
  if (entries.length === 0) {
    lines.push("  (none)");
    return lines.join("\n");
  }

  const baseline = entries.find(([name, stats]) => name !== UNKNOWN_EFFORT && stats.requests > 0) || entries[0];
  const baselineName = baseline?.[0] || UNKNOWN_EFFORT;
  const baselineAverage = averageCost(baseline?.[1] || newStats());

  for (const [name, stats] of entries) {
    const avg = averageCost(stats);
    const ratio = Number.isFinite(avg) && Number.isFinite(baselineAverage) && baselineAverage > 0
      ? avg / baselineAverage
      : Number.NaN;
    lines.push(`  ${formatStatsLine(name, stats)}, avg_cost=${formatUsd(avg)}, vs_${baselineName}=${formatRatio(ratio)}`);
  }
  return lines.join("\n");
}

function flattenNestedStats(data) {
  const flattened = {};
  for (const [outer, inner] of Object.entries(data)) {
    for (const [innerName, stats] of Object.entries(inner)) {
      flattened[`${outer} / ${innerName}`] = stats;
    }
  }
  return flattened;
}

function sortedRateLimitEntries(data) {
  return Object.entries(data).sort((a, b) => {
    const byDelta = b[1].percentUsedDelta - a[1].percentUsedDelta;
    if (byDelta !== 0) return byDelta;
    return b[1].samples - a[1].samples;
  });
}

function formatRateLimitLine(name, stats) {
  const ignored = stats.ignoredNonMonotonic ? `, ignored_nonmonotonic=${formatInt(stats.ignoredNonMonotonic)}` : "";
  const latest = stats.latestUsedPercent === null ? "" : `, latest_used=${stats.latestUsedPercent.toFixed(2)}%, latest_remaining=${stats.latestRemainingPercent.toFixed(2)}%`;
  return `${name}: samples=${formatInt(stats.samples)}, increases=${formatInt(stats.increases)}, resets=${formatInt(stats.resets)}${ignored}, used_delta=${stats.percentUsedDelta.toFixed(2)}pp${latest}, active=${formatHours(stats.activeMs)}, used_per_hour=${formatPercentPerHour(stats.percentUsedDelta, stats.activeMs)}, reset_gap=${formatHours(stats.resetGapMs)}, max_reset_gap=${formatHours(stats.maxResetGapMs)}`;
}

function formatRateLimitAttributionLine(name, stats) {
  return `${name}: samples=${formatInt(stats.samples)}, increases=${formatInt(stats.increases)}, used_delta=${stats.percentUsedDelta.toFixed(2)}pp, active=${formatHours(stats.activeMs)}, used_per_hour=${formatPercentPerHour(stats.percentUsedDelta, stats.activeMs)}, input=${formatInt(stats.input)}, cache_read=${formatInt(stats.cacheRead)}, output=${formatInt(stats.output)}, reasoning_output=${formatInt(stats.reasoningOutput)}, cost=${formatUsd(stats.costUsd)}`;
}

function formatRateLimitEffortSummary(stats, top) {
  const efforts = sortedRateLimitEntries(stats.byEffort).slice(0, Math.min(top, 4));
  if (efforts.length === 0) return "";
  return `, efforts={${efforts.map(([effort, effortStats]) => `${effort}:${effortStats.percentUsedDelta.toFixed(2)}pp`).join(", ")}}`;
}

function printRateLimitSection(report, top) {
  const lines = ["Rate limits:"];
  const overall = sortedRateLimitEntries(report.rateLimits.windows).slice(0, top);
  if (overall.length === 0) {
    lines.push("  (none)");
    return lines.join("\n");
  }

  lines.push("  Overall:");
  for (const [name, stats] of overall) {
    lines.push(`    ${formatRateLimitLine(name, stats)}`);
    const efforts = sortedRateLimitEntries(stats.byEffort).slice(0, top);
    for (const [effort, effortStats] of efforts) {
      lines.push(`      effort ${formatRateLimitAttributionLine(effort, effortStats)}`);
    }
    const modelEfforts = sortedRateLimitEntries(flattenNestedStats(stats.byModelEffort)).slice(0, top);
    for (const [modelEffort, modelEffortStats] of modelEfforts) {
      lines.push(`      model_effort ${formatRateLimitAttributionLine(modelEffort, modelEffortStats)}`);
    }
  }

  for (const [title, data] of [["By day", report.rateLimits.daily], ["By week", report.rateLimits.weekly]]) {
    lines.push(`  ${title}:`);
    const entries = sortedRateLimitEntries(data).slice(0, top);
    if (entries.length === 0) {
      lines.push("    (none)");
      continue;
    }
    for (const [name, stats] of entries) {
      lines.push(`    ${formatRateLimitLine(name, stats)}${formatRateLimitEffortSummary(stats, top)}`);
    }
  }
  return lines.join("\n");
}

function renderTextReport(report, options) {
  const lines = [];
  lines.push("Tokenomics");
  lines.push(`Sources: files=${formatInt(report.sources.files)}, zip_files=${formatInt(report.sources.zipFiles)}, zip_entries=${formatInt(report.sources.zipEntries)}, skipped=${formatInt(report.sources.skippedFiles)}, token_count_snapshots=${formatInt(report.sources.tokenCountSnapshots)}, skipped_token_count_snapshots=${formatInt(report.sources.skippedTokenCountSnapshots)}, parse_errors=${formatInt(report.sources.parseErrors)}`);
  lines.push(`Pricing sources: OpenAI=${PRICING_SOURCES.openai}; OpenAI models=${PRICING_SOURCES.openaiGpt5}; OpenAI Codex=${PRICING_SOURCES.openaiCodex}; Anthropic=${PRICING_SOURCES.anthropic}`);
  lines.push(`OpenAI context pricing mode: ${options.openaiContext}`);
  lines.push(formatStatsLine("Total", report.total));
  lines.push(printSection("By provider", report.providers, options.top));
  lines.push(printSection("By model", report.models, options.top));
  lines.push(printEffortSection("By effort", report.efforts, options.top));
  lines.push(printSection("By model/effort", flattenNestedStats(report.modelEfforts), options.top));
  lines.push(printRateLimitSection(report, options.top));
  lines.push(printSection("By project", report.projects, options.top));
  lines.push(printSection("Daily", report.daily, options.top));

  const sessions = report.sessions
    .slice()
    .sort((a, b) => b.stats.costUsd - a.stats.costUsd)
    .slice(0, options.top);
  lines.push("Sessions:");
  if (sessions.length === 0) {
    lines.push("  (none)");
  } else {
    for (const session of sessions) {
      const size = session.sizeBytes == null ? "unknown" : formatBytes(session.sizeBytes);
      const codexSnapshots = session.tokenCountSnapshots
        ? `, token_count_snapshots=${formatInt(session.tokenCountSnapshots)}, skipped_snapshots=${formatInt(session.skippedTokenCountSnapshots)}`
        : "";
      lines.push(`  ${session.path}: size=${size}, duration=${formatDurationMs(session.durationMs)}, lines=${formatInt(session.lines)}, records=${formatInt(session.records)}, messages=${formatInt(session.stats.requests)}${codexSnapshots}, parse_errors=${formatInt(session.parseErrors)}, ${formatStatsLine("session", session.stats)}`);
    }
  }

  const unpriced = Object.values(report.unpricedModels).sort((a, b) => b.requests - a.requests);
  if (unpriced.length > 0) {
    lines.push("Unpriced models:");
    for (const item of unpriced.slice(0, options.top)) {
      lines.push(`  ${item.provider}/${item.model}: requests=${formatInt(item.requests)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function renderReport(report, options) {
  if (!report._rateLimitFinalized) finalizeRateLimits(report);
  if (options.format === "json") {
    return `${JSON.stringify(report, null, 2)}\n`;
  }
  return renderTextReport(report, options);
}

async function writeReport(report, options) {
  const rendered = renderReport(report, options);
  if (options.output) {
    await fsp.mkdir(Path.dirname(options.output), { recursive: true });
    await fsp.writeFile(options.output, rendered);
    logProgress(options, `[report] ${options.output} format=${options.format} size=${formatBytes(Buffer.byteLength(rendered))}`);
  } else {
    process.stdout.write(rendered);
  }
}

function parseArgs(argv) {
  const options = {
    source: "all",
    includeArchives: true,
    home: os.homedir(),
    format: "text",
    limitFiles: Number.POSITIVE_INFINITY,
    top: 25,
    openaiContext: "auto",
    strictJson: false,
    output: null,
    progress: true,
    progressExplicit: false,
    paths: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];

    if (arg === "--json") options.format = "json";
    else if (arg === "--strict-json") options.strictJson = true;
    else if (arg === "--no-archives") options.includeArchives = false;
    else if (arg === "--archives") options.includeArchives = true;
    else if (arg === "--source") options.source = next();
    else if (arg.startsWith("--source=")) options.source = arg.slice("--source=".length);
    else if (arg === "--home") options.home = Path.resolve(next());
    else if (arg.startsWith("--home=")) options.home = Path.resolve(arg.slice("--home=".length));
    else if (arg === "--limit-files") options.limitFiles = Number(next());
    else if (arg.startsWith("--limit-files=")) options.limitFiles = Number(arg.slice("--limit-files=".length));
    else if (arg === "--top") options.top = Number(next());
    else if (arg.startsWith("--top=")) options.top = Number(arg.slice("--top=".length));
    else if (arg === "--format") options.format = next();
    else if (arg.startsWith("--format=")) options.format = arg.slice("--format=".length);
    else if (arg === "--output" || arg === "-o") options.output = Path.resolve(next());
    else if (arg.startsWith("--output=")) options.output = Path.resolve(arg.slice("--output=".length));
    else if (arg === "--no-progress") {
      options.progress = false;
      options.progressExplicit = true;
    } else if (arg === "--progress") {
      options.progress = true;
      options.progressExplicit = true;
    }
    else if (arg === "--openai-context") options.openaiContext = next();
    else if (arg.startsWith("--openai-context=")) options.openaiContext = arg.slice("--openai-context=".length);
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      options.paths.push(arg);
    }
  }

  if (!["all", "claude", "codex"].includes(options.source)) {
    throw new Error("--source must be all, claude, or codex");
  }
  if (!["auto", "short", "long"].includes(options.openaiContext)) {
    throw new Error("--openai-context must be auto, short, or long");
  }
  if (!["text", "json"].includes(options.format)) {
    throw new Error("--format must be text or json");
  }
  if (!Number.isFinite(options.top) || options.top <= 0) {
    throw new Error("--top must be a positive number");
  }
  if (Number.isNaN(options.limitFiles) || options.limitFiles <= 0) {
    throw new Error("--limit-files must be a positive number");
  }
  if (options.output && options.format === "text") {
    const ext = Path.extname(options.output).toLowerCase();
    if (ext === ".json") options.format = "json";
  }
  if (!options.output && options.format === "json" && !options.progressExplicit) {
    options.progress = false;
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node app.js [options] [paths...]

Scans Claude Code and Codex JSONL sessions and estimates token costs.

Options:
  --source all|claude|codex       Source roots to scan when paths are omitted (default: all)
  --archives / --no-archives      Include Codex archived_sessions zip files (default: include)
  --home PATH                     Home directory for default roots (default: current user home)
  --openai-context auto|short|long OpenAI short/long context pricing mode (default: auto)
  --limit-files N                 Process at most N JSONL files or zip entries
  --top N                         Rows to show per section (default: 25)
  --format text|json              Final report format (default: text, or inferred from --output .json)
  -o, --output PATH               Write final report to a .txt or .json file
  --progress / --no-progress      Print per-session progress to stdout (default: progress on)
  --json                          Print machine-readable report JSON
  --strict-json                   Fail on malformed JSONL lines
  -h, --help                      Show this help
`);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const report = await buildReport(options);
  await writeReport(report, options);
  return report;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  PRICING,
  PRICING_SOURCES,
  addUsage,
  buildReport,
  calculateCost,
  createLineProcessor,
  discoverInputs,
  finalizeRateLimits,
  main,
  newReport,
  parseArgs,
  processJsonlFile,
  processZipFile,
  renderReport,
  usageFromClaudeUsage,
  usageFromCodexInfo,
  writeReport,
};
