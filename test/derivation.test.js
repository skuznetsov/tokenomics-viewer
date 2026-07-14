"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ANALYTICS_DERIVATION_VERSION,
  PRICING_CATALOG_VERSION,
  sourceFingerprint,
} = require("../lib/core/derivation");

const sourceParts = {
  size: 128,
  kind: "jsonl",
  mtimeMs: 42,
};

test("source fingerprints use deterministic key ordering", () => {
  const first = sourceFingerprint(sourceParts);
  const second = sourceFingerprint({
    mtimeMs: sourceParts.mtimeMs,
    kind: sourceParts.kind,
    size: sourceParts.size,
  });

  assert.equal(first, second);
  assert.equal(first, [
    `analyticsDerivationVersion=${ANALYTICS_DERIVATION_VERSION}`,
    "kind=jsonl",
    "mtimeMs=42",
    `pricingCatalogVersion=${PRICING_CATALOG_VERSION}`,
    "size=128",
  ].join("|"));
});

test("source fingerprints invalidate when either derivation version changes", () => {
  const current = sourceFingerprint(sourceParts);
  const analyticsChanged = sourceFingerprint(sourceParts, {
    analyticsDerivationVersion: ANALYTICS_DERIVATION_VERSION + 1,
  });
  const pricingChanged = sourceFingerprint(sourceParts, {
    pricingCatalogVersion: PRICING_CATALOG_VERSION + 1,
  });

  assert.notEqual(analyticsChanged, current);
  assert.notEqual(pricingChanged, current);
  assert.match(current, new RegExp(`analyticsDerivationVersion=${ANALYTICS_DERIVATION_VERSION}`));
  assert.match(current, new RegExp(`pricingCatalogVersion=${PRICING_CATALOG_VERSION}`));
});

test("source fingerprints include the active database pricing revision", () => {
  const first = sourceFingerprint({ ...sourceParts, pricingRevision: "catalog-a" });
  const second = sourceFingerprint({ ...sourceParts, pricingRevision: "catalog-b" });

  assert.notEqual(first, second);
  assert.match(first, /pricingRevision=catalog-a/);
});
