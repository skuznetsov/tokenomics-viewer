"use strict";

const {
  isValidDate,
  newCostBreakdown,
  normalizeModel,
  number,
} = require("./report-model");
const { normalizeUsage } = require("./usage");

const TOKENS_PER_PRICE_UNIT = 1_000_000;

const PRICING_SOURCES = {
  openai: "https://developers.openai.com/api/docs/pricing",
  openaiGpt56: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
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
      "gpt-5.6-sol": {
        short: { input: 5.00, cacheCreate30m: 6.25, cachedInput: 0.50, output: 30.00 },
        long: { input: 10.00, cacheCreate30m: 12.50, cachedInput: 1.00, output: 45.00 },
      },
      "gpt-5.6-terra": {
        short: { input: 2.50, cacheCreate30m: 3.125, cachedInput: 0.25, output: 15.00 },
        long: { input: 5.00, cacheCreate30m: 6.25, cachedInput: 0.50, output: 22.50 },
      },
      "gpt-5.6-luna": {
        short: { input: 1.00, cacheCreate30m: 1.25, cachedInput: 0.10, output: 6.00 },
        long: { input: 2.00, cacheCreate30m: 2.50, cachedInput: 0.20, output: 9.00 },
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

function lookupOpenAIPrices(model, usage, options = {}) {
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
    variant = openAIInputTokensForLongPricing(usage) > 272_000 ? "long" : "short";
  }

  return entry[variant] || entry.short;
}

function openAIInputTokensForLongPricing(usage) {
  return number(usage.input) + number(usage.cacheCreate5m) + number(usage.cacheCreate30m) + number(usage.cacheCreate1h) + number(usage.cacheRead);
}

function isOpenAIModelPriceMatch(normalized, priceKey) {
  if (normalized === priceKey) return true;
  const prefix = `${priceKey}-`;
  if (!normalized.startsWith(prefix)) return false;
  const suffix = normalized.slice(prefix.length);
  return /^\d{4}-\d{2}-\d{2}$/.test(suffix);
}

function calculateCost(provider, model, usage, timestamp, options = {}) {
  const normalizedUsage = normalizeUsage(usage);
  const reasoningOutput = Math.min(number(normalizedUsage.reasoningOutput), number(normalizedUsage.output));
  if (provider === "anthropic") {
    const prices = lookupAnthropicPrices(model, timestamp);
    if (!prices) return { known: false, amount: 0, breakdown: newCostBreakdown(), reasoningAmount: 0 };
    const breakdown = {
      input: (normalizedUsage.input * prices.input) / TOKENS_PER_PRICE_UNIT,
      cacheCreate5m: (normalizedUsage.cacheCreate5m * prices.cacheCreate5m) / TOKENS_PER_PRICE_UNIT,
      cacheCreate30m: 0,
      cacheCreate1h: (normalizedUsage.cacheCreate1h * prices.cacheCreate1h) / TOKENS_PER_PRICE_UNIT,
      cacheRead: (normalizedUsage.cacheRead * prices.cacheRead) / TOKENS_PER_PRICE_UNIT,
      output: (normalizedUsage.output * prices.output) / TOKENS_PER_PRICE_UNIT,
    };
    return {
      known: true,
      amount: sumCostBreakdown(breakdown),
      breakdown,
      reasoningAmount: (reasoningOutput * prices.output) / TOKENS_PER_PRICE_UNIT,
    };
  }

  if (provider === "openai") {
    const prices = lookupOpenAIPrices(model, normalizedUsage, options);
    if (!prices) return { known: false, amount: 0, breakdown: newCostBreakdown(), reasoningAmount: 0 };
    const cachedInputPrice = prices.cachedInput ?? prices.input;
    const breakdown = {
      input: (normalizedUsage.input * prices.input) / TOKENS_PER_PRICE_UNIT,
      cacheCreate5m: 0,
      cacheCreate30m: (normalizedUsage.cacheCreate30m * number(prices.cacheCreate30m)) / TOKENS_PER_PRICE_UNIT,
      cacheCreate1h: 0,
      cacheRead: (normalizedUsage.cacheRead * cachedInputPrice) / TOKENS_PER_PRICE_UNIT,
      output: (normalizedUsage.output * prices.output) / TOKENS_PER_PRICE_UNIT,
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
    number(breakdown.cacheCreate30m) +
    number(breakdown.cacheCreate1h) +
    number(breakdown.cacheRead) +
    number(breakdown.output)
  );
}

module.exports = {
  PRICING,
  PRICING_SOURCES,
  TOKENS_PER_PRICE_UNIT,
  calculateCost,
  isOpenAIModelPriceMatch,
  lookupAnthropicPrices,
  lookupOpenAIPrices,
  openAIInputTokensForLongPricing,
  sumCostBreakdown,
};
