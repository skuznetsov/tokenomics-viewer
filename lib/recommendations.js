"use strict";

const MAX_RECOMMENDATIONS = 5;

function number(value) {
  return Number.isFinite(value) ? value : 0;
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function roundedMoney(value) {
  return Math.round(value * 100) / 100;
}

function weeklyCostSpike(report) {
  if (number(report.total?.requests) < 100) return null;
  const costsByDay = new Map(Object.entries(report.daily || {}).filter(([day]) => /^\d{4}-\d{2}-\d{2}$/.test(day)));
  const latestDay = [...costsByDay.keys()].sort().at(-1);
  const latestTime = Date.parse(`${latestDay || ""}T00:00:00Z`);
  if (!Number.isFinite(latestTime)) return null;
  const costs = [];
  for (let offset = 13; offset >= 0; offset -= 1) {
    const day = new Date(latestTime - offset * 86_400_000).toISOString().slice(0, 10);
    costs.push(number(costsByDay.get(day)?.costUsd));
  }
  const previous = costs.slice(0, 7).reduce((sum, value) => sum + value, 0);
  const current = costs.slice(7).reduce((sum, value) => sum + value, 0);
  const increase = current - previous;
  const increaseShare = previous > 0 ? increase / previous : 0;
  if (previous < 5 || increase < 10 || increaseShare < 0.25) return null;
  return {
    id: "weekly-cost-spike",
    severity: "warning",
    title: "Investigate the weekly cost increase",
    finding: `The latest 7 days cost ${percent(increaseShare)} more than the previous 7 days.`,
    action: "Compare the latest project and model mix with the previous week, then inspect the largest daily increases.",
    impactUsd: roundedMoney(increase),
    confidence: "high",
    evidence: `Latest 7 days vs previous 7 days · $${current.toFixed(2)} vs $${previous.toFixed(2)}`,
    caveat: "A cost increase does not prove inefficiency; it may reflect more work or a different workload.",
  };
}

function unpricedUsage(report) {
  const requests = number(report.total?.requests);
  const unpriced = number(report.total?.unpricedRequests);
  const share = requests > 0 ? unpriced / requests : 0;
  if (requests < 100 || unpriced === 0 || (share < 0.01 && unpriced < 100)) return null;
  const models = Object.values(report.unpricedModels || {})
    .sort((a, b) => number(b.requests) - number(a.requests))
    .map((row) => row.model)
    .filter((model) => model && !/^<.*>$/.test(model))
    .slice(0, 3);
  return {
    id: "unpriced-usage",
    severity: "warning",
    title: "Resolve unpriced usage",
    finding: `${Math.round(unpriced).toLocaleString("en-US")} requests (${percent(share)}) have no matching price.`,
    action: models.length
      ? `Classify as non-billable or add and verify pricing for: ${models.join(", ")}.`
      : "Classify the unrecognized provider/model identifiers as non-billable or add their tariffs.",
    impactUsd: null,
    confidence: "high",
    evidence: `All imported requests · ${Math.round(requests).toLocaleString("en-US")} request sample`,
    caveat: "Total cost may be understated, but subscription or intentionally non-billable requests may correctly have no API tariff.",
  };
}

function projectCostConcentration(report) {
  const totalCost = number(report.total?.costUsd);
  if (totalCost < 50) return null;
  const [projectName, stats] = Object.entries(report.projects || {})
    .filter(([name]) => !/^\(?unknown/i.test(name) && !/^<.*>$/.test(name))
    .sort((a, b) => number(b[1].costUsd) - number(a[1].costUsd))[0] || [];
  const projectCost = number(stats?.costUsd);
  const share = totalCost > 0 ? projectCost / totalCost : 0;
  if (!projectName || number(stats?.requests) < 100 || share < 0.5) return null;
  return {
    id: "project-cost-concentration",
    severity: "info",
    title: "Add a budget guard for the leading project",
    finding: `${projectName} accounts for ${percent(share)} of estimated cost.`,
    action: `Set a daily or weekly budget alert for ${projectName} and review its model mix when the threshold is crossed.`,
    impactUsd: null,
    confidence: "high",
    evidence: `$${projectCost.toFixed(2)} of $${totalCost.toFixed(2)} · ${Math.round(number(stats.requests)).toLocaleString("en-US")} requests`,
    caveat: "Cost concentration is not itself a problem when the project legitimately carries most of the workload.",
  };
}

function ingestionErrors(report) {
  const requests = number(report.total?.requests);
  const errors = number(report.sources?.parseErrors);
  const observed = Math.max(requests, number(report.sources?.tokenCountSnapshots)) + errors;
  if (requests < 1_000 || errors < 100 || errors / observed < 0.01) return null;
  return {
    id: "ingestion-parse-errors",
    severity: "warning",
    title: "Review ingestion parse errors",
    finding: `${Math.round(errors).toLocaleString("en-US")} records could not be parsed.`,
    action: "Inspect representative malformed records and verify whether their token usage is missing from the report.",
    impactUsd: null,
    confidence: "high",
    evidence: `${Math.round(errors).toLocaleString("en-US")} parse errors across ${Math.round(requests).toLocaleString("en-US")} imported requests`,
    caveat: "A parse error does not necessarily contain billable usage, so its cost impact is unknown.",
  };
}

function buildRecommendations(report = {}) {
  return [
    weeklyCostSpike(report),
    unpricedUsage(report),
    projectCostConcentration(report),
    ingestionErrors(report),
  ].filter(Boolean).slice(0, MAX_RECOMMENDATIONS);
}

module.exports = { buildRecommendations };
