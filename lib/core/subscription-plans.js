"use strict";

const { weekKey } = require("./report-model");

const PLAN_SIGNAL_CONFLICT_MS = 60_000;
const PLAN_SIGNAL_FRESH_MS = 14 * 24 * 60 * 60 * 1_000;

const PROVIDER_PLAN_CATALOG = Object.freeze({
  openai: Object.freeze({
    "chatgpt-plus": Object.freeze({ label: "ChatGPT Plus", monthlyUsd: 20, capacityMultiple: 1 }),
    "chatgpt-pro-100": Object.freeze({ label: "ChatGPT Pro Lite ($100)", monthlyUsd: 100, capacityMultiple: 5 }),
    "chatgpt-pro-200": Object.freeze({ label: "ChatGPT Pro ($200)", monthlyUsd: 200, capacityMultiple: 20 }),
  }),
  anthropic: Object.freeze({
    "claude-pro": Object.freeze({ label: "Claude Pro", monthlyUsd: 20, capacityMultiple: 1 }),
    "claude-max-100": Object.freeze({ label: "Claude Max ($100)", monthlyUsd: 100, capacityMultiple: 5 }),
    "claude-max-200": Object.freeze({ label: "Claude Max ($200)", monthlyUsd: 200, capacityMultiple: 20 }),
  }),
});

const OPENAI_PROTOCOL_PLANS = Object.freeze({
  plus: Object.freeze({ planId: "chatgpt-plus", confidence: "high" }),
  prolite: Object.freeze({ planId: "chatgpt-pro-100", confidence: "medium" }),
  pro: Object.freeze({ planId: "chatgpt-pro-200", confidence: "medium" }),
});

function providerForAgent(agent) {
  if (agent === "codex") return "openai";
  if (agent === "claude-code") return "anthropic";
  return null;
}

function mappedPlan(provider, planType) {
  if (provider !== "openai") return null;
  return OPENAI_PROTOCOL_PLANS[String(planType || "").trim().toLowerCase()] || null;
}

function currentProtocolDetection(report, provider, now) {
  const observations = Object.values(report?.rateLimits?.windows || {})
    .filter((stats) => providerForAgent(stats?.agent) === provider && String(stats.planType || "").trim())
    .map((stats) => ({
      planType: String(stats.planType).trim().toLowerCase(),
      observedAt: String(stats.latestAt || ""),
      observedAtMs: Date.parse(stats.latestAt || ""),
      samples: Number(stats.samples) || 0,
      limitId: stats.limitId || null,
      windowMinutes: Number(stats.windowMinutes) || null,
    }))
    .filter((row) => Number.isFinite(row.observedAtMs));
  if (!observations.length) return null;

  const latestAtMs = Math.max(...observations.map((row) => row.observedAtMs));
  const latest = observations.filter((row) => latestAtMs - row.observedAtMs <= PLAN_SIGNAL_CONFLICT_MS);
  const planTypes = [...new Set(latest.map((row) => row.planType))].sort();
  const observedAt = new Date(latestAtMs).toISOString();
  const stale = now.getTime() - latestAtMs > PLAN_SIGNAL_FRESH_MS;
  const evidence = [{
    kind: "provider-plan-type",
    observedAt,
    planTypes,
    samples: latest.reduce((sum, row) => sum + row.samples, 0),
    limitIds: [...new Set(latest.map((row) => row.limitId).filter(Boolean))].sort(),
    windowMinutes: [...new Set(latest.map((row) => row.windowMinutes).filter(Boolean))].sort((a, b) => a - b),
  }];
  if (planTypes.length !== 1) {
    return { planId: null, confidence: "none", conflict: true, observedAt, observedPlanType: null, observedPlanTypes: planTypes, stale, evidence };
  }
  const observedPlanType = planTypes[0];
  const mapping = mappedPlan(provider, observedPlanType);
  if (!mapping) {
    return { planId: null, confidence: "none", conflict: false, observedAt, observedPlanType, observedPlanTypes: planTypes, stale, evidence, unsupported: true };
  }
  return {
    planId: mapping.planId,
    confidence: stale ? "low" : mapping.confidence,
    conflict: false,
    observedAt,
    observedPlanType,
    observedPlanTypes: planTypes,
    stale,
    evidence,
  };
}

function planHistory(report, provider) {
  const grouped = new Map();
  for (const row of report?.rateLimits?.planHistory || []) {
    if (providerForAgent(row?.agent) !== provider) continue;
    const date = String(row.date || "");
    const planType = String(row.planType || "").trim().toLowerCase();
    if (!date || !planType) continue;
    const limitId = row.limitId || "default";
    const key = `${date}\0${limitId}`;
    const group = grouped.get(key) || { date, limitId: row.limitId || null, samples: 0, signals: [] };
    const mapping = mappedPlan(provider, planType);
    const samples = Number(row.samples) || 0;
    group.samples += samples;
    group.signals.push({
      planType,
      planId: mapping?.planId || null,
      planLabel: mapping ? PROVIDER_PLAN_CATALOG[provider][mapping.planId].label : null,
      samples,
      firstObservedAt: row.firstObservedAt || null,
      lastObservedAt: row.lastObservedAt || null,
      supported: Boolean(mapping),
    });
    grouped.set(key, group);
  }
  return [...grouped.values()]
    .map((group) => ({
      ...group,
      mixed: group.signals.length > 1,
      signals: group.signals
        .map((signal) => ({ ...signal, share: group.samples > 0 ? signal.samples / group.samples : null }))
        .sort((a, b) => b.samples - a.samples || a.planType.localeCompare(b.planType)),
    }))
    .sort((a, b) => b.date.localeCompare(a.date) || String(a.limitId).localeCompare(String(b.limitId)));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function addCalendarMonth(isoTimestamp) {
  const source = new Date(isoTimestamp);
  if (!Number.isFinite(source.getTime())) return null;
  const targetYear = source.getUTCFullYear() + Math.floor((source.getUTCMonth() + 1) / 12);
  const targetMonth = (source.getUTCMonth() + 1) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const target = new Date(source);
  target.setUTCFullYear(targetYear, targetMonth, Math.min(source.getUTCDate(), lastDay));
  return target.toISOString();
}

function rollingProviderUsage(report, provider, observedAt, windowMinutes = 300) {
  const endMs = Date.parse(observedAt);
  if (!Number.isFinite(endMs)) return null;
  const startMs = endMs - windowMinutes * 60_000;
  const bucketDurationMs = 15 * 60_000;
  const totals = { requests: 0, tokens: 0, costUsd: 0 };
  for (const [bucket, providers] of Object.entries(report.quarterHourlyProviderModels || {})) {
    const bucketMs = Date.parse(bucket);
    if (!Number.isFinite(bucketMs)) continue;
    const overlapMs = Math.max(0, Math.min(endMs, bucketMs + bucketDurationMs) - Math.max(startMs, bucketMs));
    if (overlapMs === 0) continue;
    const weight = overlapMs / bucketDurationMs;
    for (const stats of Object.values(providers?.[provider] || {})) {
      totals.requests += (Number(stats.requests) || 0) * weight;
      totals.tokens += ((Number(stats.input) || 0)
        + (Number(stats.cacheCreate5m) || 0)
        + (Number(stats.cacheCreate30m) || 0)
        + (Number(stats.cacheCreate1h) || 0)
        + (Number(stats.cacheRead) || 0)
        + (Number(stats.output) || 0)) * weight;
      totals.costUsd += (Number(stats.costUsd) || 0) * weight;
    }
  }
  return totals.requests > 0 ? totals : null;
}

function weeklyProviderPeaks(report, provider, windowMinutes = 300) {
  const bucketDurationMs = 15 * 60_000;
  const buckets = Object.entries(report.quarterHourlyProviderModels || {})
    .map(([timestamp, providers]) => {
      const timestampMs = Date.parse(timestamp);
      if (!Number.isFinite(timestampMs)) return null;
      const totals = { requests: 0, tokens: 0, costUsd: 0 };
      for (const stats of Object.values(providers?.[provider] || {})) {
        totals.requests += Number(stats.requests) || 0;
        totals.tokens += (Number(stats.input) || 0)
          + (Number(stats.cacheCreate5m) || 0)
          + (Number(stats.cacheCreate30m) || 0)
          + (Number(stats.cacheCreate1h) || 0)
          + (Number(stats.cacheRead) || 0)
          + (Number(stats.output) || 0);
        totals.costUsd += Number(stats.costUsd) || 0;
      }
      return totals.requests > 0 ? { timestamp, timestampMs, ...totals } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampMs - b.timestampMs);
  const peaks = new Map();
  const active = [];
  let head = 0;
  const rolling = { requests: 0, tokens: 0, costUsd: 0 };
  for (const bucket of buckets) {
    active.push(bucket);
    rolling.requests += bucket.requests;
    rolling.tokens += bucket.tokens;
    rolling.costUsd += bucket.costUsd;
    const cutoff = bucket.timestampMs - windowMinutes * 60_000;
    while (head < active.length && active[head].timestampMs <= cutoff) {
      const expired = active[head++];
      rolling.requests -= expired.requests;
      rolling.tokens -= expired.tokens;
      rolling.costUsd -= expired.costUsd;
    }
    const observedAtMs = bucket.timestampMs + bucketDurationMs;
    const week = weekKey(new Date(observedAtMs));
    const previous = peaks.get(week);
    if (!previous || rolling.costUsd > previous.costUsd) {
      peaks.set(week, { week, observedAt: new Date(observedAtMs).toISOString(), ...rolling });
    }
  }
  return [...peaks.values()].sort((a, b) => a.week.localeCompare(b.week));
}

function claudeLimitAnchors(report) {
  const events = (report.providerLimitEvents || [])
    .filter((event) => (
      event?.provider === "anthropic" &&
      /session limit/i.test(String(event.message || "")) &&
      Number.isFinite(Date.parse(event.timestamp))
    ))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const deduped = [];
  for (const event of events) {
    const previous = deduped.at(-1);
    const sameNotice = previous && String(previous.message || "") === String(event.message || "");
    if (sameNotice && Date.parse(event.timestamp) - Date.parse(previous.timestamp) < 5 * 60 * 60 * 1_000) continue;
    deduped.push(event);
  }
  return deduped.map((event) => {
    const usage = rollingProviderUsage(report, "anthropic", event.timestamp);
    return usage ? { observedAt: event.timestamp, message: event.message || null, ...usage } : null;
  }).filter(Boolean);
}

function clusterClaudeAnchors(anchors) {
  if (anchors.length < 4) return null;
  const sorted = [...anchors].sort((a, b) => a.costUsd - b.costUsd);
  let split = -1;
  let largestRatio = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    const ratio = sorted[index - 1].costUsd > 0 ? sorted[index].costUsd / sorted[index - 1].costUsd : 0;
    if (ratio > largestRatio) {
      largestRatio = ratio;
      split = index;
    }
  }
  if (split < 2 || sorted.length - split < 2 || largestRatio < 2.5) return null;
  const low = sorted.slice(0, split);
  const high = sorted.slice(split);
  const lowMedian = median(low.map((anchor) => anchor.costUsd));
  const highMedian = median(high.map((anchor) => anchor.costUsd));
  const clusterSpread = (cluster) => {
    const costs = cluster.map((anchor) => anchor.costUsd).filter((cost) => cost > 0);
    return costs.length ? Math.max(...costs) / Math.min(...costs) : Number.POSITIVE_INFINITY;
  };
  if (clusterSpread(low) > 1.75 || clusterSpread(high) > 1.75) return null;
  const capacityRatio = highMedian / lowMedian;
  const highPlanId = capacityRatio >= 3 && capacityRatio <= 10
    ? "claude-max-100"
    : capacityRatio >= 12 && capacityRatio <= 35
      ? "claude-max-200"
      : null;
  if (!highPlanId) return null;
  const lowKeys = new Set(low.map((anchor) => anchor.observedAt));
  const sustainedRuns = { low: 0, high: 0 };
  let previousCluster = null;
  let run = 0;
  for (const anchor of [...anchors].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))) {
    const cluster = lowKeys.has(anchor.observedAt) ? "low" : "high";
    run = cluster === previousCluster ? run + 1 : 1;
    sustainedRuns[cluster] = Math.max(sustainedRuns[cluster], run);
    previousCluster = cluster;
  }
  if (sustainedRuns.low < 2 || sustainedRuns.high < 2) return null;
  return {
    capacityRatio,
    lowMedianCostUsd: lowMedian,
    highMedianCostUsd: highMedian,
    alternativePlanPair: highPlanId === "claude-max-100"
      ? ["claude-max-100", "claude-max-200"]
      : null,
    anchors: anchors.map((anchor) => ({
      ...anchor,
      inferredPlanId: lowKeys.has(anchor.observedAt) ? "claude-pro" : highPlanId,
    })),
  };
}

function inferredClaudeTimeline(report, now) {
  const calibration = clusterClaudeAnchors(claudeLimitAnchors(report));
  if (!calibration) return null;
  const anchors = [...calibration.anchors].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const weeklyPeaks = weeklyProviderPeaks(report, "anthropic").map((peak) => {
    let minimumPlanId = "claude-pro";
    if (peak.costUsd >= calibration.lowMedianCostUsd * 2) minimumPlanId = "claude-max-100";
    if (peak.costUsd >= calibration.highMedianCostUsd * 2) minimumPlanId = "claude-max-200";
    return {
      ...peak,
      minimumPlanId,
      minimumPlanLabel: PROVIDER_PLAN_CATALOG.anthropic[minimumPlanId].label,
    };
  });
  const observations = [
    ...anchors.map((anchor) => ({
      kind: "limit-hit",
      observedAt: anchor.observedAt,
      planId: anchor.inferredPlanId,
    })),
    ...weeklyPeaks.map((peak) => ({
      kind: "weekly-lower-bound",
      observedAt: peak.observedAt,
      planId: peak.minimumPlanId,
    })),
  ].sort((left, right) => (
    Date.parse(left.observedAt) - Date.parse(right.observedAt)
      || (left.kind === "limit-hit" ? -1 : 1)
  ));
  const segments = [];
  const conflicts = [];
  for (const observation of observations) {
    const active = segments.at(-1);
    if (!active) {
      if (observation.kind === "weekly-lower-bound") continue;
      segments.push({
        planId: observation.planId,
        from: observation.observedAt,
        through: observation.observedAt,
        anchors: observation.kind === "limit-hit" ? 1 : 0,
        weeklyPeaks: observation.kind === "weekly-lower-bound" ? 1 : 0,
        activationEarliestAfter: null,
        activationObservedBy: observation.observedAt,
      });
      continue;
    }
    const activeMultiple = PROVIDER_PLAN_CATALOG.anthropic[active.planId].capacityMultiple;
    const nextMultiple = PROVIDER_PLAN_CATALOG.anthropic[observation.planId].capacityMultiple;
    if (observation.kind === "weekly-lower-bound") {
      if (nextMultiple < activeMultiple) continue;
      if (nextMultiple === activeMultiple) {
        active.through = observation.observedAt;
        active.weeklyPeaks += 1;
        continue;
      }
      segments.push({
        planId: observation.planId,
        from: observation.observedAt,
        through: observation.observedAt,
        anchors: 0,
        weeklyPeaks: 1,
        activationEarliestAfter: active.through,
        activationObservedBy: observation.observedAt,
      });
      continue;
    }
    if (observation.planId === active.planId) {
      active.through = observation.observedAt;
      active.anchors += 1;
      continue;
    }
    if (nextMultiple < activeMultiple) {
      const eligibleAt = active.activationEarliestAfter ? addCalendarMonth(active.activationEarliestAfter) : null;
      if (eligibleAt && Date.parse(observation.observedAt) < Date.parse(eligibleAt)) {
        conflicts.push({ observedAt: observation.observedAt, inferredPlanId: observation.planId, blockedByBillingBoundary: eligibleAt });
        active.through = observation.observedAt;
        continue;
      }
    }
    segments.push({
      planId: observation.planId,
      from: observation.observedAt,
      through: observation.observedAt,
      anchors: 1,
      weeklyPeaks: 0,
      activationEarliestAfter: nextMultiple > activeMultiple ? active.through : null,
      activationObservedBy: observation.observedAt,
    });
  }
  const last = segments.at(-1);
  const lastPlan = PROVIDER_PLAN_CATALOG.anthropic[last.planId];
  const downgradeEligibleAt = lastPlan.capacityMultiple > 1 && last.activationEarliestAfter
    ? addCalendarMonth(last.activationEarliestAfter)
    : null;
  const lastObservedAtMs = Date.parse(last.through);
  const downgradeEligibleAtMs = downgradeEligibleAt ? Date.parse(downgradeEligibleAt) : null;
  const evidenceExpiresAtMs = downgradeEligibleAtMs && lastObservedAtMs < downgradeEligibleAtMs
    ? downgradeEligibleAtMs
    : lastObservedAtMs + PLAN_SIGNAL_FRESH_MS;
  const currentSupported = now.getTime() <= evidenceExpiresAtMs;
  return {
    anchors,
    segments: segments.map((segment) => ({
      ...segment,
      planLabel: PROVIDER_PLAN_CATALOG.anthropic[segment.planId].label,
    })),
    conflicts,
    capacityRatio: calibration.capacityRatio,
    lowMedianCostUsd: calibration.lowMedianCostUsd,
    highMedianCostUsd: calibration.highMedianCostUsd,
    alternativePlanPair: calibration.alternativePlanPair,
    lastInferredPlanId: last.planId,
    lastInferredPlanLabel: lastPlan.label,
    observedAt: last.through,
    downgradeEligibleAt,
    evidenceExpiresAt: new Date(evidenceExpiresAtMs).toISOString(),
    currentLikelyPlanId: currentSupported ? last.planId : null,
    currentLikelyPlanLabel: currentSupported ? lastPlan.label : null,
    currentSupported,
    weeklyPeaks,
  };
}

function providerResult(provider, report, now) {
  const detection = currentProtocolDetection(report, provider, now);
  const inference = provider === "anthropic" && !detection ? inferredClaudeTimeline(report, now) : null;
  const lastObservedPlanId = detection?.planId || null;
  const currentPlanId = detection?.stale ? null : lastObservedPlanId;
  const currentPlan = currentPlanId ? PROVIDER_PLAN_CATALOG[provider][currentPlanId] : null;
  const lastObservedPlan = lastObservedPlanId ? PROVIDER_PLAN_CATALOG[provider][lastObservedPlanId] : null;
  let source = "none";
  if (detection?.conflict) source = "conflict";
  else if (detection?.unsupported) source = "unsupported";
  else if (detection?.planId) source = "protocol";
  else if (inference) source = "inference";
  const history = planHistory(report, provider);
  return {
    provider,
    providerLabel: provider === "openai" ? "OpenAI" : "Anthropic",
    currentPlanId,
    currentPlanLabel: currentPlan?.label || null,
    currentMonthlyUsd: currentPlan?.monthlyUsd ?? null,
    capacityMultiple: currentPlan?.capacityMultiple ?? null,
    lastObservedPlanId,
    lastObservedPlanLabel: lastObservedPlan?.label || null,
    source,
    likelyPlanId: inference?.currentLikelyPlanId || null,
    likelyPlanLabel: inference?.currentLikelyPlanLabel || null,
    confidence: detection?.confidence || (inference ? "low" : "none"),
    observedAt: detection?.observedAt || inference?.observedAt || null,
    observedPlanType: detection?.observedPlanType || null,
    observedPlanTypes: detection?.observedPlanTypes || [],
    stale: Boolean(detection?.stale),
    conflict: Boolean(detection?.conflict),
    evidence: detection?.evidence || [],
    history,
    inference,
    caveat: provider === "anthropic"
      ? "Claude session telemetry records usage but does not expose subscription plan, account identity, or quota percentages. Heuristic floors aggregate local Claude activity; inactivity cannot identify a downgrade."
      : "Codex plan_type is direct telemetry, but concurrent sessions can overlap around a plan change. Mixed days remain mixed instead of being forced into one tier.",
  };
}

function detectSubscriptionPlans(report = {}, options = {}) {
  const now = options.now instanceof Date && Number.isFinite(options.now.getTime()) ? options.now : new Date();
  return [
    providerResult("openai", report, now),
    providerResult("anthropic", report, now),
  ];
}

module.exports = {
  OPENAI_PROTOCOL_PLANS,
  PLAN_SIGNAL_CONFLICT_MS,
  PLAN_SIGNAL_FRESH_MS,
  PROVIDER_PLAN_CATALOG,
  detectSubscriptionPlans,
  claudeLimitAnchors,
  inferredClaudeTimeline,
  weeklyProviderPeaks,
  planHistory,
  providerForAgent,
  rollingProviderUsage,
};
