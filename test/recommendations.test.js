"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildRecommendations } = require("../lib/recommendations");
const { newReport } = require("../app");
const { statsFixture } = require("./support/fixtures");

function dailyCosts(values) {
  return Object.fromEntries(values.map((costUsd, index) => [
    `2026-06-${String(index + 1).padStart(2, "0")}`,
    statsFixture({ costUsd }),
  ]));
}

test("recommendations explain a material weekly cost spike", () => {
  const report = newReport();
  report.total = statsFixture({ requests: 2_000, pricedRequests: 2_000, costUsd: 210 });
  report.daily = dailyCosts([10, 10, 10, 10, 10, 10, 10, 20, 20, 20, 20, 20, 20, 20]);

  const recommendations = buildRecommendations(report);
  const spike = recommendations.find((item) => item.id === "weekly-cost-spike");

  assert.ok(spike);
  assert.equal(spike.confidence, "high");
  assert.equal(spike.impactUsd, 70);
  assert.match(spike.finding, /100\.0%/);
  assert.match(spike.evidence, /7 days vs previous 7 days/);
  assert.match(spike.caveat, /not prove inefficiency/i);
});

test("recommendations surface material unpriced coverage without inventing impact", () => {
  const report = newReport();
  report.total = statsFixture({ requests: 1_000, pricedRequests: 850, unpricedRequests: 150, costUsd: 100 });
  report.unpricedModels["openai/mystery"] = { provider: "openai", model: "mystery", requests: 150 };

  const recommendation = buildRecommendations(report).find((item) => item.id === "unpriced-usage");

  assert.ok(recommendation);
  assert.equal(recommendation.impactUsd, null);
  assert.match(recommendation.finding, /150 requests.*15\.0%/);
  assert.match(recommendation.action, /non-billable.*mystery/i);
  assert.match(recommendation.caveat, /may be understated/i);
  assert.match(recommendation.caveat, /subscription/i);
});

test("recommendations identify project concentration but do not call it waste", () => {
  const report = newReport();
  report.total = statsFixture({ requests: 1_000, pricedRequests: 1_000, costUsd: 200 });
  report.projects.alpha = statsFixture({ requests: 700, pricedRequests: 700, costUsd: 130 });
  report.projects.beta = statsFixture({ requests: 300, pricedRequests: 300, costUsd: 70 });

  const recommendation = buildRecommendations(report).find((item) => item.id === "project-cost-concentration");

  assert.ok(recommendation);
  assert.match(recommendation.finding, /alpha.*65\.0%/);
  assert.match(recommendation.action, /budget alert/i);
  assert.match(recommendation.caveat, /not itself a problem/i);
});

test("recommendations suppress weak signals and remain bounded", () => {
  const report = newReport();
  report.total = statsFixture({ requests: 10, pricedRequests: 10, costUsd: 1 });
  report.daily = dailyCosts([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2]);
  report.sources.parseErrors = 1;

  assert.deepEqual(buildRecommendations(report), []);

  report.total = statsFixture({ requests: 10_000, pricedRequests: 8_000, unpricedRequests: 2_000, costUsd: 1_000 });
  report.sources.parseErrors = 500;
  for (let index = 0; index < 10; index += 1) {
    report.projects[`project-${index}`] = statsFixture({ requests: 1_000, costUsd: 100 });
  }
  assert.ok(buildRecommendations(report).length <= 5);
});

test("weekly spike compares calendar days rather than sparse active buckets", () => {
  const report = newReport();
  report.total = statsFixture({ requests: 2_000, pricedRequests: 2_000, costUsd: 210 });
  for (let index = 0; index < 14; index += 1) {
    const date = new Date(Date.UTC(2026, 0, 1 + index * 7)).toISOString().slice(0, 10);
    report.daily[date] = statsFixture({ costUsd: index < 7 ? 10 : 20 });
  }

  assert.equal(buildRecommendations(report).some((item) => item.id === "weekly-cost-spike"), false);
});

test("unpriced recommendation omits synthetic model identifiers", () => {
  const report = newReport();
  report.total = statsFixture({ requests: 1_000, pricedRequests: 800, unpricedRequests: 200, costUsd: 100 });
  report.unpricedModels.synthetic = { provider: "anthropic", model: "<synthetic>", requests: 150 };
  report.unpricedModels.real = { provider: "openai", model: "unknown-real-model", requests: 50 };

  const recommendation = buildRecommendations(report).find((item) => item.id === "unpriced-usage");
  assert.match(recommendation.action, /unknown-real-model/);
  assert.doesNotMatch(recommendation.action, /synthetic/);
});
