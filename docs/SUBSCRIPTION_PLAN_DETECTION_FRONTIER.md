# Subscription Plan Detection Frontier SDD

Document status: implementation-verified
Current frontier: provider-scoped historical observations and guarded inference
Bounded context: direct plan metadata, raw telemetry, quota-limit anchors,
billing-boundary constraints, and honest abstention

## ProblemCard

- Signal: subscription tiers change over time and OpenAI and Anthropic can be
  used concurrently. A single configured plan is false history.
- Why now: quota percentages and API-equivalent economics are useful only when
  their provider, evidence time, and possible tier are explicit.
- Scope: recover independent provider histories automatically. Preserve mixed
  transition days, multiple limit scopes, evidence freshness, and unknowns.
- Not merely: infer one current label from total tokens or ask the user to keep
  a plan setting updated.
- Improvement probe: direct Codex aliases must remain visible by day; repeated
  Claude limit hits may infer a bounded historical episode; inactivity and
  incomplete telemetry must never manufacture a current tier.
- Validation boundary: local session telemetry only. No credentials, browser
  cookies, billing pages, private account APIs, or paid probes.

## Observed Evidence

- Codex emits `rate_limits.plan_type`. Current aliases observed in local source:
  `plus`, `prolite`, and `pro`.
- Concurrent Codex sessions can interleave old and new values around a plan
  change. Daily signal distributions are evidence; a last-value state machine
  is not historical truth.
- Claude usage snapshots expose token/cache fields and `service_tier`, but not a
  subscription plan or quota percentage.
- Claude emits synthetic `rate_limit` errors with reset notices. Repeated hits
  can calibrate relative local capacity when paired with rolling five-hour
  usage, but do not become provider billing facts.
- Only explicit `session limit` notices are capacity anchors. Generic API 429
  records remain raw evidence but cannot calibrate a subscription tier.
- Low local usage and inactivity are compatible with every higher tier.
- Plan upgrades can become effective immediately. A scheduled downgrade cannot
  become effective before the next monthly billing boundary.

## Admitted Surface

- OpenAI and Anthropic are detected independently. One provider may be absent,
  both may be active, and neither is the default identity of the other.
- OpenAI direct detection maps:
  - `plus` -> ChatGPT Plus;
  - `prolite` -> ChatGPT Pro Lite ($100);
  - `pro` -> ChatGPT Pro ($200).
- The report stores daily counts for every observed Codex plan alias, grouped by
  `limit_id`. Mixed days remain mixed and expose shares rather than majority
  rewriting.
- The newest non-conflicting direct signal is the last observed OpenAI tier.
  Stale and simultaneous conflicting signals are first-class outcomes. A stale
  direct signal moves to `lastObservedPlan`; it never remains `currentPlan`.
- Claude inference requires at least two compact, sustained limit-hit clusters
  separated by a material capacity gap. Each regime needs two consecutive
  observations; alternating or widely dispersed costs abstain. The lower
  cluster is a local Pro calibration; a
  roughly 5x cluster maps to Max $100 and a roughly 20x cluster maps to Max
  $200. Because an unanchored pair can also represent Max $100 -> Max $200, the
  alternate pair remains visible. The result is a low-confidence likely plan,
  never protocol evidence or `currentPlan`.
- An inferred upgrade may begin at its first high-capacity anchor. Its unknown
  activation time is bounded by the last lower observation and the first high
  observation. A downgrade is rejected only before the earliest possible
  monthly boundary, never through the more convenient latest bound.
- Between confirming anchors, a historical episode may be interpolated. Once a
  downgrade becomes possible and no newer anchor exists, current tier returns
  to unknown while the last inferred episode remains visible.
- Every calendar week records its maximum rolling five-hour local usage. A peak
  materially above a calibrated lower-tier limit is a one-way lower bound on
  the plausible tier. It may confirm or raise the inferred timeline, but it can
  never create a pre-anchor plan, lower an existing tier, or establish an
  account-scoped provider fact. A quiet week proves nothing about the active
  tier.
- A compatible observation after the downgrade boundary refreshes the current
  inference for 14 days. It does not make the inferred tier permanent.
- Typed columns remain the fast reporting projection. Provider telemetry
  envelopes, including duplicates and replay evidence, are stored as ZSTD
  compressed raw JSON in ClickHouse and as a compatibility TEXT column in
  SQLite for repeatable future analysis.
- Raw telemetry excludes conversation text. It includes usage payloads,
  `rate_limits`, provider error/reset metadata, and previously unknown fields.
- A derivation-version bump triggers a one-time source reimport to backfill the
  new telemetry table. Pricing-only edits still do not reimport sources.

## Rejected Surface

- Manual current-plan configuration as historical authority.
- Treating providers or plans as mutually exclusive.
- Inferring a tier solely from daily tokens, API-equivalent dollars, model
  availability, low usage, inactivity, or the presence of one limit window.
- Calling 1x/5x/20x an absolute token allowance.
- Majority-merging different `limit_id` scopes or accounts.
- Treating a transition day with multiple aliases as one clean plan day.
- Extending an inferred high tier past a possible downgrade boundary without a
  later compatible limit anchor or weekly lower-bound observation.
- Saving full prompts, assistant content, credentials, cookies, or authorization
  payloads in telemetry JSON.
- Letting plan observations alter pricing, billed/API-equivalent semantics,
  source identity, or quota values.

## Design Laws

1. Provider, scope, plan, observation time, and evidence kind are different
   typed facts.
2. Direct provider metadata outranks statistical inference.
3. Historical interpolation cannot become a current claim after its guard
   boundary expires.
4. High observed consumption can exclude lower capacities; low consumption
   cannot exclude higher capacities.
5. Mixed, stale, conflicting, inferred, and unknown are valid UI states.
6. A raw evidence row is append-only source data; dashboards consume derived
   projections rather than parsing raw JSON on every request.
7. Plan detection never changes cost semantics or pricing derivations.

## Value-Proxy Check

- Intended value: understand which subscription capacity was plausibly
  available during work and how effectively it was used.
- Visible proxies: wire alias, rolling local API-equivalent cost at a quota hit,
  token volume, and billing-boundary continuity.
- Proxy risk: local logs omit web/other-device activity and provider capacity
  varies with model, context, and policy changes.
- Counter-metrics: raw anchor count, cluster ratio, cluster spread, coverage,
  mixed-day share, evidence age, conflicts, and downgrade eligibility.
- Decision: admit direct OpenAI history and guarded Claude historical inference;
  abstain on current Claude tier whenever the temporal certificate expires.

## Falsifier Roster

- OpenAI aliases map to three distinct labels.
- A `pro -> plus -> prolite -> pro` history remains visible rather than being
  overwritten by the latest value.
- Multiple aliases on one day expose counts and shares.
- Different `limit_id` scopes remain separate.
- OpenAI and Claude usage on the same day do not contaminate each other's quota
  window totals.
- Contradictory simultaneous direct signals abstain.
- Repeated low/high Claude limit-hit clusters produce a guarded Pro -> Max
  episode when the ratio is compatible with a public tier multiple.
- Alternating or internally dispersed Claude cost clusters abstain.
- A downgrade anchor before the monthly boundary is rejected as a conflict.
- Current Claude tier becomes unknown after an unobserved downgrade boundary.
- A strong weekly maximum after that boundary refreshes a compatible tier; a
  quiet weekly maximum neither refreshes nor lowers it.
- Claude usage without repeated limit anchors abstains.
- Telemetry storage includes full usage/rate-limit envelopes but excludes
  conversation content.
- SQLite and ClickHouse retain the latest aggregate alias plus daily plan
  distributions.
- A schema derivation bump backfills telemetry once; a pricing revision does
  not invalidate source fingerprints.

## Stop Rules

- Stop classification when direct newest signals conflict.
- Stop Claude calibration with fewer than two repeated clusters or an
  incompatible capacity ratio.
- Stop current-tier inheritance at the first unobserved downgrade boundary.
- Stop before accessing credentials or undocumented account endpoints.
- Do not promote a local cluster model to provider-wide absolute limits.

## Implementation Seal

- Slice: compressed telemetry, direct OpenAI daily history, guarded Claude
  limit-hit inference, provider-specific quota economics, and evidence UI.
- Source/spec: `lib/core/telemetry.js`, `lib/core/subscription-plans.js`, parser,
  storage backends, dashboard summary, and Subscription Limits UI.
- Falsifiers: telemetry, subscription-plan, rate-limit, derivation, SQLite,
  ClickHouse, dashboard, and browser tests.
- Boundary: local database with provider and `limit_id` scoping. Durable account
  identity remains a future source-registry/multi-tenant concern.
- Verification: unit/integration suite, desktop and mobile browser render,
  committed ClickHouse backfill, real direct-plan history, real Claude
  session-limit clustering, and storage-compression probes.
