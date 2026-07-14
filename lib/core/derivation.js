"use strict";

// Bump these independently when their derived values can change for the same source bytes.
const ANALYTICS_DERIVATION_VERSION = 1;
const PRICING_CATALOG_VERSION = 1;

function sourceFingerprint(parts, {
  analyticsDerivationVersion = ANALYTICS_DERIVATION_VERSION,
  pricingCatalogVersion = PRICING_CATALOG_VERSION,
} = {}) {
  return Object.entries({
    ...parts,
    analyticsDerivationVersion,
    pricingCatalogVersion,
  })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => String(key) + "=" + (value ?? ""))
    .join("|");
}

module.exports = {
  ANALYTICS_DERIVATION_VERSION,
  PRICING_CATALOG_VERSION,
  sourceFingerprint,
};
