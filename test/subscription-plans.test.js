"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { detectSubscriptionPlans, rollingProviderUsage } = require("../lib/core/subscription-plans");

function reportWithRateLimits(windows, planHistory = []) {
  return { rateLimits: { windows, daily: {}, weekly: {}, planHistory } };
}

function byProvider(results, provider) {
  return results.find((row) => row.provider === provider);
}

test("rolling provider usage excludes the part of a 15-minute bucket after the anchor", () => {
  const report = reportWithRateLimits({});
  report.quarterHourlyProviderModels = {
    "2026-07-18T11:45Z": { anthropic: { model: { requests: 1, costUsd: 5 } } },
    "2026-07-18T12:00Z": { anthropic: { model: { requests: 1, costUsd: 100 } } },
  };

  const usage = rollingProviderUsage(report, "anthropic", "2026-07-18T12:00:00.000Z");
  assert.equal(usage.costUsd, 5);
});

test("OpenAI protocol plan aliases map to current individual subscription tiers", () => {
  const now = new Date("2026-07-18T12:00:00.000Z");
  for (const [planType, expectedPlanId, expectedLabel, expectedConfidence] of [
    ["plus", "chatgpt-plus", "ChatGPT Plus", "high"],
    ["prolite", "chatgpt-pro-100", "ChatGPT Pro Lite ($100)", "medium"],
    ["pro", "chatgpt-pro-200", "ChatGPT Pro ($200)", "medium"],
  ]) {
    const report = reportWithRateLimits({
      current: { agent: "codex", limitId: "codex", planType, latestAt: "2026-07-18T11:59:00.000Z", samples: 4 },
    });
    const result = byProvider(detectSubscriptionPlans(report, { now }), "openai");
    assert.equal(result.currentPlanId, expectedPlanId);
    assert.equal(result.currentPlanLabel, expectedLabel);
    assert.equal(result.source, "protocol");
    assert.equal(result.confidence, expectedConfidence);
    assert.equal(result.stale, false);
    assert.equal(result.observedPlanType, planType);
  }
});

test("latest OpenAI plan observation wins while historical days remain visible", () => {
  const report = reportWithRateLimits({
    old: { agent: "codex", planType: "plus", latestAt: "2026-07-07T16:30:00.000Z", samples: 20 },
    current: { agent: "codex", planType: "pro", latestAt: "2026-07-18T11:59:00.000Z", samples: 2 },
  }, [
    { date: "2026-07-07", agent: "codex", limitId: "codex", planType: "pro", samples: 306 },
    { date: "2026-07-07", agent: "codex", limitId: "codex", planType: "plus", samples: 42 },
    { date: "2026-07-09", agent: "codex", limitId: "codex", planType: "plus", samples: 1 },
    { date: "2026-07-09", agent: "codex", limitId: "codex", planType: "prolite", samples: 5820 },
    { date: "2026-07-09", agent: "codex", limitId: "codex", planType: "pro", samples: 4063 },
    { date: "2026-07-18", agent: "codex", limitId: "codex", planType: "pro", samples: 200 },
  ]);
  const result = byProvider(detectSubscriptionPlans(report, {
    now: new Date("2026-07-18T12:00:00.000Z"),
  }), "openai");

  assert.equal(result.currentPlanId, "chatgpt-pro-200");
  assert.equal(result.observedAt, "2026-07-18T11:59:00.000Z");
  assert.deepEqual(result.history.map((row) => [row.date, row.mixed, row.signals.map((signal) => signal.planType)]), [
    ["2026-07-18", false, ["pro"]],
    ["2026-07-09", true, ["prolite", "pro", "plus"]],
    ["2026-07-07", true, ["pro", "plus"]],
  ]);
  assert.equal(result.history[1].signals[0].share, 5820 / 9884);
});

test("plan history keeps independent limit scopes instead of majority-merging accounts", () => {
  const report = reportWithRateLimits({}, [
    { date: "2026-06-29", agent: "codex", limitId: "personal", planType: "pro", samples: 100 },
    { date: "2026-06-29", agent: "codex", limitId: "work", planType: "plus", samples: 10 },
  ]);
  const result = byProvider(detectSubscriptionPlans(report, {
    now: new Date("2026-07-18T12:00:00.000Z"),
  }), "openai");

  assert.equal(result.source, "none");
  assert.deepEqual(result.history.map((row) => [row.limitId, row.signals[0].planType]), [
    ["personal", "pro"],
    ["work", "plus"],
  ]);
});

test("simultaneous contradictory latest OpenAI plan signals abstain", () => {
  const report = reportWithRateLimits({
    primary: { agent: "codex", planType: "pro", latestAt: "2026-07-18T11:59:00.000Z", samples: 2 },
    secondary: { agent: "codex", planType: "prolite", latestAt: "2026-07-18T11:59:20.000Z", samples: 2 },
  });
  const result = byProvider(detectSubscriptionPlans(report, {
    now: new Date("2026-07-18T12:00:00.000Z"),
  }), "openai");

  assert.equal(result.currentPlanId, null);
  assert.equal(result.source, "conflict");
  assert.equal(result.conflict, true);
  assert.deepEqual(result.observedPlanTypes, ["pro", "prolite"]);
});

test("old protocol evidence remains last-observed but is marked stale", () => {
  const report = reportWithRateLimits({
    old: { agent: "codex", planType: "plus", latestAt: "2026-06-01T12:00:00.000Z", samples: 2 },
  });
  const result = byProvider(detectSubscriptionPlans(report, {
    now: new Date("2026-07-18T12:00:00.000Z"),
  }), "openai");

  assert.equal(result.currentPlanId, null);
  assert.equal(result.lastObservedPlanId, "chatgpt-plus");
  assert.equal(result.lastObservedPlanLabel, "ChatGPT Plus");
  assert.equal(result.source, "protocol");
  assert.equal(result.stale, true);
  assert.equal(result.confidence, "low");
});

test("providers are detected independently when subscriptions are used concurrently", () => {
  const report = reportWithRateLimits({
    openai: { agent: "codex", planType: "pro", latestAt: "2026-06-29T23:59:00.000Z", samples: 100 },
    claude: { agent: "claude-code", planType: null, latestAt: "2026-06-29T12:00:00.000Z", samples: 44 },
  });
  report.providers = {
    openai: { requests: 13_108 },
    anthropic: { requests: 44 },
  };
  const results = detectSubscriptionPlans(report, { now: new Date("2026-06-30T00:00:00.000Z") });

  assert.equal(byProvider(results, "openai").currentPlanId, "chatgpt-pro-200");
  assert.equal(byProvider(results, "anthropic").source, "none");
});

test("Anthropic abstains even with usage because inactivity and token volume do not identify a plan", () => {
  const report = reportWithRateLimits({});
  report.providers = { anthropic: { requests: 44, input: 22_942, cacheRead: 30_992_070, output: 55_432 } };
  const result = byProvider(detectSubscriptionPlans(report, {
    now: new Date("2026-07-18T12:00:00.000Z"),
  }), "anthropic");

  assert.equal(result.currentPlanId, null);
  assert.equal(result.source, "none");
  assert.match(result.caveat, /inactivity cannot identify/i);
});

function claudeInferenceReport() {
  const report = reportWithRateLimits({});
  report.providerLimitEvents = [
    { timestamp: "2026-06-04T20:15:00.000Z", provider: "anthropic", message: "session limit resets 8pm" },
    { timestamp: "2026-06-11T14:00:00.000Z", provider: "anthropic", message: "session limit resets 12pm" },
    { timestamp: "2026-06-12T20:15:00.000Z", provider: "anthropic", message: "session limit resets 6pm" },
    { timestamp: "2026-07-04T20:45:00.000Z", provider: "anthropic", message: "session limit resets 5pm" },
    { timestamp: "2026-07-05T02:00:00.000Z", provider: "anthropic", message: "session limit resets 10pm" },
    { timestamp: "2026-07-06T21:00:00.000Z", provider: "anthropic", message: "session limit resets 5pm" },
  ];
  const costs = [20, 24, 140, 145, 150, 155];
  report.quarterHourlyProviderModels = {};
  report.providerLimitEvents.forEach((event, index) => {
    const bucket = new Date(Date.parse(event.timestamp) - 15 * 60_000).toISOString().slice(0, 16) + "Z";
    report.quarterHourlyProviderModels[bucket] = {
      anthropic: {
        "claude-opus-4-8": { requests: 10, input: 10, cacheRead: 1_000, output: 20, costUsd: costs[index] },
      },
    };
  });
  return report;
}

test("Claude repeated limit hits infer a guarded Pro to Max 100 timeline", () => {
  const result = byProvider(detectSubscriptionPlans(claudeInferenceReport(), {
    now: new Date("2026-07-10T12:00:00.000Z"),
  }), "anthropic");

  assert.equal(result.source, "inference");
  assert.equal(result.currentPlanId, null);
  assert.equal(result.likelyPlanId, "claude-max-100");
  assert.equal(result.likelyPlanLabel, "Claude Max ($100)");
  assert.equal(result.confidence, "low");
  assert.deepEqual(result.inference.alternativePlanPair, ["claude-max-100", "claude-max-200"]);
  assert.ok(result.inference.capacityRatio > 5);
  assert.deepEqual(result.inference.segments.map((segment) => [segment.planId, segment.from.slice(0, 10), segment.through.slice(0, 10)]), [
    ["claude-pro", "2026-06-04", "2026-06-11"],
    ["claude-max-100", "2026-06-12", "2026-07-06"],
  ]);
  assert.equal(result.inference.downgradeEligibleAt.slice(0, 10), "2026-07-11");
  const lowWeek = result.inference.weeklyPeaks.find((row) => row.week === "2026-W23");
  const highWeek = result.inference.weeklyPeaks.find((row) => row.week === "2026-W24");
  assert.equal(lowWeek.minimumPlanId, "claude-pro");
  assert.equal(highWeek.minimumPlanId, "claude-max-100");
});

test("Claude current tier returns to unknown after an unobserved downgrade boundary", () => {
  const result = byProvider(detectSubscriptionPlans(claudeInferenceReport(), {
    now: new Date("2026-07-18T12:00:00.000Z"),
  }), "anthropic");

  assert.equal(result.source, "inference");
  assert.equal(result.currentPlanId, null);
  assert.equal(result.likelyPlanId, null);
  assert.equal(result.inference.lastInferredPlanId, "claude-max-100");
  assert.equal(result.inference.currentSupported, false);
});

test("a weekly rolling 5h peak confirms the tier even when other days are quiet", () => {
  const report = claudeInferenceReport();
  report.quarterHourlyProviderModels["2026-07-14T12:00Z"] = {
    anthropic: { "claude-opus-4-8": { requests: 10, cacheRead: 1_000, costUsd: 80 } },
  };
  const result = byProvider(detectSubscriptionPlans(report, {
    now: new Date("2026-07-18T12:00:00.000Z"),
  }), "anthropic");

  assert.equal(result.likelyPlanId, "claude-max-100");
  assert.equal(result.inference.currentSupported, true);
  assert.equal(result.inference.observedAt, "2026-07-14T12:15:00.000Z");
  assert.ok(result.inference.segments.at(-1).weeklyPeaks >= 1);
});

test("a quiet weekly peak never confirms or downgrades a higher inferred tier", () => {
  const report = claudeInferenceReport();
  report.quarterHourlyProviderModels["2026-07-14T12:00Z"] = {
    anthropic: { "claude-opus-4-8": { requests: 2, cacheRead: 100, costUsd: 10 } },
  };
  const result = byProvider(detectSubscriptionPlans(report, {
    now: new Date("2026-07-18T12:00:00.000Z"),
  }), "anthropic");

  assert.equal(result.likelyPlanId, null);
  assert.equal(result.inference.lastInferredPlanId, "claude-max-100");
  assert.equal(result.inference.observedAt, "2026-07-06T21:00:00.000Z");
});

test("Claude inference rejects alternating cost clusters without sustained regimes", () => {
  const report = reportWithRateLimits({});
  report.providerLimitEvents = [20, 200, 21, 201].map((costUsd, index) => ({
    timestamp: `2026-06-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
    provider: "anthropic",
    message: `session limit ${index}`,
    costUsd,
  }));
  report.quarterHourlyProviderModels = {};
  report.providerLimitEvents.forEach((event) => {
    const bucket = new Date(Date.parse(event.timestamp) - 15 * 60_000).toISOString().slice(0, 16) + "Z";
    report.quarterHourlyProviderModels[bucket] = {
      anthropic: { model: { requests: 1, costUsd: event.costUsd } },
    };
  });

  const result = byProvider(detectSubscriptionPlans(report, {
    now: new Date("2026-06-10T12:00:00.000Z"),
  }), "anthropic");
  assert.equal(result.source, "none");
});

test("weekly Pro floor before the first limit anchor does not invent a historical Pro segment", () => {
  const report = claudeInferenceReport();
  report.quarterHourlyProviderModels["2026-05-01T12:00Z"] = {
    anthropic: { model: { requests: 1, costUsd: 1 } },
  };
  const result = byProvider(detectSubscriptionPlans(report, {
    now: new Date("2026-07-10T12:00:00.000Z"),
  }), "anthropic");

  assert.equal(result.inference.segments[0].from, "2026-06-04T20:15:00.000Z");
});

test("Claude inference rejects a lower-tier anchor before the monthly downgrade boundary", () => {
  const report = claudeInferenceReport();
  report.providerLimitEvents.splice(3, 0, {
    timestamp: "2026-07-01T12:00:00.000Z",
    provider: "anthropic",
    message: "session limit resets 8am",
  });
  report.quarterHourlyProviderModels["2026-07-01T11:45Z"] = {
    anthropic: { "claude-opus-4-8": { requests: 10, cacheRead: 1_000, costUsd: 22 } },
  };
  const result = byProvider(detectSubscriptionPlans(report, {
    now: new Date("2026-07-10T12:00:00.000Z"),
  }), "anthropic");

  assert.equal(result.likelyPlanId, "claude-max-100");
  assert.equal(result.inference.conflicts.length, 1);
  assert.equal(result.inference.conflicts[0].inferredPlanId, "claude-pro");
  assert.equal(result.inference.conflicts[0].blockedByBillingBoundary.slice(0, 10), "2026-07-11");
});
